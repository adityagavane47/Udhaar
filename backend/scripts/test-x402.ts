/**
 * Tests the x402 paywall, investor sessions and the agent's spending rules. Spends nothing.
 *
 * A fake local facilitator stands in for the real one, so every failure can be forced and no payment
 * settles. Signed payments are built but never sent. Two real, already-settled transactions are read
 * from the mirror node to test the on-chain check. The live test is in test-x402-live.ts.
 *
 * Usage: npm run test:x402
 * Works on a temporary copy of the store. The real store is only read.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND = fileURLToPath(new URL("../", import.meta.url));
const REAL_STORE = `${BACKEND}data/store.json`;
const DATA_DIR = `${mkdtempSync(join(tmpdir(), "udhaar-x402-"))}/`;
const STORE_PATH = `${DATA_DIR}store.json`;
process.env.DATA_DIR = DATA_DIR;

const { AccountId, Client, TokenId, Transaction, TransactionId, TransferTransaction } = await import("@hiero-ledger/sdk");
const { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } = await import("@x402/core/http");
const { config } = await import("../src/config.js");
const { getParty } = await import("../src/hedera/client.js");
const { executeRun, newRun, runsToday } = await import("../src/agent/agent.js");
const { affordableUnits, purchaseCostBaseUnits } = await import("../src/agent/rules.js");
const { QuoteRefused, ReportCallError } = await import("../src/x402/client.js");
const { ApiError } = await import("../src/errors.js");
type AgentDeps = import("../src/agent/agent.js").AgentDeps;
type Listing = import("../src/agent/rules.js").Listing;

type Json = Record<string, any>;

const PORT = 4105;
const FACILITATOR_PORT = 4106;
const BASE = `http://127.0.0.1:${PORT}`;
const FEE_PAYER = "0.0.9185802";
/** Settled on-chain during research: pays the risk agent the report price of 100 base units. */
const REAL_PAYMENT = "0.0.9185802@1793926066.177008834";
/** Also settled on-chain, but pays the business, so it must never unlock a report. */
const REAL_OTHER_PAYMENT = "0.0.11310320@1793923986.951000000";

let passes = 0;
let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) passes++;
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

// ---- The fake facilitator.
const fake = { verify: "ok", settle: "ok", settleTransaction: undefined as string | undefined, verifyCalls: 0, settleCalls: 0 };
const facilitator: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/supported") {
      send(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: FEE_PAYER } }], extensions: [], signers: { "hedera:*": [FEE_PAYER] } });
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Json;
    const transaction = String(body.paymentPayload?.payload?.transaction ?? "");
    if (req.url === "/verify") {
      fake.verifyCalls++;
      if (fake.verify === "error") send(500, "broken");
      else if (fake.verify === "invalid") send(200, { isValid: false, invalidReason: "invalid_exact_hedera_payload_signature_invalid", invalidMessage: "bad signature", payer: "" });
      else send(200, { isValid: true, payer: process.env.INVESTOR_ID });
      return;
    }
    if (req.url === "/settle") {
      fake.settleCalls++;
      if (fake.settle === "error") {
        res.writeHead(500);
        res.end("not json");
      } else if (fake.settle === "fail") send(200, { success: false, network: "hedera:testnet", transaction: "", errorReason: "transaction_failed", errorMessage: "INSUFFICIENT_TOKEN_BALANCE", payer: process.env.INVESTOR_ID });
      else send(200, { success: true, network: "hedera:testnet", payer: process.env.INVESTOR_ID, transaction: fake.settleTransaction ?? transactionIdIn(transaction) });
      return;
    }
    send(404, {});
  });
});

const transactionIdIn = (base64: string) => Transaction.fromBytes(Buffer.from(base64, "base64")).transactionId?.toString() ?? "";

// ---- Talking to the server.
async function request(method: string, path: string, options: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    // Left empty: the check on the status will report it.
  }
  return { status: response.status, json, headers: response.headers };
}
const code = (reply: { status: number; json: Json }) => `${reply.status} ${reply.json.error?.code ?? "ok"}`;

async function withServer(env: Record<string, string>, run: () => Promise<void>) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: BACKEND,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, DEMO_ADMIN_PASSCODE: "x402-test-passcode", FACILITATOR_URL: `http://127.0.0.1:${FACILITATOR_PORT}`, X402_CONFIRM_ATTEMPTS: "1", MAX_STEP_HBAR: "0.001", ...env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        up = (await fetch(`${BASE}/health`)).ok;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!up) throw new Error("Server did not start");
    await run();
  } finally {
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      });
    }
  }
}

/** Reads the 402, signs a real payment matching it, and returns the header. Nothing is sent to the network. */
async function signedHeader(path: string, transactionId?: string, change: (offer: Json) => Json = (offer) => offer) {
  const first = await request("GET", path);
  const required = decodePaymentRequiredHeader(first.headers.get("payment-required") ?? "");
  const offer = required.accepts[0] as unknown as Json;
  const investor = await getParty("INVESTOR");
  const client = Client.forTestnet();
  try {
    const id = transactionId ? TransactionId.fromString(transactionId) : TransactionId.generate(AccountId.fromString(FEE_PAYER));
    const transaction = new TransferTransaction()
      .addTokenTransfer(TokenId.fromString(offer.asset), AccountId.fromString(investor.id), -Number(offer.amount))
      .addTokenTransfer(TokenId.fromString(offer.asset), AccountId.fromString(offer.payTo), Number(offer.amount))
      .setTransactionId(id)
      .freezeWith(client);
    const signed = await transaction.sign(investor.key);
    const base64 = Buffer.from(signed.toBytes()).toString("base64");
    const payload = { x402Version: 2, payload: { transaction: base64 }, accepted: change(offer), resource: required.resource };
    return { "payment-signature": encodePaymentSignatureHeader(payload as never) };
  } finally {
    client.close();
  }
}

const resetFake = () => Object.assign(fake, { verify: "ok", settle: "ok", settleTransaction: undefined, verifyCalls: 0, settleCalls: 0 });
const REPORT_FIELDS = ["grade", "riskScore", "fraudFlags", "reasons", "graph", "breakdown", "anomaly", "confidence", "creditRisk"];
const hidesReport = (json: Json) => REPORT_FIELDS.every((field) => !(field in json));

// ---- 1. The paywall.
async function checkPaywall() {
  const path = "/risk/DEMO-RELIABLE/report";
  const unpaid = await request("GET", path);
  const risk = process.env.RISK_AGENT_ID?.trim();
  check("no payment returns 402", unpaid.status === 402, code(unpaid));
  check("402 hides the report", hidesReport(unpaid.json));
  const offer = unpaid.json.accepts?.[0] ?? {};
  check("402 gives the price", offer.amount === "100" && unpaid.json.payment?.price === 1 && unpaid.json.payment?.payerTotal === 1.01, JSON.stringify(unpaid.json.payment));
  check("402 gives the token", offer.asset === config.uinrTokenId && unpaid.json.payment?.token === config.uinrTokenId);
  check("402 gives the receiving account", offer.payTo === risk && unpaid.json.payment?.payTo === risk);
  check("402 gives the network", offer.network === "hedera:testnet" && unpaid.json.payment?.network === "hedera:testnet");
  check("402 gives the resource", String(unpaid.json.resource?.url).endsWith(path) && String(unpaid.json.payment?.resource).endsWith(path));
  check("402 names the fee payer", offer.extra?.feePayer === FEE_PAYER);
  check("402 includes a HashScan link", String(unpaid.json.hashscanUrl).startsWith("https://hashscan.io/testnet/"));
  check("402 header matches the body", decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "").accepts[0]?.amount === "100");
  check("the facilitator isn't asked about an unpaid call", fake.verifyCalls === 0 && fake.settleCalls === 0);

  const manifest = await request("GET", "/.well-known/x402");
  const service = manifest.json.services?.[0] ?? {};
  check("the endpoint can be discovered", manifest.status === 200 && String(service.url).endsWith("/risk/{invoiceId}/report") && service.payTo === risk && service.amountBaseUnits === 100 && String(service.listings).endsWith("/invoices"), JSON.stringify(service));

  const summary = await request("GET", "/risk/DEMO-RELIABLE/summary");
  check("the summary stays free", summary.status === 200 && summary.json.grade === "A" && !summary.json.riskScore);
  check("the scorer behind the summary still reports errors", code(await request("GET", "/risk/NOPE/summary")) === "404 INVOICE_NOT_FOUND");
  const unknown = await request("GET", "/risk/NOPE/report");
  check("an unknown invoice is a 404, not a price", code(unknown) === "404 INVOICE_NOT_FOUND", code(unknown));

  const garbage = await request("GET", path, { headers: { "payment-signature": "garbage" } });
  check("an unreadable payment returns 402", garbage.status === 402 && garbage.json.error === "invalid_payment" && hidesReport(garbage.json), code(garbage));

  const cheap = await request("GET", path, { headers: await signedHeader(path, undefined, (o) => ({ ...o, amount: "1" })) });
  check("a payment below the price returns 402", cheap.status === 402 && cheap.json.error === "payment_requirements_mismatch" && hidesReport(cheap.json), `${code(cheap)} ${cheap.json.error}`);
  const elsewhere = await request("GET", path, { headers: await signedHeader(path, undefined, (o) => ({ ...o, payTo: "0.0.1234" })) });
  check("a payment to another account returns 402", elsewhere.status === 402 && hidesReport(elsewhere.json), code(elsewhere));
  check("mismatched payments never reach the facilitator", fake.verifyCalls === 0 && fake.settleCalls === 0, `${fake.verifyCalls}, ${fake.settleCalls}`);

  resetFake();
  fake.verify = "invalid";
  const refused = await request("GET", path, { headers: await signedHeader(path) });
  check("a refused verify returns 402", refused.status === 402 && refused.json.error === "invalid_exact_hedera_payload_signature_invalid" && hidesReport(refused.json), `${code(refused)} ${refused.json.error}`);
  check("a refused verify isn't settled", fake.verifyCalls === 1 && fake.settleCalls === 0);

  resetFake();
  fake.settle = "fail";
  const failed = await request("GET", path, { headers: await signedHeader(path) });
  check("a failed settlement returns 402 with no report", failed.status === 402 && failed.json.error === "transaction_failed" && failed.json.reason === "INSUFFICIENT_TOKEN_BALANCE" && hidesReport(failed.json), `${code(failed)} ${failed.json.error}`);

  resetFake();
  fake.settle = "error";
  const noAnswer = await request("GET", path, { headers: await signedHeader(path) });
  check("no answer from settle and nothing on-chain gives no report", code(noAnswer) === "502 SETTLEMENT_UNCONFIRMED" && hidesReport(noAnswer.json), code(noAnswer));

  resetFake();
  fake.settle = "error";
  const lostAnswer = await request("GET", path, { headers: await signedHeader(path, REAL_PAYMENT) });
  check("if settle's answer is lost, a payment on-chain still gets its report", lostAnswer.status === 200 && lostAnswer.json.settlement?.onChainConfirmed === true && lostAnswer.json.grade === "A", code(lostAnswer));
  const lostAgain = await request("GET", path, { headers: await signedHeader(path, REAL_PAYMENT) });
  check("that payment can't be used again during an outage", lostAgain.status === 402 && lostAgain.json.error === "payment_already_used" && hidesReport(lostAgain.json), `${code(lostAgain)} ${lostAgain.json.error}`);
  check("a used payment doesn't reach the facilitator's settle again", fake.settleCalls === 1, String(fake.settleCalls));
  check("settlement is confirmed on-chain, with a 1 base unit fee", lostAnswer.json.settlement?.feeToPool === 0.01 && String(lostAnswer.json.settlement?.hashscanUrl).includes("1793926070.631121529"), JSON.stringify(lostAnswer.json.settlement));

  resetFake();
  const other = await request("GET", path, { headers: await signedHeader(path, REAL_OTHER_PAYMENT) });
  check("a real transaction that pays someone else gives no report", code(other) === "502 SETTLEMENT_MISMATCH" && hidesReport(other.json), code(other));

  resetFake();
  fake.settleTransaction = REAL_PAYMENT;
  const lying = await request("GET", path, { headers: await signedHeader(path) });
  check("a facilitator naming a different transaction gives no report", code(lying) === "502 SETTLEMENT_MISMATCH" && hidesReport(lying.json), code(lying));

  resetFake();
  const paid = await request("GET", path, { headers: await signedHeader(path) });
  check("a valid payment returns the report", paid.status === 200 && paid.json.grade === "A" && paid.json.riskScore > 0 && Array.isArray(paid.json.reasons) && Boolean(paid.json.graph), code(paid));
  check("the response has the settlement ID and link", /^0\.0\.\d+@/.test(paid.json.settlement?.transactionId) && String(paid.json.settlement?.hashscanUrl).startsWith("https://hashscan.io/testnet/transaction/") && paid.json.hashscanUrl === paid.json.settlement?.hashscanUrl, JSON.stringify(paid.json.settlement));
  check("the settlement link comes first", paid.json.links?.[0]?.txId === paid.json.settlement?.transactionId);
  check("verify then settle, once each", fake.verifyCalls === 1 && fake.settleCalls === 1, `${fake.verifyCalls}, ${fake.settleCalls}`);
  check("the PAYMENT-RESPONSE header is sent", decodePaymentResponseHeader(paid.headers.get("payment-response") ?? "").success === true);
  const audit = (await request("GET", "/audit")).json.entries as Json[];
  check("the sale is in the audit log", audit.some((entry) => entry.type === "report_paid" && entry.txId === paid.json.settlement?.transactionId));
  const stored = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Json;
  check("the payment is saved", Boolean(stored.reportPayments[paid.json.settlement?.transactionId]));
}

// ---- 2. Failures must never charge.
async function checkNoChargeWithoutReport() {
  resetFake();
  let header: Record<string, string> = {};
  await withServer({}, async () => {
    header = await signedHeader("/risk/DEMO-RELIABLE/report");
  });
  resetFake();
  await withServer({ RISK_DATA_DIR: `${DATA_DIR}nothing/` }, async () => {
    const unpaid = await request("GET", "/risk/DEMO-RELIABLE/report");
    check("scoring down: no price is offered", code(unpaid) === "503 RISK_DATA_UNAVAILABLE", code(unpaid));
    const paid = await request("GET", "/risk/DEMO-RELIABLE/report", { headers: header });
    check("scoring down: a paid call is an error", code(paid) === "503 RISK_DATA_UNAVAILABLE" && hidesReport(paid.json), code(paid));
    check("scoring down: the payment isn't verified or settled", fake.verifyCalls === 0 && fake.settleCalls === 0, `${fake.verifyCalls}, ${fake.settleCalls}`);
    const session = await request("POST", "/auth/demo-investor");
    const bought = await request("POST", "/risk/DEMO-RELIABLE/buy-report", { token: session.json.token });
    check("scoring down: buy-report is an error, with nothing settled", code(bought) === "503 RISK_DATA_UNAVAILABLE" && fake.settleCalls === 0, code(bought));
  });

  await withServer({ RISK_AGENT_ID: "" }, async () => {
    const reply = await request("GET", "/risk/DEMO-RELIABLE/report");
    check("no receiving account: the route stays locked", code(reply) === "503 PAYWALL_NOT_CONFIGURED" && hidesReport(reply.json), code(reply));
  });

  await withServer({ FACILITATOR_URL: "http://127.0.0.1:9" }, async () => {
    const reply = await request("GET", "/risk/DEMO-RELIABLE/report");
    check("facilitator down: an error, with no report", code(reply) === "503 FACILITATOR_UNAVAILABLE" && hidesReport(reply.json), code(reply));
  });

  resetFake();
  await withServer({}, async () => {
    const live = await signedHeader("/risk/DEMO-RELIABLE/report");
    fake.verify = "error";
    const reply = await request("GET", "/risk/DEMO-RELIABLE/report", { headers: live });
    check("verify unavailable: an error, with no report", code(reply) === "503 FACILITATOR_UNAVAILABLE" && hidesReport(reply.json) && fake.settleCalls === 0, code(reply));
  });
}

// ---- 3. Investor sessions and the routes behind them.
async function checkSessions() {
  const rules = { reportBudget: 5, investmentBudget: 1000, minGrade: "B", maxUnitsPerInvoice: 5 };
  resetFake();
  await withServer({}, async () => {
    const session = await request("POST", "/auth/demo-investor");
    const token = session.json.token as string;
    check("a session needs no passcode", session.status === 200 && Boolean(token) && session.json.tokenType === "Bearer" && session.json.accountId === process.env.INVESTOR_ID?.trim() && session.json.persona === "investor", code(session));
    check("a session lasts 30 minutes", session.json.expiresInSeconds === 1800);
    check("a session response has a HashScan link", String(session.json.hashscanUrl).startsWith("https://hashscan.io/testnet/"));

    const admin = (await request("POST", "/auth/demo-admin", { body: { passcode: "x402-test-passcode" } })).json.token as string;
    const routes: [string, unknown][] = [["/agent/run", rules], ["/risk/DEMO-RELIABLE/buy-report", undefined], ["/invoices/NOPE/buy", { units: 1 }]];
    for (const [path, body] of routes) {
      const options = body === undefined ? {} : { body };
      check(`${path} without a token`, code(await request("POST", path, options)) === "401 INVESTOR_TOKEN_REQUIRED");
      check(`${path} with a garbage token`, code(await request("POST", path, { ...options, token: "garbage" })) === "401 INVESTOR_TOKEN_INVALID");
      check(`${path} with an admin token`, code(await request("POST", path, { ...options, token: admin })) === "401 INVESTOR_TOKEN_INVALID");
    }
    check("an investor token can't open admin routes", code(await request("POST", "/tokens/NOPE/pause", { token })) === "401 ADMIN_TOKEN_INVALID");
    check("an admin token still opens admin routes", code(await request("POST", "/tokens/NOPE/pause", { token: admin })) === "404 TOKEN_NOT_FOUND");

    const [expiresAt = "", signature = ""] = token.split(".");
    check("a changed expiry is refused", code(await request("POST", "/invoices/NOPE/buy", { body: { units: 1 }, token: `${Number(expiresAt) + 86_400_000}.${signature}` })) === "401 INVESTOR_TOKEN_INVALID");
    check("a valid token reaches the buy route", code(await request("POST", "/invoices/NOPE/buy", { body: { units: 1 }, token })) === "404 INVOICE_NOT_FOUND");
    check("a session can't buy as another account", code(await request("POST", "/invoices/NOPE/buy", { body: { units: 1, investorId: process.env.BUYER_ID?.trim() }, token })) === "403 NOT_THE_SESSION_INVESTOR");
    check("a session can name its own account", code(await request("POST", "/invoices/NOPE/buy", { body: { units: 1, investorId: process.env.INVESTOR_ID?.trim() }, token })) === "404 INVOICE_NOT_FOUND");
    check("simulated invoices can't be bought", code(await request("POST", "/invoices/DEMO-RING/buy", { body: { units: 1 }, token })) === "409 SEEDED_INVOICE");

    // buy-report pays through the real x402 client against the fake facilitator.
    const unknown = await request("POST", "/risk/NOPE/buy-report", { token });
    check("buy-report on an unknown invoice is a 404, with nothing settled", code(unknown) === "404 INVOICE_NOT_FOUND" && fake.settleCalls === 0, code(unknown));
    const bought = await request("POST", "/risk/DEMO-HIDDEN/buy-report", { token });
    check("buy-report returns the report and settlement", bought.status === 200 && bought.json.grade === "D" && bought.json.fraudFlags?.includes("SHARED_DIRECTOR") && /^0\.0\.\d+@/.test(bought.json.settlement?.transactionId) && bought.json.replayed === false, JSON.stringify(bought.json).slice(0, 300));
    check("buy-report's payment came from the investor", bought.json.settlement?.payer === process.env.INVESTOR_ID?.trim());
    const settleCalls = fake.settleCalls;
    const again = await request("POST", "/risk/DEMO-HIDDEN/buy-report", { token });
    check("buying the same report again costs nothing", again.status === 200 && again.json.replayed === true && fake.settleCalls === settleCalls && again.json.settlement?.transactionId === bought.json.settlement?.transactionId, `${fake.settleCalls} vs ${settleCalls}`);

    fake.settle = "fail";
    const failed = await request("POST", "/risk/DEMO-ADDRESS/buy-report", { token });
    check("a failed buy-report returns no report", code(failed) === "402 PAYMENT_REFUSED" && failed.json.error.reason === "transaction_failed" && hidesReport(failed.json) && hidesReport(failed.json.error), code(failed));
    resetFake();
  });

  // In their own servers, because agent runs allow 5 tries per 10 minutes.
  const badRules = [
      ["over the report maximum", { ...rules, reportBudget: config.agentMaxReportBudget + 1 }],
      ["over the investment maximum", { ...rules, investmentBudget: config.agentMaxInvestmentBudget + 1 }],
      ["a negative budget", { ...rules, reportBudget: -1 }],
      ["minimum grade D", { ...rules, minGrade: "D" }],
      ["fractional units", { ...rules, maxUnitsPerInvoice: 1.5 }],
      ["a missing rule", { reportBudget: 5, investmentBudget: 1000, minGrade: "B" }],
      ["an unknown rule", { ...rules, budget: 5 }],
  ] as const;
  for (const group of [badRules.slice(0, 4), badRules.slice(4)]) {
    await withServer({}, async () => {
      const token = (await request("POST", "/auth/demo-investor")).json.token as string;
      for (const [label, bad] of group) check(`rules with ${label} are refused`, code(await request("POST", "/agent/run", { body: bad, token })) === "400 VALIDATION_ERROR");
    });
  }

  await withServer({ DEMO_INVESTOR_TOKEN_MINUTES: "0.02" }, async () => {
    const token = (await request("POST", "/auth/demo-investor")).json.token as string;
    check("a short session works at first", code(await request("POST", "/invoices/NOPE/buy", { body: { units: 1 }, token })) === "404 INVOICE_NOT_FOUND");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    check("a session expires", code(await request("POST", "/invoices/NOPE/buy", { body: { units: 1 }, token })) === "401 INVESTOR_TOKEN_EXPIRED");
  });

  await withServer({ INVESTOR_ID: "" }, async () => {
    check("no investor account: no session", code(await request("POST", "/auth/demo-investor")) === "503 INVESTOR_NOT_CONFIGURED");
  });
}

// ---- 4. Limits and the daily cap.
async function checkLimits() {
  const rules = { reportBudget: 5, investmentBudget: 1000, minGrade: "B", maxUnitsPerInvoice: 5 };
  await withServer({ AGENT_DAILY_RUN_CAP: "0" }, async () => {
    const token = (await request("POST", "/auth/demo-investor")).json.token as string;
    const first = await request("POST", "/agent/run", { body: rules, token });
    check("the daily cap refuses a run", code(first) === "429 AGENT_DAILY_CAP_REACHED" && first.json.error.cap === 0 && Boolean(first.json.error.resetsAt) && String(first.json.error.hashscanUrl).startsWith("https://hashscan.io/"), code(first));
    check("a refused run leaves no record", (await request("GET", "/agent/runs")).json.runs.length === 0);
    for (let i = 2; i <= 5; i++) await request("POST", "/agent/run", { body: rules, token });
    check("agent runs are rate limited", code(await request("POST", "/agent/run", { body: rules, token })) === "429 RATE_LIMITED");

    for (let i = 0; i < 10; i++) await request("POST", "/risk/NOPE/buy-report", { token });
    check("buy-report is rate limited", code(await request("POST", "/risk/NOPE/buy-report", { token })) === "429 RATE_LIMITED");

    for (let i = 0; i < 60; i++) await request("GET", "/risk/NOPE/report");
    const limited = await request("GET", "/risk/NOPE/report");
    check("the paid route is rate limited", code(limited) === "429 RATE_LIMITED", code(limited));

    for (let i = 0; i < 29; i++) await request("POST", "/auth/demo-investor");
    check("investor sessions are rate limited", code(await request("POST", "/auth/demo-investor")) === "429 RATE_LIMITED");
  });

  // The cap counts runs saved in the store, so a restart can't reset it.
  const store = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Json;
  const now = new Date();
  const saved = (id: string, startedAt: Date, status: string) => ({ ...newRun({ reportBudget: 1, investmentBudget: 1, minGrade: "A", maxUnitsPerInvoice: 1 }, "0.0.1", startedAt.getTime()), runId: id, status });
  store.agentRuns = [saved("today-1", now, "completed"), saved("today-2", now, "running"), saved("yesterday", new Date(now.getTime() - 86_400_000), "completed")];
  writeFileSync(STORE_PATH, JSON.stringify(store));
  await withServer({ AGENT_DAILY_RUN_CAP: "2" }, async () => {
    const token = (await request("POST", "/auth/demo-investor")).json.token as string;
    check("runs saved earlier today count, yesterday's don't", code(await request("POST", "/agent/run", { body: rules, token })) === "429 AGENT_DAILY_CAP_REACHED");
    const runs = (await request("GET", "/agent/runs")).json;
    check("GET /agent/runs returns saved receipts", runs.runs.length === 3 && String(runs.hashscanUrl).startsWith("https://hashscan.io/"));
    check("a run cut off by a restart is marked as interrupted", runs.runs.find((run: Json) => run.runId === "today-2")?.status === "interrupted");
  });
  check("runsToday counts one UTC day", runsToday(store.agentRuns, now.getTime()) === 2);
}

// ---- 5. The agent's rules, with its outside calls replaced.
const PAY_TO = "0.0.777";
const TOKEN = "0.0.888";
const QUOTE = { amountBaseUnits: 100, feeBaseUnits: 1, totalBaseUnits: 101, asset: TOKEN, payTo: PAY_TO, network: "hedera:testnet", scheme: "exact" };

interface Script {
  listings?: Listing[];
  reports?: Record<string, Partial<{ grade: string; fraudFlags: string[]; anomaly: boolean; riskScore: number }> | Error>;
  quote?: Partial<typeof QUOTE>;
  service?: Partial<{ payTo: string; token: string }>;
  held?: Record<string, number>;
  balance?: number;
  buyError?: Error;
  chargedOnFailure?: number;
  failLogAt?: number;
}

function fakeDeps(script: Script) {
  const calls = { signed: [] as string[], bought: [] as { id: string; units: number }[], logged: [] as Json[] };
  const deps: AgentDeps = {
    now: () => Date.parse("2026-11-06T10:00:00Z"),
    investorId: "0.0.555",
    allowedPayTo: PAY_TO,
    allowedToken: TOKEN,
    discover: async () => ({ url: "http://x/risk/{invoiceId}/report", listings: "http://x/invoices", token: TOKEN, payTo: PAY_TO, network: "hedera:testnet", amountBaseUnits: 100, ...script.service }),
    listings: async () => script.listings ?? [],
    balance: async () => script.balance ?? 10_000_000,
    payForReport: async (url, approve) => {
      const id = decodeURIComponent(url.split("/")[4] ?? "");
      approve({ ...QUOTE, ...script.quote, totalBaseUnits: (script.quote?.amountBaseUnits ?? 100) + Math.floor((script.quote?.amountBaseUnits ?? 100) / 100) });
      const scripted = script.reports?.[id];
      if (scripted instanceof Error) throw scripted;
      calls.signed.push(id);
      return { grade: "A", riskScore: 90, fraudFlags: [], anomaly: false, reasons: [], settlement: { transactionId: `0.0.1@${id}`, hashscanUrl: `https://hashscan.io/testnet/transaction/${id}`, amount: 1, feeToPool: 0.01 }, ...scripted } as never;
    },
    buy: async (id, units) => {
      if (script.buyError) throw script.buyError;
      calls.bought.push({ id, units });
      return { units, unitPrice: 960, amountBaseUnits: units * 96_000, feeBaseUnits: Math.floor((units * 96_000) / 100), paymentHashscanUrl: "https://p", unitsHashscanUrl: "https://u" };
    },
    chargedForFailedBuy: () => script.chargedOnFailure ?? 0,
    heldUnits: (id) => script.held?.[id] ?? 0,
    auditTopic: async () => "0.0.999",
    log: async (_topic, message) => {
      if (script.failLogAt !== undefined && calls.logged.length + 1 >= script.failLogAt) throw new Error("HCS is down");
      calls.logged.push(JSON.parse(message) as Json);
      return { hashscanUrl: "https://hcs", txId: "0.0.1@1.1" };
    },
    persist: () => undefined,
  };
  return { deps, calls };
}

const RULES = { reportBudget: 10, investmentBudget: 10_000, minGrade: "B" as const, maxUnitsPerInvoice: 5 };
const live = (id: string, overrides: Partial<Listing> = {}): Listing => ({ id, status: "tokenized", tokenId: "0.0.5", availableUnits: 100, unitPrice: 960, maturityDate: "2027-01-01T00:00:00Z", ...overrides });
const go = async (rules: typeof RULES | import("../src/types.js").AgentRules, script: Script) => {
  const { deps, calls } = fakeDeps(script);
  const run = await executeRun(newRun(rules, deps.investorId, deps.now()), deps);
  return { run, calls };
};
const skipOf = (run: Json, id: string) => (run.skipped as Json[]).find((entry) => entry.invoiceId === id);

async function checkAgentRules() {
  const scenario = await go(RULES, {
    listings: [
      live("GOOD"),
      { id: "DEMO-RING", seeded: true, status: "risk_checked" },
      live("ODD"),
      live("LOW"),
      live("OLD", { maturityDate: "2026-11-01T00:00:00Z" }),
      live("GONE", { availableUnits: 0 }),
      live("DONE", { status: "repaid" }),
      live("NEW", { status: "submitted" }),
    ],
    reports: { "DEMO-RING": { grade: "D", fraudFlags: ["CIRCULAR_INVOICING"] }, ODD: { grade: "A", anomaly: true }, LOW: { grade: "C" } },
  });
  const { run, calls } = scenario;
  check("a normal run completes", run.status === "completed", `${run.status} ${run.stopReason}`);
  check("it checks only listed invoices", JSON.stringify(run.invoicesChecked) === JSON.stringify(["GOOD", "DEMO-RING", "ODD", "LOW", "OLD", "GONE"]), JSON.stringify(run.invoicesChecked));
  check("it pays for a report on each one that could be bought", JSON.stringify(calls.signed) === JSON.stringify(["GOOD", "DEMO-RING", "ODD", "LOW"]), JSON.stringify(calls.signed));
  check("it buys only the one that passes", calls.bought.length === 1 && calls.bought[0]?.id === "GOOD" && calls.bought[0].units === 5, JSON.stringify(calls.bought));
  check("DEMO-RING is skipped for fraud", skipOf(run, "DEMO-RING")?.code === "FRAUD" && skipOf(run, "DEMO-RING")?.paidForReport === true);
  check("a grade A anomaly is skipped", skipOf(run, "ODD")?.code === "ANOMALY");
  check("a low grade is skipped", skipOf(run, "LOW")?.code === "BELOW_MIN_GRADE");
  check("a matured bond is skipped without paying", skipOf(run, "OLD")?.code === "MATURED" && skipOf(run, "OLD")?.paidForReport === false);
  check("a sold-out invoice is skipped without paying", skipOf(run, "GONE")?.code === "SOLD_OUT" && skipOf(run, "GONE")?.paidForReport === false);
  check("spending includes the fee", run.spentOnReports === 4.04 && run.spentOnUnits === 4848, `${run.spentOnReports}, ${run.spentOnUnits}`);
  check("the receipt has transaction links", run.reports.every((report) => report.hashscanUrl && report.transactionId) && run.links.length >= 5);
  const types = calls.logged.map((message) => message.type);
  check("every payment and decision is logged", types[0] === "run.started" && types.at(-1) === "run.completed" && types.filter((type) => type === "report.paid").length === 4 && types.filter((type) => type === "decision").length === 6 && types.filter((type) => type === "purchase").length === 1, types.join());
  check("log messages fit one HCS message", calls.logged.every((message) => JSON.stringify(message).length < 1024));

  const lenient = await go({ ...RULES, minGrade: "C" }, { listings: [live("ODD")], reports: { ODD: { grade: "A", anomaly: true } } });
  check("anomalies are skipped even at the lowest minimum", skipOf(lenient.run, "ODD")?.code === "ANOMALY" && lenient.calls.bought.length === 0);
  const flaggedLenient = await go({ ...RULES, minGrade: "C" }, { listings: [live("BAD")], reports: { BAD: { grade: "A", fraudFlags: ["SHARED_ADDRESS"] } } });
  check("fraud is skipped whatever the grade", skipOf(flaggedLenient.run, "BAD")?.code === "FRAUD" && flaggedLenient.calls.bought.length === 0);
  const fakeGradeC = await go({ ...RULES, minGrade: "C" }, { listings: [live("C")], reports: { C: { grade: "C" } } });
  check("a minimum of C allows grade C", fakeGradeC.calls.bought.length === 1);
  const gradeD = await go({ ...RULES, minGrade: "C" }, { listings: [live("D")], reports: { D: { grade: "D" } } });
  check("grade D is never bought", skipOf(gradeD.run, "D")?.code === "BELOW_MIN_GRADE");

  const exact = await go({ ...RULES, reportBudget: 2.02 }, { listings: [live("A", { unitPrice: 960 }), live("B"), live("C")] });
  check("a report budget of 2.02 pays for exactly 2 reports", exact.calls.signed.length === 2 && skipOf(exact.run, "C")?.code === "REPORT_BUDGET_EXHAUSTED" && skipOf(exact.run, "C")?.paidForReport === false, JSON.stringify(exact.run.skipped));
  const short = await go({ ...RULES, reportBudget: 2.01 }, { listings: [live("A"), live("B")] });
  check("a report budget of 2.01 pays for 1, because of the fee", short.calls.signed.length === 1 && short.run.spentOnReports === 1.01, String(short.calls.signed.length));

  const nine = await go({ ...RULES, investmentBudget: 9695, maxUnitsPerInvoice: 100 }, { listings: [live("A")] });
  check("₹1 short of 10 units and their fee buys 9", nine.calls.bought[0]?.units === 9, JSON.stringify(nine.calls.bought));
  const ten = await go({ ...RULES, investmentBudget: 9696, maxUnitsPerInvoice: 100 }, { listings: [live("A")] });
  check("the exact cost of 10 units and their fee buys 10", ten.calls.bought[0]?.units === 10, JSON.stringify(ten.calls.bought));
  const none = await go({ ...RULES, investmentBudget: 960 }, { listings: [live("A")] });
  check("a budget that misses the fee on 1 unit buys nothing", skipOf(none.run, "A")?.code === "INVESTMENT_BUDGET_EXHAUSTED" && none.calls.bought.length === 0);
  const shared = await go({ ...RULES, investmentBudget: 2000 }, { listings: [live("A"), live("B")] });
  check("the investment budget carries across invoices", shared.calls.bought.length === 1 && skipOf(shared.run, "B")?.code === "INVESTMENT_BUDGET_EXHAUSTED", JSON.stringify(shared.calls.bought));

  const position = await go({ ...RULES, maxUnitsPerInvoice: 5 }, { listings: [live("A"), live("B")], held: { A: 3, B: 5 } });
  check("the unit limit counts units already held", position.calls.bought[0]?.units === 2 && skipOf(position.run, "B")?.code === "MAX_UNITS_REACHED", JSON.stringify(position.calls.bought));
  const scarce = await go(RULES, { listings: [live("A", { availableUnits: 2 })] });
  check("it never asks for more than are available", scarce.calls.bought[0]?.units === 2);

  const badPayee = await go(RULES, { listings: [live("A")], quote: { payTo: "0.0.666" } });
  check("a quote to another account is refused before signing", badPayee.calls.signed.length === 0 && skipOf(badPayee.run, "A")?.code === "QUOTE_NOT_ALLOWED" && badPayee.run.spentOnReports === 0);
  const badToken = await go(RULES, { listings: [live("A")], quote: { asset: "0.0.123" } });
  check("a quote in another token is refused before signing", badToken.calls.signed.length === 0 && skipOf(badToken.run, "A")?.code === "QUOTE_NOT_ALLOWED");
  const pricey = await go(RULES, { listings: [live("A")], quote: { amountBaseUnits: 201 } });
  check("a price rise past the agent's limit is refused, even with budget left", pricey.calls.signed.length === 0 && skipOf(pricey.run, "A")?.code === "QUOTE_NOT_ALLOWED");
  const wrongService = await go(RULES, { listings: [live("A")], service: { payTo: "0.0.666" } });
  check("a service paying someone else stops the run", wrongService.run.status === "stopped" && wrongService.calls.signed.length === 0);

  const broke = await go(RULES, { listings: [live("A")], balance: 100 });
  check("a balance without the 1% stops the run before paying", broke.run.status === "stopped" && broke.calls.signed.length === 0 && String(broke.run.stopReason).includes("too little"), broke.run.stopReason);

  const logDown = await go(RULES, { listings: [live("A")], failLogAt: 1 });
  check("no audit log at the start means no spending", logDown.run.status === "stopped" && logDown.calls.signed.length === 0 && String(logDown.run.stopReason).includes("audit log"), logDown.run.stopReason);
  const logDownLater = await go(RULES, { listings: [live("A"), live("B")], failLogAt: 2 });
  check("the audit log failing after a payment stops the run", logDownLater.run.status === "stopped" && logDownLater.calls.signed.length === 1 && logDownLater.calls.bought.length === 0 && logDownLater.run.spentOnReports === 1.01, `${logDownLater.calls.signed.length}`);

  const refused = await go(RULES, { listings: [live("A"), live("B")], reports: { A: new ReportCallError("no", 402, "HTTP_402", false) } });
  check("a report refused without charge is skipped, and the run goes on", skipOf(refused.run, "A")?.paidForReport === false && refused.run.status === "completed" && refused.calls.signed.length === 1 && refused.run.spentOnReports === 1.01);
  const unknownCharge = await go(RULES, { listings: [live("A"), live("B")], reports: { A: new ReportCallError("lost", 502, "PAID_REQUEST_FAILED", true) } });
  check("a possible charge is counted, and the run stops", unknownCharge.run.status === "stopped" && unknownCharge.run.spentOnReports === 1.01 && unknownCharge.calls.signed.length === 0, `${unknownCharge.run.spentOnReports}`);

  const buyRefused = await go(RULES, { listings: [live("A"), live("B")], buyError: new ApiError(409, "BOND_PAUSED", "paused") });
  check("a refused purchase is skipped, and the run goes on", skipOf(buyRefused.run, "A")?.code === "BOND_PAUSED" && skipOf(buyRefused.run, "B")?.code === "BOND_PAUSED" && buyRefused.run.status === "completed" && buyRefused.run.spentOnUnits === 0);
  const buyCharged = await go(RULES, { listings: [live("A"), live("B")], buyError: new ApiError(502, "UNITS_PENDING", "stuck"), chargedOnFailure: 484_800 });
  check("a purchase that took the money is counted, and the run stops", buyCharged.run.status === "stopped" && buyCharged.run.spentOnUnits === 4848 && buyCharged.calls.signed.length === 1, `${buyCharged.run.spentOnUnits}`);

  const refusedQuote = new QuoteRefused("x", "Y");
  check("QuoteRefused keeps its code", refusedQuote.code === "Y");
  check("affordableUnits includes the fee", affordableUnits(100, 96_000, 969_600) === 10 && affordableUnits(100, 96_000, 969_599) === 9 && affordableUnits(100, 0, 100) === 0 && affordableUnits(0, 96_000, 969_600) === 0);
  check("purchaseCostBaseUnits rounds the fee down like the chain", purchaseCostBaseUnits(1, 97_041) === 97_041 + 970);

  // Random rules and listings: a budget must never be exceeded, whatever happens.
  let seed = 20261106;
  const random = (max: number) => {
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return seed % max;
  };
  let broken = 0;
  for (let i = 0; i < 300; i++) {
    const rules = { reportBudget: (random(600) + 1) / 100, investmentBudget: random(20_000) + 1, minGrade: (["A", "B", "C"] as const)[random(3)] ?? "C", maxUnitsPerInvoice: random(20) + 1 };
    const listings = Array.from({ length: random(8) }, (_, index) => live(`I${index}`, { availableUnits: random(50) }));
    const reports = Object.fromEntries(listings.map((listing) => [listing.id, { grade: ["A", "B", "C", "D"][random(4)] ?? "A", anomaly: random(5) === 0, fraudFlags: random(5) === 0 ? ["SHARED_ADDRESS"] : [] }]));
    const result = await go(rules, { listings, reports });
    const unitsByInvoice = new Map<string, number>();
    for (const bought of result.calls.bought) unitsByInvoice.set(bought.id, (unitsByInvoice.get(bought.id) ?? 0) + bought.units);
    if (result.run.spentOnReports > rules.reportBudget + 1e-9 || result.run.spentOnUnits > rules.investmentBudget + 1e-9 || [...unitsByInvoice.values()].some((units) => units > rules.maxUnitsPerInvoice)) broken++;
    const badBuys = result.calls.bought.filter((bought) => {
      const facts = reports[bought.id];
      return !facts || facts.anomaly || facts.fraudFlags.length > 0 || facts.grade === "D" || ({ A: 3, B: 2, C: 1 }[facts.grade as "A" | "B" | "C"] ?? 0) < { A: 3, B: 2, C: 1 }[rules.minGrade];
    });
    if (badBuys.length > 0) broken++;
  }
  check("300 random runs never break a budget, a unit limit or a rule", broken === 0, String(broken));
}

try {
  if (!existsSync(REAL_STORE)) throw new Error("backend/data/store.json is missing");
  copyFileSync(REAL_STORE, STORE_PATH);
  await new Promise<void>((resolve) => facilitator.listen(FACILITATOR_PORT, "127.0.0.1", resolve));

  console.log("1. Paywall");
  await withServer({}, checkPaywall);
  console.log("2. No report means no charge");
  await checkNoChargeWithoutReport();
  console.log("3. Investor sessions");
  await checkSessions();
  console.log("4. Limits and the daily cap");
  await checkLimits();
  console.log("5. The agent's rules");
  await checkAgentRules();
} finally {
  facilitator.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
}
console.log(`\n${passes} passed, ${failures} failed. No payment was sent: the facilitator here is fake.`);
process.exit(failures ? 1 : 0);

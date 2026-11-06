/**
 * Tests every API route once against testnet, through a real server process, including forced
 * crashes during repayment. Progress is saved, so a rerun skips finished steps and reuses the bond
 * instead of paying for another deploy.
 *
 * Usage: npm run test:api
 * Stops before spending past BUDGET_HBAR across all runs, because more needs the user's OK.
 *
 * Uses its own store in data/api-test/, separate from the real one. Keys are never printed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BACKEND = fileURLToPath(new URL("../", import.meta.url));
const DATA_DIR = `${BACKEND}data/api-test/`;
process.env.DATA_DIR = DATA_DIR;

const { config } = await import("../src/config.js");
const { getParty } = await import("../src/hedera/client.js");
const { getAccount, mirrorGet, mirrorPages, sleep, waitForMirrorToReach } = await import("../src/hedera/mirror.js");
const { verifyMessage } = await import("../src/hcs.js");
const { TransferTransaction } = await import("@hiero-ledger/sdk");
const { uinrBalance } = await import("../src/uinr.js");

const PORT = 4100;
const BASE = `http://localhost:${PORT}`;
const PROGRESS_PATH = `${DATA_DIR}progress.json`;
const STORE_PATH = `${DATA_DIR}store.json`;
const BUDGET_HBAR = 15;
const INVOICE_AMOUNT = 100_000;
const MATURITY_MINUTES = 7;

interface Progress {
  startHbar?: number;
  invoiceNumber: string;
  invoiceId?: string;
  tokenId?: string;
  symbol?: string;
  investorKycId?: string;
  supplierKycId?: string;
  done: string[];
  results: { step: string; route: string; status: number; outcome: string; hashscanUrl?: string }[];
}

const progress: Progress = existsSync(PROGRESS_PATH)
  ? (JSON.parse(readFileSync(PROGRESS_PATH, "utf8")) as Progress)
  : { invoiceNumber: `API-TEST-${Date.now()}`, done: [], results: [] };
const saveProgress = () => writeFileSync(PROGRESS_PATH, `${JSON.stringify(progress, null, 2)}\n`);

const admin = await getParty("ADMIN");
const business = await getParty("BUSINESS");
const investor = await getParty("INVESTOR");
const buyer = await getParty("BUYER");
const supplier = await getParty("RISK_AGENT");
const repayment = await getParty("REPAYMENT");
const pool = await getParty("POOL");
const payers = [admin, business, investor, buyer, supplier, repayment, pool];

async function totalHbar() {
  let total = 0;
  for (const party of payers) total += ((await getAccount(party.id))?.balance.balance ?? 0) / 1e8;
  return total;
}

/** HBAR moved between these accounts nets out, so a drop in the total is what fees actually cost. */
async function spentHbar() {
  await waitForMirrorToReach();
  return (progress.startHbar ?? 0) - (await totalHbar());
}

async function checkBudget(nextEstimate: number, label: string) {
  const spent = await spentHbar();
  if (spent + nextEstimate > BUDGET_HBAR) {
    throw new Error(`BUDGET STOP before "${label}": spent ${spent.toFixed(2)} HBAR, next step ~${nextEstimate} HBAR, limit ${BUDGET_HBAR}. Needs the user's OK.`);
  }
}

let server: ChildProcess | undefined;
let adminToken: string | undefined;
let investorToken: string | undefined;
/** Only for the test servers started here, so the real passcode in .env isn't needed. */
const TEST_PASSCODE = randomBytes(16).toString("hex");

async function startServer(crashAt?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT), DATA_DIR, DEMO_ADMIN_PASSCODE: TEST_PASSCODE, NAV_SCHEDULER: "off" };
  if (crashAt) env.UDHAAR_CRASH_AT = crashAt;
  else delete env.UDHAAR_CRASH_AT;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: BACKEND, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (text.includes("SIMULATED CRASH")) console.log(`    server: ${text.trim()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text && !text.includes("ExperimentalWarning") && !text.includes("trace-warnings")) console.log(`    server: ${text}`);
  });
  server = child;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await fetch(`${BASE}/health`)).ok;
    } catch {
      await sleep(500);
    }
  }
  if (!up) throw new Error("Server did not start");
  // Each server start makes a new signing key, so earlier tokens stop working.
  const login = await call("POST", "/auth/demo-admin", { passcode: TEST_PASSCODE });
  assert(login.status === 200, `login returned ${login.status}`);
  adminToken = login.json.token;
  const session = await call("POST", "/auth/demo-investor");
  assert(session.status === 200, `investor session returned ${session.status}`);
  investorToken = session.json.token;
}

async function stopServer() {
  const running = server;
  server = undefined;
  if (!running || running.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    running.once("exit", () => resolve());
    running.kill();
  });
}

type Json = Record<string, any>;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      // Buying is the only route here that takes the investor's token rather than the admin's.
      ...(path.endsWith("/buy") && investorToken ? { authorization: `Bearer ${investorToken}` } : adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function report(step: string, route: string, status: number, outcome: string, hashscanUrl?: string) {
  progress.results.push({ step, route, status, outcome, ...(hashscanUrl ? { hashscanUrl } : {}) });
  console.log(`${String(status).padEnd(4)} ${route.padEnd(36)} ${outcome}${hashscanUrl ? `\n     ${hashscanUrl}` : ""}`);
}

async function step(name: string, estimateHbar: number, run: () => Promise<void>) {
  if (progress.done.includes(name)) {
    console.log(`SKIP ${name} (already done)`);
    return;
  }
  if (estimateHbar > 0) await checkBudget(estimateHbar, name);
  console.log(`\n--- ${name}`);
  await run();
  progress.done.push(name);
  saveProgress();
}

async function main() {
  if (progress.startHbar === undefined) {
    await waitForMirrorToReach();
    progress.startHbar = await totalHbar();
    saveProgress();
  }
  console.log(`Budget ${BUDGET_HBAR} HBAR. Spent so far: ${(await spentHbar()).toFixed(4)} HBAR`);
  await startServer();

  const invoicePath = () => `/invoices/${progress.invoiceId}`;
  const tokenPath = () => `/tokens/${progress.tokenId}`;
  const dueDate = new Date(Date.now() + 90 * 86_400_000).toISOString();

  await step("top up buyer", 0.05, async () => {
    const held = await uinrBalance(buyer.id);
    const needed = INVOICE_AMOUNT * 100;
    if (held >= needed) {
      console.log("Buyer already holds enough uINR");
      return;
    }
    const response = await new TransferTransaction()
      .addTokenTransfer(config.uinrTokenId, admin.id, -(needed - held))
      .addTokenTransfer(config.uinrTokenId, buyer.id, needed - held)
      .setTransactionMemo("API test top-up")
      .execute(admin.client);
    const receipt = await response.getReceipt(admin.client);
    console.log(`Treasury sent the buyer ${(needed - held) / 100} uINR: ${receipt.status.toString()}`);
  });

  await step("POST /invoices", 0.35, async () => {
    const { status, json } = await call("POST", "/invoices", { buyerId: buyer.id, amount: INVOICE_AMOUNT, dueDate, invoiceNumber: progress.invoiceNumber, pdfName: "api-test.pdf" });
    assert(status === 201, `POST /invoices returned ${status}: ${JSON.stringify(json)}`);
    progress.invoiceId = json.invoice.id;
    assert(json.invoice.fingerprint?.startsWith("sha256:"), "invoice has a fingerprint");
    assert(json.invoice.status === "submitted", "status is submitted");
    report("create", "POST /invoices", status, `${json.invoice.id} saved, hash recorded on HCS`, json.hashscanUrl);
  });

  await step("POST /invoices duplicate", 0, async () => {
    const { status, json } = await call("POST", "/invoices", { buyerId: buyer.id, amount: INVOICE_AMOUNT, dueDate, invoiceNumber: progress.invoiceNumber, pdfName: "renamed-copy.pdf" });
    assert(status === 409 && json.error?.code === "DUPLICATE_INVOICE", `duplicate returned ${status}: ${JSON.stringify(json)}`);
    assert(json.error.originalId === progress.invoiceId, "duplicate names the original invoice");
    report("duplicate", "POST /invoices (same invoice)", status, `${json.error.code}, original ${json.error.originalId}`, json.error.hashscanUrl);
  });

  await step("POST /confirm", 0.02, async () => {
    const { status, json } = await call("POST", `${invoicePath()}/confirm`);
    assert(status === 200, `confirm returned ${status}: ${JSON.stringify(json)}`);
    assert(json.invoice.status === "buyer_confirmed", "status is buyer_confirmed");
    const confirmation = json.invoice.confirmation;
    assert(verifyMessage(buyer.key.publicKey.toStringRaw(), confirmation.message, confirmation.signature), "buyer signature verifies");
    assert(!verifyMessage(admin.key.publicKey.toStringRaw(), confirmation.message, confirmation.signature), "signature fails against another key");
    report("confirm", "POST /invoices/:id/confirm", status, `buyer signature verified, signed by ${confirmation.signedBy}`, json.hashscanUrl);
  });

  await step("POST /tokenize", 11, async () => {
    const { status, json } = await call("POST", `${invoicePath()}/tokenize`, { maturityMinutes: MATURITY_MINUTES, unitFaceValue: 1000 });
    assert(status === 201, `tokenize returned ${status}: ${JSON.stringify(json)}`);
    progress.tokenId = json.invoice.tokenId;
    progress.symbol = json.invoice.symbol;
    assert(json.invoice.totalUnits === 100, "100 units");
    assert(json.invoice.retainedUnits === 100, "all units with the business");
    const annualRate = ({ A: 12, B: 16, C: 20 } as Record<string, number>)[json.invoice.grade];
    assert(annualRate !== undefined, `grade ${json.invoice.grade} has an annual rate`);
    const daysToDue = Math.ceil((Date.parse(json.invoice.dueDate) - Date.parse(json.invoice.gradedAt)) / 86_400_000);
    assert(Math.abs(json.invoice.discountPct - ((annualRate ?? 0) * daysToDue) / 365) < 0.0001, `discount follows the ${daysToDue} days to the due date, not the ${MATURITY_MINUTES}-minute maturity: ${json.invoice.discountPct}%`);
    report("tokenize", "POST /invoices/:id/tokenize", status, `bond ${json.invoice.tokenId} (${json.invoice.symbol}), 100 units to business, matures ${json.invoice.maturityDate}, grade ${json.invoice.grade}, ${json.invoice.discountPct}% discount`, json.hashscanUrl);
    for (const link of json.links.slice(-4)) console.log(`     ${link.label}: ${link.url}`);
  });

  await step("POST /kyc", 0, async () => {
    const first = await call("POST", "/kyc", { fullName: "Demo Investor", walletAddress: investor.id, country: "IN" });
    assert(first.status === 201 && first.json.request.status === "pending", `kyc returned ${first.status}: ${JSON.stringify(first.json)}`);
    assert(["clean", "warnings", "unavailable"].includes(first.json.request.walletCheck?.status), `the wallet check ran: ${first.json.request.walletCheck?.status}`);
    progress.investorKycId = first.json.request.id;
    const second = await call("POST", "/kyc", { fullName: "Demo Sand Supplier", walletAddress: supplier.id, country: "IN" });
    assert(second.status === 201, `kyc returned ${second.status}`);
    progress.supplierKycId = second.json.request.id;
    report("kyc", "POST /kyc", first.status, `2 requests pending (investor, supplier); wallet check is ${first.json.request.walletCheck?.status}`, first.json.hashscanUrl);
  });

  await step("POST /invoices/:id/buy before KYC", 0, async () => {
    const before = await uinrBalance(investor.id);
    const { status, json } = await call("POST", `${invoicePath()}/buy`, { investorId: investor.id, units: 5 });
    assert(status === 422 && json.error?.code === "NOT_ALLOWLISTED", `buy before KYC returned ${status}: ${JSON.stringify(json)}`);
    assert((await uinrBalance(investor.id)) === before, "no uINR moved");
    report("buy-blocked", "POST /invoices/:id/buy (not approved)", status, `${json.error.code}: rejected before any payment`, json.error.hashscanUrl);
  });

  await step("POST /kyc/:id/approve", 0.5, async () => {
    const investorResult = await call("POST", `/kyc/${progress.investorKycId}/approve`, { confirmWarnings: true });
    assert(investorResult.status === 200 && investorResult.json.request.status === "approved", `approve returned ${investorResult.status}: ${JSON.stringify(investorResult.json)}`);
    assert(investorResult.json.results.length === 1 && investorResult.json.results[0].ok, "added to the live bond");
    const supplierResult = await call("POST", `/kyc/${progress.supplierKycId}/approve`, { confirmWarnings: true });
    assert(supplierResult.status === 200 && supplierResult.json.results[0].ok, `approve returned ${supplierResult.status}`);
    report("approve", "POST /kyc/:id/approve", investorResult.status, "investor and supplier added to every live bond", investorResult.json.hashscanUrl);
  });

  await step("POST /invoices/:id/buy", 1, async () => {
    const before = { investor: await uinrBalance(investor.id), business: await uinrBalance(business.id), pool: await uinrBalance(pool.id) };
    const { status, json } = await call("POST", `${invoicePath()}/buy`, { investorId: investor.id, units: 20, idempotencyKey: "api-test-buy" });
    assert(status === 201, `buy returned ${status}: ${JSON.stringify(json)}`);
    assert(json.invoice.status === "funded", "status is funded");
    const price = Math.round(1000 * (100 - json.invoice.discountPct)) / 100;
    assert(json.purchase.unitPrice === price, `the unit price follows the discount: ₹${json.purchase.unitPrice}`);
    const paid = 20 * Math.round(price * 100);
    const fee = Math.floor(paid / 100);
    await waitForMirrorToReach();
    assert((await uinrBalance(business.id)) - before.business === paid, `business received ${paid / 100} uINR`);
    assert(before.investor - (await uinrBalance(investor.id)) === paid + fee, `investor paid ${(paid + fee) / 100} including the 1% fee`);
    assert((await uinrBalance(pool.id)) - before.pool === fee, `POOL received ${fee / 100} uINR`);
    report("buy", "POST /invoices/:id/buy", status, `20 units at ₹${price}: business +${paid / 100}, POOL +${fee / 100}, investor -${(paid + fee) / 100}`, json.hashscanUrl);
    for (const link of json.links) console.log(`     ${link.label}: ${link.url}`);

    const again = await call("POST", `${invoicePath()}/buy`, { investorId: investor.id, units: 20, idempotencyKey: "api-test-buy" });
    assert(again.status === 201 && again.json.replayed === true, "same idempotency key replays");
    await waitForMirrorToReach();
    assert(before.investor - (await uinrBalance(investor.id)) === paid + fee, "retry did not charge again");
    console.log("     Retry with the same idempotencyKey replayed: no second charge.");
  });

  await step("POST /pay-supplier", 1, async () => {
    const good = await call("POST", `${invoicePath()}/pay-supplier`, { supplierId: supplier.id, units: 10, amount: 10_000 });
    assert(good.status === 201, `pay-supplier returned ${good.status}: ${JSON.stringify(good.json)}`);
    report("supplier", "POST /invoices/:id/pay-supplier", good.status, "10 units to the KYC-approved supplier", good.json.hashscanUrl);

    const bad = await call("POST", `${invoicePath()}/pay-supplier`, { supplierId: buyer.id, units: 5 });
    assert(bad.status === 422 && bad.json.error?.code === "SUPPLIER_NOT_VERIFIED", `unverified returned ${bad.status}: ${JSON.stringify(bad.json)}`);
    assert(bad.json.error.reason.startsWith("AccountIsBlocked"), "the token itself rejected it");
    report("supplier-rejected", "POST /invoices/:id/pay-supplier (unverified)", bad.status, `${bad.json.error.code}: ${bad.json.error.reason}`, bad.json.error.hashscanUrl);
  });

  await step("POST /tokens pause", 0.5, async () => {
    const paused = await call("POST", `${tokenPath()}/pause`);
    assert(paused.status === 200 && paused.json.paused === true, `pause returned ${paused.status}: ${JSON.stringify(paused.json)}`);
    report("pause", "POST /tokens/:id/pause", paused.status, "paused", paused.json.hashscanUrl);

    const before = await uinrBalance(investor.id);
    const blocked = await call("POST", `${invoicePath()}/buy`, { investorId: investor.id, units: 1 });
    assert(blocked.status === 409 && blocked.json.error?.code === "BOND_PAUSED", `buy while paused returned ${blocked.status}: ${JSON.stringify(blocked.json)}`);
    assert((await uinrBalance(investor.id)) === before, "no uINR moved");
    report("pause-effect", "POST /invoices/:id/buy (while paused)", blocked.status, `${blocked.json.error.code}: no money moved`, blocked.json.error.hashscanUrl);

    const unpaused = await call("POST", `${tokenPath()}/unpause`);
    assert(unpaused.status === 200 && unpaused.json.paused === false, `unpause returned ${unpaused.status}: ${JSON.stringify(unpaused.json)}`);
    report("unpause", "POST /tokens/:id/unpause", unpaused.status, "unpaused", unpaused.json.hashscanUrl);
  });

  await step("POST /tokens freeze", 0.5, async () => {
    const frozen = await call("POST", `${tokenPath()}/freeze`, { accountId: investor.id, units: 5 });
    assert(frozen.status === 200 && frozen.json.frozenUnits === 5 && frozen.json.freeUnits === 15, `freeze returned ${frozen.status}: ${JSON.stringify(frozen.json)}`);
    report("freeze", "POST /tokens/:id/freeze", frozen.status, "froze 5 of the investor's 20 units", frozen.json.hashscanUrl);

    const holders = await call("GET", `${invoicePath()}/holders`);
    const row = holders.json.holders.find((holder: Json) => holder.accountId === investor.id);
    assert(row.frozen === true && row.frozenUnits === 5 && row.units === 20, `holder row is wrong: ${JSON.stringify(row)}`);

    const repayBlocked = await call("POST", `${invoicePath()}/repay`);
    assert(repayBlocked.status === 409, `repay while frozen returned ${repayBlocked.status}`);
    console.log(`     Repay during the freeze refused: ${repayBlocked.json.error.code}`);

    const unfrozen = await call("POST", `${tokenPath()}/unfreeze`, { accountId: investor.id });
    assert(unfrozen.status === 200 && unfrozen.json.frozenUnits === 0 && unfrozen.json.freeUnits === 20, `unfreeze returned ${unfrozen.status}: ${JSON.stringify(unfrozen.json)}`);
    report("unfreeze", "POST /tokens/:id/unfreeze", unfrozen.status, "all 20 units free again", unfrozen.json.hashscanUrl);
  });

  await step("GET routes", 0, async () => {
    const routes: [string, string, (json: Json) => string][] = [
      ["/invoices", "GET /invoices", (json) => `${json.invoices.length} invoice(s), status ${json.invoices[0]?.status}`],
      [invoicePath(), "GET /invoices/:id", (json) => `${json.invoice.links.length} links, ${json.invoice.availableUnits} units available`],
      [`${invoicePath()}/holders`, "GET /invoices/:id/holders", (json) => json.holders.map((holder: Json) => `${holder.name} ${holder.units}`).join(", ")],
      ["/kyc", "GET /kyc", (json) => `${json.requests.length} request(s), all ${json.requests[0]?.status}`],
      ["/tokens", "GET /tokens", (json) => `${json.tokens.length} token(s), paused ${json.tokens[0]?.paused}`],
      ["/balances", "GET /balances", (json) => `${json.accounts.length} accounts`],
      ["/audit", "GET /audit", (json) => `${json.entries.length} entries`],
      ["/health", "GET /health", (json) => json.status],
    ];
    for (const [path, label, summarize] of routes) {
      const { status, json } = await call("GET", path);
      assert(status === 200, `${label} returned ${status}: ${JSON.stringify(json)}`);
      assert(typeof json.hashscanUrl === "string" && json.hashscanUrl.startsWith(config.hashscanUrl), `${label} includes a HashScan link`);
      report("get", label, status, summarize(json), json.hashscanUrl);
    }
    const { json } = await call("GET", "/audit");
    assert(json.entries.every((entry: Json) => entry.hashscanUrl?.startsWith(config.hashscanUrl)), "every audit entry has a HashScan link");
    const raw = readFileSync(STORE_PATH, "utf8");
    for (const party of payers) {
      assert(!raw.includes(party.key.toStringRaw()), `the store must not contain ${party.name}'s key`);
    }
    console.log("     Store checked: contains no private keys.");
  });

  await step("POST /repay before maturity", 0, async () => {
    const matured = await call("GET", invoicePath());
    if (new Date(matured.json.invoice.maturityDate).getTime() <= Date.now()) {
      console.log("Already matured, so this check cannot run now.");
      return;
    }
    const before = await uinrBalance(buyer.id);
    const { status, json } = await call("POST", `${invoicePath()}/repay`);
    assert(status === 409 && json.error?.code === "NOT_MATURED", `repay before maturity returned ${status}: ${JSON.stringify(json)}`);
    assert((await uinrBalance(buyer.id)) === before, "buyer was not charged");
    report("repay-early", "POST /invoices/:id/repay (too early)", status, `${json.error.code}: buyer not charged`, json.error.hashscanUrl);
  });

  const { json: current } = await call("GET", invoicePath());
  const maturityMs = new Date(current.invoice.maturityDate).getTime();
  if (Date.now() < maturityMs + 5_000 && !progress.done.includes("repay complete")) {
    const waitMs = maturityMs + 5_000 - Date.now();
    console.log(`\nWaiting ${Math.ceil(waitMs / 1000)}s for the bond to mature...`);
    await sleep(waitMs);
  }

  /** Runs repay until the forced crash. A crash shows up as a dropped connection. */
  async function repayExpectingCrash(crashAt: string) {
    await stopServer();
    await startServer(crashAt);
    let crashed = false;
    try {
      const response = await call("POST", `${invoicePath()}/repay`);
      console.log(`     Unexpected response ${response.status}: ${JSON.stringify(response.json).slice(0, 300)}`);
    } catch {
      crashed = true;
    }
    assert(crashed, `the server should have crashed at ${crashAt}`);
    await stopServer();
    const store = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Json;
    const holders = (store.invoices[progress.invoiceId ?? ""].repayment?.holders ?? []) as Json[];
    console.log(`     After crash at ${crashAt}: ${holders.map((holder) => `${holder.name}[burned=${holder.burned} paid=${holder.paid}]`).join(" ")}`);
    return holders;
  }

  await step("repay crash 1: right after sending the first burn", 0.3, async () => {
    const holders = await repayExpectingCrash("burn-sent");
    assert(holders.length === 3, "snapshot saved with 3 holders before the first burn");
    assert(holders.every((holder) => !holder.burned && !holder.paid), "nothing is recorded yet");
  });
  await step("repay crash 2: burn recorded, before paying", 0, async () => {
    const holders = await repayExpectingCrash("burned-recorded");
    assert(holders[0]?.burned === true && holders[0]?.paid === false, "first holder is burned and unpaid");
  });
  await step("repay crash 3: right after sending the first payout", 0.05, async () => {
    const holders = await repayExpectingCrash("payout-sent");
    assert(holders[0]?.burned === true && holders[0]?.paid === false, "first payout sent but not recorded");
  });
  await step("repay crash 4: right after sending the second payout", 0.3, async () => {
    const holders = await repayExpectingCrash("payout-sent");
    assert(holders[0]?.paid === true, "first payout was recovered, not resent");
    assert(holders[1]?.burned === true && holders[1]?.paid === false, "second payout sent but not recorded");
  });

  await step("delete the second payout's record", 0, async () => {
    await stopServer();
    const store = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Json;
    const second = store.invoices[progress.invoiceId ?? ""].repayment.holders[1] as Json;
    const key = `${progress.symbol}:payout:${second.accountId}`;
    assert(store.ledger[key], "the intent exists before deleting");
    delete store.ledger[key];
    writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
    console.log(`     Deleted the ledger entry for ${second.name}'s payout, simulating a lost record.`);
  });

  await step("repay complete", 1.05, async () => {
    await stopServer();
    await startServer();
    const { status, json } = await call("POST", `${invoicePath()}/repay`);
    assert(status === 200, `repay returned ${status}: ${JSON.stringify(json)}`);
    assert(json.invoice.status === "repaid", "status is repaid");
    assert(json.repayment.holders.every((holder: Json) => holder.burned && holder.paid), "all burned and paid");
    report("repay", "POST /invoices/:id/repay", status, `repaid: ${json.repayment.holders.map((holder: Json) => `${holder.name} ${holder.amountBaseUnits / 100}`).join(", ")} uINR`, json.hashscanUrl);
    for (const link of json.links) console.log(`     ${link.label}: ${link.url}`);
  });

  await step("repay again", 0, async () => {
    await waitForMirrorToReach();
    const before = await uinrBalance(repayment.id);
    const { status, json } = await call("POST", `${invoicePath()}/repay`);
    assert(status === 200 && json.repayment.status === "complete", `second repay returned ${status}`);
    await waitForMirrorToReach();
    assert((await uinrBalance(repayment.id)) === before, "nothing moved");
    report("repay-again", "POST /invoices/:id/repay (again)", status, "already complete: nothing sent", json.hashscanUrl);
  });

  await step("verify payouts from chain history", 0, async () => {
    const memo = `${progress.symbol} payout`;
    const created = await mirrorGet<{ created_timestamp: string }>(`/tokens/${config.uinrTokenId}`);
    const payouts: { to: string; amount: number }[] = [];
    const path = `/transactions?account.id=${repayment.id}&transactiontype=cryptotransfer&result=success&order=asc&limit=100&timestamp=gte:${created?.created_timestamp}`;
    for await (const transaction of mirrorPages<Json>(path, "transactions")) {
      if (Buffer.from(transaction.memo_base64 ?? "", "base64").toString("utf8") !== memo) continue;
      for (const move of transaction.token_transfers ?? []) {
        if (move.token_id === config.uinrTokenId && move.account !== repayment.id) payouts.push({ to: move.account, amount: move.amount / 100 });
      }
    }
    console.log(`     Payouts on chain with memo "${memo}":`);
    for (const payout of payouts) console.log(`       ${payout.to}: ${payout.amount} uINR`);
    assert(new Set(payouts.map((payout) => payout.to)).size === payouts.length, "no account was paid twice");
    assert(payouts.length === 3, "exactly 3 payouts");
    assert(payouts.reduce((sum, payout) => sum + payout.amount, 0) === INVOICE_AMOUNT, "payouts total the invoice amount");
    console.log(`     Exactly one payout per holder, totalling ${INVOICE_AMOUNT} uINR.`);
  });

  const balances = await call("GET", "/balances");
  console.log("\nFinal balances (uINR, HBAR):");
  for (const account of balances.json.accounts) console.log(`  ${String(account.name).padEnd(12)} ${account.accountId.padEnd(15)} ${String(account.uinr).padStart(12)} ${account.hbar.toFixed(4).padStart(12)}`);
  console.log(`\nTotal spent across runs: ${(await spentHbar()).toFixed(4)} HBAR. All steps passed.`);
}

try {
  await main();
} catch (error) {
  saveProgress();
  console.error(`\nFAILED: ${error instanceof Error ? error.message : "Unknown error"}`);
  console.log(`Spent so far: ${(await spentHbar()).toFixed(4)} HBAR. Rerun to resume from this step.`);
  process.exitCode = 1;
} finally {
  saveProgress();
  await stopServer();
  process.exit(process.exitCode ?? 0);
}

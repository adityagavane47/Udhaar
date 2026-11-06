/**
 * The x402 flow on Hedera testnet, through the real facilitator: an unpaid call, a paid call, the
 * buy-report route and one full agent run. Spends real test uINR and a little HBAR, and buys real units.
 *
 * Uses the real store, so its record matches the chain afterwards. Stop your own server first:
 * the script refuses to run if one is answering on port 4000, because two would overwrite each other.
 *
 * Usage: npm run test:x402:live
 * Stops before starting if the account balances are too low. Keys are never printed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config, hashscan } from "../src/config.js";
import { allParties, getParty } from "../src/hedera/client.js";
import { getAccount, sleep, waitForMirrorToReach } from "../src/hedera/mirror.js";
import { uinrBalance } from "../src/uinr.js";

type Json = Record<string, any>;

const BACKEND = fileURLToPath(new URL("../", import.meta.url));
const PORT = 4104;
const BASE = `http://127.0.0.1:${PORT}`;
/** Your limit for any step is 15 HBAR. This whole script should cost far less, so it stops above this. */
const HBAR_LIMIT = 5;
const REPORT_INVOICE = process.argv[2] ?? "INV-0004";
const BUY_REPORT_INVOICE = process.argv[3] ?? "DEMO-LATE";
const RULES = { reportBudget: 5, investmentBudget: 5000, minGrade: "B", maxUnitsPerInvoice: 110 };

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}${!condition && detail ? `: ${detail}` : ""}`);
  if (!condition) failures++;
}

async function request(method: string, path: string, options: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as Json, headers: response.headers };
}

async function totalHbar() {
  let total = 0;
  for (const party of await allParties()) total += ((await getAccount(party.id))?.balance.balance ?? 0) / 1e8;
  return total;
}

async function main() {
  const alreadyRunning = await fetch("http://127.0.0.1:4000/health").then((response) => response.ok).catch(() => false);
  if (alreadyRunning) throw new Error("A server is answering on port 4000. Stop it first, because two servers on one store overwrite each other");

  const investor = await getParty("INVESTOR");
  const risk = await getParty("RISK_AGENT");
  const pool = await getParty("POOL");
  const balances = async () => ({ investor: await uinrBalance(investor.id), risk: await uinrBalance(risk.id), pool: await uinrBalance(pool.id) });

  const startHbar = await totalHbar();
  const start = await balances();
  console.log(`Start: ${startHbar.toFixed(4)} HBAR across all accounts. Investor ${start.investor / 100} uINR, risk agent ${start.risk / 100}, POOL ${start.pool / 100}. Facilitator: ${config.facilitatorUrl}`);

  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: BACKEND, env: { ...process.env, PORT: String(PORT), SELF_URL: BASE, X402_CONFIRM_ATTEMPTS: "15" }, stdio: ["ignore", "ignore", "inherit"] });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await fetch(`${BASE}/health`).then((response) => response.ok).catch(() => false);
      if (!up) await sleep(500);
    }
    if (!up) throw new Error("The server did not start");

    console.log("\n1. Unpaid call");
    const unpaid = await request("GET", `/risk/${REPORT_INVOICE}/report`);
    check("returns 402", unpaid.status === 402, String(unpaid.status));
    check("hides the report", !("grade" in unpaid.json) && !("riskScore" in unpaid.json));
    console.log(JSON.stringify(unpaid.json.payment, null, 2));

    console.log("\n2. Paid call, signed by the investor and settled by the facilitator");
    const { payForReport } = await import("../src/x402/client.js");
    const paidStart = Date.now();
    const paid = await payForReport<Json>(`${BASE}/risk/${REPORT_INVOICE}/report`, investor, () => undefined);
    check("returns the report", paid.riskScore > 0 && Boolean(paid.grade) && Boolean(paid.graph), JSON.stringify(paid).slice(0, 200));
    check("settled and confirmed on-chain", paid.settlement.onChainConfirmed === true, JSON.stringify(paid.settlement));
    check("the 1% went to POOL", paid.settlement.feeToPool === 0.01, String(paid.settlement.feeToPool));
    console.log(`${REPORT_INVOICE}: grade ${paid.grade}, score ${paid.riskScore}, in ${((Date.now() - paidStart) / 1000).toFixed(1)}s`);
    console.log(`Settled transaction: ${paid.settlement.transactionId}\n${paid.settlement.hashscanUrl}`);

    await waitForMirrorToReach();
    const afterPaid = await balances();
    check("investor paid 1.01 uINR", start.investor - afterPaid.investor === 101, String(start.investor - afterPaid.investor));
    check("risk agent received 1.00 uINR", afterPaid.risk - start.risk === 100, String(afterPaid.risk - start.risk));
    check("POOL received 0.01 uINR", afterPaid.pool - start.pool === 1, String(afterPaid.pool - start.pool));

    console.log("\n3. Investor session and buy-report");
    const session = await request("POST", "/auth/demo-investor");
    const token = session.json.token as string;
    check("a session needs no passcode", session.status === 200 && Boolean(token), String(session.status));
    check("buy-report needs the session", (await request("POST", `/risk/${BUY_REPORT_INVOICE}/buy-report`)).status === 401);
    const bought = await request("POST", `/risk/${BUY_REPORT_INVOICE}/buy-report`, { token });
    check("buy-report returns the report and settlement", bought.status === 200 && Boolean(bought.json.grade) && Boolean(bought.json.settlement?.transactionId), JSON.stringify(bought.json).slice(0, 300));
    console.log(`${BUY_REPORT_INVOICE}: grade ${bought.json.grade}, replayed ${bought.json.replayed}\nSettled transaction: ${bought.json.settlement?.transactionId}\n${bought.json.settlement?.hashscanUrl}`);

    console.log("\n4. Full agent run, with no person involved after this request");
    const runStart = Date.now();
    const reply = await request("POST", "/agent/run", { body: RULES, token });
    const run = reply.json;
    check("the run returns a receipt", reply.status === 201 && Boolean(run.runId), JSON.stringify(run).slice(0, 400));
    check("the run completed", run.status === "completed", `${run.status}: ${run.stopReason}`);
    check("it paid for at least 2 reports", run.reports?.length >= 2, String(run.reports?.length));
    check("it bought at least once", run.purchases?.length >= 1, String(run.purchases?.length));
    const ring = (run.skipped as Json[])?.find((entry) => entry.invoiceId === "DEMO-RING");
    check("it skipped DEMO-RING for fraud", ring?.code === "FRAUD", JSON.stringify(ring));
    check("it stayed within its report budget", run.spentOnReports <= RULES.reportBudget, String(run.spentOnReports));
    check("it stayed within its investment budget", run.spentOnUnits <= RULES.investmentBudget, String(run.spentOnUnits));
    console.log(`Took ${((Date.now() - runStart) / 1000).toFixed(0)}s. Rules: ${JSON.stringify(RULES)}`);
    console.log(`Checked: ${(run.invoicesChecked as string[]).join(", ")}`);
    console.log(`Reports (${run.spentOnReports} uINR):`);
    for (const report of run.reports as Json[]) console.log(`  ${report.invoiceId}: grade ${report.grade}, score ${report.riskScore}, flags ${report.fraudFlags.join(",") || "none"}, anomaly ${report.anomaly}\n    ${report.transactionId}\n    ${report.hashscanUrl}`);
    console.log(`Purchases (${run.spentOnUnits} uINR):`);
    for (const purchase of run.purchases as Json[]) console.log(`  ${purchase.invoiceId}: ${purchase.units} units at ₹${purchase.unitPrice}, ₹${purchase.amount} + ₹${purchase.feeToPool} fee\n    Payment: ${purchase.paymentHashscanUrl}\n    Units: ${purchase.unitsHashscanUrl}`);
    console.log("Skipped:");
    for (const skip of run.skipped as Json[]) console.log(`  ${skip.invoiceId}: ${skip.code}${skip.paidForReport ? " (after paying for its report)" : " (no report bought)"}. ${skip.reason}`);
    console.log(`Audit log: ${hashscan.topic(run.auditTopicId)} (${run.auditMessages.length} messages)`);
    for (const message of run.auditMessages as Json[]) console.log(`  ${message.type}: ${message.hashscanUrl}`);

    const listed = await request("GET", "/agent/runs");
    check("GET /agent/runs shows the run", listed.json.runs?.[0]?.runId === run.runId);
    const audit = (await request("GET", "/audit")).json.entries as Json[];
    check("the local audit log shows the run and payments", audit.some((entry) => entry.type === "agent_run") && audit.some((entry) => entry.type === "report_paid"));

    await waitForMirrorToReach();
    const end = await balances();
    const endHbar = await totalHbar();
    const spent = startHbar - endHbar;
    check(`under ${HBAR_LIMIT} HBAR in total`, spent < HBAR_LIMIT, spent.toFixed(4));
    console.log(`\nEnd: ${endHbar.toFixed(4)} HBAR (${spent.toFixed(4)} spent). Investor ${end.investor / 100} uINR, risk agent ${end.risk / 100}, POOL ${end.pool / 100}.`);
  } finally {
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      });
    }
  }
}

try {
  await main();
} catch (error) {
  failures++;
  console.log(`STOPPED: ${error instanceof Error ? error.message : "unknown error"}`);
}
console.log(`\n${failures === 0 ? "All live checks passed." : `${failures} failed.`}`);
process.exit(failures ? 1 : 0);

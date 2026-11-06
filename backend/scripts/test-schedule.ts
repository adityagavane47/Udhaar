/**
 * Tests the scheduled repayment logic: when a schedule may be created, how the outcome is read from
 * the chain (executed, failed, deleted, never ran), and that manual repay waits for a schedule that
 * is due instead of paying twice.
 *
 * Spends no HBAR and writes nothing to the chain. The store is a temporary directory and the
 * schedule history is a stand-in, so any outcome can be tested. The live run on testnet (create,
 * execute at maturity, burn, payout) is a separate one-off, reported in the README's proof table.
 *
 * Usage: npm run test:schedule
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = `${mkdtempSync(join(tmpdir(), "udhaar-schedule-"))}/`;

let passes = 0;
let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) passes++;
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const { EXECUTION_GRACE_SECONDS, MAX_SCHEDULE_SECONDS, MIN_SCHEDULE_SECONDS, ensureRepaymentSchedule, scheduleEligibility, settleSchedule } = await import("../src/schedule.js");
const { repayInvoice } = await import("../src/repayment.js");
const { invoiceView } = await import("../src/invoices.js");
const { state } = await import("../src/store.js");
type Invoice = import("../src/types.js").Invoice;
type ScheduleReader = import("../src/schedule.js").ScheduleReader;

const NOW = Date.now();
const unix = (ms: number) => Math.floor(ms / 1000);
const DAY = 86_400;

function invoice(id: string, maturityInSeconds: number, over: Partial<Invoice> = {}): Invoice {
  const value = {
    id, supplierId: "0.0.1001", supplierName: "Seller", buyerId: "0.0.1002", buyerName: "Buyer", amount: 10_000,
    issueDate: new Date(NOW).toISOString(), dueDate: new Date(NOW + 30 * DAY * 1000).toISOString(), status: "tokenized", fingerprint: `sha256:${id}`, registered: true, links: [], amountPaidBy: {},
    tokenization: { status: "complete", symbol: `SYM-${id}`, isin: "X", name: "x", units: 10, unitFaceValue: 1000, discountPct: 3, startingDateUnix: unix(NOW), maturityDateUnix: unix(NOW) + maturityInSeconds, bond: { contractId: "0.0.1", evmAddress: "0x1", symbol: `SYM-${id}` } },
    ...over,
  } as unknown as Invoice;
  state.invoices[id] = value;
  return value;
}

console.log("When a schedule may be created");
check("the limit is under the network's 62 days and over 60", MAX_SCHEDULE_SECONDS < 62 * DAY && MAX_SCHEDULE_SECONDS > 60 * DAY, String(MAX_SCHEDULE_SECONDS));
check("a bond maturing in 30 days is eligible", scheduleEligibility(invoice("A", 30 * DAY), NOW).ok === true);
check("a bond maturing in 5 minutes is eligible", scheduleEligibility(invoice("B", 300), NOW).ok === true);
const far = scheduleEligibility(invoice("C", 90 * DAY), NOW);
check("a bond maturing in 90 days waits for the periodic check", !far.ok && far.reason === "too_far");
const edge = scheduleEligibility(invoice("C2", MAX_SCHEDULE_SECONDS - 60), NOW);
check("a bond just inside the limit is eligible", edge.ok === true);
check("a bond past the limit by a minute is not", scheduleEligibility(invoice("C3", MAX_SCHEDULE_SECONDS + 60), NOW).ok === false);
const late = scheduleEligibility(invoice("D", 90 * DAY), NOW + 40 * DAY * 1000);
check("the same bond becomes eligible once maturity is within the limit", late.ok === true);
const matured = scheduleEligibility(invoice("E", -10), NOW);
check("a matured bond is not scheduled", !matured.ok && matured.reason === "matured");
const soon = scheduleEligibility(invoice("F", MIN_SCHEDULE_SECONDS - 5), NOW);
check("a bond maturing in seconds is left to manual repay", !soon.ok && soon.reason === "too_soon");
const noBond = scheduleEligibility(invoice("G", 300, { tokenization: undefined }), NOW);
check("an untokenized invoice is not scheduled", !noBond.ok && noBond.reason === "no_bond");
const repaid = scheduleEligibility(invoice("H", 300, { status: "repaid" }), NOW);
check("a repaid invoice is not scheduled", !repaid.ok && repaid.reason === "already_repaid");
const existing = invoice("I", 300, { schedule: { status: "scheduled", scheduleId: "0.0.7", createTxId: "t", createHashscanUrl: "u", hashscanUrl: "u", expiresAtUnix: unix(NOW) + 300, amountBaseUnits: 1_000_000, memo: "m", createdAt: "x" } });
check("an invoice with a schedule gets no second one", (scheduleEligibility(existing, NOW) as { reason?: string }).reason === "already_scheduled");
check("ensureRepaymentSchedule sends nothing for an ineligible invoice", (await ensureRepaymentSchedule(invoice("J", 90 * DAY), NOW)) === undefined && invoice("J2", 90 * DAY).schedule === undefined);

console.log("Reading the outcome from the chain");
const expiry = unix(NOW) - 30;
const pending = (id: string): Invoice =>
  invoice(id, -30, { schedule: { status: "scheduled", scheduleId: "0.0.99999999", createTxId: "t", createHashscanUrl: "https://c", hashscanUrl: "https://s", expiresAtUnix: expiry, amountBaseUnits: 1_000_000, memo: "m", createdAt: "x" } });
const reader = (schedule: { executedTimestamp: string | null; deleted: boolean } | undefined, ran?: { result: string }): ScheduleReader => ({
  schedule: async () => schedule,
  executed: async () => (ran ? { transactionId: "0.0.1002-1-1", consensusTimestamp: `${expiry + 1}.000000001`, result: ran.result } : undefined),
});

const early = invoice("K", 300, { schedule: { ...existing.schedule!, expiresAtUnix: unix(NOW) + 300 } });
check("nothing changes before the expiry", (await settleSchedule(early, reader({ executedTimestamp: "1.1", deleted: false }, { result: "SUCCESS" }), NOW)) === false && early.schedule?.status === "scheduled");

const ok = pending("L");
check("a schedule that ran is recorded as executed", (await settleSchedule(ok, reader({ executedTimestamp: `${expiry + 1}.000000001`, deleted: false }, { result: "SUCCESS" }), NOW)) === true && ok.schedule?.status === "executed");
check("it keeps the execution's transaction link", Boolean(ok.schedule?.executedTxId && ok.schedule.executedHashscanUrl?.includes("/transaction/")), ok.schedule?.executedHashscanUrl);
check("it is written to the audit log", state.audit.some((entry) => entry.type === "scheduled_repayment" && entry.invoiceId === "L" && entry.status === "success"));
check("settling again changes nothing", (await settleSchedule(ok, reader(undefined), NOW)) === false);

const bad = pending("M");
check("a scheduled transfer that failed is recorded as failed", (await settleSchedule(bad, reader({ executedTimestamp: null, deleted: false }, { result: "INSUFFICIENT_TOKEN_BALANCE" }), NOW)) === true && bad.schedule?.status === "failed");
check("the reason names the result", /INSUFFICIENT_TOKEN_BALANCE/.test(bad.schedule?.failureReason ?? ""), bad.schedule?.failureReason);
check("a failure is audited as rejected", state.audit.some((entry) => entry.invoiceId === "M" && entry.type === "scheduled_repayment" && entry.status === "rejected"));

const gone = pending("N");
check("a deleted schedule is a failure", (await settleSchedule(gone, reader({ executedTimestamp: null, deleted: true }), NOW)) === true && gone.schedule?.status === "failed" && /deleted/.test(gone.schedule.failureReason ?? ""));

const waiting = pending("O");
check("a schedule that has not run yet stays scheduled during the grace period", (await settleSchedule(waiting, reader({ executedTimestamp: null, deleted: false }), NOW)) === false && waiting.schedule?.status === "scheduled");
check("after the grace period with no run it counts as failed", (await settleSchedule(waiting, reader({ executedTimestamp: null, deleted: false }), NOW + (EXECUTION_GRACE_SECONDS + 60) * 1000)) === true && waiting.schedule?.status === "failed");
const neverSeen = pending("P");
check("a schedule the mirror node does not know also fails after the grace period", (await settleSchedule(neverSeen, reader(undefined), NOW + (EXECUTION_GRACE_SECONDS + 60) * 1000)) === true && neverSeen.schedule?.status === "failed");

console.log("Manual repay stays available");
const due = pending("Q");
due.tokenization!.maturityDateUnix = unix(NOW) - 30;
let blocked: { code?: string } = {};
try {
  await repayInvoice(due);
} catch (error) {
  blocked = error as { code?: string };
}
check("manual repay waits while a due schedule has not been recorded", blocked.code === "SCHEDULED_REPAYMENT_PENDING", String(blocked.code));
check("the failed schedule's view tells the portals so", invoiceView(bad).schedule?.status === "failed" && Boolean(invoiceView(bad).schedule?.failureReason));
check("a failed schedule does not make the invoice 'repaid' or stop manual repay", bad.status === "tokenized" && bad.repayment === undefined);

console.log(`\n${passes} passed, ${failures} failed`);
setTimeout(() => process.exit(failures ? 1 : 0), 200);

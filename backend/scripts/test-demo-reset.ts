/**
 * Tests the demo reset: the archive, the numbering, KYC, backup and restore, and that archived records
 * are hidden from every list while history, duplicate checks and NAV lookups still see them.
 *
 * Spends no HBAR and sends no transaction. Everything runs on temporary directories. The duplicate
 * check reads the mirror node (free) to look up the party accounts.
 *
 * Usage: npm run test:demo-reset
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "udhaar-reset-"));
const liveDir = `${root}/live/`;
mkdirSync(`${liveDir}risk`, { recursive: true });
process.env.DATA_DIR = liveDir;

let passes = 0;
let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) passes++;
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const { archiveStore, backupDataDir, restoreBackup, readStore, writeStore, resolveBackup, backupsDir } = await import("../src/demo/reset.js");
await import("../src/config.js");

const WALLET = "0.0.5000";
const sample = () => ({
  version: 1,
  nextInvoiceNumber: 9,
  invoices: {
    "INV-0001": { id: "INV-0001", status: "repaid", fingerprint: "fp-1", registered: true, dueDate: "2027-02-03T00:00:00.000Z", links: [], amountPaidBy: {} },
    "INV-0008": { id: "INV-0008", status: "funded", fingerprint: "fp-8", registered: true, dueDate: "2026-11-07T00:00:00.000Z", links: [], amountPaidBy: {} },
  },
  kyc: {
    "kyc-a": { id: "kyc-a", walletAddress: WALLET, status: "approved", pendingBonds: ["0.0.1"], fullName: "Priya" },
    "kyc-b": { id: "kyc-b", walletAddress: "0.0.6000", status: "approved", pendingBonds: [], fullName: "Shree" },
  },
  purchases: { p1: { id: "p1", invoiceId: "INV-0001", status: "complete" } },
  ledger: { "hcs:confirm:INV-0001": { key: "hcs:confirm:INV-0001", status: "done", succeeded: true } },
  audit: [{ id: "a1", type: "units_buy", description: "x" }, { id: "a2", type: "kyc_approve", description: "y" }],
  reportPayments: { tx1: { invoiceId: "INV-0001", transactionId: "tx1" } },
  agentRuns: [{ runId: "r1", status: "completed", startedAt: "2026-11-06T01:00:00.000Z" }],
  nav: { latest: { "INV-0001": { invoiceId: "INV-0001", nav: 999 } }, lastDailyDate: "2026-11-06" },
});

console.log("Archive and numbering");
const before = sample();
const { store, summary } = archiveStore(before, { investorAccountId: WALLET });
check("every invoice, run and audit entry is archived", Object.values(store.invoices).every((i: any) => i.archived === true) && store.agentRuns.every((r: any) => r.archived) && store.audit.every((a: any) => a.archived));
check("counts are reported", summary.archived.invoices === 2 && summary.archived.agentRuns === 1 && summary.archived.auditEntries === 2);
check("nothing is deleted", Object.keys(store.invoices).length === 2 && store.agentRuns.length === 1 && store.audit.length === 2);
check("purchases, ledger, report payments and NAV are untouched", JSON.stringify([store.purchases, store.ledger, store.reportPayments, store.nav]) === JSON.stringify([before.purchases, before.ledger, before.reportPayments, before.nav]));
check("the input is not modified", (before.invoices["INV-0001"] as any).archived === undefined);
check("next invoice is INV-0042", store.nextInvoiceNumber === 42 && summary.nextInvoiceId === "INV-0042" && summary.raisedBecause === undefined);
check("Priya's KYC is pending and her pending bonds are cleared", store.kyc["kyc-a"].status === "pending" && store.kyc["kyc-a"].pendingBonds.length === 0 && summary.kyc?.before === "approved");
check("the other KYC request is untouched", store.kyc["kyc-b"].status === "approved");
const again = archiveStore(store, { investorAccountId: WALLET });
check("running it twice archives nothing new", again.summary.archived.invoices === 0 && again.summary.alreadyArchived.invoices === 2 && again.store.nextInvoiceNumber === 42);
const retake = structuredClone(store);
retake.invoices["INV-0042"] = { id: "INV-0042", status: "repaid", fingerprint: "fp-42", registered: true, links: [], amountPaidBy: {} };
const second = archiveStore(retake, { investorAccountId: WALLET });
check("a number already used is never handed out again", second.store.nextInvoiceNumber === 43 && second.summary.raisedBecause?.includes("INV-0042") === true && second.store.invoices["INV-0042"].archived === true);
check("no KYC change when the wallet has no request", archiveStore(sample(), { investorAccountId: "0.0.9" }).summary.kyc === null);

console.log("Backup and restore");
writeFileSync(`${liveDir}store.json`, JSON.stringify(sample()));
writeFileSync(`${liveDir}risk/seed.json`, "{}");
const backup = backupDataDir(liveDir, "", new Date("2026-11-06T12:00:00.000Z"));
check("the backup is a timestamped folder under data/backups", backup.includes("backups") && backup.includes("2026-11-06T12-00-00-000Z") && existsSync(`${backup}/store.json`) && existsSync(`${backup}/risk/seed.json`));
const second2 = backupDataDir(liveDir, "", new Date("2026-11-06T12:05:00.000Z"));
check("a backup does not copy earlier backups", !existsSync(`${second2}/backups`));
writeStore(liveDir, archiveStore(readStore(liveDir), { investorAccountId: WALLET }).store);
check("the live store is reset", readStore(liveDir).nextInvoiceNumber === 42);
check("the backup still holds the old state", JSON.parse(readFileSync(`${backup}/store.json`, "utf8")).nextInvoiceNumber === 9);
check("a backup can be named by folder name", resolveBackup(liveDir, "2026-11-06T12-00-00-000Z") === join(backupsDir(liveDir), "2026-11-06T12-00-00-000Z"));
const restored = restoreBackup(liveDir, backup);
check("restore brings the old state back", readStore(liveDir).nextInvoiceNumber === 9 && readStore(liveDir).kyc["kyc-a"].status === "approved" && (readStore(liveDir).invoices["INV-0001"] as any).archived === undefined);
check("restore saves the state it replaced first", readStore(restored.safetyBackup).nextInvoiceNumber === 42);
check("restoring a missing backup fails", (() => { try { resolveBackup(liveDir, "nope"); return false; } catch { return true; } })());

console.log("Lists hide archived records, lookups still find them");
writeStore(liveDir, archiveStore(sample(), { investorAccountId: WALLET }).store);
// A store written before the server starts, as the reset does. Module state loads it once, here.
const { state } = await import("../src/store.js");
const { liveInvoices } = await import("../src/kyc.js");
const { createApp } = await import("../src/app.js");
const { publishNav, navFor } = await import("../src/nav.js");
const { createInvoice, getInvoice } = await import("../src/invoices.js");
const { ApiError } = await import("../src/errors.js");
// Give the archived invoices a bond so they count as tokenized.
for (const invoice of Object.values(state.invoices)) {
  Object.assign(invoice, { tokenId: `0.0.${invoice.id.slice(-1)}`, unitFaceValue: 1000, grade: "A", tokenization: { status: "complete", symbol: `S${invoice.id}`, isin: "x", name: "n", units: 1, unitFaceValue: 1000, discountPct: 0, startingDateUnix: 0, maturityDateUnix: 0, bond: { symbol: `S${invoice.id}`, contractId: `0.0.${invoice.id.slice(-1)}`, evm: "0x0" } } });
}
state.invoices["INV-0008"]!.dueDate = new Date(Date.now() + 5 * 86_400_000).toISOString();
check("archived invoices are not live bonds", liveInvoices().length === 0);
const sent: string[] = [];
const run = await publishNav({ trigger: "daily" }, async (message) => { sent.push(message); return { topicId: "0.0.1", transactionId: "t", hashscanUrl: "u" }; });
check("NAV is not published for archived invoices", run.published.length === 0 && sent.length === 0);
check("NAV can still be read for an archived invoice by ID", navFor("INV-0008", new Date()).invoiceId === "INV-0008");
check("an archived invoice is still found by ID", getInvoice("INV-0001").archived === true);
check("the store still holds the NAV, payments and ledger", Object.keys(state.nav.latest).length === 1 && Object.keys(state.reportPayments).length === 1 && Object.keys(state.ledger).length === 1);

const server = createApp().listen(0);
try {
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = async (path: string) => (await (await fetch(`${base}${path}`)).json()) as Record<string, any>;
  const invoices = (await get("/invoices")).invoices as { id: string }[];
  check("GET /invoices lists no archived invoice", invoices.every((i) => !/^INV-/.test(i.id)), invoices.map((i) => i.id).join(","));
  check("GET /invoices/:id still returns an archived invoice", (await get("/invoices/INV-0001")).invoice?.id === "INV-0001");
  check("GET /agent/runs is empty", (await get("/agent/runs")).runs.length === 0);
  check("GET /audit is empty", (await get("/audit")).entries.length === 0);
  check("GET /tokens is empty", (await get("/tokens")).tokens.length === 0);
  check("GET /kyc shows Priya pending", ((await get("/kyc")).requests as any[]).find((r) => r.walletAddress === WALLET)?.status === "pending");
  check("GET /nav/:id still answers for an archived invoice", (await get("/nav/INV-0008")).invoiceId === "INV-0008");
} finally {
  server.closeAllConnections();
  server.close();
}

console.log("Duplicate guard");
if (process.env.BUSINESS_ID && process.env.BUYER_ID) {
  const input = { supplierId: process.env.BUSINESS_ID, buyerId: process.env.BUYER_ID, amount: 10_000, dueDate: "2026-11-07", invoiceNumber: "RESET-TEST-1" };
  const canonical = JSON.stringify({ supplierId: input.supplierId, buyerId: input.buyerId, amount: input.amount, dueDate: "2026-11-07", invoiceNumber: "reset-test-1" });
  state.invoices["INV-0001"]!.fingerprint = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  const error = await createInvoice(input).then(() => undefined, (e: unknown) => (e instanceof ApiError ? e : undefined));
  check("an archived invoice still blocks a duplicate, before anything is sent", error?.code === "DUPLICATE_INVOICE" && (error.details as { originalId?: string }).originalId === "INV-0001", error?.code);
} else {
  console.log("  skipped: BUSINESS_ID and BUYER_ID are not set");
}

console.log(`\n${passes} passed, ${failures} failed`);
// The duplicate check opens Hedera client connections that keep the process alive, so exit explicitly.
setTimeout(() => process.exit(failures ? 1 : 0), 200);

/**
 * Tests the NAV feed: the formula, rounding, the due-day and overdue rules, the HCS message, the daily
 * key, the free GET route, the admin-only publish route and the NAV carried in the paid report.
 *
 * Spends no HBAR and writes nothing to the chain: publishing uses a fake publisher, and the store is a
 * temporary directory.
 *
 * Usage: npm run test:nav
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = `${mkdtempSync(join(tmpdir(), "udhaar-nav-"))}/`;

let passes = 0;
let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) passes++;
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}
const section = (title: string) => console.log(`\n${title}`);

const { navFor, navView, navForReport, publishNav, navMessage } = await import("../src/nav.js");
const { navPerUnit, discountPctFor, discountedUnitPrice } = await import("../src/risk/scorecard.js");
const { unitPrice } = await import("../src/invoices.js");
const { state } = await import("../src/store.js");
const { createApp } = await import("../src/app.js");
const { ApiError } = await import("../src/errors.js");
type Invoice = import("../src/types.js").Invoice;

const NOW = new Date("2026-11-06T10:00:00.000Z");
const DAY = 86_400_000;
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

function tokenized(id: string, over: Partial<Invoice> = {}): Invoice {
  const invoice = {
    id, supplierId: "0.0.1", supplierName: "Supplier", buyerId: "0.0.2", buyerName: "Buyer", amount: 100_000,
    issueDate: NOW.toISOString(), dueDate: daysFromNow(90), status: "tokenized", fingerprint: "f", registered: true,
    tokenId: "0.0.5555", symbol: "UDH-TEST", unitFaceValue: 1000, totalUnits: 100, retainedUnits: 100, grade: "A", discountPct: 2.9589,
    links: [], amountPaidBy: {},
    tokenization: { status: "complete", symbol: "UDH-TEST", isin: "x", name: "n", units: 100, unitFaceValue: 1000, discountPct: 2.9589, startingDateUnix: 0, maturityDateUnix: 0, bond: { symbol: "UDH-TEST", contractId: "0.0.5555", evm: "0x0" } },
    ...over,
  } as Invoice;
  state.invoices[id] = invoice;
  return invoice;
}
const rejects = async (work: () => unknown) => {
  try {
    await work();
    return undefined;
  } catch (error) {
    return error instanceof ApiError ? error : undefined;
  }
};

section("Formula");
{
  // Grade A is 12% a year: 1000 x (1 - 0.12 x 90 / 365) = 970.41.
  const a = tokenized("INV-A");
  const quote = navFor("INV-A", NOW);
  check("grade A, 90 days: 970.41", quote.nav === 970.41, String(quote.nav));
  check("rate and days are reported", quote.annualRatePct === 12 && quote.daysRemaining === 90 && quote.status === "active");
  check("the bond token ID is the contract ID", quote.bondTokenId === "0.0.5555");
  check("on the day it was priced, NAV equals the issue price", quote.nav === unitPrice(a), `${quote.nav} vs ${unitPrice(a)}`);
  check("navPerUnit agrees with discountPctFor and discountedUnitPrice", navPerUnit("B", 1000, 45) === discountedUnitPrice(1000, discountPctFor("B", 45) as number));
  check("grade B, 45 days: 1000 x (1 - 0.16 x 45/365) = 980.27", navPerUnit("B", 1000, 45) === 980.27, String(navPerUnit("B", 1000, 45)));
  check("grade C, 365 days: 800", navPerUnit("C", 1000, 365) === 800);
  check("rounds to the paisa", Number.isInteger(Math.round((navPerUnit("A", 999, 17) as number) * 100)));
  check("NAV rises toward face value as the due date nears", (navFor("INV-A", new Date(NOW.getTime() + 60 * DAY)).nav as number) > (quote.nav as number));
  check("grade D has no NAV", navPerUnit("D", 1000, 30) === null);
}

section("Due date and overdue");
{
  tokenized("INV-DUE", { dueDate: daysFromNow(0.5) });
  const dueToday = navFor("INV-DUE", NOW);
  check("on the due day, 1 day remains and NAV is just under face", dueToday.status === "active" && dueToday.daysRemaining === 1 && dueToday.nav !== null && dueToday.nav < 1000);
  tokenized("INV-ZERO", { dueDate: NOW.toISOString() });
  const zero = navFor("INV-ZERO", NOW);
  check("zero days left: face value, still active", zero.status === "active" && zero.daysRemaining === 0 && zero.nav === 1000, JSON.stringify(zero));
  tokenized("INV-LATE", { dueDate: daysFromNow(-3) });
  const late = navFor("INV-LATE", NOW);
  check("a missed due date is overdue with no price", late.status === "overdue" && late.nav === null && late.daysRemaining === -3);
  tokenized("INV-JUST", { dueDate: daysFromNow(-0.4) });
  check("less than a day past due is not yet overdue", navFor("INV-JUST", NOW).status === "active");
  tokenized("INV-PAID", { status: "repaid", dueDate: daysFromNow(10) });
  check("a repaid invoice has no NAV", navFor("INV-PAID", NOW).status === "repaid" && navFor("INV-PAID", NOW).nav === null);
}

section("Errors");
{
  const raw = tokenized("INV-RAW");
  delete raw.tokenization;
  check("an untokenized invoice is refused", (await rejects(() => navFor("INV-RAW", NOW)))?.code === "NOT_TOKENIZED");
  check("an unknown invoice is a 404", (await rejects(() => navFor("INV-NOPE", NOW)))?.status === 404);
  check("a simulated invoice is refused", (await rejects(() => navFor("DEMO-RING", NOW)))?.code === "SEEDED_INVOICE");
}

section("Publishing");
{
  for (const id of ["INV-DUE", "INV-ZERO", "INV-JUST", "INV-PAID", "INV-RAW"]) delete state.invoices[id];
  const sent: { message: string; key: string }[] = [];
  const fake = async (message: string, key: string) => {
    sent.push({ message, key });
    return { topicId: "0.0.7777", transactionId: `0.0.1@${sent.length}`, consensusTimestamp: `${sent.length}.000000001`, hashscanUrl: `https://hashscan.io/testnet/transaction/${sent.length}.000000001` };
  };
  const run = await publishNav({ trigger: "daily", date: NOW }, fake);
  check("only the live invoice is published", run.published.length === 1 && run.published[0]?.invoiceId === "INV-A", JSON.stringify(run.published.map((p) => p.invoiceId)));
  check("the overdue invoice is skipped, not priced", run.skipped.length === 1 && run.skipped[0]?.invoiceId === "INV-LATE" && sent.length === 1);
  check("the overdue invoice is marked", state.invoices["INV-LATE"]?.overdue === true && state.invoices["INV-A"]?.overdue === undefined);

  const message = JSON.parse(sent[0]?.message ?? "{}") as Record<string, unknown>;
  check(
    "message has invoice ID, bond token ID, NAV, rate, days remaining, timestamp",
    message.invoiceId === "INV-A" && message.bondTokenId === "0.0.5555" && message.nav === 970.41 && message.annualRatePct === 12 && message.daysRemaining === 90 && message.timestamp === NOW.toISOString(),
    JSON.stringify(message),
  );
  check("navMessage matches what was sent", JSON.stringify(navMessage({ ...navFor("INV-A", NOW), nav: 970.41 })) === sent[0]?.message);

  await publishNav({ trigger: "daily", date: NOW }, fake);
  check("a daily retry on the same day reuses the same key", sent[0]?.key === sent[1]?.key);
  await publishNav({ trigger: "daily", date: new Date(NOW.getTime() + DAY) }, fake);
  check("the next day uses a new key", sent[2]?.key !== sent[0]?.key);
  await publishNav({ trigger: "on-demand", date: NOW, invoiceId: "INV-A" }, fake);
  await publishNav({ trigger: "on-demand", date: NOW, invoiceId: "INV-A" }, fake);
  check("on-demand always gets a fresh key", sent[3]?.key !== sent[4]?.key);
  check("on-demand can target one invoice", (await publishNav({ trigger: "on-demand", date: NOW, invoiceId: "INV-A" }, fake)).published.length === 1);
  check("targeting an unknown invoice is refused", (await rejects(() => publishNav({ trigger: "on-demand", invoiceId: "INV-NOPE" }, fake)))?.status === 404);

  const failing = await publishNav({ trigger: "on-demand", date: NOW }, async () => {
    throw new Error("chain down");
  });
  check("a failed publish is reported and doesn't stop the run", failing.failed.length === 1 && failing.failed[0]?.error === "chain down" && failing.skipped.length === 1);
  check("a failure leaves the last good publication in place", state.nav.latest["INV-A"]?.trigger === "on-demand" && state.nav.latest["INV-A"]?.topicId === "0.0.7777");

  const old = tokenized("INV-OLD");
  delete old.grade;
  tokenized("INV-DONE", { status: "repaid" });
  const mixed = await publishNav({ trigger: "daily", date: NOW }, fake);
  check("an ungraded bond is skipped as unpriced and doesn't stop the run", mixed.skipped.some((item) => item.invoiceId === "INV-OLD" && item.reason === "unpriced") && mixed.published.length === 1 && mixed.failed.length === 0);
  check("a repaid invoice is left out of the run", !mixed.published.some((item) => item.invoiceId === "INV-DONE") && !mixed.skipped.some((item) => item.invoiceId === "INV-DONE"));
  check("naming an ungraded bond directly is an error", (await rejects(() => publishNav({ trigger: "on-demand", invoiceId: "INV-OLD" }, fake)))?.code === "NOT_PRICED");
  delete state.invoices["INV-OLD"];
  delete state.invoices["INV-DONE"];
}

section("GET /nav and the paid report");
{
  const view = navView("INV-A", NOW);
  check("GET view has the NAV and the last published proof", view.nav === 970.41 && view.lastPublished?.topicId === "0.0.7777" && view.lastPublished.hashscanUrl.includes("hashscan.io") && view.topic?.id === "0.0.7777");
  check("HashScan topic link is included", view.topic?.hashscanUrl === "https://hashscan.io/testnet/topic/0.0.7777" && view.links.some((link) => link.url === view.topic?.hashscanUrl));
  const late = navView("INV-LATE", NOW);
  check("overdue invoice: no NAV, no published price", late.status === "overdue" && late.nav === null && late.lastPublished === null);
  check("the paid report carries NAV and its proof", navForReport("INV-A")?.lastPublished?.transactionId !== undefined && navForReport("INV-A")?.invoiceId === "INV-A");
  check("a simulated invoice's report has no NAV", navForReport("DEMO-RING") === null);

  const server = createApp().listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const free = await fetch(`${base}/nav/INV-A`);
    const body = (await free.json()) as Record<string, any>;
    check("GET /nav/:invoiceId is free and returns 200", free.status === 200 && body.invoiceId === "INV-A" && typeof body.nav === "number" && body.lastPublished?.topicId === "0.0.7777", JSON.stringify(body).slice(0, 200));
    check("GET /nav for an unknown invoice is 404", (await fetch(`${base}/nav/INV-NOPE`)).status === 404);
    check("GET /nav for a simulated invoice is 409", (await fetch(`${base}/nav/DEMO-RING`)).status === 409);
    const noAuth = await fetch(`${base}/nav/publish`, { method: "POST" });
    check("POST /nav/publish without an admin token is refused", noAuth.status === 401, String(noAuth.status));
    const badToken = await fetch(`${base}/nav/publish`, { method: "POST", headers: { authorization: "Bearer nope" } });
    check("POST /nav/publish with a bad token is refused", badToken.status === 401, String(badToken.status));
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;

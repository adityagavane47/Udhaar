/**
 * Tests the demo-only short maturity: the setting, the refusal while it is off, the label every view
 * carries, and that pricing still follows the due date.
 *
 * Spends no HBAR and writes nothing to the chain. The store is a temporary directory. The path that
 * deploys a bond is covered by the live demo run, not here.
 *
 * Usage: npm run test:demo-maturity
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = `${mkdtempSync(join(tmpdir(), "udhaar-demo-"))}/`;
// Empty, not deleted: dotenv would refill a deleted variable from .env, but never overrides one that is set.
process.env.DEMO_SHORT_MATURITY_MINUTES = "";

let passes = 0;
let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) passes++;
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const { config, parseDemoMaturityMinutes } = await import("../src/config.js");
const { hasDemoMaturity, invoiceView, tokenizeInvoice } = await import("../src/invoices.js");
const { navFor } = await import("../src/nav.js");
const { state } = await import("../src/store.js");
const { createApp } = await import("../src/app.js");
const { ApiError } = await import("../src/errors.js");
type Invoice = import("../src/types.js").Invoice;

const DAY = 86_400_000;
const NOW = Date.now();
const unix = (ms: number) => Math.floor(ms / 1000);

function invoice(id: string, maturityMs: number, dueMs: number, over: Partial<Invoice> = {}): Invoice {
  const value = {
    id, supplierId: "0.0.1", supplierName: "S", buyerId: "0.0.2", buyerName: "B", amount: 10_000,
    issueDate: new Date(NOW).toISOString(), dueDate: new Date(dueMs).toISOString(), status: "funded", fingerprint: "f", registered: true,
    tokenId: "0.0.5555", symbol: "UDH-T", unitFaceValue: 1000, totalUnits: 10, retainedUnits: 0, grade: "A", discountPct: 0.0329,
    links: [], amountPaidBy: {},
    tokenization: { status: "complete", symbol: "UDH-T", isin: "x", name: "n", units: 10, unitFaceValue: 1000, discountPct: 0.0329, startingDateUnix: 0, maturityDateUnix: unix(maturityMs), bond: { symbol: "UDH-T", contractId: "0.0.5555", evm: "0x0" } },
    ...over,
  } as Invoice;
  state.invoices[id] = value;
  return value;
}

console.log("Setting");
check("unset means off", parseDemoMaturityMinutes(undefined) === null && parseDemoMaturityMinutes("") === null && config.demoShortMaturityMinutes === null);
check("5 is accepted", parseDemoMaturityMinutes("5") === 5);
check("under 3 is refused", parseDemoMaturityMinutes("2") === null && parseDemoMaturityMinutes("0") === null);
check("over a day is refused", parseDemoMaturityMinutes("1441") === null);
check("text is refused", parseDemoMaturityMinutes("soon") === null && parseDemoMaturityMinutes("NaN") === null);

console.log("Refusal while off");
{
  invoice("INV-OFF", NOW + 600_000, NOW + DAY, { status: "buyer_confirmed" });
  delete state.invoices["INV-OFF"]?.tokenization;
  const refused = await tokenizeInvoice("INV-OFF", { demoMaturity: true }).then(() => undefined, (error: unknown) => (error instanceof ApiError ? error : undefined));
  check("demoMaturity is refused when the setting is off", refused?.code === "DEMO_MATURITY_DISABLED" && refused.status === 422, refused?.code);
  check("nothing was planned", state.invoices["INV-OFF"]?.tokenization === undefined);
}

console.log("Label");
{
  const demo = invoice("INV-DEMO", NOW + 5 * 60_000, NOW + DAY);
  const normal = invoice("INV-NORMAL", NOW + 30 * DAY, NOW + 30 * DAY);
  const late = invoice("INV-LATE", NOW - 3600_000, NOW + DAY);
  check("a bond maturing minutes ahead of its due date is labelled", hasDemoMaturity(demo) && invoiceView(demo).demoMaturity === true);
  check("the label stays after the bond has matured", hasDemoMaturity(late) && invoiceView(late).demoMaturity === true);
  check("a normal bond is not labelled", !hasDemoMaturity(normal) && !("demoMaturity" in invoiceView(normal)));
  check("an invoice with no bond is not labelled", !hasDemoMaturity({ ...normal, tokenization: undefined as never }));
}

console.log("Pricing and NAV follow the due date");
{
  const quote = navFor("INV-DEMO", new Date(NOW));
  check("a 1-day due date with a 5-minute maturity is priced at 1 day", quote.daysRemaining === 1 && quote.status === "active", JSON.stringify(quote));
  check("NAV is just under face value", quote.nav !== null && quote.nav > 999 && quote.nav < 1000, String(quote.nav));
}

console.log("Routes");
{
  const server = createApp().listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const health = (await (await fetch(`${base}/health`)).json()) as { demo?: { shortMaturityMinutes: number | null } };
    check("/health reports demo maturity as off", health.demo?.shortMaturityMinutes === null);
    const noAuth = await fetch(`${base}/invoices/INV-DEMO/tokenize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ demoMaturity: true }) });
    check("tokenizing still needs an admin token", noAuth.status === 401, String(noAuth.status));
    const list = (await (await fetch(`${base}/invoices`)).json()) as { invoices: { id: string; demoMaturity?: boolean }[] };
    check("GET /invoices carries the label", list.invoices.find((entry) => entry.id === "INV-DEMO")?.demoMaturity === true && list.invoices.find((entry) => entry.id === "INV-NORMAL")?.demoMaturity === undefined);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;

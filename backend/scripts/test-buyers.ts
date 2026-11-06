/**
 * Tests the two extra buyer companies: their mock data, the buyers route, and the trust result an
 * invoice to each one gets (Apex good, Nova risky).
 *
 * Spends no HBAR and writes nothing to the chain. The store is a temporary directory. It reads the
 * mirror node (free) for the trust checklist.
 *
 * Usage: npm run test:buyers
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = `${mkdtempSync(join(tmpdir(), "udhaar-buyers-"))}/`;

let passes = 0;
let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) passes++;
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const { loadDataset } = await import("../src/risk/dataset.js");
const { loadTrustData, verifyGstin } = await import("../src/trust/data.js");
const { validateGstin } = await import("../src/trust/gstin.js");
const { invoiceTrust, companyTrust } = await import("../src/trust/service.js");
const { state } = await import("../src/store.js");
const { createApp } = await import("../src/app.js");
const { ROLES, knownAccountName } = await import("../src/hedera/client.js");
type Invoice = import("../src/types.js").Invoice;

const apexId = process.env.APEX_ID!;
const novaId = process.env.NOVA_ID!;
const businessId = process.env.BUSINESS_ID!;
const PLACEHOLDERS = ["0.0.11400101", "0.0.11400102"];
const json = JSON.stringify;

console.log("Accounts");
check("both accounts are configured with keys", Boolean(apexId && novaId && process.env.APEX_KEY && process.env.NOVA_KEY));
check("neither uses a placeholder ID", ![apexId, novaId].some((id) => PLACEHOLDERS.includes(id)));
check("the server knows them as roles", knownAccountName(apexId) === "APEX" && knownAccountName(novaId) === "NOVA" && ROLES.APEX === "Apex Infra Pvt Ltd" && ROLES.NOVA === "Nova Retail");

console.log("Mock data");
const dataset = loadDataset();
const trust = loadTrustData();
const apex = dataset.companies.get(dataset.accountLinks.get(apexId) ?? "");
const nova = dataset.companies.get(dataset.accountLinks.get(novaId) ?? "");
check("both accounts link to dataset companies", apex?.name === "Apex Infra Pvt Ltd" && nova?.name === "Nova Retail");
check("the dataset still holds 52 companies and every original link", dataset.companies.size === 52 && dataset.accountLinks.size === 4);
const apexProfile = trust.profiles.get(apex?.id ?? "");
const novaProfile = trust.profiles.get(nova?.id ?? "");
check("Apex: bureau 780, no MSME-1 dues, no complaints", apexProfile?.bureauScore === 780 && apexProfile.msme1DuesOver45DaysInr === 0 && apexProfile.samadhaanComplaints === 0, json(apexProfile));
check("Nova: bureau 610, MSME-1 dues over 10 lakh, 4 complaints", novaProfile?.bureauScore === 610 && novaProfile.msme1DuesOver45DaysInr > 1_000_000 && novaProfile.samadhaanComplaints === 4, json(novaProfile));
check("both GSTINs are valid, in the mock registry, and use PAN serial 0000", [apexProfile, novaProfile].every((p) => p !== undefined && validateGstin(p.gstin).valid && trust.registry.has(p.gstin) && p.gstin.slice(7, 11) === "0000"));
check("neither company ID is a valid GSTIN", !validateGstin(apex?.id ?? "").valid && !validateGstin(nova?.id ?? "").valid);
check("the registry names match the companies", verifyGstin(apexProfile?.gstin ?? "", "Apex Infra Pvt Ltd").nameMatches === true && verifyGstin(novaProfile?.gstin ?? "", "Nova Retail").nameMatches === true);
check("Apex filed all 6 returns on time, Nova only 3", verifyGstin(apexProfile?.gstin ?? "", "Apex Infra Pvt Ltd").filing?.onTime === 6 && verifyGstin(novaProfile?.gstin ?? "", "Nova Retail").filing?.onTime === 3);

console.log("Trust result for an invoice to each buyer");
const invoice = (id: string, buyerId: string, name: string): Invoice => {
  const value = {
    id, supplierId: businessId, supplierName: "Ramesh Cement Traders", buyerId, buyerName: name, amount: 10_000,
    issueDate: new Date().toISOString(), dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString(), status: "submitted", fingerprint: `sha256:${id}`, registered: false, links: [], amountPaidBy: {},
  } as Invoice;
  state.invoices[id] = value;
  return value;
};
invoice("INV-T-APEX", apexId, "Apex Infra Pvt Ltd");
invoice("INV-T-NOVA", novaId, "Nova Retail");
const forApex = await invoiceTrust("INV-T-APEX");
const forNova = await invoiceTrust("INV-T-NOVA");
console.log(`  buyer scores: Apex ${forApex.buyer.score}, Nova ${forNova.buyer.score}`);
check("Apex has a good buyer score", forApex.buyer.score >= 700, String(forApex.buyer.score));
check("Nova has a low buyer score", forNova.buyer.score <= 600, String(forNova.buyer.score));
check("Apex scores well above Nova", forApex.buyer.score - forNova.buyer.score >= 150);
const buyerWarnings = (result: typeof forApex) => result.checklist.filter((item: any) => item.status === "warn" || item.status === "fail");
const novaNotes = buyerWarnings(forNova).map((item: any) => `${item.label}: ${item.detail}`);
const apexNotes = buyerWarnings(forApex).map((item: any) => item.label);
check("Nova's checklist carries warnings about the buyer", novaNotes.some((note: string) => /Nova Retail/.test(note)), novaNotes.join(" | "));
check("Nova has more warnings than Apex", buyerWarnings(forNova).length > buyerWarnings(forApex).length, `${buyerWarnings(forNova).length} vs ${buyerWarnings(forApex).length}`);
check("the buyer's own factors explain the gap", forNova.buyer.breakdown.externalObligations.points < 15 && forApex.buyer.breakdown.externalObligations.points === 20);
const company = await companyTrust(novaId);
check("the company view for Nova says its outside data is mock", company.externalProfile.source === "mock");
console.log(`  Nova checklist notes: ${novaNotes.join(" | ")}`);
console.log(`  Apex checklist notes: ${apexNotes.join(", ") || "none"}`);

console.log("Buyers route");
const server = createApp().listen(0);
try {
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const body = (await (await fetch(`${base}/buyers`)).json()) as { buyers: { accountId: string; name: string }[]; externalDataSource: string };
  check("GET /buyers lists BigBuild, Apex and Nova with their company names", body.buyers.length === 3 && body.buyers.some((b) => b.accountId === process.env.BUYER_ID && b.name === "BigBuild Ltd") && body.buyers.some((b) => b.accountId === apexId && b.name === "Apex Infra Pvt Ltd") && body.buyers.some((b) => b.accountId === novaId && b.name === "Nova Retail"), json(body.buyers.map((b) => b.name)));
  check("it says the data is mock", body.externalDataSource === "mock");
  check("it never returns a key", !json(body).match(/KEY|private|[0-9a-f]{64}/i));
  const saved = process.env.NOVA_KEY;
  process.env.NOVA_KEY = "";
  const without = (await (await fetch(`${base}/buyers`)).json()) as { buyers: { accountId: string }[] };
  process.env.NOVA_KEY = saved ?? "";
  check("a buyer with no configured key is not listed", without.buyers.length === 2 && !without.buyers.some((b) => b.accountId === novaId));
} finally {
  server.closeAllConnections();
  server.close();
}

console.log(`\n${passes} passed, ${failures} failed`);
setTimeout(() => process.exit(failures ? 1 : 0), 200);

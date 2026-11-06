/**
 * Tests the trust layer: GSTIN rules, the mock GST registry, the mock e-invoice signer, the Udhaar
 * Trust Score, the invoice checklist and the new-company limit.
 *
 * Covers: a good buyer, a new buyer (cold start), a bad buyer (dues and complaints), a cancelled
 * GSTIN, a name mismatch and a tampered e-invoice.
 *
 * Spends no HBAR and writes nothing to the chain. Part 1 runs in this process with a fake chain
 * reader, so on-chain history can be set to anything. Part 2 starts a real server on a temporary
 * copy of the store and reads real mirror-node history (free).
 *
 * Usage: npm run test:trust
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND = fileURLToPath(new URL("../", import.meta.url));
const SEED_DIR = `${BACKEND}data/risk/`;
const DATA_DIR = `${mkdtempSync(join(tmpdir(), "udhaar-trust-"))}/`;
process.env.DATA_DIR = DATA_DIR;
if (existsSync(`${BACKEND}data/store.json`)) copyFileSync(`${BACKEND}data/store.json`, `${DATA_DIR}store.json`);

type Json = Record<string, any>;
const readSeed = (name: string) => JSON.parse(readFileSync(`${SEED_DIR}${name}.json`, "utf8")) as Json;

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

const { validateGstin, validateUdyam, gstinCheckDigit } = await import("../src/trust/gstin.js");
const { verifyGstin, loadTrustData } = await import("../src/trust/data.js");
const { signEInvoice, verifyEInvoice } = await import("../src/trust/irp.js");
const { computeTrust, limitFor } = await import("../src/trust/score.js");
const { companyTrust, invoiceTrust, checkNewInvoice, gstinOf } = await import("../src/trust/service.js");
const { loadDataset } = await import("../src/risk/dataset.js");
const { state } = await import("../src/store.js");
const { ApiError } = await import("../src/errors.js");

const data = loadTrustData();
const stories = data.stories;
const dataset = loadDataset();
const itemOf = (result: Json, id: string) => (result.checklist as Json[]).find((item) => item.id === id) as Json;
const rejects = async (work: () => Promise<unknown>) => {
  try {
    await work();
    return undefined;
  } catch (error) {
    return error instanceof ApiError ? error : undefined;
  }
};

// ---- 1a. GSTIN rules.
section("GSTIN and Udyam");
{
  const gstins = [...data.profiles.values()].map((profile) => profile.gstin);
  check("every mock GSTIN passes format, state code and checksum", gstins.every((gstin) => validateGstin(gstin).valid));
  check("every mock GSTIN is unique", new Set(gstins).size === gstins.length);
  check("mock GSTINs use PAN serial 0000, which can't be a real taxpayer", gstins.every((gstin) => gstin.slice(7, 11) === "0000"));
  check("no mock GSTIN equals an existing company ID", gstins.every((gstin) => !dataset.companies.has(gstin)));
  const good = gstins[0] as string;
  const wrongDigit = `${good.slice(0, 14)}${good.endsWith("A") ? "B" : "A"}`;
  check("a wrong check character fails the checksum", validateGstin(wrongDigit).problem === "CHECKSUM");
  check("a short number fails the format", validateGstin(good.slice(0, 14)).problem === "FORMAT");
  check("lower case is accepted", validateGstin(good.toLowerCase()).valid);
  const badState = `00${good.slice(2, 14)}`;
  check("a made-up state code is refused even with a matching checksum", validateGstin(`${badState}${gstinCheckDigit(badState)}`).problem === "STATE_CODE");
  const badHolder = `27ABCXD0000A1Z`;
  check("an impossible PAN holder type is refused", validateGstin(`${badHolder}${gstinCheckDigit(badHolder)}`).problem === "PAN_HOLDER_TYPE");
  check("the existing dataset's company IDs are not valid GSTINs, so none can be real", [...dataset.companies.keys()].every((id) => !validateGstin(id).valid));
  check("Udyam: valid format", validateUdyam("UDYAM-MH-99-1234567").valid);
  check("Udyam: bad format is refused", !validateUdyam("UDYAM-MH-1234567").valid && !validateUdyam("MH-99-1234567").valid);
  check("every profile's Udyam number has a valid format", [...data.profiles.values()].every((profile) => profile.udyam === null || validateUdyam(profile.udyam).valid));
}

// ---- 1b. The mock registry and the verification order.
section("GST verification");
{
  const nameOf = (id: string) => dataset.companies.get(id)?.name ?? "";
  const gstinById = (id: string) => data.profiles.get(id)?.gstin ?? "";
  const ok = verifyGstin(gstinById(stories.goodBuyer.buyer), nameOf(stories.goodBuyer.buyer));
  check("a good company passes every step", ok.ok && ok.steps.map((step) => step.step).join() === "checksum,registry,status,name,filing", ok.steps.map((step) => step.step).join());

  const cancelled = verifyGstin(gstinById(stories.cancelledGstin.supplier), nameOf(stories.cancelledGstin.supplier));
  check("cancelled GSTIN: valid checksum, found, but not Active", cancelled.checksum === "pass" && cancelled.registry === "pass" && cancelled.gstStatus === "Cancelled" && !cancelled.ok);
  check("cancelled GSTIN: stops before the name and filing steps", cancelled.steps.at(-1)?.step === "status" && cancelled.nameMatches === null);

  const mismatch = verifyGstin(gstinById(stories.nameMismatch.supplier), nameOf(stories.nameMismatch.supplier));
  check("name mismatch: valid and Active, but the name differs", mismatch.checksum === "pass" && mismatch.gstStatus === "Active" && mismatch.nameMatches === false && !mismatch.ok);
  check("name mismatch: says what the registry holds", (mismatch.steps.at(-1)?.detail ?? "").includes(mismatch.registryName ?? "?"));

  const typo = verifyGstin(`${gstinById(stories.goodBuyer.buyer).slice(0, 14)}Q`, "Anything");
  check("a mistyped GSTIN stops at the checksum and never reaches the registry", typo.checksum === "fail" && typo.registry === "not_run" && typo.steps.length === 1);

  const registryOnly = "27ABCCD0000A1Z";
  const unknown = verifyGstin(`${registryOnly}${gstinCheckDigit(registryOnly)}`, "Anything");
  check("a valid GSTIN that is not in the registry fails at the registry step", unknown.checksum === "pass" && unknown.registry === "fail");

  const { normalizeName } = await import("../src/trust/data.js");
  check("names match ignoring case, punctuation, 'Ltd.' and 'Limited'", normalizeName("Devgiri Infra Projects Ltd.") === normalizeName("DEVGIRI INFRA PROJECTS LIMITED") && normalizeName("A & B Co") === normalizeName("A AND B CO"));

  const registry = readSeed("gst-registry");
  const entries = Object.values(registry.entries) as Json[];
  check("registry: every entry has 6 months of filings", entries.every((entry) => entry.filings.length === 6));
  check("registry: exactly one Cancelled GSTIN", entries.filter((entry) => entry.status === "Cancelled").length === 1);
  check("registry: marked as mock", registry.source === "mock" && readSeed("external-profiles").source === "mock");
}

// ---- 1c. The mock IRP.
section("E-invoice signing (mock IRP)");
const fields = { sellerGstin: gstinOf(stories.goodBuyer.buyer) as string, buyerGstin: gstinOf(stories.newBuyer.buyer) as string, invoiceNumber: "RCT/2026/0042", amount: 80_000, date: "2026-11-06" };
{
  const signed = signEInvoice(fields);
  check("a signed QR is a three-part ES256 JWS", signed.signedQr.split(".").length === 3 && JSON.parse(Buffer.from(signed.signedQr.split(".")[0] as string, "base64url").toString()).alg === "ES256");
  check("the IRN is a 64-character hash", /^[0-9a-f]{64}$/.test(signed.irn));
  const good = verifyEInvoice(signed.signedQr, fields);
  check("untouched, it verifies", good.verified && good.signatureValid && good.mismatches.length === 0, good.reason);

  const wrong: Record<string, Json> = {
    sellerGstin: { sellerGstin: gstinOf(stories.cancelledGstin.supplier) },
    buyerGstin: { buyerGstin: gstinOf(stories.goodBuyer.buyer) },
    invoiceNumber: { invoiceNumber: "RCT/2026/0043" },
    amount: { amount: 80_001 },
    date: { date: "2026-11-07" },
  };
  for (const [field, change] of Object.entries(wrong)) {
    const result = verifyEInvoice(signed.signedQr, { ...fields, ...change });
    check(`tampered ${field}: refused, and ${field} is named`, !result.verified && result.signatureValid && result.mismatches.some((item) => item.field === field), JSON.stringify(result.mismatches));
  }

  // Changing the signed claims themselves breaks the signature.
  const [header, payload, signature] = signed.signedQr.split(".") as [string, string, string];
  const edited = JSON.parse(Buffer.from(payload, "base64url").toString());
  edited.TotInvVal = 8_000_000;
  const forged = `${header}.${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${signature}`;
  const forgedResult = verifyEInvoice(forged, { ...fields, amount: 8_000_000 });
  check("a payload edited after signing fails the signature, even if it now matches the invoice", !forgedResult.verified && !forgedResult.signatureValid);
  const noneHeader = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${payload}.`;
  check("alg:none is refused", !verifyEInvoice(noneHeader, fields).verified);
  check("garbage is refused", !verifyEInvoice("not.a.jws", fields).verified && !verifyEInvoice("x", fields).verified);
  const flipped = `${header}.${payload}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
  check("a changed signature is refused", !verifyEInvoice(flipped, fields).signatureValid);
}

// ---- 1d. The score and the limit, with fake on-chain history.
section("Trust score and limit");
const event = (n: number, onTime: boolean, daysLate = 0) => ({ invoiceId: `INV-${n}`, role: "buyer" as const, amount: 50_000, dueDate: "2026-11-01T00:00:00.000Z", paidAt: "2026-11-01T00:00:00.000Z", onTime, daysLate, transactionId: `0.0.1-${n}-0`, hashscanUrl: "https://hashscan.io/testnet/transaction/1" });
const input = (companyId: string, events: ReturnType<typeof event>[]) => {
  const company = dataset.companies.get(companyId);
  return { name: company?.name ?? companyId, company, profile: data.profiles.get(companyId), events, history: dataset.invoices, referenceDate: dataset.referenceDate, now: Date.parse("2026-11-06") };
};
{
  const good = computeTrust(input(stories.goodBuyer.buyer, []));
  const fresh = computeTrust(input(stories.newBuyer.buyer, []));
  const bad = computeTrust(input(stories.badBuyers[0]?.buyer as string, []));

  check("good buyer: a high score", good.score >= 800 && good.score <= 900, String(good.score));
  check("bad buyer: a low score, far under the good one", bad.score <= 600 && good.score - bad.score >= 200, `${bad.score} vs ${good.score}`);
  check("scores stay inside 300–900", [good, fresh, bad].every((score) => score.score >= 300 && score.score <= 900));
  check("new buyer: marked New on Udhaar", fresh.newOnUdhaar && fresh.label === "New on Udhaar");
  check("new buyer: payment history comes from the mock external profile", fresh.breakdown.paymentHistory.source === "mock-external");
  check("new buyer: limit is ₹1,00,000 per invoice", fresh.limit.perInvoiceInr === 100_000 && fresh.limit.onTimeRepayments === 0);
  check("every factor has points, max, a reason and a source", [good, fresh, bad].every((score) => Object.values(score.breakdown).every((factor) => typeof factor.points === "number" && factor.max > 0 && factor.reason.length > 10 && ["hedera", "mock-external"].includes(factor.source))));
  check("factors add up to the score's points", Math.abs(Object.values(good.breakdown).reduce((sum, factor) => sum + factor.points, 0) - good.points) < 0.3);
  check("bad buyer: the reason names the dues and complaints", /MSME-1/.test(bad.breakdown.externalObligations.reason) && /complaints? on MSME Samadhaan/.test(bad.breakdown.externalObligations.reason), bad.breakdown.externalObligations.reason);

  const twoOnTime = computeTrust(input(stories.newBuyer.buyer, [event(1, true), event(2, true)]));
  check("2 on-time repayments: not new any more, but still capped", !twoOnTime.newOnUdhaar && twoOnTime.label === null && twoOnTime.limit.perInvoiceInr === 100_000);
  check("history from the chain is a hedera-sourced factor", twoOnTime.breakdown.paymentHistory.source === "hedera");
  const threeOnTime = computeTrust(input(stories.newBuyer.buyer, [event(1, true), event(2, true), event(3, true)]));
  check("3 on-time repayments: the cap is gone", threeOnTime.limit.perInvoiceInr === null && threeOnTime.limit.onTimeRepayments === 3);
  const lateOnes = computeTrust(input(stories.newBuyer.buyer, [1, 2, 3, 4, 5].map((n) => event(n, false, 40))));
  const onTimeOnes = computeTrust(input(stories.newBuyer.buyer, [1, 2, 3, 4, 5].map((n) => event(n, true))));
  check("five late repayments score far below five on-time ones", onTimeOnes.score - lateOnes.score >= 80, `${onTimeOnes.score} vs ${lateOnes.score}`);
  check("late repayments do not count toward lifting the cap", limitFor([1, 2, 3].map((n) => event(n, false, 5))).perInvoiceInr === 100_000);
  check("a company with no profile at all still scores, as neutral", computeTrust({ ...input("0.0.1", []), company: undefined, profile: undefined }).score > 300);
}

// ---- 1e. Checklist and upload checks through the service, with a fake chain.
section("Checklist and upload checks (fake chain)");
const SUPPLIER = process.env.BUSINESS_ID as string;
const BUYER = process.env.BUYER_ID as string;
{
  const fakeInvoices = (count: number, onTime: boolean) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`INV-F${i}`, { id: `INV-F${i}`, supplierId: SUPPLIER, buyerId: BUYER, amount: 50_000, dueDate: "2026-11-01T00:00:00.000Z", links: [], repayment: { status: "complete", detected: { transactionId: `0.0.1-${i}-0`, hashscanUrl: `https://hashscan.io/testnet/transaction/${i}` } } }]));
  const chain = (onTime: boolean) => ({
    repayment: async (id: string) => ({ paidAt: onTime ? "2026-10-30T12:00:00.000Z" : `2026-12-20T12:00:00.000Z${id.length > 0 ? "" : ""}` }),
    confirmation: async () => undefined,
    registry: async () => undefined,
  });
  const upload = { supplierId: SUPPLIER, buyerId: BUYER, invoiceNumber: "RCT/2026/0042", issueDate: "2026-11-06" };

  Object.assign(state, { invoices: {} });
  const none = await rejects(() => checkNewInvoice({ ...upload, amount: 500_000 }, chain(true)));
  check("cold start: ₹5,00,000 is refused with TRUST_LIMIT_EXCEEDED", none?.code === "TRUST_LIMIT_EXCEEDED" && none.status === 422, none?.message);
  check("cold start: exactly ₹1,00,000 is allowed", (await rejects(() => checkNewInvoice({ ...upload, amount: 100_000 }, chain(true)))) === undefined);

  state.invoices = fakeInvoices(2, true) as never;
  check("2 on-time repayments: still refused", (await rejects(() => checkNewInvoice({ ...upload, amount: 500_000 }, chain(true))))?.code === "TRUST_LIMIT_EXCEEDED");
  state.invoices = fakeInvoices(3, true) as never;
  check("3 on-time repayments for both parties: ₹5,00,000 is allowed", (await rejects(() => checkNewInvoice({ ...upload, amount: 500_000 }, chain(true)))) === undefined);
  state.invoices = fakeInvoices(3, false) as never;
  check("3 LATE repayments: still refused", (await rejects(() => checkNewInvoice({ ...upload, amount: 500_000 }, chain(false))))?.code === "TRUST_LIMIT_EXCEEDED");
  const company = await companyTrust(BUYER, chain(false) as never);
  check("company view lists the on-chain repayments with HashScan links", company.repayments.length === 3 && company.repayments.every((item) => item.hashscanUrl.includes("hashscan.io") && item.onTime === false));
  state.invoices = {} as never;

  // E-invoice at upload.
  const signed = signEInvoice({ sellerGstin: gstinOf(SUPPLIER) as string, buyerGstin: gstinOf(BUYER) as string, invoiceNumber: upload.invoiceNumber, amount: 80_000, date: "2026-11-06" });
  const accepted = await checkNewInvoice({ ...upload, amount: 80_000, signedQr: signed.signedQr }, chain(true));
  check("a matching signed QR is accepted and its IRN returned", accepted?.irn === signed.irn);
  check("no QR is fine: it is optional", (await checkNewInvoice({ ...upload, amount: 80_000 }, chain(true))) === undefined);
  const tamperedAmount = await rejects(() => checkNewInvoice({ ...upload, amount: 90_000, signedQr: signed.signedQr }, chain(true)));
  check("tampered amount at upload: EINVOICE_MISMATCH naming the amount", tamperedAmount?.code === "EINVOICE_MISMATCH" && JSON.stringify(tamperedAmount) !== "" && /amount/.test(tamperedAmount.message), tamperedAmount?.message);
  const tamperedNumber = await rejects(() => checkNewInvoice({ ...upload, invoiceNumber: "RCT/2026/9999", amount: 80_000, signedQr: signed.signedQr }, chain(true)));
  check("tampered invoice number at upload is refused", tamperedNumber?.code === "EINVOICE_MISMATCH");
  const [header, payload, signature] = signed.signedQr.split(".") as [string, string, string];
  const forgedClaims = { ...JSON.parse(Buffer.from(payload, "base64url").toString()), TotInvVal: 90_000 };
  const forged = `${header}.${Buffer.from(JSON.stringify(forgedClaims)).toString("base64url")}.${signature}`;
  const forgedResult = await rejects(() => checkNewInvoice({ ...upload, amount: 90_000, signedQr: forged }, chain(true)));
  check("a forged QR is refused as EINVOICE_SIGNATURE_INVALID", forgedResult?.code === "EINVOICE_SIGNATURE_INVALID");
  check("a QR needs an invoice number to check", (await rejects(() => checkNewInvoice({ supplierId: SUPPLIER, buyerId: BUYER, amount: 80_000, signedQr: signed.signedQr }, chain(true))))?.code === "EINVOICE_NEEDS_INVOICE_NUMBER");

  // A stored invoice with a QR that no longer matches fails the checklist: the QR is re-checked every time.
  const stored = { id: "INV-E1", supplierId: SUPPLIER, supplierName: "Ramesh Cement Traders", buyerId: BUYER, buyerName: "BigBuild Ltd", amount: 80_000, issueDate: "2026-11-06T00:00:00.000Z", dueDate: "2027-02-04T00:00:00.000Z", status: "submitted", invoiceNumber: upload.invoiceNumber, fingerprint: "sha256:test", registered: true, links: [], amountPaidBy: {}, signedQr: signed.signedQr };
  state.invoices = { "INV-E1": stored, "INV-E2": { ...stored, id: "INV-E2", amount: 95_000 } } as never;
  const offline = { repayment: async () => undefined, confirmation: async () => undefined, registry: async () => undefined };
  const good = await invoiceTrust("INV-E1", offline);
  check("checklist: matching e-invoice passes", itemOf(good, "eInvoice").status === "pass", itemOf(good, "eInvoice").detail);
  const bad = await invoiceTrust("INV-E2", offline);
  check("checklist: an e-invoice that no longer matches fails", itemOf(bad, "eInvoice").status === "fail", itemOf(bad, "eInvoice").detail);
  check("checklist: unconfirmed buyer is a warning, not a pass", itemOf(good, "buyerConfirmed").status === "warn");
  check("checklist: a fingerprint missing from the registry is a warning", itemOf(good, "notFinancedBefore").status === "warn");
  const doubled = await invoiceTrust("INV-E1", { ...offline, registry: async () => ({ invoiceId: "INV-0009", sequence: 7, hashscanUrl: "https://hashscan.io/testnet/transaction/9" }) });
  check("checklist: a fingerprint already held by another invoice fails", itemOf(doubled, "notFinancedBefore").status === "fail" && /INV-0009/.test(itemOf(doubled, "notFinancedBefore").detail));
  const confirmedChain = { ...offline, confirmation: async () => ({ sequence: 12, topicId: "0.0.5", valid: true }), registry: async () => ({ invoiceId: "INV-E1", sequence: 3, hashscanUrl: "https://hashscan.io/testnet/transaction/3" }) };
  state.invoices = { "INV-E1": { ...stored, confirmation: { message: "{}", signature: "", signedBy: BUYER, hashscanUrl: "https://hashscan.io/testnet/transaction/55.1" } } } as never;
  const proven = await invoiceTrust("INV-E1", confirmedChain);
  check("checklist: confirmation shows the HCS sequence number and a HashScan link", itemOf(proven, "buyerConfirmed").status === "pass" && /sequence number 12/.test(itemOf(proven, "buyerConfirmed").detail) && itemOf(proven, "buyerConfirmed").proofUrl.includes("hashscan.io"));
  check("checklist: a registry hit by this invoice passes with a link", itemOf(proven, "notFinancedBefore").status === "pass" && itemOf(proven, "notFinancedBefore").proofUrl.includes("hashscan.io"));
  const forgedChain = { ...confirmedChain, confirmation: async () => ({ sequence: 12, topicId: "0.0.5", valid: false, problem: "posted by 0.0.99, not the buyer" }) };
  check("checklist: a confirmation posted by someone else fails", itemOf(await invoiceTrust("INV-E1", forgedChain), "buyerConfirmed").status === "fail");
  state.invoices = {} as never;
}

// ---- 2. Through a real server.
section("Routes (real server, free)");
const PORT = 4107;
const BASE = `http://localhost:${PORT}`;
async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : {}) as Json };
}

const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: BACKEND, env: { ...process.env, PORT: String(PORT), DATA_DIR, DEMO_ADMIN_PASSCODE: "unused-passcode-for-trust-test" }, stdio: ["ignore", "ignore", "ignore"] });
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

  const get = async (path: string) => request("GET", path);
  const reliable = await get(`/trust/${stories.goodBuyer.invoiceId}`);
  check("good buyer: 200 with seller, buyer and a checklist", reliable.status === 200 && reliable.json.seller && reliable.json.buyer && Array.isArray(reliable.json.checklist), `${reliable.status}`);
  check("responses say external data is mock", reliable.json.externalDataSource === "mock" && reliable.json.checklist.filter((item: Json) => item.source === "mock").length >= 5);
  check("good buyer: no MSME-1 dues, no complaints", itemOf(reliable.json, "buyerMsme1Dues").status === "pass" && itemOf(reliable.json, "buyerSamadhaanComplaints").status === "pass");
  check("good buyer: GSTIN valid, Active, name matches", ["gstinValid", "gstActive", "nameMatches"].every((id) => itemOf(reliable.json, id).status === "pass"), JSON.stringify(reliable.json.checklist.map((item: Json) => [item.id, item.status])));
  check("good buyer: no fraud ring", itemOf(reliable.json, "noFraudRing").status === "pass");
  check("seeded invoice: e-invoice, confirmation and registry are not_provided", ["eInvoice", "buyerConfirmed", "notFinancedBefore"].every((id) => itemOf(reliable.json, id).status === "not_provided"));
  check("every item has a status, detail and source", reliable.json.checklist.every((item: Json) => ["pass", "warn", "fail", "not_provided"].includes(item.status) && item.detail && item.source));
  check("good buyer: score above 800", reliable.json.buyer.score >= 800, String(reliable.json.buyer.score));
  check("response has the HashScan fields", typeof reliable.json.hashscanUrl === "string" && Array.isArray(reliable.json.links));

  const realRepaid = Object.values((JSON.parse(readFileSync(`${DATA_DIR}store.json`, "utf8")) as Json).invoices as Record<string, Json>).filter((invoice) => invoice.repayment?.detected);
  const buyerCompany = await get(`/trust/company/${BUYER}`);
  check("company route works for a real account", buyerCompany.status === 200 && buyerCompany.json.name === "BigBuild Ltd", `${buyerCompany.status}`);
  if (realRepaid.length > 0) {
    const first = buyerCompany.json.repayments[0] as Json;
    check("company route: real on-chain repayments are read from the mirror node, with HashScan links", buyerCompany.json.repayments.length >= 1 && first.hashscanUrl.includes("hashscan.io") && first.onTime === true, JSON.stringify(first));
    check("company route: a company with real history is not 'New on Udhaar'", buyerCompany.json.newOnUdhaar === false && buyerCompany.json.breakdown.paymentHistory.source === "hedera");
    check("company route: 1 on-time repayment keeps the ₹1,00,000 cap", buyerCompany.json.limit.perInvoiceInr === 100_000 && buyerCompany.json.limit.onTimeRepayments === buyerCompany.json.repayments.filter((item: Json) => item.onTime).length);
  } else {
    console.log("NOTE no real repaid invoice in the store, so the on-chain history checks were skipped");
  }
  check("company route: also takes a dataset company ID and a GSTIN", (await get(`/trust/company/${stories.newBuyer.buyer}`)).status === 200 && (await get(`/trust/company/${data.profiles.get(stories.newBuyer.buyer)?.gstin}`)).status === 200);
  const freshCompany = await get(`/trust/company/${stories.newBuyer.buyer}`);
  check("new buyer: 'New on Udhaar', ₹1,00,000 limit, mock-external history", freshCompany.json.label === "New on Udhaar" && freshCompany.json.limit.perInvoiceInr === 100_000 && freshCompany.json.breakdown.paymentHistory.source === "mock-external");
  check("company route: shows the mock profile, labelled", freshCompany.json.externalProfile.source === "mock" && typeof freshCompany.json.externalProfile.bureauScore === "number");

  const bad = stories.badBuyers[0];
  const lateInvoice = await get(`/trust/${bad?.invoiceId}`);
  check("bad buyer: MSME-1 dues and Samadhaan complaints fail", itemOf(lateInvoice.json, "buyerMsme1Dues").status === "fail" && itemOf(lateInvoice.json, "buyerSamadhaanComplaints").status === "fail", JSON.stringify(lateInvoice.json.checklist?.map((item: Json) => [item.id, item.status])));
  check("bad buyer: score far below the good buyer", reliable.json.buyer.score - lateInvoice.json.buyer.score >= 200, `${lateInvoice.json.buyer.score}`);
  for (const other of stories.badBuyers.slice(1)) {
    const result = await get(`/trust/${other.invoiceId}`);
    check(`bad buyer ${other.buyer}: dues and complaints fail`, itemOf(result.json, "buyerMsme1Dues").status === "fail" && itemOf(result.json, "buyerSamadhaanComplaints").status === "fail");
  }

  const cancelled = await get(`/trust/${stories.cancelledGstin.invoiceId}`);
  check("cancelled GSTIN: GSTIN valid but GST status fails", itemOf(cancelled.json, "gstinValid").status === "pass" && itemOf(cancelled.json, "gstActive").status === "fail" && /Cancelled/.test(itemOf(cancelled.json, "gstActive").detail), JSON.stringify(cancelled.json.checklist?.map((item: Json) => [item.id, item.status])));
  check("cancelled GSTIN: overall fail", cancelled.json.overall === "fail");
  const mismatch = await get(`/trust/${stories.nameMismatch.invoiceId}`);
  check("name mismatch: GSTIN valid and Active but the name check fails", itemOf(mismatch.json, "gstinValid").status === "pass" && itemOf(mismatch.json, "gstActive").status === "pass" && itemOf(mismatch.json, "nameMatches").status === "fail", JSON.stringify(mismatch.json.checklist?.map((item: Json) => [item.id, item.status])));
  const ring = await get("/trust/DEMO-RING");
  check("fraud ring invoice: the ring item fails", itemOf(ring.json, "noFraudRing").status === "fail");
  const anomaly = await get("/trust/DEMO-ANOMALY");
  check("anomaly invoice: the amount item fails", itemOf(anomaly.json, "amountNormal").status === "fail", itemOf(anomaly.json, "amountNormal").detail);

  check("unknown invoice: 404", (await get("/trust/NOPE-1")).status === 404);
  check("unknown company: 404", (await get("/trust/company/not-a-company")).status === 404);
  check("an unknown Hedera account is scored as a new company", (await get("/trust/company/0.0.1234")).json.label === "New on Udhaar");

  // Tampered e-invoice through the routes: refused before anything is written or spent.
  const before = (await get("/invoices")).json.invoices.length;
  const minted = await request("POST", "/mock-irp/e-invoice", { supplierId: SUPPLIER, buyerId: BUYER, invoiceNumber: "RCT/2026/0042", amount: 50_000, date: "2026-11-06" });
  check("mock IRP signs an e-invoice and says it is mock", minted.status === 200 && minted.json.source === "mock" && minted.json.signedQr.split(".").length === 3);
  const tampered = await request("POST", "/invoices", { supplierId: SUPPLIER, buyerId: BUYER, invoiceNumber: "RCT/2026/0042", issueDate: "2026-11-06", amount: 60_000, dueDate: "2027-02-04", signedQr: minted.json.signedQr });
  check("POST /invoices with a tampered amount: 422 EINVOICE_MISMATCH", tampered.status === 422 && tampered.json.error.code === "EINVOICE_MISMATCH" && tampered.json.error.mismatches.some((item: Json) => item.field === "amount"), JSON.stringify(tampered.json));
  const forgedSig = await request("POST", "/invoices", { supplierId: SUPPLIER, buyerId: BUYER, invoiceNumber: "RCT/2026/0042", issueDate: "2026-11-06", amount: 50_000, dueDate: "2027-02-04", signedQr: `${(minted.json.signedQr as string).slice(0, -4)}AAAA` });
  check("POST /invoices with a broken signature: 422 EINVOICE_SIGNATURE_INVALID", forgedSig.status === 422 && forgedSig.json.error.code === "EINVOICE_SIGNATURE_INVALID", JSON.stringify(forgedSig.json));
  const tooBig = await request("POST", "/invoices", { supplierId: SUPPLIER, buyerId: BUYER, amount: 500_000, dueDate: "2027-02-04" });
  check("POST /invoices above the new-company limit: 422 TRUST_LIMIT_EXCEEDED", tooBig.status === 422 && tooBig.json.error.code === "TRUST_LIMIT_EXCEEDED", JSON.stringify(tooBig.json));
  check("nothing was created by the refusals", (await get("/invoices")).json.invoices.length === before);
  check("mock IRP refuses an invalid GSTIN", (await request("POST", "/mock-irp/e-invoice", { sellerGstin: "27ABCDE1234F1Z5", buyerGstin: "27ABCDE1234F1Z5", invoiceNumber: "X", amount: 1 })).json.error?.code === "INVALID_GSTIN");
  check("the public key is served", (await get("/mock-irp/public-key")).json.alg === "ES256");
} finally {
  if (child.exitCode === null) {
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
    });
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

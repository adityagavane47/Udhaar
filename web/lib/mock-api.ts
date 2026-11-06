// Mock implementations. Only lib/api.ts may import this file, and only when
// NEXT_PUBLIC_USE_MOCK=true (or for routes the backend doesn't have yet).
import { setAdminSession, setStoredRole } from "./auth";
import { ApiError, DuplicateInvoiceError } from "./errors";
import { RATE_BY_GRADE } from "./utils";
import {
  ACCOUNTS, companies, holdersByToken, invoices, investorKyc,
  kycRequests, pausedTokens, riskReports, transactions, unlockedReports,
} from "./mock";
import type {
  AgentPurchaseItem, AgentReportItem, AgentRules, AgentRun, AgentSkipItem,
  Company, Grade, Holder, InvestorSession, Invoice, KycRequest, Listing, PortfolioItem,
  ReportSettlement, RiskReport, TokenCatalog, Transaction, TransactionType, TokenInfo, TxResult,
  ChecklistItem, CompanyTrust, InvoiceTrust, MockEInvoice, MockEInvoiceRequest, PartyTrust,
  NavInfo, TrustFactor, TrustRepayment,
} from "./types";

const delay = (ms = 600) => new Promise((r) => setTimeout(r, ms));
const HASHSCAN = "https://hashscan.io/testnet";
let seq = 100;

function record(type: TransactionType, description: string, actor: string, invoiceId?: string): TxResult {
  seq += 1;
  const payer = `0.0.${11310000 + seq}`;
  const secs = Math.floor(Date.now() / 1000);
  const nanos = String(seq).padStart(9, "0");
  const txId = `${payer}@${secs}.${nanos}`;
  const hashscanUrl = `${HASHSCAN}/transaction/${payer}-${secs}-${nanos}`;
  const t: Transaction = { id: `t-${seq}`, type, description, actor, timestamp: new Date().toISOString(), hashscanUrl, invoiceId };
  transactions.unshift(t);
  return { txId, hashscanUrl };
}

const find = (id: string) => {
  const inv = invoices.find((i) => i.id === id);
  if (!inv) throw new Error(`Invoice ${id} not found`);
  return inv;
};
const setStatus = (inv: Invoice, status: Invoice["status"], url: string) => {
  inv.status = status;
  inv.hashscanUrl = url;
};
const daysTo = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000));
const unitPrice = (inv: Invoice) => Math.round((inv.unitFaceValue ?? 1000) * (1 - (inv.discountPct ?? 0) / 100) * 100) / 100;
const holdersOf = (inv: Invoice): Holder[] => (inv.tokenId ? (holdersByToken[inv.tokenId] ??= []) : []);
const available = (inv: Invoice) => (inv.totalUnits ?? 0) - (inv.retainedUnits ?? 0) - holdersOf(inv).reduce((s, x) => s + x.units, 0);
const clone = <T,>(v: T): T => structuredClone(v);

/* ───────── Shared ───────── */
export async function getCompanies(): Promise<Company[]> {
  await delay(200);
  return clone(companies);
}
export async function getInvoice(id: string): Promise<Invoice> {
  await delay(200);
  return clone(find(id));
}

/* ───────── Trust (all mock) ───────── */
const mockSignedInvoices = new Set<string>();
const inrShort = (n: number) => "₹" + n.toLocaleString("en-IN");

/** Per-company mock profile: points per factor, repayments on Hedera as [amount, daysLate], and outside facts. */
interface TrustSeed { pay: number; profile: number; obl: number; net: number; reps: [number, number][]; msme: number; complaints: number }
const TRUST_SEEDS: Record<string, TrustSeed> = {
  "0.0.11310319": { pay: 34, profile: 23, obl: 18, net: 13, reps: [[150000, 0], [220000, 0], [90000, 2], [310000, 0], [180000, 0]], msme: 0, complaints: 0 },
  "0.0.11310318": { pay: 22, profile: 19, obl: 17, net: 11, reps: [], msme: 0, complaints: 0 },
  "0.0.11400101": { pay: 26, profile: 18, obl: 12, net: 9, reps: [[200000, 0], [120000, 0]], msme: 600000, complaints: 1 },
  "0.0.11400102": { pay: 10, profile: 6, obl: 4, net: 5, reps: [], msme: 3200000, complaints: 4 },
};
const DEFAULT_SEED: TrustSeed = { pay: 24, profile: 16, obl: 14, net: 10, reps: [], msme: 0, complaints: 0 };
const seedOf = (id: string) => TRUST_SEEDS[id] ?? DEFAULT_SEED;

function trustRepayments(id: string): TrustRepayment[] {
  return seedOf(id).reps.map(([amount, daysLate], i) => {
    const due = new Date(Date.now() - (150 - i * 25) * 86_400_000);
    const paid = new Date(due.getTime() + daysLate * 86_400_000 - 3_600_000);
    const secs = Math.floor(paid.getTime() / 1000);
    return {
      invoiceId: `INV-00${10 + i}`, role: i % 2 ? "supplier" : "buyer", amount, dueDate: due.toISOString(), paidAt: paid.toISOString(),
      onTime: daysLate === 0, daysLate, transactionId: `0.0.${11300000 + i}@${secs}.000000001`,
      hashscanUrl: `${HASHSCAN}/transaction/0.0.${11300000 + i}-${secs}-000000001`,
    };
  });
}
const onTimeCount = (id: string) => trustRepayments(id).filter((r) => r.onTime).length;

function scoreOf(id: string) {
  const sd = seedOf(id);
  const reps = trustRepayments(id);
  const onTime = onTimeCount(id);
  const hasHistory = reps.length > 0;
  const f = (points: number, max: number, reason: string, source: TrustFactor["source"]): TrustFactor => ({ points, max, reason, source });
  const points = sd.pay + sd.profile + sd.obl + sd.net;
  return {
    score: 300 + 6 * points, points, newOnUdhaar: !hasHistory, label: hasHistory ? null : ("New on Udhaar" as const),
    breakdown: {
      paymentHistory: hasHistory
        ? f(sd.pay, 40, `${onTime} of ${reps.length} repayments confirmed on Hedera were on time.`, "hedera")
        : f(sd.pay, 40, "No repayments on Udhaar yet, so this comes from the mock bureau score.", "mock-external"),
      companyProfile: f(sd.profile, 25, "Company age, GST filing rate and size, from the mock registry.", "mock-external"),
      externalObligations: f(sd.obl, 20, sd.msme || sd.complaints ? `Mock MSME-1 dues of ${inrShort(sd.msme)} and ${sd.complaints} Samadhaan complaint(s) lower this.` : "No overdue MSME-1 dues or Samadhaan complaints in the mock data.", "mock-external"),
      network: f(sd.net, 15, "How promptly the company pays its other suppliers, from mock data.", "mock-external"),
    },
    limit: {
      perInvoiceInr: onTime >= 3 ? null : 100000, onTimeRepayments: onTime, required: 3,
      reason: onTime >= 3 ? "3 or more on-time repayments: no per-invoice cap." : `Capped at ₹1,00,000 per invoice until 3 on-time repayments (${onTime} so far).`,
    },
  };
}

const partyTrust = (id: string, name: string): PartyTrust => ({
  ...scoreOf(id), name, companyId: id, inDataset: true, repayments: trustRepayments(id),
});

export async function getInvoiceTrust(invoiceId: string): Promise<InvoiceTrust> {
  await delay(400);
  const inv = find(invoiceId);
  const seller = partyTrust(inv.supplierId, inv.supplierName);
  const buyer = partyTrust(inv.buyerId, inv.buyerName);
  const bs = seedOf(inv.buyerId);
  const signed = mockSignedInvoices.has(inv.id);
  const confirmed = !["submitted", "buyer_rejected"].includes(inv.status);
  const item = (id: string, label: string, status: ChecklistItem["status"], detail: string, source: ChecklistItem["source"], proofUrl?: string): ChecklistItem =>
    ({ id, label, status, detail, source, ...(proofUrl ? { proofUrl } : {}) });
  const checklist: ChecklistItem[] = [
    item("gstinValid", "GSTIN valid", "pass", "Both GSTINs have a valid format, state code and checksum.", "mock"),
    item("gstActive", "GST registration active", "pass", "Both companies are Active in the mock registry.", "mock"),
    item("nameMatches", "Name matches registry", "pass", `${inv.supplierName} and ${inv.buyerName} match their registry names.`, "mock"),
    item("gstFiling", "GST filing", bs.complaints > 2 ? "warn" : "pass", bs.complaints > 2 ? "Buyer filed 4 of the last 6 returns on time." : "5 of the last 6 returns were filed on time.", "mock"),
    item("udyam", "Udyam registration", "pass", "Seller's Udyam number has a valid format (format only, not looked up).", "mock"),
    signed
      ? item("eInvoice", "E-invoice signature", "pass", "Signed by the mock IRP and it still matches every field of this invoice.", "mock")
      : item("eInvoice", "E-invoice signature", "not_provided", "No signed e-invoice QR was sent with this invoice.", "mock"),
    inv.seeded
      ? item("buyerConfirmed", "Buyer confirmed on Hedera", "not_provided", "Simulated invoice: no chain record.", "hedera")
      : confirmed
        ? item("buyerConfirmed", "Buyer confirmed on Hedera", "pass", `Buyer's signed message is on the HCS confirmations topic (sequence #${1200 + inv.id.length * 7}).`, "hedera", inv.hashscanUrl)
        : item("buyerConfirmed", "Buyer confirmed on Hedera", "warn", "The buyer has not confirmed this invoice yet.", "hedera"),
    inv.seeded
      ? item("notFinancedBefore", "Not financed before", "not_provided", "Simulated invoice: no chain record.", "hedera")
      : item("notFinancedBefore", "Not financed before", "pass", "The fingerprint is in the HCS registry once, as this invoice.", "hedera", inv.hashscanUrl),
    item("amountNormal", "Amount looks normal", inv.amount > 350000 ? "warn" : "pass", inv.amount > 350000 ? "About 2.4 times this seller's median (simulated) invoice." : "In line with this seller's median (simulated) invoice.", "udhaar"),
    inv.id === "DEMO-RING"
      ? item("noFraudRing", "No fraud ring", "fail", "Billing loop found: buyer and seller share a director and an address.", "udhaar")
      : item("noFraudRing", "No fraud ring", "pass", "No billing loops, shared directors or shared address.", "udhaar"),
    item("buyerMsme1Dues", "Buyer's MSME-1 dues", bs.msme > 1000000 ? "fail" : bs.msme > 0 ? "warn" : "pass", bs.msme ? `Buyer owes ${inrShort(bs.msme)} to small suppliers for over 45 days (mock).` : "No dues over 45 days (mock).", "mock"),
    item("buyerSamadhaanComplaints", "Buyer's Samadhaan complaints", bs.complaints >= 3 ? "fail" : bs.complaints ? "warn" : "pass", bs.complaints ? `${bs.complaints} delayed-payment complaint(s) against the buyer (mock).` : "No delayed-payment complaints (mock).", "mock"),
  ];
  const count = (st: ChecklistItem["status"]) => checklist.filter((c) => c.status === st).length;
  const summary = { pass: count("pass"), warn: count("warn"), fail: count("fail"), notProvided: count("not_provided") };
  return clone({
    invoiceId, seeded: Boolean(inv.seeded), externalDataSource: "mock", seller, buyer, checklist, summary,
    overall: summary.fail ? "fail" : summary.warn ? "warn" : "pass", hashscanUrl: inv.hashscanUrl ?? `${HASHSCAN}/topic/0.0.7000001`,
  });
}

export async function getCompanyTrust(id: string): Promise<CompanyTrust> {
  await delay(350);
  const c = companies.find((x) => x.id === id || x.hederaAccount === id);
  if (!c) throw new ApiError("COMPANY_NOT_FOUND", `No company matches ${id}.`, 404);
  const sd = seedOf(c.id);
  return clone({
    ...scoreOf(c.id), companyId: c.id, name: c.name, inDataset: true, accounts: [c.hederaAccount], externalDataSource: "mock",
    externalProfile: {
      source: "mock", gstin: `27MOCK${c.id.slice(-4)}A1Z5`, udyam: c.type === "buyer" ? null : `UDYAM-MH-26-${c.id.slice(-7)}`,
      bureauScore: 560 + sd.pay * 7, msme1DuesOver45DaysInr: sd.msme, samadhaanComplaints: sd.complaints, gstFilingRegularity: c.gstFilingRate,
    },
    repayments: trustRepayments(c.id), hashscanUrl: `${HASHSCAN}/account/${c.hederaAccount}`,
  });
}

export async function getMockEInvoice(input: MockEInvoiceRequest): Promise<MockEInvoice> {
  await delay(600);
  if (!companies.some((c) => c.id === input.buyerId)) throw new ApiError("GSTIN_REQUIRED", "Choose a buyer first.", 422);
  const irn = Array.from(input.invoiceNumber).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, "0").repeat(8);
  const claims = { Irn: irn, DocNo: input.invoiceNumber, DocTyp: "INV", TotInvVal: input.amount, BuyerId: input.buyerId, iss: "MOCK-IRP", mock: true };
  return { source: "mock", irn, signedQr: `mock-irp.${btoa(JSON.stringify(claims))}.mock-signature`, claims };
}

/* ───────── Business ───────── */
export async function getBusinessInvoices(): Promise<Invoice[]> {
  await delay(300);
  return clone(invoices.filter((i) => i.supplierId === ACCOUNTS.business.companyId));
}

export async function getBusinessSummary() {
  await delay(300);
  const mine = invoices.filter((i) => i.supplierId === ACCOUNTS.business.companyId);
  const received = mine
    .filter((i) => i.status === "funded" || i.status === "repaid")
    .reduce((s, i) => s + Math.round(((i.totalUnits ?? 0) - (i.retainedUnits ?? 0)) * unitPrice(i)), 0);
  const pending = mine.filter((i) => !["funded", "repaid", "buyer_rejected"].includes(i.status)).reduce((s, i) => s + i.amount, 0);
  return { received, pending, invoiceCount: mine.length };
}

export async function uploadInvoice(input: { buyerId: string; amount: number; dueDate: string; pdfName: string; invoiceNumber?: string; signedQr?: string }): Promise<{ invoice: Invoice; tx: TxResult }> {
  await delay(900);
  for (const [party, id] of [["supplier", ACCOUNTS.business.companyId], ["buyer", input.buyerId]] as const) {
    if (onTimeCount(id) < 3 && input.amount > 100000) {
      throw new ApiError("TRUST_LIMIT_EXCEEDED", `New businesses can tokenize up to ₹1,00,000 per invoice until 3 on-time repayments (${party === "buyer" ? "the buyer is new" : "your business is new"}). Nothing was written.`, 422, { party, limit: 100000 });
    }
  }
  if (input.signedQr) {
    if (!input.invoiceNumber) throw new ApiError("EINVOICE_NEEDS_INVOICE_NUMBER", "invoiceNumber is required when a signed e-invoice QR is sent.", 422);
    let claims: Record<string, unknown>;
    try {
      const [head, body, sig] = input.signedQr.split(".");
      if (head !== "mock-irp" || sig !== "mock-signature") throw new Error("bad");
      claims = JSON.parse(atob(body)) as Record<string, unknown>;
    } catch {
      throw new ApiError("EINVOICE_SIGNATURE_INVALID", "The e-invoice signature is not valid: it was changed or not signed by the mock IRP. Get a new e-invoice. Nothing was written.", 422, { source: "mock" });
    }
    const mismatches = [
      ["invoice number", claims.DocNo, input.invoiceNumber],
      ["amount", claims.TotInvVal, input.amount],
      ["buyer", claims.BuyerId, input.buyerId],
    ].filter(([, a, b]) => a !== b).map(([field, expected, found]) => ({ field, expected, found }));
    if (mismatches.length) throw new ApiError("EINVOICE_MISMATCH", `The signed e-invoice doesn't match this invoice: ${mismatches.map((m) => `${m.field} (e-invoice says ${String(m.expected)}, form says ${String(m.found)})`).join("; ")}. Get a new e-invoice after changing the form. Nothing was written.`, 422, { source: "mock", mismatches });
  }
  const fingerprint = `sha256:${input.buyerId}-${input.amount}-${input.dueDate}`;
  const existing = invoices.find(
    (i) => i.supplierId === ACCOUNTS.business.companyId && i.buyerId === input.buyerId && i.amount === input.amount && i.dueDate.slice(0, 10) === input.dueDate && i.status !== "buyer_rejected",
  );
  if (existing) throw new DuplicateInvoiceError(existing.id, existing.hashscanUrl ?? `${HASHSCAN}/topic/0.0.7000001`);
  const buyer = companies.find((c) => c.id === input.buyerId);
  if (!buyer) throw new Error("Choose a buyer");
  const supplier = companies.find((c) => c.id === ACCOUNTS.business.companyId)!;
  const id = `INV-${String(48 + invoices.length).padStart(4, "0")}`;
  const tx = record("invoice_upload", `${id} fingerprint written to HCS registry`, "Business", id);
  const invoice: Invoice = {
    id, supplierId: supplier.id, supplierName: supplier.name, buyerId: buyer.id, buyerName: buyer.name,
    amount: input.amount, issueDate: new Date().toISOString(), dueDate: new Date(input.dueDate).toISOString(),
    status: "submitted", pdfName: input.pdfName, fingerprint, hashscanUrl: tx.hashscanUrl,
    invoiceNumber: input.invoiceNumber || undefined,
  };
  if (input.signedQr) mockSignedInvoices.add(id);
  invoices.unshift(invoice);
  return { invoice: clone(invoice), tx };
}

export async function getSuppliers(): Promise<Company[]> {
  await delay(200);
  return clone(companies.filter((c) => c.type !== "buyer" && c.id !== ACCOUNTS.business.companyId));
}

export async function getTransferableInvoices(): Promise<Invoice[]> {
  await delay(200);
  return clone(invoices.filter((i) => i.supplierId === ACCOUNTS.business.companyId && (i.retainedUnits ?? 0) > 0));
}

export async function paySupplierWithUnits(input: { invoiceId: string; supplierId: string; amount: number; units: number }): Promise<TxResult> {
  await delay(900);
  const inv = find(input.invoiceId);
  const sup = companies.find((c) => c.id === input.supplierId);
  if (!sup) throw new Error("Choose a supplier");
  if (!sup.kycVerified) throw new Error(`Transfer failed: ${sup.name} is not KYC-verified, so the token rejects the transfer.`);
  if (!Number.isInteger(input.units) || input.units <= 0) throw new Error("Units must be a positive whole number");
  if (input.units > (inv.retainedUnits ?? 0)) throw new Error(`You only hold ${inv.retainedUnits ?? 0} units of ${inv.id}`);
  inv.retainedUnits = (inv.retainedUnits ?? 0) - input.units;
  const holders = holdersOf(inv);
  const existing = holders.find((x) => x.accountId === sup.hederaAccount);
  if (existing) existing.units += input.units;
  else holders.push({ accountId: sup.hederaAccount, name: sup.name, units: input.units, amountPaid: input.amount, frozen: false });
  return record("units_transfer", `${input.units} units of ${inv.id} sent to ${sup.name} (₹${input.amount.toLocaleString("en-IN")})`, "Business", inv.id);
}

/* ───────── Buyer ───────── */
export async function getBuyerToConfirm(): Promise<Invoice[]> {
  await delay(300);
  return clone(invoices.filter((i) => i.buyerId === ACCOUNTS.buyer.companyId && i.status === "submitted"));
}
export async function getBuyerUpcoming(): Promise<Invoice[]> {
  await delay(300);
  return clone(invoices.filter((i) => i.buyerId === ACCOUNTS.buyer.companyId && ["buyer_confirmed", "risk_checked", "tokenized", "funded"].includes(i.status)));
}

export async function confirmInvoice(id: string): Promise<TxResult> {
  await delay(900);
  const inv = find(id);
  const tx = record("buyer_confirm", `${inv.buyerName} confirmed ${id}`, "Buyer", id);
  setStatus(inv, "buyer_confirmed", tx.hashscanUrl);
  // The risk engine runs right after confirmation in the real flow.
  const rep = riskReports[id];
  const days = Math.max(1, daysTo(inv.dueDate));
  if (rep) {
    inv.grade = rep.grade; inv.riskScore = rep.riskScore; inv.discountPct = rep.suggestedDiscountPct;
    inv.status = "risk_checked";
  } else {
    inv.grade = "B"; inv.riskScore = 70; inv.discountPct = Number(((RATE_BY_GRADE.B! * days) / 365).toFixed(4)); inv.status = "risk_checked";
  }
  return tx;
}
export async function rejectInvoice(id: string): Promise<TxResult> {
  await delay(900);
  const inv = find(id);
  const tx = record("buyer_reject", `${inv.buyerName} rejected ${id}`, "Buyer", id);
  setStatus(inv, "buyer_rejected", tx.hashscanUrl);
  return tx;
}
export async function payInvoice(id: string): Promise<TxResult> {
  await delay(1100);
  const inv = find(id);
  if (inv.status !== "funded") throw new Error("Only funded invoices can be paid at maturity");
  const tx = record("buyer_payment", `${inv.buyerName} paid ₹${inv.amount.toLocaleString("en-IN")} for ${id}; holders repaid`, "Buyer", id);
  setStatus(inv, "repaid", tx.hashscanUrl);
  return tx;
}

/* ───────── Investor ───────── */
export async function getMyKyc(): Promise<KycRequest | null> {
  await delay(250);
  return clone(investorKyc.current);
}
export async function submitKyc(input: { fullName: string; walletAddress: string; country: string }): Promise<KycRequest> {
  await delay(900);
  if (!/^0\.0\.\d+$/.test(input.walletAddress)) throw new Error("Wallet must look like 0.0.12345");
  const req: KycRequest = {
    id: `kyc-${seq++}`, ...input, status: "pending", submittedAt: new Date().toISOString(),
    walletScan: input.walletAddress === "0.0.666013" ? "flagged" : "clean",
    walletScanNote: input.walletAddress === "0.0.666013" ? "Known scam wallet" : undefined,
  };
  investorKyc.current = req;
  kycRequests.unshift(req);
  return clone(req);
}

export async function getListings(): Promise<Listing[]> {
  await delay(400);
  const toListing = (i: Invoice, blocked: boolean): Listing => ({
    invoiceId: i.id, buyerName: i.buyerName, amount: i.amount,
    returnPct: blocked ? 0 : Number((((i.unitFaceValue ?? 1000) / unitPrice(i) - 1) * 100).toFixed(2)),
    daysToMaturity: daysTo(i.dueDate), dueDate: i.dueDate, maturityDate: i.maturityDate ?? i.dueDate,
    annualRatePct: i.grade ? RATE_BY_GRADE[i.grade] : undefined, discountPct: i.discountPct,
    grade: i.grade, buyerTrustScore: scoreOf(i.buyerId).score, availableUnits: blocked ? 0 : available(i),
    unitPrice: blocked ? (i.unitFaceValue ?? 1000) : unitPrice(i), unitFaceValue: i.unitFaceValue ?? 1000, tokenId: i.tokenId, blocked,
  });
  const live = invoices.filter((i) => (i.status === "tokenized" || i.status === "funded") && i.tokenId && available(i) > 0 && i.grade && i.grade !== "D");
  const demo = invoices.filter((i) => i.seeded && i.grade === "D" && !i.tokenId);
  return clone([...live.map((i) => toListing(i, false)), ...demo.map((i) => toListing(i, true))]);
}
export async function getListing(invoiceId: string): Promise<Listing> {
  const l = (await getListings()).find((x) => x.invoiceId === invoiceId);
  if (!l) throw new Error("Listing not found or sold out");
  return l;
}

const mockSettlements = new Map<string, ReportSettlement>();
const mockAgentRuns: AgentRun[] = [];

export async function isReportUnlocked(invoiceId: string): Promise<RiskReport | null> {
  await delay(150);
  if (!unlockedReports.has(invoiceId)) return null;
  const s = mockSettlements.get(invoiceId);
  return s ? buildReport(invoiceId, s, true) : null;
}
function getOrDefaultReport(invoiceId: string): Omit<RiskReport, "paymentTx" | "hashscanUrl"> | undefined {
  if (riskReports[invoiceId]) return riskReports[invoiceId];
  if (invoiceId === "INV-0043" || invoiceId === "INV-0046") return undefined;
  const days = Math.max(1, daysTo(find(invoiceId).dueDate));
  return {
    invoiceId,
    riskScore: 85,
    grade: "A",
    confidence: "HIGH",
    creditRisk: "LOW",
    fraudFlags: [],
    anomaly: false,
    annualRatePct: RATE_BY_GRADE.A,
    daysToDue: days,
    suggestedDiscountPct: Number((((RATE_BY_GRADE.A ?? 12) * days) / 365).toFixed(4)),
    reasons: [
      "Buyer confirmed the invoice on Hedera Consensus Service",
      "Company active since 2003 with 99% GST filing compliance",
      "Invoice amount is in line with the buyer's usual orders",
      "No duplicate fingerprint or circular trading flags detected",
    ],
  };
}
function buildReport(invoiceId: string, settlement: ReportSettlement, replayed: boolean): RiskReport {
  const r = getOrDefaultReport(invoiceId);
  if (!r) throw new ApiError("RISK_UNAVAILABLE", "Risk service unavailable — nothing was charged.", 503);
  return {
    ...r,
    settlement,
    replayed,
    paymentTx: settlement.transactionId,
    hashscanUrl: settlement.hashscanUrl,
  };
}
export async function buyRiskReport(invoiceId: string): Promise<RiskReport> {
  await delay(1200);
  const r = getOrDefaultReport(invoiceId);
  if (!r) throw new ApiError("RISK_UNAVAILABLE", "Risk service unavailable — nothing was charged.", 503);
  const prev = mockSettlements.get(invoiceId);
  if (prev) return buildReport(invoiceId, prev, true);
  const tx = record("report_paid", `Paid ₹1.01 in uINR over x402 for risk report on ${invoiceId}`, "Investor", invoiceId);
  const settlement: ReportSettlement = {
    transactionId: tx.txId,
    hashscanUrl: tx.hashscanUrl,
    payer: ACCOUNTS.investor.accountId,
    payTo: "0.0.11310322",
    network: "hedera:testnet",
    token: "0.0.11327250",
    amount: 1,
    feeToPool: 0.01,
    onChainConfirmed: true,
    settledAt: new Date().toISOString(),
  };
  mockSettlements.set(invoiceId, settlement);
  unlockedReports.add(invoiceId);
  return buildReport(invoiceId, settlement, false);
}

export async function buyUnits(input: { invoiceId: string; units: number }): Promise<TxResult> {
  await delay(1000);
  if (investorKyc.current?.status !== "approved") throw new Error("Purchase rejected by the token: your wallet is not KYC-approved yet.");
  const inv = find(input.invoiceId);
  if (!Number.isInteger(input.units) || input.units <= 0) throw new Error("Units must be a positive whole number");
  if (inv.tokenId && pausedTokens[inv.tokenId]) throw new Error("Token is paused by the admin. Purchases are blocked.");
  const holders = holdersOf(inv);
  const me = holders.find((x) => x.accountId === ACCOUNTS.investor.accountId);
  if (me?.frozen) throw new Error("Your holding is frozen by the admin.");
  if (input.units > available(inv)) throw new Error(`Only ${available(inv)} units are available`);
  const cost = input.units * unitPrice(inv);
  if (me) { me.units += input.units; me.amountPaid += cost; }
  else holders.push({ accountId: ACCOUNTS.investor.accountId, name: ACCOUNTS.investor.name, units: input.units, amountPaid: cost, frozen: false });
  if (inv.status === "tokenized") inv.status = "funded";
  const tx = record("units_buy", `${ACCOUNTS.investor.name} bought ${input.units} units of ${inv.id} for ₹${cost.toLocaleString("en-IN")}`, "Investor", inv.id);
  inv.hashscanUrl = tx.hashscanUrl;
  return tx;
}

export async function getPortfolio(): Promise<PortfolioItem[]> {
  await delay(400);
  const out: PortfolioItem[] = [];
  for (const inv of invoices) {
    const me = holdersOf(inv).find((x) => x.accountId === ACCOUNTS.investor.accountId);
    if (me) out.push({
      invoiceId: inv.id, buyerName: inv.buyerName, units: me.units, amountPaid: me.amountPaid,
      expectedPayout: me.units * (inv.unitFaceValue ?? 1000), dueDate: inv.dueDate,
      grade: (inv.grade ?? "C") as Grade, repaid: inv.status === "repaid",
    });
  }
  return clone(out);
}

/* ───────── Admin ───────── */
export async function getKycRequests(): Promise<KycRequest[]> {
  await delay(300);
  return clone(kycRequests);
}
export async function reviewKyc(id: string, approve: boolean): Promise<TxResult> {
  await delay(900);
  const k = kycRequests.find((x) => x.id === id);
  if (!k) throw new Error("KYC request not found");
  if (approve && k.walletScan === "flagged") throw new Error("Wallet scan flagged this applicant. Reject instead.");
  k.status = approve ? "approved" : "rejected";
  const tx = record(approve ? "kyc_approve" : "kyc_reject", `${k.fullName} ${approve ? "added to" : "kept off"} the allowlist`, "Admin");
  k.hashscanUrl = tx.hashscanUrl;
  return tx;
}

export async function getAwaitingTokenization(): Promise<Invoice[]> {
  await delay(300);
  return clone(invoices.filter((i) => i.status === "risk_checked"));
}
export async function createToken(invoiceId: string, opts?: { maturityMinutes?: number }): Promise<TxResult> {
  void opts;
  await delay(1400);
  const inv = find(invoiceId);
  if (inv.grade === "D") {
    const rep = riskReports[invoiceId];
    record("risk_blocked", `Tokenization of ${inv.id} refused: grade D`, "Admin", inv.id);
    throw new ApiError("RISK_BLOCKED", `Tokenization blocked: grade D, refused by the risk engine (RISK_BLOCKED). Reasons: ${(rep?.reasons ?? []).join("; ")}.`, 409);
  }
  if (inv.status !== "risk_checked") throw new Error("Only risk-checked invoices can be tokenized");
  const tokenId = `0.0.${7001100 + invoices.indexOf(inv) + seq}`;
  inv.tokenId = tokenId;
  inv.totalUnits = Math.round(inv.amount / 1000);
  inv.unitFaceValue = 1000;
  inv.retainedUnits = 0;
  holdersByToken[tokenId] = [];
  const tx = record("token_create", `Token ${tokenId} created for ${inv.id}: ${inv.totalUnits} units of ₹1,000`, "Admin", inv.id);
  setStatus(inv, "tokenized", `${HASHSCAN}/token/${tokenId}`);
  return { ...tx, hashscanUrl: `${HASHSCAN}/token/${tokenId}` };
}

export async function getTokens(): Promise<TokenInfo[]> {
  await delay(300);
  return clone(
    invoices.filter((i) => i.tokenId).map((i): TokenInfo => ({
      tokenId: i.tokenId!, invoiceId: i.id, buyerName: i.buyerName, totalUnits: i.totalUnits ?? 0,
      unitFaceValue: i.unitFaceValue ?? 1000, maturityDate: i.maturityDate ?? i.dueDate, dueDate: i.dueDate, paused: !!pausedTokens[i.tokenId!],
      holders: holdersOf(i),
    })),
  );
}
export async function setTokenPaused(tokenId: string, paused: boolean): Promise<TxResult> {
  await delay(900);
  pausedTokens[tokenId] = paused;
  return record(paused ? "token_pause" : "token_unpause", `Token ${tokenId} ${paused ? "paused" : "unpaused"}`, "Admin");
}
export async function setHolderFrozen(tokenId: string, accountId: string, frozen: boolean): Promise<TxResult> {
  await delay(900);
  const holder = (holdersByToken[tokenId] ?? []).find((x) => x.accountId === accountId);
  if (!holder) throw new Error("Holder not found");
  holder.frozen = frozen;
  return record(frozen ? "holder_freeze" : "holder_unfreeze", `${holder.name} ${frozen ? "frozen" : "unfrozen"} on ${tokenId}`, "Admin");
}
export async function getAuditLog(): Promise<Transaction[]> {
  await delay(300);
  return clone(transactions);
}

export async function getTokenCatalog(): Promise<TokenCatalog> {
  await delay(150);
  const bonds = invoices
    .filter((i) => i.tokenId)
    .map((i) => ({
      tokenId: i.tokenId!,
      invoiceId: i.id,
      symbol: i.symbol,
      buyerName: i.buyerName,
      unitFaceValue: i.unitFaceValue ?? 1000,
    }));
  return { uinrTokenId: "0.0.11327250", bonds };
}

export async function loginDemoAdmin(passcode: string): Promise<{ ok: boolean }> {
  await delay(300);
  if (!passcode.trim()) throw new ApiError("INVALID_PASSCODE", "Wrong passcode", 401);
  setAdminSession({
    token: `mock-admin-${Date.now()}`,
    expiresAt: new Date(Date.now() + 1800 * 1000).toISOString(),
  });
  setStoredRole("admin");
  return { ok: true };
}

export async function loginDemoInvestor(): Promise<InvestorSession> {
  await delay(200);
  return {
    token: `mock-investor-${Date.now()}`,
    expiresAt: new Date(Date.now() + 1800 * 1000).toISOString(),
    expiresInSeconds: 1800,
    accountId: ACCOUNTS.investor.accountId,
    tokenType: "Bearer",
    hashscanUrl: `${HASHSCAN}/account/${ACCOUNTS.investor.accountId}`,
  };
}

export async function runAgent(rules: AgentRules): Promise<AgentRun> {
  await delay(1500);
  if (rules.reportBudget <= 0 || rules.reportBudget > 50) {
    throw new ApiError("VALIDATION_ERROR", "reportBudget must be between 1 and 50 rupees.", 400);
  }
  if (rules.investmentBudget <= 0 || rules.investmentBudget > 50000) {
    throw new ApiError("VALIDATION_ERROR", "investmentBudget must be between 1 and 50,000 rupees.", 400);
  }
  const startedAt = new Date().toISOString();
  const rank: Record<string, number> = { A: 3, B: 2, C: 1, D: 0 };
  const candidates = invoices.filter((i) => i.status === "tokenized" || i.status === "funded" || i.seeded);
  const invoicesChecked: string[] = [];
  const reports: AgentReportItem[] = [];
  const purchases: AgentPurchaseItem[] = [];
  const skipped: AgentSkipItem[] = [];
  let spentOnReports = 0;
  let spentOnUnits = 0;

  for (const inv of candidates) {
    if (!inv.seeded && available(inv) <= 0) continue;
    invoicesChecked.push(inv.id);
    if (spentOnReports + 1.01 > rules.reportBudget) {
      skipped.push({ invoiceId: inv.id, code: "REPORT_BUDGET_EXHAUSTED", reason: "Report budget left does not cover ₹1.01", paidForReport: false });
      continue;
    }
    const rep = await buyRiskReport(inv.id);
    spentOnReports = Number((spentOnReports + 1.01).toFixed(2));
    reports.push({
      invoiceId: inv.id,
      amount: 1,
      feeToPool: 0.01,
      transactionId: rep.settlement!.transactionId,
      hashscanUrl: rep.settlement!.hashscanUrl,
      grade: rep.grade,
      riskScore: rep.riskScore,
      fraudFlags: rep.fraudFlags,
      anomaly: rep.anomaly,
    });
    if (rep.fraudFlags.length > 0) {
      skipped.push({ invoiceId: inv.id, code: "FRAUD", reason: `Fraud flags: ${rep.fraudFlags.join(", ")}`, paidForReport: true });
      continue;
    }
    if (rep.anomaly) {
      skipped.push({ invoiceId: inv.id, code: "ANOMALY", reason: "Invoice carries an anomaly warning", paidForReport: true });
      continue;
    }
    if ((rank[rep.grade] ?? 0) < rank[rules.minGrade]) {
      skipped.push({ invoiceId: inv.id, code: "BELOW_MIN_GRADE", reason: `Grade ${rep.grade} is below minimum ${rules.minGrade}`, paidForReport: true });
      continue;
    }
    if (!inv.tokenId) {
      skipped.push({ invoiceId: inv.id, code: "NOT_BUYABLE", reason: "No token available to buy", paidForReport: true });
      continue;
    }
    const held = holdersOf(inv).find((h) => h.accountId === ACCOUNTS.investor.accountId)?.units ?? 0;
    const room = rules.maxUnitsPerInvoice - held;
    if (room <= 0) {
      skipped.push({ invoiceId: inv.id, code: "MAX_UNITS_REACHED", reason: `Already holds ${held} units`, paidForReport: true });
      continue;
    }
    const price = unitPrice(inv);
    const perUnitWithFee = price * 1.01;
    const affordable = Math.floor((rules.investmentBudget - spentOnUnits) / perUnitWithFee);
    const qty = Math.min(room, available(inv), affordable);
    if (qty <= 0) {
      skipped.push({ invoiceId: inv.id, code: "INVESTMENT_BUDGET_EXHAUSTED", reason: "Remaining investment budget cannot cover 1 unit + 1% fee", paidForReport: true });
      continue;
    }
    const tx = await buyUnits({ invoiceId: inv.id, units: qty });
    const amt = Number((qty * price).toFixed(2));
    const fee = Number((amt * 0.01).toFixed(2));
    spentOnUnits = Number((spentOnUnits + amt + fee).toFixed(2));
    purchases.push({
      invoiceId: inv.id,
      units: qty,
      unitPrice: price,
      amount: amt,
      feeToPool: fee,
      paymentHashscanUrl: tx.hashscanUrl,
      unitsHashscanUrl: tx.hashscanUrl,
    });
  }

  const auditTx = record("agent_run", `Auto-invest agent checked ${invoicesChecked.length} invoices, bought ${purchases.length}`, "Investor");
  const run: AgentRun = {
    runId: `run-${Date.now()}`,
    status: "completed",
    startedAt,
    finishedAt: new Date().toISOString(),
    investor: ACCOUNTS.investor.accountId,
    rules,
    invoicesChecked,
    reports,
    spentOnReports,
    purchases,
    spentOnUnits,
    skipped,
    auditTopicId: "0.0.11332556",
    auditMessages: [{ type: "run.completed", hashscanUrl: auditTx.hashscanUrl, txId: auditTx.txId }],
    hashscanUrl: `${HASHSCAN}/topic/0.0.11332556`,
  };
  mockAgentRuns.unshift(run);
  return clone(run);
}

export async function getAgentRuns(): Promise<AgentRun[]> {
  await delay(200);
  return clone(mockAgentRuns);
}

/* ───────── NAV feed ───────── */
const MOCK_NAV_TOPIC = "0.0.7002001";
export async function getNav(invoiceId: string): Promise<NavInfo> {
  await delay(300);
  const inv = find(invoiceId);
  if (!inv.tokenId) throw new ApiError("NOT_TOKENIZED", `${invoiceId} has not been tokenized, so it has no NAV`, 409);
  // INV-0047 stands for a bond tokenized before grades were saved.
  if (invoiceId === "INV-0047") throw new ApiError("NOT_PRICED", `${invoiceId} has no grade, so its NAV can't be worked out`, 409);
  const overdue = invoiceId === "INV-0045";
  const days = overdue ? -3 : invoiceId === "INV-0042" ? 90 : Math.max(0, daysTo(inv.dueDate));
  const rate = inv.grade ? (RATE_BY_GRADE[inv.grade] ?? 12) : 12;
  const face = inv.unitFaceValue ?? 1000;
  const nav = overdue ? null : invoiceId === "INV-0042" ? 970.41 : Math.round(face * (1 - (rate * days) / 36500) * 100) / 100;
  const msg = `${HASHSCAN}/transaction/1793958355.504763920`;
  return clone({
    invoiceId, bondTokenId: inv.tokenId, symbol: `UDH-${invoiceId.slice(-4)}`,
    status: overdue ? "overdue" : "active", faceValue: face, annualRatePct: rate, daysRemaining: days, nav,
    dueDate: inv.dueDate, asOf: new Date().toISOString(),
    topic: { id: MOCK_NAV_TOPIC, hashscanUrl: `${HASHSCAN}/topic/${MOCK_NAV_TOPIC}` },
    lastPublished: overdue ? null : {
      nav: nav ?? 0, daysRemaining: days, timestamp: new Date().toISOString(), topicId: MOCK_NAV_TOPIC,
      topicUrl: `${HASHSCAN}/topic/${MOCK_NAV_TOPIC}`, transactionId: "0.0.11227777-1793958348-649000000", hashscanUrl: msg,
    },
    hashscanUrl: msg, links: [],
  });
}

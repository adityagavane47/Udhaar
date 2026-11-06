// Mock implementations. Only lib/api.ts may import this file, and only when
// NEXT_PUBLIC_USE_MOCK=true (or for routes the backend doesn't have yet).
import { ApiError, DuplicateInvoiceError } from "./errors";
import { RATE_BY_GRADE } from "./utils";
import {
  ACCOUNTS, PAID_REPORT_FEE_USDC, companies, holdersByToken, invoices, investorKyc,
  kycRequests, pausedTokens, riskReports, transactions, unlockedReports,
} from "./mock";
import type {
  Company, Grade, Holder, Invoice, KycRequest, Listing, PortfolioItem, RiskReport,
  Transaction, TransactionType, TokenInfo, TxResult,
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

export async function uploadInvoice(input: { buyerId: string; amount: number; dueDate: string; pdfName: string; invoiceNumber?: string }): Promise<{ invoice: Invoice; tx: TxResult }> {
  await delay(900);
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
  };
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
    grade: i.grade, availableUnits: blocked ? 0 : available(i),
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

export async function isReportUnlocked(invoiceId: string): Promise<RiskReport | null> {
  await delay(150);
  return unlockedReports.has(invoiceId) ? buildReport(invoiceId, "already paid") : null;
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
function buildReport(invoiceId: string, tx: string): RiskReport {
  const r = getOrDefaultReport(invoiceId);
  if (!r) throw new Error("Risk service unavailable: no report returned, nothing was charged.");
  return { ...r, paymentTx: tx, hashscanUrl: `${HASHSCAN}/transaction/${tx}` };
}
export async function buyRiskReport(invoiceId: string): Promise<RiskReport> {
  await delay(1200);
  const r = getOrDefaultReport(invoiceId);
  if (!r) throw new Error("Risk service unavailable: no report returned, nothing was charged.");
  const tx = record("risk_report", `Paid ${PAID_REPORT_FEE_USDC} USDC for risk report on ${invoiceId}`, "Investor", invoiceId);
  unlockedReports.add(invoiceId);
  return { ...r, paymentTx: tx.txId, hashscanUrl: tx.hashscanUrl };
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

export async function loginDemoAdmin(passcode: string): Promise<{ ok: boolean }> {
  await delay(300);
  if (!passcode.trim()) throw new Error("Enter the demo passcode.");
  return { ok: true };
}


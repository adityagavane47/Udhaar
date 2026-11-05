// The ONLY file components talk to. Real backend calls by default; mock data
// (lib/mock-api.ts + lib/mock.ts) only when NEXT_PUBLIC_USE_MOCK=true.
import { ACCOUNTS, companies as mockCompanies } from "./mock";
import * as mock from "./mock-api";
import { ApiError, DuplicateInvoiceError } from "./errors";
import type {
  Company, Holder, Invoice, KycRequest, Listing, PortfolioItem, RepaymentHolder,
  Transaction, TokenInfo, TxResult,
} from "./types";

export { ApiError, DuplicateInvoiceError };

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "true";

/* ───────── HTTP helpers ───────── */

interface ErrorBody { error?: { code?: string; message?: string; originalId?: string; hashscanUrl?: string } & Record<string, unknown> }

/** No client-side timeout: tokenize takes about a minute and repay about 15 s per holder. */
async function http<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError("NETWORK_ERROR", `Cannot reach the backend at ${API_URL}. Start it with "cd backend && npm start".`);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const e = (json as ErrorBody | null)?.error;
    if (e?.code === "DUPLICATE_INVOICE") {
      throw new DuplicateInvoiceError(e.originalId, e.hashscanUrl ?? "", e.message ? `Duplicate invoice: already financed (${e.message})` : "Duplicate invoice: already financed.");
    }
    const msg = e?.code === "SUPPLIER_NOT_VERIFIED" || e?.code === "NOT_ALLOWLISTED"
      ? `Transfer blocked: recipient not verified (${e.message})`
      : (e?.message ?? `The backend returned an error (${res.status}).`);
    throw new ApiError(e?.code ?? `HTTP_${res.status}`, msg, res.status, e ?? {});
  }
  return json as T;
}

const post = async <T,>(path: string, body: unknown = {}): Promise<T> => {
  try { return await http<T>("POST", path, body); } finally { invoicesCache = null; }
};

interface TxResponse { hashscanUrl: string; tx?: { txId?: string } }
const txOf = (r: TxResponse): TxResult => ({ hashscanUrl: r.hashscanUrl, txId: r.tx?.txId ?? "" });

/** Reads are shared for 2 s so pages that ask several times don't hit the chain repeatedly. */
let invoicesCache: { at: number; p: Promise<Invoice[]> } | null = null;
function listInvoices(): Promise<Invoice[]> {
  if (invoicesCache && Date.now() - invoicesCache.at < 2000) return invoicesCache.p;
  const p = http<{ invoices: Invoice[] }>("GET", "/invoices").then((r) => r.invoices);
  invoicesCache = { at: Date.now(), p };
  p.catch(() => { if (invoicesCache?.p === p) invoicesCache = null; });
  return p;
}

interface HoldersResponse { invoiceId: string; tokenId: string | null; holders: Holder[]; repaidHolders: RepaymentHolder[] }
const getHolders = (id: string) => http<HoldersResponse>("GET", `/invoices/${encodeURIComponent(id)}/holders`);

const repaidToHolder = (h: RepaymentHolder): Holder => ({
  accountId: h.accountId, name: h.name, units: h.units, amountPaid: 0, frozen: false, repaid: true, hashscanUrl: h.paymentHashscanUrl,
});

const unitPriceOf = (i: Invoice) => i.unitPrice ?? Math.round((i.unitFaceValue ?? 1000) * (1 - (i.discountPct ?? 0) / 100));
const maturityOf = (i: Invoice) => i.maturityDate ?? i.dueDate;
const isLive = (i: Invoice) => (i.status === "tokenized" || i.status === "funded") && !!i.tokenId;

function toListing(i: Invoice): Listing {
  const face = i.unitFaceValue ?? 1000;
  const price = unitPriceOf(i);
  return {
    invoiceId: i.id, buyerName: i.buyerName, amount: i.amount,
    returnPct: Number(((face / price - 1) * 100).toFixed(1)),
    daysToMaturity: Math.max(0, Math.round((new Date(maturityOf(i)).getTime() - Date.now()) / 86_400_000)),
    grade: i.grade, // the backend has no risk engine yet, so this stays undefined
    availableUnits: i.availableUnits ?? i.retainedUnits ?? 0,
    unitPrice: price, unitFaceValue: face, tokenId: i.tokenId!,
  };
}

/** One idempotency key per (action, invoice, units) until it succeeds, so a retry never double-charges. */
const keys = new Map<string, string>();
async function withKey<T>(name: string, run: (key: string) => Promise<T>): Promise<T> {
  const key = keys.get(name) ?? crypto.randomUUID();
  keys.set(name, key);
  const out = await run(key);
  keys.delete(name);
  return out;
}

const unsupported = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} isn't supported by the backend yet.`);
};

/* ───────── Real implementation ───────── */

const real: typeof mock = {
  // Not in the backend yet: these stay on mock data.
  getCompanies: mock.getCompanies,
  buyRiskReport: mock.buyRiskReport,
  isReportUnlocked: mock.isReportUnlocked,
  rejectInvoice: unsupported("Rejecting an invoice"),

  async getSuppliers() {
    const [{ requests }, base] = await Promise.all([
      http<{ requests: KycRequest[] }>("GET", "/kyc"),
      mock.getSuppliers(),
    ]);
    const approved = new Set(requests.filter((k) => k.status === "approved").map((k) => k.walletAddress));
    const out: Company[] = base.map((c) => ({ ...c, kycVerified: approved.has(c.hederaAccount) }));
    for (const k of requests) {
      if (k.walletAddress === ACCOUNTS.business.accountId || k.walletAddress === ACCOUNTS.investor.accountId) continue;
      if (!out.some((c) => c.hederaAccount === k.walletAddress)) {
        out.push({
          id: k.walletAddress, name: k.fullName, type: "supplier", foundedYear: 2020,
          gstFilingRate: 0.9, city: "India", address: "", phone: "", hederaAccount: k.walletAddress, kycVerified: k.status === "approved",
        });
      }
    }
    return out;
  },

  async getInvoice(id) {
    return (await http<{ invoice: Invoice }>("GET", `/invoices/${encodeURIComponent(id)}`)).invoice;
  },

  /* Business */
  async getBusinessInvoices() {
    return (await listInvoices()).filter((i) => i.supplierId === ACCOUNTS.business.accountId);
  },
  async getBusinessSummary() {
    const mine = (await listInvoices()).filter((i) => i.supplierId === ACCOUNTS.business.accountId);
    // Derived: cash credited on sold units (investor payments plus units handed to suppliers).
    const credited = await Promise.all(
      mine.filter((i) => i.tokenId && (i.status === "funded" || i.status === "repaid")).map(async (i) => {
        const h = await getHolders(i.id);
        if (i.status === "repaid") return h.repaidHolders.filter((x) => x.accountId !== i.supplierId).reduce((s, x) => s + x.units, 0) * unitPriceOf(i);
        return h.holders.filter((x) => x.accountId !== i.supplierId).reduce((s, x) => s + x.amountPaid, 0);
      }),
    );
    return {
      received: credited.reduce((s, n) => s + n, 0),
      pending: mine.filter((i) => !["funded", "repaid", "buyer_rejected"].includes(i.status)).reduce((s, i) => s + i.amount, 0),
      invoiceCount: mine.length,
    };
  },
  async uploadInvoice(input) {
    const buyerName = mockCompanies.find((c) => c.hederaAccount === input.buyerId)?.name;
    const r = await post<TxResponse & { invoice: Invoice }>("/invoices", {
      buyerId: input.buyerId, buyerName, amount: input.amount, dueDate: input.dueDate,
      invoiceNumber: input.invoiceNumber || undefined, pdfName: input.pdfName,
    });
    return { invoice: r.invoice, tx: txOf(r) };
  },
  async getTransferableInvoices() {
    return (await listInvoices()).filter((i) => i.supplierId === ACCOUNTS.business.accountId && isLive(i) && (i.retainedUnits ?? 0) > 0);
  },
  async paySupplierWithUnits(input) {
    return withKey(`pay:${input.invoiceId}:${input.supplierId}:${input.units}`, async (idempotencyKey) =>
      txOf(await post<TxResponse>(`/invoices/${encodeURIComponent(input.invoiceId)}/pay-supplier`, {
        supplierId: input.supplierId, units: input.units, amount: input.amount, idempotencyKey,
      })));
  },

  /* Buyer */
  async getBuyerToConfirm() {
    return (await listInvoices()).filter((i) => i.buyerId === ACCOUNTS.buyer.accountId && i.status === "submitted");
  },
  async getBuyerUpcoming() {
    return (await listInvoices()).filter((i) => i.buyerId === ACCOUNTS.buyer.accountId && ["buyer_confirmed", "risk_checked", "tokenized", "funded"].includes(i.status));
  },
  async confirmInvoice(id) {
    return txOf(await post<TxResponse>(`/invoices/${encodeURIComponent(id)}/confirm`));
  },
  async payInvoice(id) {
    return txOf(await post<TxResponse>(`/invoices/${encodeURIComponent(id)}/repay`));
  },

  /* Investor */
  async getMyKyc() {
    const { requests } = await http<{ requests: KycRequest[] }>("GET", `/kyc?walletAddress=${ACCOUNTS.investor.accountId}`);
    return requests[0] ?? null;
  },
  async submitKyc(input) {
    return (await post<{ request: KycRequest }>("/kyc", input)).request;
  },
  async getListings() {
    return (await listInvoices()).filter((i) => isLive(i) && (i.availableUnits ?? i.retainedUnits ?? 0) > 0 && new Date(maturityOf(i)).getTime() > Date.now()).map(toListing);
  },
  async getListing(invoiceId) {
    const { invoice } = await http<{ invoice: Invoice }>("GET", `/invoices/${encodeURIComponent(invoiceId)}`);
    if (!isLive(invoice) || (invoice.availableUnits ?? invoice.retainedUnits ?? 0) <= 0) throw new Error("Listing not found or sold out");
    return toListing(invoice);
  },
  async buyUnits(input) {
    return withKey(`buy:${input.invoiceId}:${input.units}`, async (idempotencyKey) =>
      txOf(await post<TxResponse>(`/invoices/${encodeURIComponent(input.invoiceId)}/buy`, {
        units: input.units, investorId: ACCOUNTS.investor.accountId, idempotencyKey,
      })));
  },
  async getPortfolio() {
    const out: PortfolioItem[] = [];
    await Promise.all((await listInvoices()).filter((i) => i.tokenId).map(async (i) => {
      const h = await getHolders(i.id);
      const face = i.unitFaceValue ?? 1000;
      const mineNow = h.holders.find((x) => x.accountId === ACCOUNTS.investor.accountId);
      const mineRepaid = h.repaidHolders.find((x) => x.accountId === ACCOUNTS.investor.accountId);
      const units = mineNow?.units ?? mineRepaid?.units;
      if (!units) return;
      out.push({
        invoiceId: i.id, buyerName: i.buyerName, units, amountPaid: mineNow?.amountPaid ?? units * unitPriceOf(i),
        expectedPayout: units * face, dueDate: maturityOf(i), grade: i.grade, repaid: i.status === "repaid",
      });
    }));
    return out.sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));
  },

  /* Admin */
  async getKycRequests() {
    return (await http<{ requests: KycRequest[] }>("GET", "/kyc")).requests;
  },
  async reviewKyc(id, approve) {
    if (!approve) throw new Error("Rejecting a KYC request isn't supported by the backend yet.");
    return txOf(await post<TxResponse>(`/kyc/${encodeURIComponent(id)}/approve`));
  },
  async getAwaitingTokenization() {
    return (await listInvoices()).filter((i) => i.status === "buyer_confirmed" || i.status === "risk_checked");
  },
  async createToken(invoiceId, opts) {
    const r = await post<TxResponse>(`/invoices/${encodeURIComponent(invoiceId)}/tokenize`, opts?.maturityMinutes ? { maturityMinutes: opts.maturityMinutes } : {});
    return txOf(r);
  },
  async getTokens() {
    const [{ tokens }, invoices] = await Promise.all([
      http<{ tokens: TokenInfo[] }>("GET", "/tokens"),
      listInvoices(),
    ]);
    const out = await Promise.all(invoices.filter((i) => i.tokenId).map(async (i): Promise<TokenInfo | null> => {
      const live = tokens.find((t) => t.tokenId === i.tokenId);
      if (i.status === "repaid") {
        const h = await getHolders(i.id);
        return {
          tokenId: i.tokenId!, symbol: i.symbol, invoiceId: i.id, buyerName: i.buyerName, totalUnits: i.totalUnits ?? 0,
          unitFaceValue: i.unitFaceValue ?? 1000, maturityDate: maturityOf(i), paused: live?.paused ?? false,
          holders: h.repaidHolders.map(repaidToHolder), repaid: true, hashscanUrl: i.hashscanUrl,
        };
      }
      return live ?? null;
    }));
    return out.filter((t): t is TokenInfo => t !== null);
  },
  async setTokenPaused(tokenId, paused) {
    return txOf(await post<TxResponse>(`/tokens/${encodeURIComponent(tokenId)}/${paused ? "pause" : "unpause"}`));
  },
  async setHolderFrozen(tokenId, accountId, frozen) {
    return txOf(await post<TxResponse>(`/tokens/${encodeURIComponent(tokenId)}/${frozen ? "freeze" : "unfreeze"}`, { accountId }));
  },
  async getAuditLog(): Promise<Transaction[]> {
    return (await http<{ entries: Transaction[] }>("GET", "/audit")).entries;
  },
};

const impl: typeof mock = USE_MOCK ? mock : real;

export const {
  getCompanies, getInvoice, getBusinessInvoices, getBusinessSummary, uploadInvoice, getSuppliers,
  getTransferableInvoices, paySupplierWithUnits, getBuyerToConfirm, getBuyerUpcoming, confirmInvoice,
  rejectInvoice, payInvoice, getMyKyc, submitKyc, getListings, getListing, isReportUnlocked,
  buyRiskReport, buyUnits, getPortfolio, getKycRequests, reviewKyc, getAwaitingTokenization,
  createToken, getTokens, setTokenPaused, setHolderFrozen, getAuditLog,
} = impl;


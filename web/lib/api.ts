// The ONLY file components talk to. Real backend calls by default; mock data
// (lib/mock-api.ts + lib/mock.ts) only when NEXT_PUBLIC_USE_MOCK=true.
import { ACCOUNTS, companies as mockCompanies } from "./mock";
import * as mock from "./mock-api";
import { readAdminToken, setAdminToken } from "./auth";
import { ApiError, DuplicateInvoiceError } from "./errors";
import type {
  Company, Grade, Holder, Invoice, KycRequest, Listing, PortfolioItem, RepaymentHolder,
  RiskReport, Transaction, TokenInfo, TxResult,
} from "./types";
import { RATE_BY_GRADE } from "./utils";

export { ApiError, DuplicateInvoiceError };

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "true";

/* ───────── HTTP helpers ───────── */

interface ErrorBody { error?: { code?: string; message?: string; originalId?: string; hashscanUrl?: string } & Record<string, unknown> }

/** No client-side timeout: tokenize takes about a minute and repay about 15 s per holder. */
async function http<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const adminToken = readAdminToken();
  if (adminToken) headers["Authorization"] = `Bearer ${adminToken}`;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
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
    if (e?.code === "RISK_BLOCKED") {
      const reasons = Array.isArray(e.reasons) ? ` Reasons: ${(e.reasons as string[]).join("; ")}.` : "";
      throw new ApiError(e.code, `Tokenization blocked: grade D, refused by the risk engine (RISK_BLOCKED). ${e.message ?? ""}${reasons}`.trim(), res.status, e);
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

const unitPriceOf = (i: Invoice) => i.unitPrice ?? Math.round((i.unitFaceValue ?? 1000) * (1 - (i.discountPct ?? 0) / 100) * 100) / 100;
const maturityOf = (i: Invoice) => i.maturityDate ?? i.dueDate;
const isLive = (i: Invoice) => (i.status === "tokenized" || i.status === "funded") && !!i.tokenId;
const isBlockedDemo = (i: Invoice) => i.grade === "D" && !i.tokenId;

/** Grade from GET /risk/:id/summary, shared for a minute. undefined if the risk engine can't score it. */
const gradeCache = new Map<string, { at: number; p: Promise<Grade | undefined> }>();
function gradeOf(i: Invoice): Promise<Grade | undefined> {
  const hit = gradeCache.get(i.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = http<{ grade: Grade }>("GET", `/risk/${encodeURIComponent(i.id)}/summary`)
    .then((r) => r.grade)
    .catch(() => i.grade);
  gradeCache.set(i.id, { at: Date.now(), p });
  return p;
}
const withGrade = async (i: Invoice): Promise<Invoice> => (i.grade ? i : { ...i, grade: await gradeOf(i) });

function toListing(i: Invoice): Listing {
  const face = i.unitFaceValue ?? 1000;
  const blocked = isBlockedDemo(i);
  const price = blocked ? face : unitPriceOf(i);
  return {
    invoiceId: i.id, buyerName: i.buyerName, amount: i.amount,
    returnPct: blocked ? 0 : Number(((face / price - 1) * 100).toFixed(2)),
    daysToMaturity: Math.max(0, Math.round((new Date(maturityOf(i)).getTime() - Date.now()) / 86_400_000)),
    dueDate: i.dueDate,
    maturityDate: maturityOf(i),
    annualRatePct: i.grade ? RATE_BY_GRADE[i.grade] : undefined,
    discountPct: i.discountPct,
    grade: i.grade,
    availableUnits: blocked ? 0 : i.availableUnits ?? i.retainedUnits ?? 0,
    unitPrice: price, unitFaceValue: face, tokenId: i.tokenId, blocked,
  };
}

/** The full report is free until x402 is added, so one fetch is kept to show again later. */
const reports = new Map<string, RiskReport>();

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
  rejectInvoice: unsupported("Rejecting an invoice"),

  /** GET /risk/:id/report. No paywall yet, so no payment is made. */
  async buyRiskReport(invoiceId) {
    const r = await http<RiskReport>("GET", `/risk/${encodeURIComponent(invoiceId)}/report`);
    reports.set(invoiceId, r);
    return r;
  },
  async isReportUnlocked(invoiceId) {
    return reports.get(invoiceId) ?? null;
  },

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
    const mine = (await listInvoices()).filter((i) => i.supplierId === ACCOUNTS.business.accountId);
    return Promise.all(mine.map(withGrade));
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
    const all = await listInvoices();
    const live = all.filter((i) => isLive(i) && (i.availableUnits ?? i.retainedUnits ?? 0) > 0 && new Date(maturityOf(i)).getTime() > Date.now());
    // Only graded invoices are listed. The grade comes from the free risk summary.
    const graded = (await Promise.all(live.map(withGrade))).filter((i) => i.grade);
    const out = graded.map(toListing);
    const demo = all.find(isBlockedDemo);
    if (demo) out.push(toListing(demo));
    return out;
  },
  async getListing(invoiceId) {
    const { invoice } = await http<{ invoice: Invoice }>("GET", `/invoices/${encodeURIComponent(invoiceId)}`);
    if (isBlockedDemo(invoice)) return toListing(invoice);
    const graded = await withGrade(invoice);
    if (!isLive(graded) || !graded.grade || (graded.availableUnits ?? graded.retainedUnits ?? 0) <= 0) throw new Error("Listing not found or sold out");
    return toListing(graded);
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
    return txOf(await post<TxResponse>(`/kyc/${encodeURIComponent(id)}/${approve ? "approve" : "reject"}`));
  },
  async getAwaitingTokenization() {
    const queue = (await listInvoices()).filter((i) => i.status === "buyer_confirmed" || i.status === "risk_checked");
    return Promise.all(queue.map(withGrade));
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
          unitFaceValue: i.unitFaceValue ?? 1000, maturityDate: maturityOf(i), dueDate: i.dueDate, paused: live?.paused ?? false,
          holders: h.repaidHolders.map(repaidToHolder), repaid: true, hashscanUrl: i.hashscanUrl,
        };
      }
      return live ? { ...live, dueDate: i.dueDate } : null;
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
  async loginDemoAdmin(passcode: string): Promise<{ ok: boolean }> {
    try {
      const r = await http<{ ok?: boolean; token?: string; status?: string }>("POST", "/auth/demo-admin", { passcode });
      if (r && r.ok === false) throw new ApiError("AUTH_FAILED", "Invalid passcode.", 401);
      if (r?.token) setAdminToken(r.token);
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError && (e.code === "ROUTE_NOT_FOUND" || e.status === 404)) {
        throw new ApiError("ADMIN_LOGIN_UNAVAILABLE", "Admin login not available yet.", 404);
      }
      throw e;
    }
  },
};

const impl: typeof mock = USE_MOCK ? mock : real;

export const {
  getCompanies, getInvoice, getBusinessInvoices, getBusinessSummary, uploadInvoice, getSuppliers,
  getTransferableInvoices, paySupplierWithUnits, getBuyerToConfirm, getBuyerUpcoming, confirmInvoice,
  rejectInvoice, payInvoice, getMyKyc, submitKyc, getListings, getListing, isReportUnlocked,
  buyRiskReport, buyUnits, getPortfolio, getKycRequests, reviewKyc, getAwaitingTokenization,
  createToken, getTokens, setTokenPaused, setHolderFrozen, getAuditLog, loginDemoAdmin,
} = impl;


// The ONLY file components talk to. Real backend calls by default; mock data
// (lib/mock-api.ts + lib/mock.ts) only when NEXT_PUBLIC_USE_MOCK=true.
import { ACCOUNTS, companies as mockCompanies } from "./mock";
import * as mock from "./mock-api";
import {
  clearAdminSession,
  isInvestorSessionFresh,
  readAdminToken,
  readInvestorSession,
  readStoredRole,
  setAdminSession,
  setInvestorSession,
  setStoredRole,
} from "./auth";
import { ApiError, DuplicateInvoiceError } from "./errors";
import type {
  AgentRules,
  AgentRun,
  BondTokenMeta,
  Company,
  CompanyTrust,
  Grade,
  Holder,
  InvestorSession,
  Invoice,
  InvoiceTrust,
  KycRequest,
  Listing,
  MockEInvoice,
  NavInfo,
  PortfolioItem,
  RepaymentHolder,
  RiskReport,
  TokenCatalog,
  TokenInfo,
  Transaction,
  TxResult,
} from "./types";
import { RATE_BY_GRADE, fmtDateTime } from "./utils";

export { ApiError, DuplicateInvoiceError };

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "true";

/* ───────── HTTP & auth helpers ───────── */

interface ErrorObject extends Record<string, unknown> {
  code?: string;
  message?: string;
  reason?: string;
  originalId?: string;
  hashscanUrl?: string;
  retryAfterSeconds?: number;
  cap?: number;
  resetsAt?: string;
}

interface RawErrorBody {
  error?: ErrorObject | string;
  reason?: string;
  hashscanUrl?: string;
  links?: unknown;
}

type AuthHeader = { mode: "default" } | { mode: "none" } | { mode: "bearer"; token: string };

const INVESTOR_AUTH_CODES = new Set([
  "INVESTOR_TOKEN_REQUIRED",
  "INVESTOR_TOKEN_INVALID",
  "INVESTOR_TOKEN_EXPIRED",
]);

function formatErrorMessage(status: number, e: ErrorObject | undefined): string {
  const code = e?.code;
  if (status === 402 || code === "PAYMENT_REFUSED") {
    const detail =
      e?.message && e?.reason && e.message !== e.reason
        ? `${e.message} (${e.reason})`
        : e?.reason || e?.message;
    return `Payment refused${detail ? `: ${detail}` : ""} — nothing was charged.`;
  }
  if (code === "INSUFFICIENT_UINR") {
    const base = e?.message ?? "Insufficient uINR balance to cover the amount plus the 1% fee.";
    return /nothing was charged/i.test(base) ? base : `${base} (Nothing was charged.)`;
  }
  if (code === "RATE_LIMITED") {
    const wait =
      typeof e?.retryAfterSeconds === "number"
        ? ` Please wait ${e.retryAfterSeconds}s before trying again.`
        : "";
    return `${e?.message ?? "Rate limit reached."}${wait}`;
  }
  if (code === "AGENT_DAILY_CAP_REACHED") {
    const capPart = e?.cap != null ? ` (${e.cap} runs per UTC day)` : "";
    const resetPart =
      typeof e?.resetsAt === "string" && e.resetsAt
        ? ` Resets at ${fmtDateTime(e.resetsAt)}.`
        : "";
    return `${e?.message ?? `Daily agent cap reached${capPart}.`}${
      e?.message && e?.cap != null && !String(e.message).includes(String(e.cap)) ? capPart : ""
    }${resetPart}`;
  }
  if (code === "TRUST_LIMIT_EXCEEDED") {
    const who = e?.party === "buyer" ? " (the buyer is new)" : e?.party === "supplier" ? " (your business is new)" : "";
    return `New businesses can tokenize up to ₹1,00,000 per invoice until 3 on-time repayments${who}. Nothing was written.`;
  }
  if (code === "EINVOICE_MISMATCH") {
    const list = Array.isArray(e?.mismatches)
      ? (e.mismatches as { field: string; expected: unknown; found: unknown }[])
          .map((m) => `${m.field} (e-invoice says ${String(m.expected)}, form says ${String(m.found)})`)
          .join("; ")
      : "";
    return `The signed e-invoice doesn't match this invoice${list ? `: ${list}` : ""}. Get a new e-invoice after changing the form. Nothing was written.`;
  }
  if (code === "EINVOICE_SIGNATURE_INVALID") {
    return "The e-invoice signature is not valid: it was changed or not signed by the mock IRP. Get a new e-invoice. Nothing was written.";
  }
  if (code === "AGENT_RUN_IN_PROGRESS") {
    return e?.message ?? "An auto-invest agent run is already in progress. Wait for it to finish.";
  }
  if (
    code === "RISK_DATA_UNAVAILABLE" ||
    code === "RISK_UNAVAILABLE" ||
    code === "FACILITATOR_UNAVAILABLE" ||
    code === "PAYWALL_NOT_CONFIGURED"
  ) {
    const base = e?.message ?? "Risk or payment service is unavailable";
    return /nothing was charged/i.test(base) ? base : `${base} — nothing was charged.`;
  }
  if (
    code === "PAID_REQUEST_FAILED" ||
    code === "SETTLEMENT_MISMATCH" ||
    code === "SETTLEMENT_UNCONFIRMED"
  ) {
    const detail = e?.message ? ` (${e.message})` : code ? ` (${code})` : "";
    return `The payment may have gone through, and no report was returned${detail}.${
      e?.hashscanUrl ? " Check the HashScan link before paying again." : ""
    }`;
  }
  if (code === "SUPPLIER_NOT_VERIFIED" || code === "NOT_ALLOWLISTED") {
    return `Transfer blocked: recipient not verified (${e?.message ?? code})`;
  }
  return e?.message ?? `The backend returned an error (${status}).`;
}

/** No client-side timeout: tokenize takes ~1 min, agent runs take 1–2 min, and repay ~15 s per holder. */
async function http<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  auth: AuthHeader = { mode: "default" },
): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const adminToken = auth.mode === "default" ? readAdminToken() : null;
  const sentAdminToken = Boolean(adminToken);
  if (adminToken) headers["Authorization"] = `Bearer ${adminToken}`;
  if (auth.mode === "bearer") {
    headers["Authorization"] = `Bearer ${auth.token}`;
  }
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      "NETWORK_ERROR",
      `Cannot reach the backend at ${API_URL}. Start it with "cd backend && npm start".`,
    );
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    // Only clear the admin session when the request actually sent the admin token and got 401.
    if (res.status === 401 && sentAdminToken) {
      clearAdminSession();
      throw new ApiError(
        "ADMIN_SESSION_ENDED",
        "Admin session ended. Enter the Operator passcode again.",
        401,
      );
    }
    const raw = (json as RawErrorBody | null) ?? undefined;
    const e: ErrorObject | undefined =
      typeof raw?.error === "string"
        ? {
            code: res.status === 402 ? "PAYMENT_REFUSED" : `HTTP_${res.status}`,
            message: raw.error,
            reason: raw.reason,
            hashscanUrl: raw.hashscanUrl,
            links: raw.links,
          }
        : raw?.error;
    if (e?.code === "DUPLICATE_INVOICE") {
      throw new DuplicateInvoiceError(
        e.originalId,
        e.hashscanUrl ?? "",
        e.message
          ? `Duplicate invoice: already financed (${e.message})`
          : "Duplicate invoice: already financed.",
      );
    }
    if (e?.code === "RISK_BLOCKED") {
      const reasons = Array.isArray(e.reasons)
        ? ` Reasons: ${(e.reasons as string[]).join("; ")}.`
        : "";
      throw new ApiError(
        e.code,
        `Tokenization blocked: grade D, refused by the risk engine (RISK_BLOCKED). ${e.message ?? ""}${reasons}`.trim(),
        res.status,
        e,
      );
    }
    const msg = formatErrorMessage(res.status, e);
    throw new ApiError(e?.code ?? `HTTP_${res.status}`, msg, res.status, e ?? {});
  }
  return json as T;
}

const post = async <T,>(path: string, body: unknown = {}): Promise<T> => {
  try {
    return await http<T>("POST", path, body);
  } finally {
    invoicesCache = null;
  }
};

let inflightInvestorAuth: Promise<InvestorSession> | null = null;

async function fetchInvestorSession(): Promise<InvestorSession> {
  if (inflightInvestorAuth) return inflightInvestorAuth;
  inflightInvestorAuth = http<InvestorSession>("POST", "/auth/demo-investor", undefined, {
    mode: "none",
  })
    .then((r) => {
      const session: InvestorSession = {
        token: r.token,
        expiresAt: r.expiresAt,
        expiresInSeconds: r.expiresInSeconds,
        accountId: r.accountId,
        tokenType: r.tokenType ?? "Bearer",
        hashscanUrl: r.hashscanUrl,
        links: r.links,
      };
      setInvestorSession(session);
      return session;
    })
    .finally(() => {
      inflightInvestorAuth = null;
    });
  return inflightInvestorAuth;
}

async function ensureInvestorSession(): Promise<InvestorSession> {
  const existing = readInvestorSession();
  if (isInvestorSessionFresh(existing)) return existing;
  return fetchInvestorSession();
}

/**
 * Sends a POST with the investor session token ONLY (never the admin token).
 * Refreshes the session before calling if expired, and retries ONCE only on 401
 * INVESTOR_TOKEN_REQUIRED / INVESTOR_TOKEN_INVALID / INVESTOR_TOKEN_EXPIRED.
 */
async function investorPost<T>(
  path: string,
  bodyOrBuilder?: Record<string, unknown> | ((session: InvestorSession) => Record<string, unknown>),
): Promise<T> {
  const sendWith = (session: InvestorSession) => {
    const payload =
      typeof bodyOrBuilder === "function"
        ? (bodyOrBuilder as (s: InvestorSession) => unknown)(session)
        : bodyOrBuilder;
    return http<T>("POST", path, payload, { mode: "bearer", token: session.token });
  };
  try {
    const session = await ensureInvestorSession();
    try {
      return await sendWith(session);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && INVESTOR_AUTH_CODES.has(e.code)) {
        setInvestorSession(null);
        const fresh = await fetchInvestorSession();
        return await sendWith(fresh);
      }
      throw e;
    }
  } finally {
    invoicesCache = null;
  }
}

interface TxResponse {
  hashscanUrl: string;
  tx?: { txId?: string };
}
const txOf = (r: TxResponse): TxResult => ({
  hashscanUrl: r.hashscanUrl,
  txId: r.tx?.txId ?? "",
});

/** Reads are shared for 2 s so pages that ask several times don't hit the chain repeatedly. */
let invoicesCache: { at: number; p: Promise<Invoice[]> } | null = null;
function listInvoices(): Promise<Invoice[]> {
  if (invoicesCache && Date.now() - invoicesCache.at < 2000) return invoicesCache.p;
  const p = http<{ invoices: Invoice[] }>("GET", "/invoices").then((r) => r.invoices);
  invoicesCache = { at: Date.now(), p };
  p.catch(() => {
    if (invoicesCache?.p === p) invoicesCache = null;
  });
  return p;
}

interface HoldersResponse {
  invoiceId: string;
  tokenId: string | null;
  holders: Holder[];
  repaidHolders: RepaymentHolder[];
}
const getHolders = (id: string) =>
  http<HoldersResponse>("GET", `/invoices/${encodeURIComponent(id)}/holders`);

const repaidToHolder = (h: RepaymentHolder): Holder => ({
  accountId: h.accountId,
  name: h.name,
  units: h.units,
  amountPaid: 0,
  frozen: false,
  repaid: true,
  hashscanUrl: h.paymentHashscanUrl,
});

const unitPriceOf = (i: Invoice) =>
  i.unitPrice ??
  Math.round((i.unitFaceValue ?? 1000) * (1 - (i.discountPct ?? 0) / 100) * 100) / 100;
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
/** Buyer trust score from GET /trust/:id, shared for a minute. undefined if the trust service can't answer. */
const buyerScoreCache = new Map<string, { at: number; p: Promise<number | undefined> }>();
function buyerScoreOf(invoiceId: string): Promise<number | undefined> {
  const hit = buyerScoreCache.get(invoiceId);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = http<InvoiceTrust>("GET", `/trust/${encodeURIComponent(invoiceId)}`)
    .then((r) => r.buyer.score)
    .catch(() => undefined);
  buyerScoreCache.set(invoiceId, { at: Date.now(), p });
  return p;
}
const withGrade = async (i: Invoice): Promise<Invoice> =>
  i.grade ? i : { ...i, grade: await gradeOf(i) };

function toListing(i: Invoice): Listing {
  const face = i.unitFaceValue ?? 1000;
  const blocked = isBlockedDemo(i);
  const price = blocked ? face : unitPriceOf(i);
  return {
    invoiceId: i.id,
    buyerName: i.buyerName,
    amount: i.amount,
    returnPct: blocked ? 0 : Number(((face / price - 1) * 100).toFixed(2)),
    daysToMaturity: Math.max(
      0,
      Math.round((new Date(maturityOf(i)).getTime() - Date.now()) / 86_400_000),
    ),
    dueDate: i.dueDate,
    maturityDate: maturityOf(i),
    annualRatePct: i.grade ? RATE_BY_GRADE[i.grade] : undefined,
    discountPct: i.discountPct,
    grade: i.grade,
    availableUnits: blocked ? 0 : (i.availableUnits ?? i.retainedUnits ?? 0),
    unitPrice: price,
    unitFaceValue: face,
    tokenId: i.tokenId,
    blocked,
  };
}

/** Keeps reports returned with HTTP 200 from POST /risk/:id/buy-report during this session. */
const reports = new Map<string, RiskReport>();
if (typeof window !== "undefined") {
  window.addEventListener("udhaar-role-change", () => {
    if (!readStoredRole()) reports.clear();
  });
}

/** One idempotency key per click; retained only if 502 UNITS_PENDING needs a safe finish retry. */
const pendingUnitKeys = new Map<string, string>();
async function withClickKey<T>(
  name: string,
  keepOnCodes: Set<string>,
  run: (key: string) => Promise<T>,
): Promise<T> {
  const key = pendingUnitKeys.get(name) ?? crypto.randomUUID();
  try {
    const out = await run(key);
    pendingUnitKeys.delete(name);
    return out;
  } catch (e) {
    if (e instanceof ApiError && keepOnCodes.has(e.code)) {
      pendingUnitKeys.set(name, key);
    } else {
      pendingUnitKeys.delete(name);
    }
    throw e;
  }
}

const investorAccountId = () => readInvestorSession()?.accountId || ACCOUNTS.investor.accountId;

const unsupported = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} isn't supported by the backend yet.`);
};

/* ───────── Real implementation ───────── */

const real: typeof mock = {
  // Not in the backend yet: these stay on mock data.
  getCompanies: mock.getCompanies,
  rejectInvoice: unsupported("Rejecting an invoice"),

  /** POST /risk/:id/buy-report with investor token and no body. */
  async buyRiskReport(invoiceId) {
    const r = await investorPost<RiskReport>(`/risk/${encodeURIComponent(invoiceId)}/buy-report`);
    const mapped: RiskReport = {
      ...r,
      paymentTx: r.settlement?.transactionId,
      hashscanUrl: r.settlement?.hashscanUrl || r.hashscanUrl || undefined,
    };
    reports.set(invoiceId, mapped);
    return mapped;
  },
  async isReportUnlocked(invoiceId) {
    return reports.get(invoiceId) ?? null;
  },

  async getSuppliers() {
    const [{ requests }, base] = await Promise.all([
      http<{ requests: KycRequest[] }>("GET", "/kyc"),
      mock.getSuppliers(),
    ]);
    const approved = new Set(
      requests.filter((k) => k.status === "approved").map((k) => k.walletAddress),
    );
    const out: Company[] = base.map((c) => ({
      ...c,
      kycVerified: approved.has(c.hederaAccount),
    }));
    const invAcct = investorAccountId();
    for (const k of requests) {
      if (k.walletAddress === ACCOUNTS.business.accountId || k.walletAddress === invAcct) continue;
      if (!out.some((c) => c.hederaAccount === k.walletAddress)) {
        out.push({
          id: k.walletAddress,
          name: k.fullName,
          type: "supplier",
          foundedYear: 2020,
          gstFilingRate: 0.9,
          city: "India",
          address: "",
          phone: "",
          hederaAccount: k.walletAddress,
          kycVerified: k.status === "approved",
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
    const mine = (await listInvoices()).filter(
      (i) => i.supplierId === ACCOUNTS.business.accountId,
    );
    return Promise.all(mine.map(withGrade));
  },
  async getBusinessSummary() {
    const mine = (await listInvoices()).filter(
      (i) => i.supplierId === ACCOUNTS.business.accountId,
    );
    const credited = await Promise.all(
      mine
        .filter((i) => i.tokenId && (i.status === "funded" || i.status === "repaid"))
        .map(async (i) => {
          const h = await getHolders(i.id);
          if (i.status === "repaid") {
            return (
              h.repaidHolders
                .filter((x) => x.accountId !== i.supplierId)
                .reduce((s, x) => s + x.units, 0) * unitPriceOf(i)
            );
          }
          return h.holders
            .filter((x) => x.accountId !== i.supplierId)
            .reduce((s, x) => s + x.amountPaid, 0);
        }),
    );
    return {
      received: credited.reduce((s, n) => s + n, 0),
      pending: mine
        .filter((i) => !["funded", "repaid", "buyer_rejected"].includes(i.status))
        .reduce((s, i) => s + i.amount, 0),
      invoiceCount: mine.length,
    };
  },
  async uploadInvoice(input) {
    const buyerName = mockCompanies.find((c) => c.hederaAccount === input.buyerId)?.name;
    const r = await post<TxResponse & { invoice: Invoice }>("/invoices", {
      buyerId: input.buyerId,
      buyerName,
      amount: input.amount,
      dueDate: input.dueDate,
      invoiceNumber: input.invoiceNumber || undefined,
      pdfName: input.pdfName,
      signedQr: input.signedQr || undefined,
    });
    return { invoice: r.invoice, tx: txOf(r) };
  },
  async getTransferableInvoices() {
    return (await listInvoices()).filter(
      (i) =>
        i.supplierId === ACCOUNTS.business.accountId && isLive(i) && (i.retainedUnits ?? 0) > 0,
    );
  },
  async paySupplierWithUnits(input) {
    return withClickKey(
      `pay:${input.invoiceId}:${input.supplierId}:${input.units}`,
      new Set(),
      async (idempotencyKey) =>
        txOf(
          await post<TxResponse>(`/invoices/${encodeURIComponent(input.invoiceId)}/pay-supplier`, {
            supplierId: input.supplierId,
            units: input.units,
            amount: input.amount,
            idempotencyKey,
          }),
        ),
    );
  },

  /* Buyer */
  async getBuyerToConfirm() {
    return (await listInvoices()).filter(
      (i) => i.buyerId === ACCOUNTS.buyer.accountId && i.status === "submitted",
    );
  },
  async getBuyerUpcoming() {
    return (await listInvoices()).filter(
      (i) =>
        i.buyerId === ACCOUNTS.buyer.accountId &&
        ["buyer_confirmed", "risk_checked", "tokenized", "funded"].includes(i.status),
    );
  },
  async confirmInvoice(id) {
    return txOf(await post<TxResponse>(`/invoices/${encodeURIComponent(id)}/confirm`));
  },
  async payInvoice(id) {
    return txOf(await post<TxResponse>(`/invoices/${encodeURIComponent(id)}/repay`));
  },

  /* Investor */
  async getMyKyc() {
    const acct = investorAccountId();
    const { requests } = await http<{ requests: KycRequest[] }>(
      "GET",
      `/kyc?walletAddress=${encodeURIComponent(acct)}`,
    );
    return requests[0] ?? null;
  },
  async submitKyc(input) {
    return (await post<{ request: KycRequest }>("/kyc", input)).request;
  },
  async getListings() {
    const all = await listInvoices();
    const live = all.filter(
      (i) =>
        isLive(i) &&
        (i.availableUnits ?? i.retainedUnits ?? 0) > 0 &&
        new Date(maturityOf(i)).getTime() > Date.now(),
    );
    const graded = (await Promise.all(live.map(withGrade))).filter((i) => i.grade);
    const out = graded.map(toListing);
    const demo = all.find(isBlockedDemo);
    if (demo) out.push(toListing(demo));
    return Promise.all(out.map(async (l) => ({ ...l, buyerTrustScore: await buyerScoreOf(l.invoiceId) })));
  },
  async getListing(invoiceId) {
    const { invoice } = await http<{ invoice: Invoice }>(
      "GET",
      `/invoices/${encodeURIComponent(invoiceId)}`,
    );
    if (isBlockedDemo(invoice)) return toListing(invoice);
    const graded = await withGrade(invoice);
    if (
      !isLive(graded) ||
      !graded.grade ||
      (graded.availableUnits ?? graded.retainedUnits ?? 0) <= 0
    ) {
      throw new Error("Listing not found or sold out");
    }
    return toListing(graded);
  },
  async buyUnits(input) {
    return withClickKey(
      `buy:${input.invoiceId}:${input.units}`,
      new Set(["UNITS_PENDING"]),
      async (idempotencyKey) =>
        txOf(
          await investorPost<TxResponse>(
            `/invoices/${encodeURIComponent(input.invoiceId)}/buy`,
            (session) => ({
              units: input.units,
              investorId: session.accountId,
              idempotencyKey,
            }),
          ),
        ),
    );
  },
  async getPortfolio() {
    const acct = investorAccountId();
    const out: PortfolioItem[] = [];
    await Promise.all(
      (await listInvoices())
        .filter((i) => i.tokenId)
        .map(async (i) => {
          const h = await getHolders(i.id);
          const face = i.unitFaceValue ?? 1000;
          const mineNow = h.holders.find((x) => x.accountId === acct);
          const mineRepaid = h.repaidHolders.find((x) => x.accountId === acct);
          const units = mineNow?.units ?? mineRepaid?.units;
          if (!units) return;
          out.push({
            invoiceId: i.id,
            buyerName: i.buyerName,
            units,
            amountPaid: mineNow?.amountPaid ?? units * unitPriceOf(i),
            expectedPayout: units * face,
            dueDate: maturityOf(i),
            grade: i.grade,
            repaid: i.status === "repaid",
          });
        }),
    );
    return out.sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));
  },

  /* Trust */
  async getInvoiceTrust(invoiceId) {
    return http<InvoiceTrust>("GET", `/trust/${encodeURIComponent(invoiceId)}`);
  },
  async getNav(invoiceId) {
    return http<NavInfo>("GET", `/nav/${encodeURIComponent(invoiceId)}`);
  },
  async getCompanyTrust(id) {
    return http<CompanyTrust>("GET", `/trust/company/${encodeURIComponent(id)}`);
  },
  async getMockEInvoice(input): Promise<MockEInvoice> {
    return http<MockEInvoice>("POST", "/mock-irp/e-invoice", {
      supplierId: ACCOUNTS.business.accountId,
      buyerId: input.buyerId,
      invoiceNumber: input.invoiceNumber,
      amount: input.amount,
      date: input.date,
    });
  },

  /* Auto-invest agent */
  async runAgent(rules: AgentRules): Promise<AgentRun> {
    return investorPost<AgentRun>("/agent/run", {
      reportBudget: rules.reportBudget,
      investmentBudget: rules.investmentBudget,
      minGrade: rules.minGrade,
      maxUnitsPerInvoice: rules.maxUnitsPerInvoice,
    });
  },
  async getAgentRuns(): Promise<AgentRun[]> {
    return (await http<{ runs: AgentRun[] }>("GET", "/agent/runs")).runs;
  },

  /* Admin */
  async getKycRequests() {
    return (await http<{ requests: KycRequest[] }>("GET", "/kyc")).requests;
  },
  async reviewKyc(id, approve) {
    return txOf(
      await post<TxResponse>(`/kyc/${encodeURIComponent(id)}/${approve ? "approve" : "reject"}`),
    );
  },
  async getAwaitingTokenization() {
    const queue = (await listInvoices()).filter(
      (i) => i.status === "buyer_confirmed" || i.status === "risk_checked",
    );
    return Promise.all(queue.map(withGrade));
  },
  async createToken(invoiceId, opts) {
    const r = await post<TxResponse>(
      `/invoices/${encodeURIComponent(invoiceId)}/tokenize`,
      opts?.maturityMinutes ? { maturityMinutes: opts.maturityMinutes } : {},
    );
    return txOf(r);
  },
  async getTokens() {
    const [{ tokens }, invoices] = await Promise.all([
      http<{ tokens: TokenInfo[] }>("GET", "/tokens"),
      listInvoices(),
    ]);
    const out = await Promise.all(
      invoices
        .filter((i) => i.tokenId)
        .map(async (i): Promise<TokenInfo | null> => {
          const live = tokens.find((t) => t.tokenId === i.tokenId);
          if (i.status === "repaid") {
            const h = await getHolders(i.id);
            return {
              tokenId: i.tokenId!,
              symbol: i.symbol,
              invoiceId: i.id,
              buyerName: i.buyerName,
              totalUnits: i.totalUnits ?? 0,
              unitFaceValue: i.unitFaceValue ?? 1000,
              maturityDate: maturityOf(i),
              dueDate: i.dueDate,
              paused: live?.paused ?? false,
              holders: h.repaidHolders.map(repaidToHolder),
              repaid: true,
              hashscanUrl: i.hashscanUrl,
            };
          }
          return live ? { ...live, dueDate: i.dueDate } : null;
        }),
    );
    return out.filter((t): t is TokenInfo => t !== null);
  },
  async setTokenPaused(tokenId, paused) {
    return txOf(
      await post<TxResponse>(
        `/tokens/${encodeURIComponent(tokenId)}/${paused ? "pause" : "unpause"}`,
      ),
    );
  },
  async setHolderFrozen(tokenId, accountId, frozen) {
    return txOf(
      await post<TxResponse>(
        `/tokens/${encodeURIComponent(tokenId)}/${frozen ? "freeze" : "unfreeze"}`,
        { accountId },
      ),
    );
  },
  async getAuditLog(): Promise<Transaction[]> {
    return (await http<{ entries: Transaction[] }>("GET", "/audit")).entries;
  },
  async getTokenCatalog(): Promise<TokenCatalog> {
    const [balRes, x402Res, invs, tokRes] = await Promise.all([
      http<{ uinrTokenId?: string }>("GET", "/balances").catch(() => null),
      http<{ services?: { token?: string }[] }>("GET", "/.well-known/x402").catch(() => null),
      listInvoices().catch(() => [] as Invoice[]),
      http<{ tokens?: TokenInfo[] }>("GET", "/tokens").catch(() => null),
    ]);
    const uinrTokenId =
      balRes?.uinrTokenId || x402Res?.services?.[0]?.token || null;
    const byToken = new Map<string, BondTokenMeta>();
    for (const i of invs) {
      if (!i.tokenId) continue;
      byToken.set(i.tokenId, {
        tokenId: i.tokenId,
        invoiceId: i.id,
        symbol: i.symbol,
        buyerName: i.buyerName,
        unitFaceValue: i.unitFaceValue ?? 1000,
      });
    }
    for (const t of tokRes?.tokens ?? []) {
      if (!t.tokenId) continue;
      const existing = byToken.get(t.tokenId);
      const holders = (t.holders ?? []).map((h) => ({
        accountId: h.accountId,
        units: h.units,
      }));
      byToken.set(t.tokenId, {
        tokenId: t.tokenId,
        invoiceId: existing?.invoiceId || t.invoiceId,
        symbol: existing?.symbol || t.symbol,
        buyerName: existing?.buyerName || t.buyerName,
        unitFaceValue: existing?.unitFaceValue ?? t.unitFaceValue ?? 1000,
        holders,
      });
    }
    if (!uinrTokenId && byToken.size === 0) {
      return mock.getTokenCatalog();
    }
    return { uinrTokenId, bonds: Array.from(byToken.values()) };
  },
  async loginDemoAdmin(passcode: string): Promise<{ ok: boolean }> {
    let res: Response;
    try {
      res = await fetch(`${API_URL}/auth/demo-admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
        cache: "no-store",
      });
    } catch {
      throw new ApiError("NETWORK_ERROR", "Backend not reachable", 0);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError("BAD_RESPONSE", "Unexpected response from server", res.status);
    }
    if (res.status === 401) {
      throw new ApiError("INVALID_PASSCODE", "Wrong passcode", 401);
    }
    if (!res.ok) {
      const raw = (json as RawErrorBody | null) ?? undefined;
      const e = typeof raw?.error === "object" ? raw.error : undefined;
      throw new ApiError(
        e?.code ?? `HTTP_${res.status}`,
        e?.message ?? "Unexpected response from server",
        res.status,
      );
    }
    const r = json as { ok?: boolean; token?: string; expiresAt?: string } | null;
    if (r?.ok === false) {
      throw new ApiError("INVALID_PASSCODE", "Wrong passcode", 401);
    }
    if (
      !r ||
      typeof r.token !== "string" ||
      !r.token ||
      typeof r.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(r.expiresAt)) ||
      Date.parse(r.expiresAt) <= Date.now()
    ) {
      throw new ApiError("BAD_RESPONSE", "Unexpected response from server", 200);
    }
    setAdminSession({ token: r.token, expiresAt: r.expiresAt });
    setStoredRole("admin");
    return { ok: true };
  },
  async loginDemoInvestor(): Promise<InvestorSession> {
    return fetchInvestorSession();
  },
};

const impl: typeof mock = USE_MOCK ? mock : real;

export const {
  getCompanies,
  getInvoice,
  getBusinessInvoices,
  getBusinessSummary,
  uploadInvoice,
  getSuppliers,
  getTransferableInvoices,
  paySupplierWithUnits,
  getBuyerToConfirm,
  getBuyerUpcoming,
  confirmInvoice,
  rejectInvoice,
  payInvoice,
  getMyKyc,
  submitKyc,
  getListings,
  getListing,
  isReportUnlocked,
  buyRiskReport,
  buyUnits,
  getPortfolio,
  runAgent,
  getAgentRuns,
  getInvoiceTrust,
  getNav,
  getCompanyTrust,
  getMockEInvoice,
  getKycRequests,
  reviewKyc,
  getAwaitingTokenization,
  createToken,
  getTokens,
  setTokenPaused,
  setHolderFrozen,
  getAuditLog,
  getTokenCatalog,
  loginDemoAdmin,
  loginDemoInvestor,
} = impl;

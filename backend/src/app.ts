import { existsSync, readFileSync } from "node:fs";
import cors from "cors";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { read } from "./ats/bond.js";
import { startAgentRun } from "./agent/agent.js";
import { loginAdmin, requireAdmin, requireInvestor, startInvestorSession } from "./auth.js";
import { config, fromBaseUnits, hashscan, uinrFeeBaseUnits } from "./config.js";
import { ApiError } from "./errors.js";
import { allParties, getParty } from "./hedera/client.js";
import { getAccount } from "./hedera/mirror.js";
import { accountName, buyUnits, confirmInvoice, createInvoice, getInvoice, holdersOf, invoiceView, paySupplier, tokenizeInvoice } from "./invoices.js";
import { approveKyc, ensureWalletCheck, liveInvoices, rejectKyc, submitKyc } from "./kyc.js";
import { limits } from "./limits.js";
import { navForReport, navView, publishNav } from "./nav.js";
import { repayInvoice } from "./repayment.js";
import { loadDataset } from "./risk/dataset.js";
import { isSeededInvoiceId, marketplaceDemoInvoice, riskReport, riskSummary, seededInvoiceView } from "./risk/service.js";
import { serialized, state } from "./store.js";
import { freezeHolder, listTokens, pauseToken, unfreezeHolder, unpauseToken } from "./tokens.js";
import type { Link } from "./types.js";
import { publicKeyRecord, signEInvoice } from "./trust/irp.js";
import { validateGstin } from "./trust/gstin.js";
import { companyTrust, gstinOf, invoiceTrust } from "./trust/service.js";
import { uinrBalance } from "./uinr.js";
import { assertQuoteAllowed, payForReport, QuoteRefused, ReportCallError } from "./x402/client.js";
import { chargeForReport, reportPayTo, serviceManifest, settlementOf } from "./x402/paywall.js";

/** Roles whose accounts can confirm and repay invoices as a buyer. The server signs with the role's own key. */
const BUYER_ROLES = ["BUYER", "APEX", "NOVA"] as const;

const accountId = z.string().regex(/^0\.0\.\d+$/, "must look like 0.0.12345");
const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be a valid date");
const positiveInt = z.number().int().positive();

const schemas = {
  login: z.object({ passcode: z.string().min(1) }),
  invoice: z.object({
    supplierId: accountId.optional(),
    buyerId: accountId.optional(),
    supplierName: z.string().min(1).optional(),
    buyerName: z.string().min(1).optional(),
    amount: positiveInt,
    dueDate: isoDate,
    issueDate: isoDate.optional(),
    invoiceNumber: z.string().min(1).optional(),
    pdfName: z.string().min(1).optional(),
    signedQr: z.string().min(1).optional(),
  }),
  eInvoice: z.object({
    supplierId: z.string().min(1).optional(),
    buyerId: z.string().min(1).optional(),
    sellerGstin: z.string().min(1).optional(),
    buyerGstin: z.string().min(1).optional(),
    invoiceNumber: z.string().min(1),
    amount: z.number().positive(),
    date: isoDate.optional(),
  }),
  // Strict, because the discount comes from the risk grade and a sent one must not look accepted.
  tokenize: z.strictObject({
    demoMaturity: z.boolean().optional(),
    maturityMinutes: z.number().positive().optional(),
    maturityDate: isoDate.optional(),
    unitFaceValue: positiveInt.optional(),
  }),
  kyc: z.object({ fullName: z.string().min(1), walletAddress: accountId, country: z.string().min(1) }),
  buy: z.object({ investorId: accountId.optional(), units: positiveInt, idempotencyKey: z.string().min(1).optional() }),
  paySupplier: z.object({ supplierId: accountId, units: positiveInt, amount: z.number().positive().optional(), idempotencyKey: z.string().min(1).optional() }),
  freeze: z.object({ accountId, units: positiveInt.optional() }),
  approveKyc: z.strictObject({ confirmWarnings: z.boolean().optional() }),
  navPublish: z.strictObject({ invoiceId: z.string().min(1).optional() }),
  // Strict, so a misspelled limit is refused rather than ignored.
  agentRules: z.strictObject({
    reportBudget: z.number().positive().max(config.agentMaxReportBudget),
    investmentBudget: z.number().positive().max(config.agentMaxInvestmentBudget),
    minGrade: z.enum(["A", "B", "C"]),
    maxUnitsPerInvoice: positiveInt,
  }),
};

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`);
  throw new ApiError(400, "VALIDATION_ERROR", issues.join("; "), { issues });
}

const param = (req: Request, name: string) => String(req.params[name]);

/** Every state-changing route runs one at a time. See serialized() in store.ts. */
const mutation = (status: number, work: (req: Request) => Promise<object>): RequestHandler =>
  async (req, res) => {
    res.status(status).json(await serialized(() => work(req)));
  };

function knownTopics(): { registryTopicId: string; confirmationTopicId: string; agentAuditTopicId?: string; navTopicId?: string } | undefined {
  return existsSync(config.hcsRecordPath) ? JSON.parse(readFileSync(config.hcsRecordPath, "utf8")) : undefined;
}

function topicLinks(): Link[] {
  const topics = knownTopics();
  return topics
    ? [
        { label: "HCS invoice registry", url: hashscan.topic(topics.registryTopicId) },
        { label: "HCS buyer confirmations", url: hashscan.topic(topics.confirmationTopicId) },
        ...(topics.agentAuditTopicId ? [{ label: "HCS agent audit log", url: hashscan.topic(topics.agentAuditTopicId) }] : []),
        ...(topics.navTopicId ? [{ label: "HCS NAV feed", url: hashscan.topic(topics.navTopicId) }] : []),
      ]
    : [];
}

/** The server pays its own paywall with the investor's key. A report already bought isn't charged for again. */
async function buyReportAsInvestor(invoiceId: string) {
  const investor = await getParty("INVESTOR");
  const earlier = Object.values(state.reportPayments).find((payment) => payment.invoiceId === invoiceId && payment.payer === investor.id);
  if (earlier) {
    const report = await riskReport(invoiceId);
    const settlement = settlementOf(earlier);
    return { ...report, nav: navForReport(invoiceId), settlement, replayed: true, hashscanUrl: settlement.hashscanUrl, links: [{ label: "x402 settlement", url: settlement.hashscanUrl, txId: settlement.transactionId }, ...report.links] };
  }

  const cost = config.reportPriceBaseUnits + uinrFeeBaseUnits(config.reportPriceBaseUnits);
  const held = await uinrBalance(investor.id);
  if (held < cost) throw new ApiError(422, "INSUFFICIENT_UINR", `${investor.name} holds ${fromBaseUnits(held)} uINR but a report costs ${fromBaseUnits(cost)} including the 1% fee`, { hashscanUrl: hashscan.account(investor.id) });

  try {
    const paid = await payForReport<object>(`${config.selfUrl}/risk/${encodeURIComponent(invoiceId)}/report`, investor, (quote) => assertQuoteAllowed(quote, reportPayTo(), config.uinrTokenId));
    return { ...paid, replayed: false };
  } catch (error) {
    if (error instanceof ReportCallError) throw new ApiError(error.status, error.code, error.message, error.details);
    if (error instanceof QuoteRefused) throw new ApiError(502, error.code, error.message, { hashscanUrl: hashscan.account(investor.id) });
    throw error;
  }
}

async function balances() {
  const parties = await allParties();
  const accounts = [
    ...parties.map((party) => ({ accountId: party.id, name: party.name, role: party.role })),
    ...Object.values(state.kyc)
      .filter((request) => !parties.some((party) => party.id === request.walletAddress))
      .map((request) => ({ accountId: request.walletAddress, name: accountName(request.walletAddress), role: "KYC_WALLET" })),
  ];
  const live = liveInvoices();
  const rows = [];
  for (const entry of accounts) {
    const account = await getAccount(entry.accountId);
    const bonds = [];
    for (const invoice of live) {
      const bond = invoice.tokenization?.bond;
      if (!bond || !account) continue;
      bonds.push({
        invoiceId: invoice.id,
        symbol: bond.symbol,
        tokenId: bond.contractId,
        units: Number(await read<bigint>(bond, "balanceOf(address)", [account.evm_address])),
        frozenUnits: Number(await read<bigint>(bond, "getFrozenTokens(address)", [account.evm_address])),
        hashscanUrl: hashscan.contract(bond.contractId),
      });
    }
    rows.push({
      ...entry,
      hbar: (account?.balance.balance ?? 0) / 1e8,
      uinr: fromBaseUnits(await uinrBalance(entry.accountId)),
      bonds,
      hashscanUrl: hashscan.account(entry.accountId),
    });
  }
  return rows;
}

export function createApp() {
  const app = express();
  if (config.trustProxyHops > 0) app.set("trust proxy", config.trustProxyHops);
  app.use(cors({ exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", network: "testnet", demo: { shortMaturityMinutes: config.demoShortMaturityMinutes }, hashscanUrl: hashscan.token(config.uinrTokenId), links: [{ label: "uINR token", url: hashscan.token(config.uinrTokenId) }, ...topicLinks()] });
  });

  // Auth
  app.post("/auth/demo-admin", limits.login, (req, res) => {
    const session = loginAdmin(parse(schemas.login, req.body).passcode);
    res.json({ ok: true, ...session, tokenType: "Bearer", hashscanUrl: hashscan.token(config.uinrTokenId), links: [{ label: "uINR token", url: hashscan.token(config.uinrTokenId) }] });
  });

  app.post("/auth/demo-investor", limits.investorSession, (_req, res) => {
    const session = startInvestorSession();
    res.json({ ok: true, ...session, tokenType: "Bearer", hashscanUrl: hashscan.account(session.accountId), links: [{ label: "Investor account", url: hashscan.account(session.accountId) }] });
  });

  // Invoices
  app.post(
    "/invoices",
    limits.hbar,
    mutation(201, async (req) => {
      const input = parse(schemas.invoice, req.body);
      const supplierId = input.supplierId ?? process.env.BUSINESS_ID?.trim();
      const buyerId = input.buyerId ?? process.env.BUYER_ID?.trim();
      if (!supplierId || !buyerId) throw new ApiError(422, "MISSING_PARTY", "supplierId and buyerId are required");
      const result = await createInvoice({ ...input, supplierId, buyerId });
      return { ...result, hashscanUrl: result.tx.hashscanUrl, links: result.invoice.links };
    }),
  );
  app.post(
    "/invoices/:id/confirm",
    limits.hbar,
    mutation(200, async (req) => {
      const result = await confirmInvoice(param(req, "id"));
      return { ...result, hashscanUrl: result.tx.hashscanUrl, links: result.invoice.links };
    }),
  );
  app.post(
    "/invoices/:id/tokenize",
    requireAdmin,
    limits.tokenize,
    mutation(201, async (req) => {
      const result = await tokenizeInvoice(param(req, "id"), parse(schemas.tokenize, req.body));
      return { ...result, hashscanUrl: result.tx.hashscanUrl, links: result.invoice.links };
    }),
  );
  app.post(
    "/invoices/:id/buy",
    requireInvestor,
    limits.hbar,
    mutation(201, async (req) => {
      const input = parse(schemas.buy, req.body);
      const investorId = process.env.INVESTOR_ID?.trim();
      if (!investorId) throw new ApiError(503, "INVESTOR_NOT_CONFIGURED", "INVESTOR_ID is not set on the server");
      // The session stands for one persona, so it can't spend from another account the server holds keys for.
      if (input.investorId && input.investorId !== investorId) throw new ApiError(403, "NOT_THE_SESSION_INVESTOR", `This session can only buy as ${investorId}`, { hashscanUrl: hashscan.account(investorId) });
      const result = await buyUnits(param(req, "id"), { ...input, investorId });
      return { ...result, hashscanUrl: result.tx.hashscanUrl, links: result.links ?? result.invoice.links };
    }),
  );
  app.post(
    "/invoices/:id/pay-supplier",
    limits.hbar,
    mutation(201, async (req) => {
      const result = await paySupplier(param(req, "id"), parse(schemas.paySupplier, req.body));
      return { ...result, hashscanUrl: result.tx.hashscanUrl };
    }),
  );
  app.post(
    "/invoices/:id/repay",
    limits.hbar,
    mutation(200, async (req) => {
      const invoice = getInvoice(param(req, "id"));
      const { repayment, links } = await repayInvoice(invoice);
      return { invoice: invoiceView(invoice), repayment, links, hashscanUrl: invoice.hashscanUrl ?? links[0]?.url ?? "", tx: { hashscanUrl: repayment.detected?.hashscanUrl ?? "", txId: repayment.detected?.transactionId ?? "" } };
    }),
  );

  app.get("/invoices", async (_req, res) => {
    const links = topicLinks();
    const demo = await marketplaceDemoInvoice();
    res.json({ invoices: [...Object.values(state.invoices).filter((invoice) => !invoice.archived).map(invoiceView), ...(demo ? [demo] : [])], hashscanUrl: links[0]?.url ?? hashscan.token(config.uinrTokenId), links });
  });
  app.get("/invoices/:id", async (req, res) => {
    const id = param(req, "id");
    if (!state.invoices[id] && isSeededInvoiceId(id)) {
      const invoice = await seededInvoiceView(id);
      res.json({ invoice, hashscanUrl: invoice.hashscanUrl, links: invoice.links });
      return;
    }
    const invoice = invoiceView(getInvoice(id));
    res.json({ invoice, hashscanUrl: invoice.hashscanUrl, links: invoice.links });
  });
  app.get("/invoices/:id/holders", async (req, res) => {
    res.json(await holdersOf(param(req, "id")));
  });

  // Risk
  app.get("/risk/:invoiceId/summary", async (req, res) => {
    res.json(await riskSummary(param(req, "invoiceId")));
  });
  app.get("/risk/:invoiceId/report", limits.paidReport, async (req, res) => {
    const invoiceId = param(req, "invoiceId");
    // Scored first, so an error here means nobody is quoted or charged for a report that can't be produced.
    const report = await riskReport(invoiceId);
    const payment = req.get("payment-signature") ?? req.get("x-payment");
    const charge = await chargeForReport(invoiceId, payment, `${req.protocol}://${req.get("host")}${req.originalUrl}`);
    res.set(charge.headers);
    if (!charge.paid) {
      res.status(402).json(charge.body);
      return;
    }
    const { settlement } = charge;
    res.json({ ...report, nav: navForReport(invoiceId), settlement, hashscanUrl: settlement.hashscanUrl, links: [{ label: "x402 settlement", url: settlement.hashscanUrl, txId: settlement.transactionId }, ...report.links] });
  });
  app.post(
    "/risk/:invoiceId/buy-report",
    requireInvestor,
    limits.buyReport,
    mutation(200, (req) => buyReportAsInvestor(param(req, "invoiceId"))),
  );
  app.get("/.well-known/x402", (req, res) => {
    res.json(serviceManifest(`${req.protocol}://${req.get("host")}`));
  });

  // NAV feed: reading is free, publishing is admin-only.
  app.get("/nav/:invoiceId", (req, res) => {
    res.json(navView(param(req, "invoiceId")));
  });
  app.post(
    "/nav/publish",
    requireAdmin,
    limits.hbar,
    mutation(200, async (req) => {
      const input = parse(schemas.navPublish, req.body);
      const run = await publishNav({ trigger: "on-demand", ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}) });
      const last = run.published[0];
      return { ...run, hashscanUrl: last?.hashscanUrl ?? hashscan.token(config.uinrTokenId), links: [...run.published.map((item) => ({ label: `NAV ${item.invoiceId}`, url: item.hashscanUrl, txId: item.transactionId })), ...topicLinks().filter((link) => link.label === "HCS NAV feed")] };
    }),
  );

  // Trust: free. Outside data in these responses is MOCK, and says so.
  app.get("/trust/company/:id", async (req, res) => {
    const result = await companyTrust(param(req, "id"));
    res.json({ ...result, externalDataSource: "mock" });
  });
  app.get("/trust/:invoiceId", async (req, res) => {
    res.json(await invoiceTrust(param(req, "invoiceId")));
  });

  // The mock e-invoice signer. It stands in for India's IRP, which can't be called here.
  app.post("/mock-irp/e-invoice", (req, res) => {
    const input = parse(schemas.eInvoice, req.body);
    const sellerGstin = (input.sellerGstin ?? (input.supplierId ? gstinOf(input.supplierId) : undefined))?.toUpperCase();
    const buyerGstin = (input.buyerGstin ?? (input.buyerId ? gstinOf(input.buyerId) : undefined))?.toUpperCase();
    if (!sellerGstin || !buyerGstin) throw new ApiError(422, "GSTIN_REQUIRED", "Send sellerGstin and buyerGstin, or supplierId and buyerId of companies that have a GSTIN on record");
    for (const [role, gstin] of [["sellerGstin", sellerGstin], ["buyerGstin", buyerGstin]] as const) {
      const check = validateGstin(gstin);
      if (!check.valid) throw new ApiError(422, "INVALID_GSTIN", `${role} ${gstin}: ${check.reason}`);
    }
    const date = (input.date ? new Date(input.date) : new Date()).toISOString().slice(0, 10);
    const signed = signEInvoice({ sellerGstin, buyerGstin, invoiceNumber: input.invoiceNumber, amount: input.amount, date });
    res.json({ source: "mock", notice: "Signed by this project's mock IRP. It proves nothing about a real invoice.", ...signed, hashscanUrl: hashscan.token(config.uinrTokenId), links: [{ label: "uINR token", url: hashscan.token(config.uinrTokenId) }] });
  });
  app.get("/mock-irp/public-key", (_req, res) => {
    res.json({ ...publicKeyRecord(), hashscanUrl: hashscan.token(config.uinrTokenId), links: [{ label: "uINR token", url: hashscan.token(config.uinrTokenId) }] });
  });

  // Agent
  app.post("/agent/run", requireInvestor, limits.agentRun, async (req, res) => {
    res.status(201).json(await startAgentRun(parse(schemas.agentRules, req.body)));
  });
  app.get("/agent/runs", (_req, res) => {
    const auditTopicId = knownTopics()?.agentAuditTopicId;
    const link = auditTopicId ? hashscan.topic(auditTopicId) : hashscan.token(config.uinrTokenId);
    res.json({ runs: state.agentRuns.filter((run) => !run.archived), hashscanUrl: link, links: [{ label: auditTopicId ? "Agent audit log (HCS)" : "uINR token", url: link }] });
  });

  // KYC
  app.post(
    "/kyc",
    mutation(201, async (req) => {
      const { request, created } = await submitKyc(parse(schemas.kyc, req.body));
      return { request, created, hashscanUrl: request.hashscanUrl, links: [{ label: "Wallet", url: hashscan.account(request.walletAddress) }] };
    }),
  );
  app.post(
    "/kyc/:id/approve",
    requireAdmin,
    limits.hbar,
    mutation(200, async (req) => {
      const result = await approveKyc(param(req, "id"), parse(schemas.approveKyc, req.body));
      return { ...result, hashscanUrl: result.tx.hashscanUrl };
    }),
  );
  app.post(
    "/kyc/:id/reject",
    requireAdmin,
    mutation(200, async (req) => {
      const result = rejectKyc(param(req, "id"));
      return { ...result, hashscanUrl: result.tx.hashscanUrl };
    }),
  );
  app.get("/kyc", async (req, res) => {
    const wallet = typeof req.query.walletAddress === "string" ? req.query.walletAddress : undefined;
    const requests = Object.values(state.kyc).filter((request) => !wallet || request.walletAddress === wallet);
    // A request with no wallet check yet gets one here, once. A failure is reported in the result, not as an error.
    for (const request of requests) await ensureWalletCheck(request);
    res.json({ requests, hashscanUrl: requests[0]?.hashscanUrl ?? hashscan.token(config.uinrTokenId), links: requests.map((request) => ({ label: request.walletAddress, url: hashscan.account(request.walletAddress) })) });
  });

  // Token controls
  app.post("/tokens/:id/pause", requireAdmin, limits.hbar, mutation(200, (req) => pauseToken(param(req, "id")).then((result) => ({ ...result, hashscanUrl: result.tx.hashscanUrl }))));
  app.post("/tokens/:id/unpause", requireAdmin, limits.hbar, mutation(200, (req) => unpauseToken(param(req, "id")).then((result) => ({ ...result, hashscanUrl: result.tx.hashscanUrl }))));
  app.post("/tokens/:id/freeze", requireAdmin, limits.hbar, mutation(200, (req) => freezeHolder(param(req, "id"), parse(schemas.freeze, req.body)).then((result) => ({ ...result, hashscanUrl: result.tx.hashscanUrl }))));
  app.post("/tokens/:id/unfreeze", requireAdmin, limits.hbar, mutation(200, (req) => unfreezeHolder(param(req, "id"), parse(schemas.freeze, req.body)).then((result) => ({ ...result, hashscanUrl: result.tx.hashscanUrl }))));
  app.get("/tokens", async (_req, res) => {
    const tokens = await listTokens();
    res.json({ tokens, hashscanUrl: tokens[0]?.hashscanUrl ?? hashscan.token(config.uinrTokenId), links: tokens.map((token) => ({ label: token.symbol, url: token.hashscanUrl })) });
  });

  // Buyers this server can sign for: only an account with both its ID and its key configured is listed.
  app.get("/buyers", (_req, res) => {
    const dataset = loadDataset();
    const buyers = BUYER_ROLES.flatMap((role) => {
      const accountId = process.env[`${role}_ID`]?.trim();
      if (!accountId || !process.env[`${role}_KEY`]?.trim()) return [];
      const company = dataset.companies.get(dataset.accountLinks.get(accountId) ?? "");
      return [{
        accountId,
        name: company?.name ?? accountName(accountId),
        companyId: company?.id ?? null,
        foundedYear: company?.foundedYear ?? null,
        size: company?.size ?? null,
        city: company?.city ?? null,
        address: company?.address ?? null,
        phone: company?.phone ?? null,
        gstFilingRate: company?.gstFilingRate ?? null,
        hashscanUrl: hashscan.account(accountId),
      }];
    });
    res.json({ buyers, externalDataSource: "mock", hashscanUrl: buyers[0]?.hashscanUrl ?? hashscan.token(config.uinrTokenId), links: buyers.map((buyer) => ({ label: buyer.name, url: buyer.hashscanUrl })) });
  });

  // Balances and audit
  app.get("/balances", async (_req, res) => {
    res.json({ accounts: await balances(), uinrTokenId: config.uinrTokenId, hashscanUrl: hashscan.token(config.uinrTokenId), links: [{ label: "uINR token", url: hashscan.token(config.uinrTokenId) }] });
  });
  app.get("/audit", (_req, res) => {
    const entries = state.audit.filter((entry) => !entry.archived);
    res.json({ entries, hashscanUrl: entries[0]?.hashscanUrl ?? hashscan.token(config.uinrTokenId), links: topicLinks() });
  });

  app.use((req, res) => {
    res.status(404).json({ error: { code: "ROUTE_NOT_FOUND", message: `${req.method} ${req.path} does not exist` } });
  });

  // Messages only: full error objects are never returned or logged, so nothing else can leak.
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message, ...error.details } });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: { code: "INVALID_JSON", message: "The request body is not valid JSON" } });
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`${req.method} ${req.path} failed: ${message}`);
    res.status(502).json({ error: { code: "CHAIN_OPERATION_FAILED", message: `${message}. Retrying this route is safe: completed steps are not repeated.` } });
  });

  return app;
}

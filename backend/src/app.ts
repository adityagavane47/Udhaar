import { existsSync, readFileSync } from "node:fs";
import cors from "cors";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { read } from "./ats/bond.js";
import { config, fromBaseUnits, hashscan } from "./config.js";
import { ApiError } from "./errors.js";
import { allParties } from "./hedera/client.js";
import { getAccount } from "./hedera/mirror.js";
import { accountName, buyUnits, confirmInvoice, createInvoice, getInvoice, holdersOf, invoiceView, paySupplier, tokenizeInvoice } from "./invoices.js";
import { approveKyc, liveInvoices, submitKyc } from "./kyc.js";
import { repayInvoice } from "./repayment.js";
import { serialized, state } from "./store.js";
import { freezeHolder, listTokens, pauseToken, unfreezeHolder, unpauseToken } from "./tokens.js";
import type { Link } from "./types.js";
import { uinrBalance } from "./uinr.js";

const accountId = z.string().regex(/^0\.0\.\d+$/, "must look like 0.0.12345");
const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be a valid date");
const positiveInt = z.number().int().positive();

const schemas = {
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
  }),
  tokenize: z.object({
    maturityMinutes: z.number().positive().optional(),
    maturityDate: isoDate.optional(),
    unitFaceValue: positiveInt.optional(),
    discountPct: z.number().min(0).lt(100).optional(),
  }),
  kyc: z.object({ fullName: z.string().min(1), walletAddress: accountId, country: z.string().min(1) }),
  buy: z.object({ investorId: accountId.optional(), units: positiveInt, idempotencyKey: z.string().min(1).optional() }),
  paySupplier: z.object({ supplierId: accountId, units: positiveInt, amount: z.number().positive().optional(), idempotencyKey: z.string().min(1).optional() }),
  freeze: z.object({ accountId, units: positiveInt.optional() }),
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

function knownTopics(): { registryTopicId: string; confirmationTopicId: string } | undefined {
  return existsSync(config.hcsRecordPath) ? JSON.parse(readFileSync(config.hcsRecordPath, "utf8")) : undefined;
}

function topicLinks(): Link[] {
  const topics = knownTopics();
  return topics
    ? [
        { label: "HCS invoice registry", url: hashscan.topic(topics.registryTopicId) },
        { label: "HCS buyer confirmations", url: hashscan.topic(topics.confirmationTopicId) },
      ]
    : [];
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
  app.use(cors());
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", network: "testnet", hashscanUrl: hashscan.token(config.uinrTokenId), links: [{ label: "uINR token", url: hashscan.token(config.uinrTokenId) }, ...topicLinks()] });
  });

  // Invoices
  app.post(
    "/invoices",
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
    mutation(200, async (req) => {
      const result = await confirmInvoice(param(req, "id"));
      return { ...result, hashscanUrl: result.tx.hashscanUrl, links: result.invoice.links };
    }),
  );
  app.post(
    "/invoices/:id/tokenize",
    mutation(201, async (req) => {
      const result = await tokenizeInvoice(param(req, "id"), parse(schemas.tokenize, req.body));
      return { ...result, hashscanUrl: result.tx.hashscanUrl, links: result.invoice.links };
    }),
  );
  app.post(
    "/invoices/:id/buy",
    mutation(201, async (req) => {
      const input = parse(schemas.buy, req.body);
      const investorId = input.investorId ?? process.env.INVESTOR_ID?.trim();
      if (!investorId) throw new ApiError(422, "MISSING_PARTY", "investorId is required");
      const result = await buyUnits(param(req, "id"), { ...input, investorId });
      return { ...result, hashscanUrl: result.tx.hashscanUrl, links: result.links ?? result.invoice.links };
    }),
  );
  app.post(
    "/invoices/:id/pay-supplier",
    mutation(201, async (req) => {
      const result = await paySupplier(param(req, "id"), parse(schemas.paySupplier, req.body));
      return { ...result, hashscanUrl: result.tx.hashscanUrl };
    }),
  );
  app.post(
    "/invoices/:id/repay",
    mutation(200, async (req) => {
      const invoice = getInvoice(param(req, "id"));
      const { repayment, links } = await repayInvoice(invoice);
      return { invoice: invoiceView(invoice), repayment, links, hashscanUrl: invoice.hashscanUrl ?? links[0]?.url ?? "", tx: { hashscanUrl: repayment.detected?.hashscanUrl ?? "", txId: repayment.detected?.transactionId ?? "" } };
    }),
  );

  app.get("/invoices", (_req, res) => {
    const links = topicLinks();
    res.json({ invoices: Object.values(state.invoices).map(invoiceView), hashscanUrl: links[0]?.url ?? hashscan.token(config.uinrTokenId), links });
  });
  app.get("/invoices/:id", (req, res) => {
    const invoice = invoiceView(getInvoice(param(req, "id")));
    res.json({ invoice, hashscanUrl: invoice.hashscanUrl, links: invoice.links });
  });
  app.get("/invoices/:id/holders", async (req, res) => {
    res.json(await holdersOf(param(req, "id")));
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
    mutation(200, async (req) => {
      const result = await approveKyc(param(req, "id"));
      return { ...result, hashscanUrl: result.tx.hashscanUrl };
    }),
  );
  app.get("/kyc", (req, res) => {
    const wallet = typeof req.query.walletAddress === "string" ? req.query.walletAddress : undefined;
    const requests = Object.values(state.kyc).filter((request) => !wallet || request.walletAddress === wallet);
    res.json({ requests, hashscanUrl: requests[0]?.hashscanUrl ?? hashscan.token(config.uinrTokenId), links: requests.map((request) => ({ label: request.walletAddress, url: hashscan.account(request.walletAddress) })) });
  });

  // Token controls
  app.post("/tokens/:id/pause", mutation(200, (req) => pauseToken(param(req, "id")).then((result) => ({ ...result, hashscanUrl: result.tx.hashscanUrl }))));
  app.post("/tokens/:id/unpause", mutation(200, (req) => unpauseToken(param(req, "id")).then((result) => ({ ...result, hashscanUrl: result.tx.hashscanUrl }))));
  app.post("/tokens/:id/freeze", mutation(200, (req) => freezeHolder(param(req, "id"), parse(schemas.freeze, req.body)).then((result) => ({ ...result, hashscanUrl: result.tx.hashscanUrl }))));
  app.post("/tokens/:id/unfreeze", mutation(200, (req) => unfreezeHolder(param(req, "id"), parse(schemas.freeze, req.body)).then((result) => ({ ...result, hashscanUrl: result.tx.hashscanUrl }))));
  app.get("/tokens", async (_req, res) => {
    const tokens = await listTokens();
    res.json({ tokens, hashscanUrl: tokens[0]?.hashscanUrl ?? hashscan.token(config.uinrTokenId), links: tokens.map((token) => ({ label: token.symbol, url: token.hashscanUrl })) });
  });

  // Balances and audit
  app.get("/balances", async (_req, res) => {
    res.json({ accounts: await balances(), uinrTokenId: config.uinrTokenId, hashscanUrl: hashscan.token(config.uinrTokenId), links: [{ label: "uINR token", url: hashscan.token(config.uinrTokenId) }] });
  });
  app.get("/audit", (_req, res) => {
    res.json({ entries: state.audit, hashscanUrl: state.audit[0]?.hashscanUrl ?? hashscan.token(config.uinrTokenId), links: topicLinks() });
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

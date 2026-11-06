import { randomUUID } from "node:crypto";
import { config, fromBaseUnits, hashscan, toBaseUnits, uinrFeeBaseUnits } from "../config.js";
import { ApiError } from "../errors.js";
import { ensureAgentAuditTopic, submitMessage } from "../hcs.js";
import { getParty } from "../hedera/client.js";
import { buyUnits } from "../invoices.js";
import { audit, save, serialized, state } from "../store.js";
import type { AgentRules, AgentRun, Link } from "../types.js";
import { uinrBalance } from "../uinr.js";
import { assertQuoteAllowed, payForReport, QuoteRefused, ReportCallError, type ReportQuote } from "../x402/client.js";
import { reportPayTo } from "../x402/paywall.js";
import { decide, skipBeforePaying, type Listing, type ReportFacts } from "./rules.js";

export interface ServiceInfo {
  url: string;
  listings: string;
  token: string;
  payTo: string;
  network: string;
  amountBaseUnits: number;
}

export interface PaidReportResult extends ReportFacts {
  settlement: { transactionId: string; hashscanUrl: string; feeToPool: number; amount: number };
}

export interface PurchaseResult {
  units: number;
  unitPrice: number;
  amountBaseUnits: number;
  feeBaseUnits: number;
  paymentHashscanUrl?: string;
  unitsHashscanUrl?: string;
}

/** Everything the agent does to the outside world. The tests replace these, so its rules run without spending. */
export interface AgentDeps {
  now(): number;
  investorId: string;
  /** The only account and token the agent will pay for reports. Comes from settings, not the server's quote. */
  allowedPayTo: string;
  allowedToken: string;
  discover(): Promise<ServiceInfo>;
  listings(url: string): Promise<Listing[]>;
  balance(): Promise<number>;
  payForReport(url: string, approve: (quote: ReportQuote) => void): Promise<PaidReportResult>;
  buy(invoiceId: string, units: number, idempotencyKey: string): Promise<PurchaseResult>;
  /** What a failed buy actually took from the investor, if anything. */
  chargedForFailedBuy(invoiceId: string, idempotencyKey: string): number;
  heldUnits(invoiceId: string): number;
  auditTopic(): Promise<string>;
  log(topicId: string, message: string, key: string): Promise<{ hashscanUrl: string; txId?: string }>;
  persist(): void;
}

class AuditLogFailed extends Error {}
class StopRun extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function newRun(rules: AgentRules, investor: string, nowMs: number): AgentRun {
  return {
    runId: randomUUID(),
    status: "running",
    startedAt: new Date(nowMs).toISOString(),
    investor,
    rules,
    invoicesChecked: [],
    reports: [],
    spentOnReports: 0,
    purchases: [],
    spentOnUnits: 0,
    skipped: [],
    auditMessages: [],
    hashscanUrl: hashscan.account(investor),
    links: [],
  };
}

const short = (text: string) => (text.length > 180 ? `${text.slice(0, 177)}...` : text);

/** Runs one pass over the listings. It always returns a receipt: if something stops it, the receipt says what and why. */
export async function executeRun(run: AgentRun, deps: AgentDeps): Promise<AgentRun> {
  const reportBudget = toBaseUnits(run.rules.reportBudget);
  const investmentBudget = toBaseUnits(run.rules.investmentBudget);
  let reportSpent = 0;
  let investmentSpent = 0;

  const updateTotals = () => {
    run.spentOnReports = fromBaseUnits(reportSpent);
    run.spentOnUnits = fromBaseUnits(investmentSpent);
    deps.persist();
  };

  let topicId = "";
  const log = async (type: string, fields: Record<string, unknown> = {}) => {
    const sequence = run.auditMessages.length + 1;
    try {
      const message = JSON.stringify({ v: 1, type, run: run.runId, seq: sequence, at: new Date(deps.now()).toISOString(), ...fields });
      const result = await deps.log(topicId, message, `agent:${run.runId}:${sequence}`);
      run.auditMessages.push({ type, hashscanUrl: result.hashscanUrl, ...(result.txId ? { txId: result.txId } : {}) });
      deps.persist();
    } catch (error) {
      // No spending goes unlogged, so a broken log ends the run.
      throw new AuditLogFailed(error instanceof Error ? error.message : "unknown error");
    }
  };

  const skip = async (invoiceId: string, code: string, reason: string, paidForReport: boolean) => {
    run.skipped.push({ invoiceId, code, reason, paidForReport });
    deps.persist();
    await log("decision", { invoice: invoiceId, decision: "skip", code, reason: short(reason) });
  };

  try {
    topicId = await deps.auditTopic();
    run.auditTopicId = topicId;
    run.hashscanUrl = hashscan.topic(topicId);
    await log("run.started", { investor: run.investor, rules: run.rules });

    const service = await deps.discover();
    run.endpoint = service.url;
    if (service.payTo !== deps.allowedPayTo || service.token !== deps.allowedToken) throw new StopRun(`The service asks for payment to ${service.payTo} in ${service.token}, which isn't allowed`);

    const listings = await deps.listings(service.listings);
    for (const listing of listings) {
      if (!listing.seeded && !["tokenized", "funded"].includes(listing.status ?? "")) continue;
      run.invoicesChecked.push(listing.id);
      deps.persist();

      const before = skipBeforePaying(listing, deps.now());
      if (before) {
        await skip(listing.id, before.code, before.reason, false);
        continue;
      }

      // Checked again here against the live quote, because the server could change its price.
      const approve = (quote: ReportQuote) => {
        assertQuoteAllowed(quote, deps.allowedPayTo, deps.allowedToken);
        if (reportSpent + quote.totalBaseUnits > reportBudget) throw new QuoteRefused(`The report budget has ${fromBaseUnits(reportBudget - reportSpent)} uINR left and this report costs ${fromBaseUnits(quote.totalBaseUnits)}`, "REPORT_BUDGET_EXHAUSTED");
      };

      // The facilitator only checks for the price, so without the 1% on top the payment would fail on-chain.
      const reportCost = service.amountBaseUnits + uinrFeeBaseUnits(service.amountBaseUnits);
      const held = await deps.balance();
      if (held < reportCost) throw new StopRun(`The investor holds only ${fromBaseUnits(held)} uINR, too little for a report and its 1% fee`);

      let report: PaidReportResult;
      try {
        report = await deps.payForReport(service.url.replace("{invoiceId}", encodeURIComponent(listing.id)), approve);
      } catch (error) {
        if (error instanceof QuoteRefused) {
          await skip(listing.id, error.code, error.message, false);
          continue;
        }
        if (error instanceof ReportCallError && !error.maybeCharged) {
          await skip(listing.id, error.code, error.message, false);
          continue;
        }
        // The money may have moved, so count it against the budget and stop rather than risk paying twice.
        reportSpent += reportCost;
        updateTotals();
        throw new StopRun(`Paying for ${listing.id}'s report failed part-way and may have been charged: ${error instanceof Error ? error.message : "unknown error"}`);
      }

      const paidBaseUnits = toBaseUnits(report.settlement.amount) + toBaseUnits(report.settlement.feeToPool);
      reportSpent += paidBaseUnits;
      run.reports.push({
        invoiceId: listing.id,
        amount: report.settlement.amount,
        feeToPool: report.settlement.feeToPool,
        transactionId: report.settlement.transactionId,
        hashscanUrl: report.settlement.hashscanUrl,
        grade: report.grade,
        riskScore: report.riskScore,
        fraudFlags: report.fraudFlags,
        anomaly: report.anomaly,
      });
      updateTotals();
      await log("report.paid", { invoice: listing.id, amountBaseUnits: paidBaseUnits, tx: report.settlement.transactionId, grade: report.grade, flags: report.fraudFlags, anomaly: report.anomaly });

      const decision = decide(report, listing, run.rules, {
        heldUnits: deps.heldUnits(listing.id),
        investmentLeftBaseUnits: investmentBudget - investmentSpent,
        unitPriceBaseUnits: toBaseUnits(listing.unitPrice ?? 0),
      });
      if (decision.action === "skip") {
        await skip(listing.id, decision.code, decision.reason, true);
        continue;
      }
      await log("decision", { invoice: listing.id, decision: "buy", units: decision.units, costBaseUnits: decision.costBaseUnits });

      const idempotencyKey = `agent-${run.runId}`;
      try {
        const purchase = await deps.buy(listing.id, decision.units, idempotencyKey);
        investmentSpent += purchase.amountBaseUnits + purchase.feeBaseUnits;
        run.purchases.push({
          invoiceId: listing.id,
          units: purchase.units,
          unitPrice: purchase.unitPrice,
          amount: fromBaseUnits(purchase.amountBaseUnits),
          feeToPool: fromBaseUnits(purchase.feeBaseUnits),
          ...(purchase.paymentHashscanUrl ? { paymentHashscanUrl: purchase.paymentHashscanUrl } : {}),
          ...(purchase.unitsHashscanUrl ? { unitsHashscanUrl: purchase.unitsHashscanUrl } : {}),
        });
        updateTotals();
        await log("purchase", { invoice: listing.id, units: purchase.units, amountBaseUnits: purchase.amountBaseUnits, feeBaseUnits: purchase.feeBaseUnits, unitsTx: purchase.unitsHashscanUrl });
      } catch (error) {
        if (error instanceof AuditLogFailed) throw error;
        const charged = deps.chargedForFailedBuy(listing.id, idempotencyKey);
        if (charged > 0) {
          investmentSpent += charged;
          updateTotals();
          throw new StopRun(`Buying ${listing.id} took the payment but didn't finish: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        await skip(listing.id, error instanceof ApiError ? error.code : "BUY_FAILED", error instanceof Error ? error.message : "unknown error", true);
      }
    }

    run.status = "completed";
    await log("run.completed", { reports: run.reports.length, reportSpentBaseUnits: reportSpent, purchases: run.purchases.length, investmentSpentBaseUnits: investmentSpent, skipped: run.skipped.length });
  } catch (error) {
    run.status = "stopped";
    run.stopReason = error instanceof AuditLogFailed ? `The HCS audit log failed, so the run stopped: ${error.message}` : error instanceof Error ? error.message : "unknown error";
  }

  run.finishedAt = new Date(deps.now()).toISOString();
  const links: Link[] = [
    ...(run.auditTopicId ? [{ label: "Agent audit log (HCS)", url: hashscan.topic(run.auditTopicId) }] : []),
    ...run.reports.map((report) => ({ label: `Report payment: ${report.invoiceId}`, url: report.hashscanUrl, txId: report.transactionId })),
    ...run.purchases.flatMap((purchase) => [
      ...(purchase.paymentHashscanUrl ? [{ label: `Payment for ${purchase.invoiceId} units`, url: purchase.paymentHashscanUrl }] : []),
      ...(purchase.unitsHashscanUrl ? [{ label: `${purchase.units} units of ${purchase.invoiceId}`, url: purchase.unitsHashscanUrl }] : []),
    ]),
  ];
  run.links = links;
  updateTotals();
  return run;
}

export const runsToday = (runs: AgentRun[], nowMs: number) => {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return runs.filter((run) => run.startedAt.slice(0, 10) === day).length;
};

/** After a restart, a run still marked as running can't finish. Its receipt shows what was spent. */
export function markInterruptedRuns() {
  let changed = false;
  for (const run of state.agentRuns) {
    if (run.status === "running") {
      run.status = "interrupted";
      run.stopReason = "The server restarted during this run";
      changed = true;
    }
  }
  if (changed) save();
}

async function liveDeps(): Promise<AgentDeps> {
  const investor = await getParty("INVESTOR");
  const getJson = async <T>(url: string): Promise<T> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return (await response.json()) as T;
  };
  const purchaseKey = (invoiceId: string, idempotencyKey: string) => `${invoiceId}:${investor.id}:${idempotencyKey}`;
  return {
    now: () => Date.now(),
    investorId: investor.id,
    allowedPayTo: reportPayTo(),
    allowedToken: config.uinrTokenId,
    // The agent starts from the base URL alone and finds the paid endpoint the same way an outside client would.
    discover: async () => {
      const manifest = await getJson<{ services: ServiceInfo[] }>(`${config.selfUrl}/.well-known/x402`);
      const service = manifest.services[0];
      if (!service) throw new Error("The service list is empty");
      return service;
    },
    listings: async (url) => (await getJson<{ invoices: Listing[] }>(url)).invoices,
    balance: () => uinrBalance(investor.id),
    payForReport: (url, approve) => payForReport<PaidReportResult>(url, investor, approve),
    buy: async (invoiceId, units, idempotencyKey) => {
      const { purchase } = await serialized(() => buyUnits(invoiceId, { investorId: investor.id, units, idempotencyKey }));
      return {
        units: purchase.units,
        unitPrice: purchase.unitPrice,
        amountBaseUnits: purchase.amountBaseUnits,
        feeBaseUnits: purchase.feeBaseUnits,
        ...(purchase.paymentHashscanUrl ? { paymentHashscanUrl: purchase.paymentHashscanUrl } : {}),
        ...(purchase.unitsHashscanUrl ? { unitsHashscanUrl: purchase.unitsHashscanUrl } : {}),
      };
    },
    chargedForFailedBuy: (invoiceId, idempotencyKey) => {
      const purchase = state.purchases[purchaseKey(invoiceId, idempotencyKey)];
      return purchase && purchase.status !== "pending" ? purchase.amountBaseUnits + purchase.feeBaseUnits : 0;
    },
    heldUnits: (invoiceId) => Object.values(state.purchases).filter((purchase) => purchase.invoiceId === invoiceId && purchase.investorId === investor.id && purchase.status === "complete").reduce((sum, purchase) => sum + purchase.units, 0),
    auditTopic: ensureAgentAuditTopic,
    log: async (topicId, message, key) => {
      const record = await submitMessage(topicId, investor, message, key);
      return { hashscanUrl: record.hashscanUrl ?? hashscan.topic(topicId), txId: record.transactionId };
    },
    persist: save,
  };
}

let running = false;

/** One run at a time, because budgets and positions are read as the run goes. */
export async function startAgentRun(rules: AgentRules): Promise<AgentRun> {
  const proof = { hashscanUrl: hashscan.token(config.uinrTokenId) };
  if (running) throw new ApiError(409, "AGENT_RUN_IN_PROGRESS", "An agent run is already going. Wait for its receipt", proof);
  const now = Date.now();
  const today = runsToday(state.agentRuns, now);
  if (today >= config.agentDailyRunCap) {
    const resetsAt = `${new Date(now + 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;
    throw new ApiError(429, "AGENT_DAILY_CAP_REACHED", `The limit of ${config.agentDailyRunCap} agent runs a day has been reached`, { ...proof, cap: config.agentDailyRunCap, resetsAt });
  }

  // Set before the first await, so two requests can't both pass the checks above.
  running = true;
  try {
    const deps = await liveDeps();
    const run = newRun(rules, deps.investorId, now);
    state.agentRuns.unshift(run);
    save();
    await executeRun(run, deps);
    audit({ type: "agent_run", description: `Agent run ${run.status}: ${run.reports.length} reports for ${run.spentOnReports} uINR, ${run.purchases.length} purchases for ${run.spentOnUnits} uINR, ${run.skipped.length} skipped`, actor: "auto-invest agent", hashscanUrl: run.hashscanUrl, status: run.status === "completed" ? "success" : "rejected" });
    return run;
  } finally {
    running = false;
  }
}

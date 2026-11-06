import { uinrFeeBaseUnits } from "../config.js";
import type { AgentRules } from "../types.js";

/**
 * The agent's spending rules. These are plain functions with no model or network involved, so the
 * same inputs always give the same decision.
 */

export interface Listing {
  id: string;
  seeded?: boolean;
  status?: string;
  tokenId?: string;
  maturityDate?: string;
  availableUnits?: number;
  unitPrice?: number;
}

export interface ReportFacts {
  grade: "A" | "B" | "C" | "D";
  riskScore: number;
  fraudFlags: string[];
  anomaly: boolean;
  reasons: string[];
}

export type Decision = { action: "buy"; units: number; costBaseUnits: number } | { action: "skip"; code: string; reason: string };

const GRADE_ORDER = { A: 3, B: 2, C: 1, D: 0 };

export const gradeMeetsMinimum = (grade: ReportFacts["grade"], minimum: AgentRules["minGrade"]) => GRADE_ORDER[grade] >= GRADE_ORDER[minimum];

/** Reasons not to spend even the report fee. The simulated invoice stays in, so its fraud is shown by the report. */
export function skipBeforePaying(listing: Listing, nowMs: number): { code: string; reason: string } | undefined {
  if (listing.seeded) return undefined;
  if (!listing.tokenId) return { code: "NOT_LISTED", reason: "It has no token yet" };
  if (listing.maturityDate && Date.parse(listing.maturityDate) <= nowMs) return { code: "MATURED", reason: `Its bond matured on ${listing.maturityDate}, so it can't be bought` };
  if ((listing.availableUnits ?? 0) <= 0) return { code: "SOLD_OUT", reason: "No units are left to buy" };
  return undefined;
}

/** The cost of `units`, with the 1% fee the sender pays on top. */
export const purchaseCostBaseUnits = (units: number, unitPriceBaseUnits: number) => {
  const amount = units * unitPriceBaseUnits;
  return amount + uinrFeeBaseUnits(amount);
};

/** The most units from `limit` that the budget covers, fee included. */
export function affordableUnits(limit: number, unitPriceBaseUnits: number, budgetBaseUnits: number): number {
  if (unitPriceBaseUnits <= 0) return 0;
  let units = Math.min(limit, Math.floor(budgetBaseUnits / unitPriceBaseUnits));
  while (units > 0 && purchaseCostBaseUnits(units, unitPriceBaseUnits) > budgetBaseUnits) units -= 1;
  return Math.max(units, 0);
}

/** Decides what to do after reading a report. The order is fixed, so fraud is always the reason given when present. */
export function decide(report: ReportFacts, listing: Listing, rules: AgentRules, context: { heldUnits: number; investmentLeftBaseUnits: number; unitPriceBaseUnits: number }): Decision {
  if (report.fraudFlags.length > 0) return { action: "skip", code: "FRAUD", reason: `Fraud flag: ${report.fraudFlags.join(", ")}` };
  if (report.anomaly) return { action: "skip", code: "ANOMALY", reason: "Anomaly warning: invoices with one are always skipped, whatever the minimum grade" };
  if (!gradeMeetsMinimum(report.grade, rules.minGrade)) return { action: "skip", code: "BELOW_MIN_GRADE", reason: `Grade ${report.grade} is below the minimum of ${rules.minGrade}` };
  if (!listing.tokenId || listing.seeded) return { action: "skip", code: "NOT_BUYABLE", reason: "It has no token to buy" };

  const room = rules.maxUnitsPerInvoice - context.heldUnits;
  if (room <= 0) return { action: "skip", code: "MAX_UNITS_REACHED", reason: `The investor already holds ${context.heldUnits} units, and the limit is ${rules.maxUnitsPerInvoice}` };

  const units = affordableUnits(Math.min(room, listing.availableUnits ?? 0), context.unitPriceBaseUnits, context.investmentLeftBaseUnits);
  if (units <= 0) return { action: "skip", code: "INVESTMENT_BUDGET_EXHAUSTED", reason: "The investment budget left doesn't cover one unit and its 1% fee" };
  return { action: "buy", units, costBaseUnits: purchaseCostBaseUnits(units, context.unitPriceBaseUnits) };
}

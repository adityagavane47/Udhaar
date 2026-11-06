import type { Company, SeedInvoice } from "./dataset.js";
import type { GraphPerson } from "./graphStore.js";

export type Grade = "A" | "B" | "C" | "D";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type FraudFlag = "CIRCULAR_INVOICING" | "SHARED_DIRECTOR" | "SHARED_ADDRESS";

const DAY_MS = 86_400_000;
const ANOMALY_MULTIPLE = 10;
const ANOMALY_PENALTY = 10;
/** A median of fewer invoices than this says little about what's usual. */
const MIN_BASELINE = 3;
/** Fraud forces grade D, so the score is capped to stay on the same scale as the grade. */
const MAX_FLAGGED_SCORE = 49;

/** What each grade earns an investor per year. Grade D is never listed. */
export const GRADE_ANNUAL_RATE_PCT: Record<Grade, number | null> = { A: 12, B: 16, C: 20, D: null };
const DAYS_IN_YEAR = 365;

/**
 * Annual rate × days to the invoice's due date / 365. Always pass days to the due date, never to a
 * bond's maturity, because demo bonds mature early. Null when there's no valid price: grade D, a due
 * date already passed, or one so far away that the discount would reach 100%.
 */
export function discountPctFor(grade: Grade, wholeDaysToDue: number): number | null {
  const annualRate = GRADE_ANNUAL_RATE_PCT[grade];
  if (annualRate === null || wholeDaysToDue <= 0) return null;
  const discount = Math.round(((annualRate * wholeDaysToDue) / DAYS_IN_YEAR) * 10_000) / 10_000;
  return discount < 100 ? discount : null;
}

/** To the paisa, because uINR has 2 decimals and whole rupees would erase the return on short invoices. */
export const discountedUnitPrice = (unitFaceValue: number, discountPct: number) => Math.round(unitFaceValue * (100 - discountPct)) / 100;

export interface FraudFindings {
  cycles: string[][];
  sharedDirectors: GraphPerson[];
  sharedAddress: boolean;
}

export interface ScorecardInput {
  invoiceId: string;
  amount: number;
  dueDate: string;
  now: number;
  /** Overdue invoices are measured to this date, so scores don't drift as the clock moves. */
  referenceDate: string;
  supplier: Company | undefined;
  buyer: Company | undefined;
  supplierName: string;
  buyerName: string;
  history: SeedInvoice[];
  fraud: FraudFindings;
  nameOfCompany: (id: string) => string;
  maskPerson: (id: string) => string;
}

export interface Scorecard {
  riskScore: number;
  grade: Grade;
  confidence: Confidence;
  creditRisk: "LOW" | "MEDIUM" | "HIGH";
  fraudFlags: FraudFlag[];
  anomaly: boolean;
  annualRatePct: number | null;
  daysToDue: number;
  suggestedDiscountPct: number | null;
  reasons: string[];
  breakdown: {
    paymentHistory: { points: number; max: 40 };
    companyProfile: { points: number; max: 25 };
    thisInvoice: { points: number; max: 20 };
    network: { points: number; max: 15 };
    anomalyPenalty: number;
    scoreBeforeFraudCap: number;
  };
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const oneDecimal = (value: number) => Math.round(value * 10) / 10;
const rupees = (value: number) => `₹${Math.round(value).toLocaleString("en-IN")}`;
const percent = (share: number) => `${Math.round(share * 100)}%`;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export interface Settled {
  supplierId: string;
  onTime: boolean;
  daysLate: number;
}

export function settleOutcome(invoice: SeedInvoice, referenceMs: number): Settled {
  const due = Date.parse(invoice.dueDate);
  const paid = invoice.paidDate ? Date.parse(invoice.paidDate) : null;
  return { supplierId: invoice.supplierId, onTime: paid !== null && paid <= due, daysLate: Math.max(0, ((paid ?? referenceMs) - due) / DAY_MS) };
}

function paymentHistory(settled: Settled[], buyerName: string, reasons: string[]): number {
  if (settled.length === 0) {
    reasons.push(`${buyerName} has no payment history, so it gets a neutral 20 of 40 for payment history, at low confidence.`);
    return 20;
  }
  const onTimeShare = settled.filter((outcome) => outcome.onTime).length / settled.length;
  const averageLate = settled.reduce((sum, outcome) => sum + outcome.daysLate, 0) / settled.length;
  const raw = 28 * onTimeShare + 12 * clamp(1 - averageLate / 60, 0, 1);
  // A handful of invoices proves little, so short histories stay close to neutral.
  const points = 20 + (raw - 20) * Math.min(settled.length / 5, 1);
  reasons.push(`${buyerName} paid ${percent(onTimeShare)} of ${settled.length} past invoices on time, ${averageLate < 1 ? "with almost no delay on average" : `and was ${Math.round(averageLate)} day${Math.round(averageLate) === 1 ? "" : "s"} late on average`}.`);
  return points;
}

export function companyProfile(buyer: Company | undefined, buyerName: string, now: number, reasons: string[]): number {
  if (!buyer) {
    reasons.push(`${buyerName} isn't in the dataset, so it's scored as a new company.`);
    return 9;
  }
  const age = new Date(now).getUTCFullYear() - buyer.foundedYear;
  const agePoints = age >= 10 ? 10 : age >= 5 ? 7 : age >= 2 ? 4 : 1;
  const gst = buyer.gstFilingRate;
  const gstPoints = gst >= 0.95 ? 10 : gst >= 0.85 ? 8 : gst >= 0.7 ? 6 : gst >= 0.5 ? 3 : 1;
  const sizePoints = { large: 5, medium: 4, small: 3, micro: 1 }[buyer.size];
  reasons.push(`${buyerName} is a ${buyer.size} company, ${age <= 1 ? "founded last year" : `founded ${age} years ago`}, and filed ${percent(gst)} of its GST returns on time.`);
  return agePoints + gstPoints + sizePoints;
}

/** 8 points when in line with what's usual. Unknown is 5, so having no data neither helps nor hurts much. */
function amountPoints(amount: number, past: number[]): { points: number; usual: number | null } {
  if (past.length < MIN_BASELINE) return { points: 5, usual: null };
  const usual = median(past);
  const ratio = amount / usual;
  return { points: ratio <= 2 ? 8 : ratio <= 5 ? 5 : ratio <= 10 ? 2 : 0, usual };
}

export function networkPoints(settled: Settled[], supplierId: string | undefined, buyerName: string, reasons: string[]): number {
  const bySupplier = new Map<string, Settled[]>();
  for (const outcome of settled) {
    if (outcome.supplierId === supplierId) continue;
    bySupplier.set(outcome.supplierId, [...(bySupplier.get(outcome.supplierId) ?? []), outcome]);
  }
  if (bySupplier.size === 0) {
    reasons.push(`There's no record of how ${buyerName} pays other suppliers, so network is neutral.`);
    return 7.5;
  }
  const shares = [...bySupplier.values()].map((outcomes) => outcomes.filter((outcome) => outcome.onTime).length / outcomes.length);
  const average = shares.reduce((sum, share) => sum + share, 0) / shares.length;
  reasons.push(`Across ${bySupplier.size} other supplier${bySupplier.size === 1 ? "" : "s"}, ${buyerName} paid ${percent(average)} of invoices on time.`);
  // As with payment history, one or two suppliers say little.
  return 7.5 + (15 * average - 7.5) * Math.min(bySupplier.size / 3, 1);
}

function fraudChecks(input: ScorecardInput, reasons: string[]): FraudFlag[] {
  const flags: FraudFlag[] = [];
  const firstCycle = input.fraud.cycles[0];
  if (firstCycle) {
    flags.push("CIRCULAR_INVOICING");
    const names = firstCycle.map(input.nameOfCompany);
    reasons.push(`Fraud: billing runs in a circle, ${[...names, names[0]].join(" → ")}. This can inflate trade that never happened.`);
  }
  if (input.fraud.sharedDirectors.length > 0) {
    flags.push("SHARED_DIRECTOR");
    const people = input.fraud.sharedDirectors.map((person) => input.maskPerson(person.id)).join(", ");
    reasons.push(`Fraud: ${people} is a director of both ${input.supplierName} and ${input.buyerName}, so the sale may not be at arm's length.`);
  }
  if (input.fraud.sharedAddress) {
    flags.push("SHARED_ADDRESS");
    reasons.push(`Fraud: ${input.supplierName} and ${input.buyerName} are registered at the same address, so they may be one business.`);
  }
  return flags;
}

export function scoreInvoice(input: ScorecardInput): Scorecard {
  const referenceMs = Date.parse(input.referenceDate);
  const past = input.history.filter((invoice) => invoice.id !== input.invoiceId && invoice.status !== "open");
  const fromBuyer = input.buyer ? past.filter((invoice) => invoice.buyerId === input.buyer?.id) : [];
  const fromSupplier = input.supplier ? past.filter((invoice) => invoice.supplierId === input.supplier?.id) : [];
  const settled = fromBuyer.map((invoice) => settleOutcome(invoice, referenceMs));

  const reasons: string[] = [];
  const fraudFlags = fraudChecks(input, reasons);

  const anomalyReasons: string[] = [];
  const creditReasons: string[] = [];
  const history = paymentHistory(settled, input.buyerName, creditReasons);
  const profile = companyProfile(input.buyer, input.buyerName, input.now, creditReasons);

  const vsBuyer = amountPoints(input.amount, fromBuyer.map((invoice) => invoice.amount));
  const vsSupplier = amountPoints(input.amount, fromSupplier.map((invoice) => invoice.amount));
  const daysToDue = (Date.parse(input.dueDate) - input.now) / DAY_MS;
  const wholeDaysToDue = Math.ceil(daysToDue);
  const duePoints = daysToDue < 0 ? 0 : daysToDue < 7 ? 1 : daysToDue < 30 ? 3 : daysToDue <= 120 ? 4 : 2;
  creditReasons.push(`This invoice is for ${rupees(input.amount)}${vsBuyer.usual !== null ? `; ${input.buyerName} usually pays about ${rupees(vsBuyer.usual)}` : ""}${vsSupplier.usual !== null ? `, and ${input.supplierName} usually bills about ${rupees(vsSupplier.usual)}` : ""}.`);
  creditReasons.push(daysToDue < 0 ? "The due date has already passed." : `It's due in ${wholeDaysToDue} days.`);
  const invoicePoints = vsBuyer.points + vsSupplier.points + duePoints;

  const network = networkPoints(settled, input.supplier?.id, input.buyerName, creditReasons);

  const anomaly = vsSupplier.usual !== null && input.amount > ANOMALY_MULTIPLE * vsSupplier.usual;
  if (anomaly) anomalyReasons.push(`Warning: this is ${Math.round(input.amount / (vsSupplier.usual ?? 1))} times what ${input.supplierName} usually bills, so ${ANOMALY_PENALTY} points were taken off.`);

  const subtotal = Math.round(history + profile + invoicePoints + network);
  const penalty = anomaly ? ANOMALY_PENALTY : 0;
  const beforeFraudCap = clamp(subtotal - penalty, 0, 100);
  const riskScore = fraudFlags.length > 0 ? Math.min(beforeFraudCap, MAX_FLAGGED_SCORE) : beforeFraudCap;
  const grade: Grade = fraudFlags.length > 0 ? "D" : riskScore >= 80 ? "A" : riskScore >= 65 ? "B" : riskScore >= 50 ? "C" : "D";

  const known = input.buyer !== undefined && input.supplier !== undefined;
  const confidence: Confidence = !known || settled.length < 5 ? "LOW" : settled.length < 20 || fromSupplier.length < MIN_BASELINE ? "MEDIUM" : "HIGH";
  if (input.supplier === undefined) creditReasons.push(`${input.supplierName} isn't in the dataset, so there's no record of what it usually bills.`);

  reasons.push(...anomalyReasons, ...creditReasons);
  if (fraudFlags.length > 0) reasons.push("Any fraud flag means grade D: this invoice can't be listed or tokenized.");
  else if (grade === "D") reasons.push("A score under 50 means grade D: this invoice can't be listed or tokenized.");

  return {
    riskScore,
    grade,
    confidence,
    creditRisk: subtotal >= 80 ? "LOW" : subtotal >= 50 ? "MEDIUM" : "HIGH",
    fraudFlags,
    anomaly,
    annualRatePct: GRADE_ANNUAL_RATE_PCT[grade],
    daysToDue: wholeDaysToDue,
    suggestedDiscountPct: discountPctFor(grade, wholeDaysToDue),
    reasons,
    breakdown: {
      paymentHistory: { points: oneDecimal(history), max: 40 },
      companyProfile: { points: oneDecimal(profile), max: 25 },
      thisInvoice: { points: oneDecimal(invoicePoints), max: 20 },
      network: { points: oneDecimal(network), max: 15 },
      anomalyPenalty: penalty,
      scoreBeforeFraudCap: beforeFraudCap,
    },
  };
}

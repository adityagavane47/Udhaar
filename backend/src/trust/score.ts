/**
 * The Udhaar Trust Score, 300 to 900, for one company (a seller or a buyer).
 *
 * It reuses the risk scorecard's pieces and its 100-point scale, then maps it to 300 + 6 × points:
 *
 *   payment history      40  on-chain repayments (hedera); with none, the mock bureau score and rating
 *   company profile      25  the scorecard's: age, GST filing, size (mock-external)
 *   external obligations 20  MSME-1 dues over 45 days and Samadhaan complaints (mock-external)
 *   network              15  the scorecard's: how the company pays others (mock-external)
 *
 * The scorecard's "this invoice" part is left out, because it describes one invoice and not a company.
 * Those checks are in the invoice checklist instead.
 */
import type { Company, SeedInvoice } from "../risk/dataset.js";
import { clamp, companyProfile, networkPoints, settleOutcome } from "../risk/scorecard.js";
import type { ExternalProfile } from "./data.js";

/** Until a company has this many on-time repayments on Udhaar, each invoice it is part of is capped. */
export const REQUIRED_ON_TIME_REPAYMENTS = 3;
export const NEW_COMPANY_LIMIT_INR = 100_000;

export type FactorSource = "hedera" | "mock-external";

export interface Factor {
  points: number;
  max: number;
  reason: string;
  source: FactorSource;
}

export interface RepaymentEvent {
  invoiceId: string;
  /** Which side of the invoice this company was on. */
  role: "buyer" | "supplier";
  amount: number;
  dueDate: string;
  /** The repayment's consensus time on Hedera. */
  paidAt: string;
  onTime: boolean;
  daysLate: number;
  transactionId: string;
  hashscanUrl: string;
}

export interface TrustLimit {
  /** Rupees per invoice. Null when there is no cap. */
  perInvoiceInr: number | null;
  onTimeRepayments: number;
  required: number;
  reason: string;
}

export interface TrustScore {
  score: number;
  /** Out of 100, before it is mapped onto 300 to 900. */
  points: number;
  newOnUdhaar: boolean;
  label: "New on Udhaar" | null;
  breakdown: { paymentHistory: Factor; companyProfile: Factor; externalObligations: Factor; network: Factor };
  limit: TrustLimit;
}

export interface TrustInput {
  name: string;
  company: Company | undefined;
  profile: ExternalProfile | undefined;
  events: RepaymentEvent[];
  history: SeedInvoice[];
  referenceDate: string;
  now: number;
}

const oneDecimal = (value: number) => Math.round(value * 10) / 10;
const rupees = (value: number) => `₹${Math.round(value).toLocaleString("en-IN")}`;
const percent = (share: number) => `${Math.round(share * 100)}%`;

const RATING_SHARE: Record<NonNullable<ExternalProfile["creditRating"]>, number> = { AAA: 1, AA: 0.9, A: 0.8, BBB: 0.65, BB: 0.5, B: 0.35, C: 0.2, D: 0 };

/** What payment history is worth from the mock bureau score alone: 40 × the score's place in 300–900, with a rating counting for a fifth. */
function externalHistory(profile: ExternalProfile | undefined, name: string): { points: number; reason: string } {
  if (!profile) return { points: 20, reason: `${name} has no (mock) credit profile, so payment history is a neutral 20 of 40.` };
  const bureau = clamp((profile.bureauScore - 300) / 600, 0, 1);
  const rating = profile.creditRating;
  const share = rating ? 0.8 * bureau + 0.2 * RATING_SHARE[rating] : bureau;
  return { points: 40 * share, reason: `${name}'s (mock) bureau score is ${profile.bureauScore} out of 900${rating ? ` and its (mock) credit rating is ${rating}` : ""}.` };
}

function paymentHistory(input: TrustInput): Factor {
  const external = externalHistory(input.profile, input.name);
  const count = input.events.length;
  if (count === 0) {
    return { points: oneDecimal(external.points), max: 40, source: "mock-external", reason: `No repayments on Udhaar yet, so this uses outside data. ${external.reason}` };
  }
  const onTimeShare = input.events.filter((event) => event.onTime).length / count;
  const averageLate = input.events.reduce((sum, event) => sum + event.daysLate, 0) / count;
  // The same formula as the scorecard, but a short history is pulled toward the outside profile and not toward a neutral 20.
  const raw = 28 * onTimeShare + 12 * clamp(1 - averageLate / 60, 0, 1);
  const weight = Math.min(count / 5, 1);
  const points = external.points + (raw - external.points) * weight;
  const late = averageLate < 1 ? "with almost no delay" : `${Math.round(averageLate)} day${Math.round(averageLate) === 1 ? "" : "s"} late on average`;
  const blend = weight < 1 ? ` With under 5 repayments, ${percent(1 - weight)} of this still comes from outside data.` : "";
  return { points: oneDecimal(points), max: 40, source: "hedera", reason: `Repaid ${percent(onTimeShare)} of ${count} invoice${count === 1 ? "" : "s"} on time on Hedera, ${late}.${blend}` };
}

function profileFactor(input: TrustInput): Factor {
  const reasons: string[] = [];
  const points = companyProfile(input.company, input.name, input.now, reasons);
  return { points: oneDecimal(points), max: 25, source: "mock-external", reason: reasons[0] ?? "" };
}

function obligationsFactor(input: TrustInput): Factor {
  const { profile, name } = input;
  if (!profile) return { points: 10, max: 20, source: "mock-external", reason: `${name} has no (mock) MSME-1 or Samadhaan record, so this is a neutral 10 of 20.` };
  const duesPoints = 10 * (1 - Math.min(1, profile.msme1DuesOver45DaysInr / 5_000_000));
  const complaintPoints = 10 - Math.min(10, profile.samadhaanComplaints * 1.25);
  const dues = profile.msme1DuesOver45DaysInr === 0 ? "reports no dues to small suppliers over 45 days" : `owes small suppliers ${rupees(profile.msme1DuesOver45DaysInr)} for over 45 days (MSME-1)`;
  const complaints = profile.samadhaanComplaints === 0 ? "has no delayed-payment complaints" : `has ${profile.samadhaanComplaints} delayed-payment complaint${profile.samadhaanComplaints === 1 ? "" : "s"} on MSME Samadhaan`;
  return { points: oneDecimal(duesPoints + complaintPoints), max: 20, source: "mock-external", reason: `${name} ${dues} and ${complaints}.` };
}

function networkFactor(input: TrustInput): Factor {
  const reasons: string[] = [];
  const referenceMs = Date.parse(input.referenceDate);
  const settled = input.company ? input.history.filter((invoice) => invoice.buyerId === input.company?.id && invoice.status !== "open").map((invoice) => settleOutcome(invoice, referenceMs)) : [];
  const points = networkPoints(settled, undefined, input.name, reasons);
  return { points: oneDecimal(points), max: 15, source: "mock-external", reason: reasons[0] ?? "" };
}

export function limitFor(events: RepaymentEvent[]): TrustLimit {
  const onTimeRepayments = events.filter((event) => event.onTime).length;
  const capped = onTimeRepayments < REQUIRED_ON_TIME_REPAYMENTS;
  return {
    perInvoiceInr: capped ? NEW_COMPANY_LIMIT_INR : null,
    onTimeRepayments,
    required: REQUIRED_ON_TIME_REPAYMENTS,
    reason: capped
      ? `Capped at ${rupees(NEW_COMPANY_LIMIT_INR)} per invoice until ${REQUIRED_ON_TIME_REPAYMENTS} on-time repayments on Udhaar (${onTimeRepayments} so far).`
      : `No cap: ${onTimeRepayments} on-time repayments on Udhaar.`,
  };
}

export function computeTrust(input: TrustInput): TrustScore {
  const breakdown = { paymentHistory: paymentHistory(input), companyProfile: profileFactor(input), externalObligations: obligationsFactor(input), network: networkFactor(input) };
  const points = Object.values(breakdown).reduce((sum, factor) => sum + factor.points, 0);
  const newOnUdhaar = input.events.length === 0;
  return {
    score: Math.round(300 + 6 * clamp(points, 0, 100)),
    points: oneDecimal(points),
    newOnUdhaar,
    label: newOnUdhaar ? "New on Udhaar" : null,
    breakdown,
    limit: limitFor(input.events),
  };
}

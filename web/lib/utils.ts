import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

/** Prices to the paisa, e.g. ₹970.41 (whole rupees keep no decimals). */
export const inrPrice = (n: number) =>
  "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

/** Percentages with up to 2 decimals, e.g. 2.96%. null or undefined shows a dash. */
export const pct = (n: number | null | undefined) => (n == null ? "—" : `${Number(n.toFixed(2))}%`);

/** Annual rate for each grade. D is not listed. */
export const RATE_BY_GRADE: Record<string, number | null> = { A: 12, B: 16, C: 20, D: null };

/** Whole days until a date; part of a day counts as a whole day. Zero once passed. */
export const daysUntil = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));

/** True once a bond's maturity has passed, with a few seconds for the chain's clock to catch up. */
export const maturityReached = (maturityDate: string | undefined, dueDate: string, graceSeconds = 10) =>
  Date.now() >= new Date(maturityDate ?? dueDate).getTime() + graceSeconds * 1000;

/** "Demo: repays in 5 min" when the bond matures before the invoice is due. Empty otherwise. */
export function demoMaturityText(maturityDate: string | undefined, dueDate: string): string {
  if (!maturityDate) return "";
  const ms = new Date(maturityDate).getTime() - Date.now();
  if (ms >= new Date(dueDate).getTime() - Date.now() - 60_000) return "";
  const mins = Math.max(0, Math.ceil(ms / 60_000));
  if (mins < 60) return `Demo: repays in ${mins} min`;
  const hours = Math.ceil(mins / 60);
  if (hours < 48) return `Demo: repays in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.ceil(hours / 24);
  return `Demo: repays in ${days} days`;
}

/** e.g. "12% a year · due in 90 days". Returns "not listed · grade D" for grade D, or "" if there is no rate. */
export function termText(rate: number | null | undefined, dueDate: string, grade?: string): string {
  if (grade === "D" || rate === null) return "not listed · grade D";
  if (rate === undefined) return "";
  const d = daysUntil(dueDate);
  return `${pct(rate)} a year · due in ${d} ${d === 1 ? "day" : "days"}`;
}

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");


/**
 * The HashScan link to show beside an error, only when it points at a transaction. A link to a token, account,
 * topic or contract means nothing was written on-chain, so it would prove nothing.
 */
export const errLink = (e: unknown): string | undefined => {
  const u = (e as { hashscanUrl?: unknown } | null)?.hashscanUrl;
  return typeof u === "string" && /\/transaction\//.test(u) ? u : undefined;
};

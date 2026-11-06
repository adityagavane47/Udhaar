import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { config, hashscan } from "./config.js";
import { ApiError } from "./errors.js";
import { ensureNavTopic, submitMessage, type HcsTopics } from "./hcs.js";
import { getParty } from "./hedera/client.js";
import { getInvoice } from "./invoices.js";
import { GRADE_ANNUAL_RATE_PCT, navPerUnit } from "./risk/scorecard.js";
import { save, serialized, state } from "./store.js";
import type { Invoice, Link, NavPublication } from "./types.js";

const DAY_MS = 86_400_000;
const utcDay = (date: Date) => date.toISOString().slice(0, 10);

export interface NavQuote {
  invoiceId: string;
  bondTokenId: string;
  symbol: string;
  /** "overdue" and "repaid" have no price: nothing is published for them. */
  status: "active" | "overdue" | "repaid";
  faceValue: number;
  annualRatePct: number;
  /** Whole days to the due date, rounded up like the issue price. Negative once overdue. */
  daysRemaining: number;
  /** Per token, to the paisa. Null when overdue or repaid. */
  nav: number | null;
  dueDate: string;
  asOf: string;
}

function tokenizedInvoice(invoiceId: string): Invoice {
  const invoice = getInvoice(invoiceId);
  if (invoice.tokenization?.status !== "complete" || !invoice.tokenization.bond) throw new ApiError(409, "NOT_TOKENIZED", `${invoice.id} has not been tokenized, so it has no NAV`);
  return invoice;
}

/**
 * NAV per token = face value × (1 − annual rate × days remaining / 365), to the paisa. It comes from the
 * same pricing code as the issue price, using the grade the bond was priced with, and counts days to the
 * invoice's due date, not to the bond's maturity. The due day itself still counts; the day after is overdue.
 * Pure: nothing is saved here.
 */
export function navFor(invoiceId: string, date: Date = new Date()): NavQuote {
  const invoice = tokenizedInvoice(invoiceId);
  const bond = invoice.tokenization?.bond;
  const grade = invoice.grade;
  const rate = grade ? GRADE_ANNUAL_RATE_PCT[grade] : null;
  if (!bond || !grade || rate === null) throw new ApiError(409, "NOT_PRICED", `${invoice.id} has no grade, so its NAV can't be worked out`);
  const faceValue = invoice.unitFaceValue ?? config.defaultUnitFaceValue;
  // `|| 0` turns the -0 that ceil gives on the due day into 0.
  const daysRemaining = Math.ceil((Date.parse(invoice.dueDate) - date.getTime()) / DAY_MS) || 0;
  const status = invoice.status === "repaid" ? "repaid" : daysRemaining < 0 ? "overdue" : "active";
  return {
    invoiceId: invoice.id,
    bondTokenId: bond.contractId,
    symbol: bond.symbol,
    status,
    faceValue,
    annualRatePct: rate,
    daysRemaining,
    nav: status === "active" ? navPerUnit(grade, faceValue, daysRemaining) : null,
    dueDate: invoice.dueDate,
    asOf: date.toISOString(),
  };
}

function knownNavTopicId(): string | undefined {
  return existsSync(config.hcsRecordPath) ? (JSON.parse(readFileSync(config.hcsRecordPath, "utf8")) as HcsTopics).navTopicId : undefined;
}

const publicationView = (publication: NavPublication) => ({ ...publication, topicUrl: hashscan.topic(publication.topicId) });

/** Free read: the current NAV, and where the last published one can be checked. */
export function navView(invoiceId: string, date: Date = new Date()) {
  const quote = navFor(invoiceId, date);
  const last = state.nav.latest[invoiceId];
  const topicId = last?.topicId ?? knownNavTopicId();
  const links: Link[] = [
    ...(last ? [{ label: "Last published NAV", url: last.hashscanUrl, txId: last.transactionId }] : []),
    ...(topicId ? [{ label: "HCS NAV feed", url: hashscan.topic(topicId) }] : []),
  ];
  return {
    ...quote,
    topic: topicId ? { id: topicId, hashscanUrl: hashscan.topic(topicId) } : null,
    lastPublished: last ? publicationView(last) : null,
    hashscanUrl: last?.hashscanUrl ?? (topicId ? hashscan.topic(topicId) : hashscan.contract(quote.bondTokenId)),
    links: links.length ? links : [{ label: "Bond", url: hashscan.contract(quote.bondTokenId) }],
  };
}

/** What the paid risk report carries. Null for an invoice with no bond, such as a simulated one. */
export function navForReport(invoiceId: string) {
  const invoice = state.invoices[invoiceId];
  return invoice?.tokenization?.status === "complete" ? navView(invoiceId) : null;
}

export interface NavMessage {
  v: 1;
  type: "nav.published";
  invoiceId: string;
  bondTokenId: string;
  nav: number;
  annualRatePct: number;
  daysRemaining: number;
  timestamp: string;
}

export function navMessage(quote: NavQuote & { nav: number }): NavMessage {
  return { v: 1, type: "nav.published", invoiceId: quote.invoiceId, bondTokenId: quote.bondTokenId, nav: quote.nav, annualRatePct: quote.annualRatePct, daysRemaining: quote.daysRemaining, timestamp: quote.asOf };
}

/** Writes one message to the feed. Swappable so tests can run without the chain. */
export type NavPublisher = (message: string, key: string) => Promise<{ topicId: string; transactionId: string; consensusTimestamp?: string; hashscanUrl: string }>;

const chainPublisher: NavPublisher = async (message, key) => {
  const topicId = await ensureNavTopic();
  const record = await submitMessage(topicId, await getParty("ADMIN"), message, key);
  return { topicId, transactionId: record.transactionId, ...(record.consensusTimestamp ? { consensusTimestamp: record.consensusTimestamp } : {}), hashscanUrl: record.hashscanUrl ?? hashscan.topic(topicId) };
};

export interface NavRun {
  trigger: "daily" | "on-demand";
  asOf: string;
  published: ReturnType<typeof publicationView>[];
  /** Overdue invoices are marked and left out. "unpriced" means a bond tokenized before grades were saved, which has no rate to work from. */
  skipped: { invoiceId: string; reason: "overdue" | "unpriced" }[];
  failed: { invoiceId: string; error: string }[];
}

/**
 * Publishes the NAV of every live tokenized invoice, or one if `invoiceId` is given. An overdue invoice
 * is marked overdue and gets no price. Run it inside serialized(), as it writes the store.
 */
export async function publishNav(options: { trigger: "daily" | "on-demand"; date?: Date; invoiceId?: string }, publisher: NavPublisher = chainPublisher): Promise<NavRun> {
  const date = options.date ?? new Date();
  const targets = options.invoiceId
    ? [tokenizedInvoice(options.invoiceId)]
    : Object.values(state.invoices).filter((invoice) => invoice.tokenization?.status === "complete" && invoice.tokenization.bond);
  const run: NavRun = { trigger: options.trigger, asOf: date.toISOString(), published: [], skipped: [], failed: [] };

  for (const invoice of targets) {
    if (invoice.status === "repaid") {
      if (options.invoiceId) throw new ApiError(409, "ALREADY_REPAID", `${invoice.id} is repaid and its units are burned, so it has no NAV`);
      continue;
    }
    let quote: NavQuote;
    try {
      quote = navFor(invoice.id, date);
    } catch (error) {
      if (options.invoiceId) throw error;
      if (error instanceof ApiError && error.code === "NOT_PRICED") {
        run.skipped.push({ invoiceId: invoice.id, reason: "unpriced" });
        continue;
      }
      throw error;
    }
    if (quote.status === "overdue" || quote.nav === null) {
      if (!invoice.overdue) {
        invoice.overdue = true;
        save();
      }
      run.skipped.push({ invoiceId: invoice.id, reason: "overdue" });
      continue;
    }
    try {
      // A daily key repeats within a day, so a retry can't post twice. On-demand always posts.
      const key = options.trigger === "daily" ? `nav:${invoice.id}:${utcDay(date)}:${quote.daysRemaining}` : `nav:${invoice.id}:${randomUUID()}`;
      const sent = await publisher(JSON.stringify(navMessage({ ...quote, nav: quote.nav })), key);
      const publication: NavPublication = {
        invoiceId: invoice.id,
        bondTokenId: quote.bondTokenId,
        nav: quote.nav,
        annualRatePct: quote.annualRatePct,
        daysRemaining: quote.daysRemaining,
        timestamp: quote.asOf,
        trigger: options.trigger,
        ...sent,
      };
      state.nav.latest[invoice.id] = publication;
      save();
      run.published.push(publicationView(publication));
    } catch (error) {
      run.failed.push({ invoiceId: invoice.id, error: error instanceof Error ? error.message : "Unknown error" });
    }
  }
  return run;
}

/** Checks every hour and publishes once per UTC day. A day with a failure is tried again on the next check. */
export function startNavScheduler(intervalMs = 3_600_000) {
  // Test servers that run on real accounts set this, so they never post prices on their own.
  if (process.env.NAV_SCHEDULER === "off") return;
  const tick = async () => {
    try {
      await serialized(async () => {
        const today = utcDay(new Date());
        if (state.nav.lastDailyDate === today) return;
        const run = await publishNav({ trigger: "daily" });
        if (run.failed.length > 0) {
          console.error(`NAV daily publish: ${run.failed.length} failed (${run.failed.map((item) => `${item.invoiceId}: ${item.error}`).join("; ")}). Will retry.`);
          return;
        }
        state.nav.lastDailyDate = today;
        save();
      });
    } catch (error) {
      console.error(`NAV daily publish failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };
  void tick();
  setInterval(tick, intervalMs).unref();
}

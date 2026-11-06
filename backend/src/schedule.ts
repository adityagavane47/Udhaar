import { ScheduleCreateTransaction, Timestamp, TransferTransaction } from "@hiero-ledger/sdk";
import { config, hashscan, toBaseUnits } from "./config.js";
import { executeOnce, getParty, getSigner } from "./hedera/client.js";
import { mirrorGet, type MirrorTransaction } from "./hedera/mirror.js";
import { repayInvoice } from "./repayment.js";
import { audit, save, serialized, state } from "./store.js";
import type { Invoice, RepaymentSchedule } from "./types.js";

/**
 * The network refuses a schedule that expires more than 62 days (5,356,800 s) from now. Checked on
 * testnet: 61.5 days was accepted, 63 days failed with SCHEDULE_EXPIRATION_TIME_TOO_FAR_IN_FUTURE.
 * An hour is held back so the clock difference between this server and the network can't tip it over.
 */
export const MAX_SCHEDULE_SECONDS = 5_356_800 - 3_600;
/** A maturity closer than this is left to the manual route: the schedule needs time to reach consensus. */
export const MIN_SCHEDULE_SECONDS = 20;
/** After the expiry, how long the network gets to run the schedule before it counts as failed. */
export const EXECUTION_GRACE_SECONDS = 120;

export interface ScheduleState {
  executedTimestamp: string | null;
  deleted: boolean;
}

/** What the check needs from the chain. Swappable, so tests can use any schedule history. */
export interface ScheduleReader {
  schedule(scheduleId: string): Promise<ScheduleState | undefined>;
  /** The scheduled transaction the network ran, or undefined if it has not been recorded. */
  executed(scheduleId: string, executedTimestamp: string | null, buyerId: string, sinceUnix: number): Promise<{ transactionId: string; consensusTimestamp: string; result: string } | undefined>;
}

interface MirrorSchedule {
  executed_timestamp: string | null;
  deleted: boolean;
}

export const mirrorScheduleReader: ScheduleReader = {
  async schedule(scheduleId) {
    const body = await mirrorGet<MirrorSchedule>(`/schedules/${scheduleId}`);
    return body ? { executedTimestamp: body.executed_timestamp, deleted: body.deleted } : undefined;
  },
  async executed(_scheduleId, executedTimestamp, buyerId, sinceUnix) {
    // A schedule that ran has the timestamp of the scheduled transaction. A failed run may not, so also look for one.
    const body = executedTimestamp
      ? await mirrorGet<{ transactions: (MirrorTransaction & { scheduled?: boolean })[] }>(`/transactions?timestamp=${executedTimestamp}`)
      : await mirrorGet<{ transactions: (MirrorTransaction & { scheduled?: boolean })[] }>(`/transactions?account.id=${buyerId}&order=desc&limit=25&timestamp=gte:${sinceUnix}.000000000`);
    const found = body?.transactions.find((transaction) => transaction.scheduled === true);
    return found ? { transactionId: found.transaction_id, consensusTimestamp: found.consensus_timestamp, result: found.result } : undefined;
  },
};

export type ScheduleSkip = "no_bond" | "already_scheduled" | "already_repaid" | "matured" | "too_soon" | "too_far";

/** Whether a repayment can be scheduled for this invoice right now, and why not if it cannot. */
export function scheduleEligibility(invoice: Invoice, nowMs = Date.now()): { ok: true; maturityUnix: number } | { ok: false; reason: ScheduleSkip } {
  const plan = invoice.tokenization;
  if (!plan || plan.status !== "complete" || !plan.bond) return { ok: false, reason: "no_bond" };
  if (invoice.schedule) return { ok: false, reason: "already_scheduled" };
  if (invoice.repayment || invoice.status === "repaid") return { ok: false, reason: "already_repaid" };
  const secondsLeft = plan.maturityDateUnix - nowMs / 1000;
  if (secondsLeft <= 0) return { ok: false, reason: "matured" };
  if (secondsLeft < MIN_SCHEDULE_SECONDS) return { ok: false, reason: "too_soon" };
  if (secondsLeft > MAX_SCHEDULE_SECONDS) return { ok: false, reason: "too_far" };
  return { ok: true, maturityUnix: plan.maturityDateUnix };
}

/**
 * Creates the schedule: a uINR transfer of the full repayment from the buyer to REPAYMENT, with the
 * same memo as the manual route, set to run at maturity whether or not more signatures arrive.
 * The buyer signs the creation, which also signs the transfer. The buyer also holds the admin key, so
 * the schedule can be deleted. It runs at most once per bond: the transaction ledger remembers it.
 */
export async function ensureRepaymentSchedule(invoice: Invoice, nowMs = Date.now()): Promise<RepaymentSchedule | undefined> {
  const eligible = scheduleEligibility(invoice, nowMs);
  if (!eligible.ok) return undefined;
  const bond = invoice.tokenization?.bond;
  if (!bond) return undefined;

  const buyer = await getSigner(invoice.buyerId);
  const repayment = await getParty("REPAYMENT");
  const symbol = bond.symbol;
  const amountBase = toBaseUnits(invoice.amount);

  const record = await executeOnce({
    key: `${symbol}:schedule`,
    payer: buyer,
    maxFeeHbar: config.htsMaxFeeHbar,
    build: () => {
      const repay = new TransferTransaction()
        .addTokenTransfer(config.uinrTokenId, buyer.id, -amountBase)
        .addTokenTransfer(config.uinrTokenId, repayment.id, amountBase)
        .setTransactionMemo(symbol);
      return new ScheduleCreateTransaction()
        .setScheduledTransaction(repay)
        .setExpirationTime(Timestamp.fromDate(new Date(eligible.maturityUnix * 1000)))
        .setWaitForExpiry(true)
        .setAdminKey(buyer.key.publicKey)
        .setScheduleMemo(`Udhaar repayment of ${invoice.id}`);
    },
  });
  if (!record.succeeded) throw new Error(`${symbol}:schedule failed with ${record.result} (${record.hashscanUrl})`);
  if (!record.entityId) throw new Error(`${symbol}:schedule succeeded but the mirror node gave no schedule ID (${record.hashscanUrl})`);

  invoice.schedule = {
    status: "scheduled",
    scheduleId: record.entityId,
    createTxId: record.transactionId,
    createHashscanUrl: record.hashscanUrl ?? "",
    hashscanUrl: hashscan.schedule(record.entityId),
    expiresAtUnix: eligible.maturityUnix,
    amountBaseUnits: amountBase,
    memo: symbol,
    createdAt: new Date().toISOString(),
  };
  save();
  audit({
    type: "repayment_scheduled",
    description: `${invoice.buyerName} scheduled repayment of ${invoice.amount} uINR for ${invoice.id}, to run at maturity (${record.entityId})`,
    actor: buyer.name,
    hashscanUrl: invoice.schedule.hashscanUrl,
    txId: record.transactionId,
    invoiceId: invoice.id,
  });
  return invoice.schedule;
}

/**
 * Reads the schedule from the chain and records what happened. Nothing changes before the expiry.
 * Returns true if the status changed.
 */
export async function settleSchedule(invoice: Invoice, reader: ScheduleReader = mirrorScheduleReader, nowMs = Date.now()): Promise<boolean> {
  const schedule = invoice.schedule;
  if (!schedule || schedule.status !== "scheduled") return false;
  if (nowMs / 1000 < schedule.expiresAtUnix) return false;

  const onChain = await reader.schedule(schedule.scheduleId);
  const ran = await reader.executed(schedule.scheduleId, onChain?.executedTimestamp ?? null, invoice.buyerId, schedule.expiresAtUnix - 1);

  if (ran && ran.result === "SUCCESS") {
    schedule.status = "executed";
    schedule.executedTxId = ran.transactionId;
    schedule.executedHashscanUrl = hashscan.transaction(ran.consensusTimestamp);
    schedule.executedAt = new Date(Number(ran.consensusTimestamp.split(".")[0]) * 1000).toISOString();
    save();
    audit({ type: "scheduled_repayment", description: `Scheduled repayment of ${invoice.id} ran: ${invoice.buyerName} paid ${invoice.amount} uINR to REPAYMENT`, actor: "Hedera schedule", hashscanUrl: schedule.executedHashscanUrl, txId: ran.transactionId, invoiceId: invoice.id });
    return true;
  }

  const failed = (reason: string, link?: string) => {
    schedule.status = "failed";
    schedule.failureReason = reason;
    if (link) schedule.executedHashscanUrl = link;
    save();
    audit({ type: "scheduled_repayment", description: `Scheduled repayment of ${invoice.id} failed: ${reason}. Manual repay is still available.`, actor: "Hedera schedule", hashscanUrl: link ?? schedule.hashscanUrl, invoiceId: invoice.id, status: "rejected" });
    return true;
  };
  if (ran) return failed(`The scheduled transfer ended with ${ran.result}`, hashscan.transaction(ran.consensusTimestamp));
  if (onChain?.deleted) return failed("The schedule was deleted before it ran");
  if (nowMs / 1000 > schedule.expiresAtUnix + EXECUTION_GRACE_SECONDS) return failed("The schedule did not run by its expiry, most likely because the buyer lacked the uINR");
  return false;
}

export type ScheduleAction = { invoiceId: string; action: "created" | "executed" | "failed" | "repaid" | "error"; detail?: string };

/**
 * One pass: create schedules that are now within the network's limit, record the ones that have
 * expired, and run the normal repayment (burn, then pay) for any whose payment landed. Run it inside serialized().
 */
export async function runScheduleCheck(reader: ScheduleReader = mirrorScheduleReader, nowMs = Date.now()): Promise<ScheduleAction[]> {
  const actions: ScheduleAction[] = [];
  for (const invoice of Object.values(state.invoices)) {
    if (invoice.archived || invoice.status === "repaid" || invoice.repayment?.status === "complete") continue;
    if (invoice.tokenization?.status !== "complete") continue;
    try {
      if (!invoice.schedule) {
        if (await ensureRepaymentSchedule(invoice, nowMs)) actions.push({ invoiceId: invoice.id, action: "created" });
        continue;
      }
      if (await settleSchedule(invoice, reader, nowMs)) actions.push({ invoiceId: invoice.id, action: invoice.schedule.status === "executed" ? "executed" : "failed" });
      if (invoice.schedule.status === "executed" && invoice.repayment?.status !== "needs_review") {
        await repayInvoice(invoice);
        actions.push({ invoiceId: invoice.id, action: "repaid" });
      }
    } catch (error) {
      actions.push({ invoiceId: invoice.id, action: "error", detail: error instanceof Error ? error.message : "unknown error" });
    }
  }
  return actions;
}

/** Checks every 30 seconds (SCHEDULE_CHECK_SECONDS). SCHEDULE_WATCHER=off turns it off, for test servers on real accounts. */
export function startScheduleWatcher() {
  if (process.env.SCHEDULE_WATCHER === "off") return;
  const seconds = Number(process.env.SCHEDULE_CHECK_SECONDS ?? 30);
  const tick = async () => {
    try {
      const actions = await serialized(() => runScheduleCheck());
      for (const action of actions) console.log(`Schedule check: ${action.invoiceId} ${action.action}${action.detail ? ` (${action.detail})` : ""}`);
    } catch (error) {
      console.error(`Schedule check failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };
  void tick();
  setInterval(tick, (Number.isFinite(seconds) && seconds >= 5 ? seconds : 30) * 1000).unref();
}

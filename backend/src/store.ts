import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { config, hashscan } from "./config.js";
import type { AuditEntry, State } from "./types.js";

const STORE_PATH = `${config.dataDir.replace(/[\\/]$/, "")}/store.json`;

const emptyState = (): State => ({ version: 1, nextInvoiceNumber: 1, invoices: {}, kyc: {}, purchases: {}, ledger: {}, audit: [], reportPayments: {}, agentRuns: [] });

/** Spread over the empty state, so a store saved before a field existed still loads. */
export const state: State = { ...emptyState(), ...(existsSync(STORE_PATH) ? (JSON.parse(readFileSync(STORE_PATH, "utf8")) as Partial<State>) : {}) };

/** Syncs a temp file to disk and renames it, so a crash can never leave a half-written store. */
export function save() {
  const temporary = `${STORE_PATH}.tmp`;
  const handle = openSync(temporary, "w");
  try {
    writeSync(handle, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, STORE_PATH);
}

export function audit(entry: Omit<AuditEntry, "id" | "timestamp" | "status" | "hashscanUrl"> & { hashscanUrl?: string; status?: AuditEntry["status"] }) {
  const { hashscanUrl, status, ...fields } = entry;
  state.audit.unshift({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    status: status ?? "success",
    hashscanUrl: hashscanUrl ?? hashscan.token(config.uinrTokenId),
    ...fields,
  });
  save();
}

let tail: Promise<unknown> = Promise.resolve();

/**
 * Runs state-changing work one request at a time. Money moves in several steps with
 * chain reads between them, so two overlapping requests could otherwise both decide to pay.
 */
export function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.catch(() => undefined);
  return run;
}

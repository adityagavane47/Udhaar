import { closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

/** The number the first invoice of a recording gets. */
export const FIRST_DEMO_INVOICE_NUMBER = 42;

type Json = Record<string, any>;

export interface ResetSummary {
  archived: { invoices: number; agentRuns: number; auditEntries: number };
  alreadyArchived: { invoices: number; agentRuns: number; auditEntries: number };
  kyc: { id: string; walletAddress: string; before: string } | null;
  nextInvoiceNumber: number;
  nextInvoiceId: string;
  /** Set when the next number had to go above 42, because an invoice with that number or higher already exists. */
  raisedBecause?: string;
}

const invoiceNumber = (id: string) => /^INV-(\d+)$/.exec(id)?.[1];
export const invoiceIdFor = (n: number) => `INV-${String(n).padStart(4, "0")}`;

/**
 * Archives, never deletes: every invoice, agent run and audit entry gets `archived: true`, so lists hide
 * it while lookups by ID, the duplicate guard, trust history, NAV, saved transaction keys and paid
 * x402 reports still see it. Purchases, ledger, report payments and NAV records are left alone.
 *
 * A number that an existing invoice already uses is never handed out again: reusing it would replay
 * that invoice's saved confirmation transaction and overwrite its record.
 */
export function archiveStore(input: Json, options: { investorAccountId?: string | undefined; firstNumber?: number }): { store: Json; summary: ResetSummary } {
  const store = structuredClone(input);
  const first = options.firstNumber ?? FIRST_DEMO_INVOICE_NUMBER;
  const summary: ResetSummary = {
    archived: { invoices: 0, agentRuns: 0, auditEntries: 0 },
    alreadyArchived: { invoices: 0, agentRuns: 0, auditEntries: 0 },
    kyc: null,
    nextInvoiceNumber: first,
    nextInvoiceId: invoiceIdFor(first),
  };

  const flag = (items: Json[], key: keyof ResetSummary["archived"]) => {
    for (const item of items) {
      if (item.archived === true) summary.alreadyArchived[key] += 1;
      else {
        item.archived = true;
        summary.archived[key] += 1;
      }
    }
  };
  flag(Object.values(store.invoices ?? {}) as Json[], "invoices");
  flag((store.agentRuns ?? []) as Json[], "agentRuns");
  flag((store.audit ?? []) as Json[], "auditEntries");

  const numbers = Object.keys(store.invoices ?? {})
    .map(invoiceNumber)
    .filter((n): n is string => n !== undefined)
    .map(Number);
  const highest = numbers.length ? Math.max(...numbers) : 0;
  const next = Math.max(first, highest + 1);
  if (next > first) {
    summary.raisedBecause = `${invoiceIdFor(highest)} already exists, so ${invoiceIdFor(next)} is next. To start at ${invoiceIdFor(first)} again, restore the backup from before the take and reset again`;
  }
  store.nextInvoiceNumber = next;
  summary.nextInvoiceNumber = next;
  summary.nextInvoiceId = invoiceIdFor(next);

  if (options.investorAccountId) {
    for (const request of Object.values(store.kyc ?? {}) as Json[]) {
      if (request.walletAddress !== options.investorAccountId) continue;
      summary.kyc = { id: request.id, walletAddress: request.walletAddress, before: request.status };
      request.status = "pending";
      request.pendingBonds = [];
    }
  }
  return { store, summary };
}

export const storePath = (dataDir: string) => join(dataDir, "store.json");
export const backupsDir = (dataDir: string) => join(dataDir, "backups");

/** Syncs a temp file and renames it, so a crash can't leave a half-written store. */
export function writeStore(dataDir: string, store: Json) {
  const path = storePath(dataDir);
  const handle = openSync(`${path}.tmp`, "w");
  try {
    writeSync(handle, `${JSON.stringify(store, null, 2)}\n`);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(`${path}.tmp`, path);
}

export function readStore(dataDir: string): Json {
  if (!existsSync(storePath(dataDir))) throw new Error(`No store at ${storePath(dataDir)}`);
  return JSON.parse(readFileSync(storePath(dataDir), "utf8")) as Json;
}

/** Copies the whole data directory, except earlier backups, into data/backups/<timestamp>[-label]. */
export function backupDataDir(dataDir: string, label = "", now = new Date()): string {
  const target = join(backupsDir(dataDir), `${now.toISOString().replace(/[:.]/g, "-")}${label ? `-${label}` : ""}`);
  mkdirSync(target, { recursive: true });
  // Entry by entry, because Node refuses to copy a directory into a folder inside itself.
  for (const entry of readdirSync(dataDir)) {
    if (entry !== "backups") cpSync(join(dataDir, entry), join(target, entry), { recursive: true });
  }
  return target;
}

/** A backup can be named by absolute path, relative path, or just its folder name under data/backups. */
export function resolveBackup(dataDir: string, name: string): string {
  const candidates = isAbsolute(name) ? [name] : [resolve(name), join(backupsDir(dataDir), basename(name))];
  const found = candidates.find((candidate) => existsSync(storePath(candidate)));
  if (!found) throw new Error(`No backup with a store.json at ${candidates.join(" or ")}`);
  if (resolve(found) === resolve(dataDir)) throw new Error("That is the live data directory, not a backup");
  return found;
}

/** Puts a backup back over the data directory. The current state is saved first, so a restore can itself be undone. */
export function restoreBackup(dataDir: string, name: string): { restoredFrom: string; safetyBackup: string } {
  const source = resolveBackup(dataDir, name);
  const safetyBackup = backupDataDir(dataDir, "before-restore");
  for (const entry of readdirSync(source)) cpSync(join(source, entry), join(dataDir, entry), { recursive: true, force: true });
  return { restoredFrom: source, safetyBackup };
}

/** True if something already answers on the backend's port: a running server would overwrite the store. */
export async function serverIsRunning(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

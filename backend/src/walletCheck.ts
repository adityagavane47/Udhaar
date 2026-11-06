import { readFileSync } from "node:fs";
import { z } from "zod";
import { config, hashscan } from "./config.js";
import { mirrorGet } from "./hedera/mirror.js";

/** An account younger than this many days is flagged. */
export const NEW_ACCOUNT_DAYS = 7;
/** How many of the account's latest transfers are searched for blocklisted counterparties. */
export const TRANSFERS_CHECKED = 100;
/** The transaction count stops here, so a busy account can't make the check slow. */
const COUNT_PAGES = 5;

export interface WalletWarning {
  code: "ACCOUNT_TOO_NEW" | "BLOCKLISTED_COUNTERPARTY";
  message: string;
  /** The blocklisted account, for BLOCKLISTED_COUNTERPARTY. */
  accountId?: string;
}

export interface WalletCheck {
  source: "mirror";
  checkedAt: string;
  /** "unavailable" when the mirror node could not be read: nothing is claimed either way. */
  status: "clean" | "warnings" | "unavailable";
  accountCreatedAt?: string;
  accountAgeDays?: number;
  transactionCount?: number;
  /** True when the account has more transactions than were counted. */
  transactionCountCapped?: boolean;
  transfersChecked?: number;
  counterpartiesChecked?: number;
  warnings: WalletWarning[];
  /** Always "mock": the blocklist is fictional. */
  blocklist: "mock";
  note?: string;
  hashscanUrl: string;
}

const blocklistSchema = z.object({
  source: z.literal("mock"),
  accounts: z.array(z.object({ accountId: z.string().regex(/^0\.0\.\d+$/), reason: z.string() })),
});

let blocklist: Map<string, string> | undefined;
export function loadBlocklist(): Map<string, string> {
  if (!blocklist) {
    const parsed = blocklistSchema.parse(JSON.parse(readFileSync(`${config.riskDataDir}blocklist.json`, "utf8")));
    blocklist = new Map(parsed.accounts.map((entry) => [entry.accountId, entry.reason]));
  }
  return blocklist;
}

/** What the check needs from the chain. Swappable, so tests can use any account history. */
export interface WalletReader {
  /** When the account was created, or undefined if it does not exist. */
  createdAt(accountId: string): Promise<Date | undefined>;
  /** The accounts on the other side of the latest `limit` transfers, and how many transfers that was. */
  counterparties(accountId: string, limit: number): Promise<{ transfers: number; accounts: string[] }>;
  /** How many transactions the account is part of, counting at most `maxPages` pages of 100. */
  transactionCount(accountId: string, maxPages: number): Promise<{ count: number; capped: boolean }>;
}

interface MirrorTransfers {
  transactions: { transfers?: { account: string }[]; token_transfers?: { account: string }[]; nft_transfers?: { sender_account_id: string | null; receiver_account_id: string | null }[] }[];
  links?: { next: string | null };
}

export const mirrorWalletReader: WalletReader = {
  async createdAt(accountId) {
    const account = await mirrorGet<{ created_timestamp: string | null }>(`/accounts/${accountId}`);
    return account?.created_timestamp ? new Date(Number(account.created_timestamp.split(".")[0]) * 1000) : undefined;
  },
  async counterparties(accountId, limit) {
    const body = await mirrorGet<MirrorTransfers>(`/transactions?account.id=${accountId}&transactiontype=cryptotransfer&order=desc&limit=${limit}`);
    if (!body) throw new Error(`Mirror node had no transactions for ${accountId}`);
    const others = new Set<string>();
    for (const transaction of body.transactions) {
      const seen = [...(transaction.transfers ?? []).map((move) => move.account), ...(transaction.token_transfers ?? []).map((move) => move.account), ...(transaction.nft_transfers ?? []).flatMap((move) => [move.sender_account_id, move.receiver_account_id])];
      for (const other of seen) if (other && other !== accountId) others.add(other);
    }
    return { transfers: body.transactions.length, accounts: [...others] };
  },
  async transactionCount(accountId, maxPages) {
    let count = 0;
    let next: string | null = `/transactions?account.id=${accountId}&order=desc&limit=100`;
    for (let page = 0; next && page < maxPages; page++) {
      const body: (MirrorTransfers & { links?: { next: string | null } }) | undefined = await mirrorGet(next);
      if (!body) throw new Error(`Mirror node had no transactions for ${accountId}`);
      count += body.transactions.length;
      // The mirror node can send a next link after a short last page, so a page under 100 means that was all of them.
      next = body.transactions.length >= 100 && body.links?.next ? body.links.next.replace(/^\/api\/v1/, "") : null;
    }
    return { count, capped: next !== null };
  },
};

/**
 * Reads the account from the mirror node and applies the two rules: under 7 days old, and any
 * interaction with an account on the (mock) blocklist in its latest 100 transfers. It never throws:
 * if the mirror node can't be read the result says "unavailable" and claims nothing.
 */
export async function checkWallet(accountId: string, reader: WalletReader = mirrorWalletReader, now: number = Date.now()): Promise<WalletCheck> {
  const base = { source: "mirror" as const, checkedAt: new Date(now).toISOString(), blocklist: "mock" as const, hashscanUrl: hashscan.account(accountId) };
  try {
    const created = await reader.createdAt(accountId);
    if (!created) return { ...base, status: "unavailable", warnings: [], note: `Account ${accountId} was not found on the mirror node` };
    const [moves, count] = await Promise.all([reader.counterparties(accountId, TRANSFERS_CHECKED), reader.transactionCount(accountId, COUNT_PAGES)]);

    const ageDays = Math.floor((now - created.getTime()) / 86_400_000);
    const warnings: WalletWarning[] = [];
    if (ageDays < NEW_ACCOUNT_DAYS) {
      warnings.push({ code: "ACCOUNT_TOO_NEW", message: `The account is ${ageDays <= 0 ? "less than a day" : `${ageDays} day${ageDays === 1 ? "" : "s"}`} old, under the ${NEW_ACCOUNT_DAYS}-day minimum (created ${created.toISOString().slice(0, 10)})` });
    }
    const list = loadBlocklist();
    for (const other of moves.accounts) {
      const reason = list.get(other);
      if (reason !== undefined) warnings.push({ code: "BLOCKLISTED_COUNTERPARTY", accountId: other, message: `Transferred with ${other}, which is on the (mock) blocklist: ${reason}` });
    }
    return {
      ...base,
      status: warnings.length ? "warnings" : "clean",
      accountCreatedAt: created.toISOString(),
      accountAgeDays: ageDays,
      transactionCount: count.count,
      transactionCountCapped: count.capped,
      transfersChecked: moves.transfers,
      counterpartiesChecked: moves.accounts.length,
      warnings,
    };
  } catch (error) {
    return { ...base, status: "unavailable", warnings: [], note: `The mirror node could not be read: ${error instanceof Error ? error.message : "unknown error"}` };
  }
}

import { TransferTransaction } from "@hiero-ledger/sdk";
import { config, fromBaseUnits } from "./config.js";
import { ApiError } from "./errors.js";
import { executeOnce, type Party } from "./hedera/client.js";
import { getAccount, mirrorGet, mirrorPages, poll, type MirrorTransaction } from "./hedera/mirror.js";

const TOKEN = () => config.uinrTokenId;

export async function uinrBalance(accountId: string): Promise<number> {
  const body = await mirrorGet<{ tokens: { balance: number }[] }>(`/accounts/${accountId}/tokens?token.id=${TOKEN()}`);
  return body?.tokens[0]?.balance ?? 0;
}

/** True if this account can receive uINR now: already associated, or has a free automatic slot. */
export async function canReceiveUinr(accountId: string): Promise<{ ok: boolean; reason?: string }> {
  const account = await getAccount(accountId);
  if (!account) return { ok: false, reason: "account not found" };
  if (account.deleted) return { ok: false, reason: "account is deleted" };
  if (account.receiver_sig_required) return { ok: false, reason: "account requires its own signature to receive" };
  const association = await mirrorGet<{ tokens: unknown[] }>(`/accounts/${accountId}/tokens?token.id=${TOKEN()}`);
  if ((association?.tokens.length ?? 0) > 0) return { ok: true };
  const slots = account.max_automatic_token_associations;
  if (slots === -1) return { ok: true };
  if (slots === 0) return { ok: false, reason: "account is not associated with uINR and has no automatic slots" };
  let used = 0;
  for await (const token of mirrorPages<{ automatic_association: boolean }>(`/accounts/${accountId}/tokens?limit=100`, "tokens")) {
    if (token.automatic_association) used += 1;
  }
  return used < slots ? { ok: true } : { ok: false, reason: `all ${slots} automatic association slots are used` };
}

const decodeMemo = (transaction: MirrorTransaction) => Buffer.from(transaction.memo_base64 ?? "", "base64").toString("utf8");

export const movedAmount = (transaction: MirrorTransaction, accountId: string) =>
  transaction.token_transfers?.find((move) => move.token_id === TOKEN() && move.account === accountId)?.amount ?? 0;

/** Successful uINR transfers into `toId` with this exact memo. Throws if the search cannot finish. */
export async function findTransfersInto(toId: string, memo: string): Promise<MirrorTransaction[]> {
  const created = await mirrorGet<{ created_timestamp: string }>(`/tokens/${TOKEN()}`);
  if (!created) throw new Error("uINR token not found on the mirror node");
  const matches: MirrorTransaction[] = [];
  const path = `/transactions?account.id=${toId}&transactiontype=cryptotransfer&result=success&order=asc&limit=100&timestamp=gte:${created.created_timestamp}`;
  for await (const transaction of mirrorPages<MirrorTransaction>(path, "transactions")) {
    if (decodeMemo(transaction) === memo && movedAmount(transaction, toId) > 0) matches.push(transaction);
  }
  return matches;
}

export interface SendOptions {
  key: string;
  from: Party;
  toId: string;
  amountBaseUnits: number;
  memo: string;
  /** Custom fee the sender pays on top, in base units. Zero when either side is exempt. */
  expectedFeeBaseUnits?: number;
  crashAfterSend?: string;
}

/**
 * Sends uINR at most once per key. Two layers stop a second payment: the ledger resolves any saved
 * intent, then the chain is searched for this memo, so even a lost record cannot cause a resend.
 * The balance is checked last, so a payment that already happened is not mistaken for missing funds.
 */
export async function sendUinrOnce(options: SendOptions) {
  const { key, from, toId, amountBaseUnits, memo, crashAfterSend } = options;
  const fee = options.expectedFeeBaseUnits ?? 0;
  const record = await executeOnce({
    key,
    payer: from,
    maxFeeHbar: config.htsMaxFeeHbar,
    ...(crashAfterSend ? { crashAfterSend } : {}),
    build: () =>
      new TransferTransaction()
        .addTokenTransfer(TOKEN(), from.id, -amountBaseUnits)
        .addTokenTransfer(TOKEN(), toId, amountBaseUnits)
        .setTransactionMemo(memo),
    beforeSend: async () => {
      const earlier = (await findTransfersInto(toId, memo)).find((transaction) => movedAmount(transaction, from.id) < 0);
      if (earlier) return earlier;
      const needed = amountBaseUnits + fee;
      const held = await uinrBalance(from.id);
      if (held < needed) {
        throw new ApiError(422, "INSUFFICIENT_UINR", `${from.name} holds ${fromBaseUnits(held)} uINR but needs ${fromBaseUnits(needed)} (including any fee)`);
      }
      return undefined;
    },
  });
  if (!record.succeeded) throw new Error(`${key} failed with ${record.result} (${record.hashscanUrl})`);

  const transaction = await poll(`mirror record of ${record.transactionId}`, async () => {
    const found = await mirrorGet<{ transactions: MirrorTransaction[] }>(`/transactions/${record.transactionId}`);
    return found?.transactions.find((entry) => entry.nonce === 0);
  });
  const charged = (transaction.assessed_custom_fees ?? []).reduce((sum, entry) => sum + entry.amount, 0);
  if (movedAmount(transaction, toId) !== amountBaseUnits || charged !== fee) {
    throw new Error(`${key}: expected ${amountBaseUnits} with a ${fee} fee, chain shows ${movedAmount(transaction, toId)} with a ${charged} fee (${record.hashscanUrl})`);
  }
  return record;
}

/** What the trust layer reads from Hedera. It sits behind an interface so tests can supply their own history. */
import { config } from "../config.js";
import { ensureTopics, findFingerprint, verifyMessage } from "../hcs.js";
import { mirrorGet, type MirrorTransaction } from "../hedera/mirror.js";

export interface RepaymentProof {
  /** Consensus time, ISO. */
  paidAt: string;
}

export interface ConfirmationProof {
  sequence: number;
  topicId: string;
  /** Whether the message was posted by the buyer, carries a good signature, and names this invoice. */
  valid: boolean;
  problem?: string;
}

export interface RegistryProof {
  invoiceId: string;
  sequence: number;
  hashscanUrl: string;
}

export interface ChainReader {
  /** Undefined when the transaction doesn't exist or didn't succeed with a uINR payment from the buyer. */
  repayment(transactionId: string, buyerAccountId: string): Promise<RepaymentProof | undefined>;
  confirmation(input: { consensusTimestamp: string; invoiceId: string; fingerprint: string; buyerAccountId: string }): Promise<ConfirmationProof | undefined>;
  registry(fingerprint: string): Promise<RegistryProof | undefined>;
}

const toIso = (consensusTimestamp: string) => new Date(Number(consensusTimestamp.split(".")[0]) * 1000 + Number((consensusTimestamp.split(".")[1] ?? "0").slice(0, 3).padEnd(3, "0"))).toISOString();

const repaymentCache = new Map<string, RepaymentProof | undefined>();

/** Reads the mirror node. Anything that can't be read throws, so a score is never built from a partial history. */
export const mirrorChain: ChainReader = {
  async repayment(transactionId, buyerAccountId) {
    const key = `${transactionId}|${buyerAccountId}`;
    if (repaymentCache.has(key)) return repaymentCache.get(key);
    const found = await mirrorGet<{ transactions: MirrorTransaction[] }>(`/transactions/${transactionId}`);
    const transaction = found?.transactions.find((entry) => entry.nonce === 0);
    const paidByBuyer = transaction?.token_transfers?.some((move) => move.token_id === config.uinrTokenId && move.account === buyerAccountId && move.amount < 0);
    const proof = transaction && transaction.result === "SUCCESS" && paidByBuyer ? { paidAt: toIso(transaction.consensus_timestamp) } : undefined;
    repaymentCache.set(key, proof);
    return proof;
  },

  async confirmation({ consensusTimestamp, invoiceId, fingerprint, buyerAccountId }) {
    const { confirmationTopicId } = await ensureTopics();
    const found = await mirrorGet<{ messages: { message: string; sequence_number: number; payer_account_id: string }[] }>(`/topics/${confirmationTopicId}/messages?timestamp=eq:${consensusTimestamp}&limit=1`);
    const item = found?.messages[0];
    if (!item) return undefined;
    const proof = (valid: boolean, problem?: string): ConfirmationProof => ({ sequence: item.sequence_number, topicId: confirmationTopicId, valid, ...(problem ? { problem } : {}) });
    try {
      const envelope = JSON.parse(Buffer.from(item.message, "base64").toString("utf8")) as { payload: string; signature: string; publicKey: string };
      const payload = JSON.parse(envelope.payload) as { type?: string; invoiceId?: string; fingerprint?: string; buyer?: string };
      if (item.payer_account_id !== buyerAccountId) return proof(false, `posted by ${item.payer_account_id}, not the buyer ${buyerAccountId}`);
      if (!verifyMessage(envelope.publicKey, envelope.payload, envelope.signature)) return proof(false, "the buyer's signature does not verify");
      if (payload.type !== "invoice.confirmed" || payload.invoiceId !== invoiceId || payload.fingerprint !== fingerprint) return proof(false, "the signed message is about a different invoice");
      return proof(true);
    } catch {
      return proof(false, "the message on the topic could not be read");
    }
  },

  async registry(fingerprint) {
    const entry = await findFingerprint(fingerprint);
    return entry ? { invoiceId: entry.invoiceId, sequence: entry.sequence, hashscanUrl: entry.hashscanUrl } : undefined;
  },
};

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PublicKey, TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { config, hashscan } from "./config.js";
import { executeOnce, getParty, type Party } from "./hedera/client.js";
import { mirrorPages } from "./hedera/mirror.js";
import type { TxRecord } from "./types.js";

export interface HcsTopics {
  registryTopicId: string;
  confirmationTopicId: string;
}

interface MirrorTopicMessage {
  consensus_timestamp: string;
  message: string;
  sequence_number: number;
  payer_account_id: string;
}

export interface RegistryEntry {
  v: 1;
  type: "invoice.registered";
  fingerprint: string;
  invoiceId: string;
}

let topics: HcsTopics | undefined;

async function createTopic(key: string, memo: string, submitKeyHolder?: Party): Promise<string> {
  const admin = await getParty("ADMIN");
  const record = await executeOnce({
    key,
    payer: admin,
    maxFeeHbar: config.hcsMaxFeeHbar + 3,
    build: () => {
      const transaction = new TopicCreateTransaction().setTopicMemo(memo);
      if (submitKeyHolder) transaction.setSubmitKey(submitKeyHolder.key.publicKey);
      return transaction;
    },
  });
  if (!record.succeeded || !record.entityId) throw new Error(`Topic creation failed with ${record.result}`);
  return record.entityId;
}

/**
 * Topic IDs live in a tracked file, not the store: losing them would start an empty registry and
 * silently allow double financing.
 *
 * The registry only accepts admin-signed messages, so nobody can block an invoice by posting its
 * hash first. Confirmations stay open for buyers to post, and each one carries the buyer's signature.
 */
export async function ensureTopics(): Promise<HcsTopics> {
  if (topics) return topics;
  if (existsSync(config.hcsRecordPath)) {
    topics = JSON.parse(readFileSync(config.hcsRecordPath, "utf8")) as HcsTopics;
    return topics;
  }
  const admin = await getParty("ADMIN");
  topics = {
    registryTopicId: await createTopic("hcs:topic:registry", "Udhaar invoice registry", admin),
    confirmationTopicId: await createTopic("hcs:topic:confirmations", "Udhaar buyer confirmations"),
  };
  writeFileSync(config.hcsRecordPath, `${JSON.stringify(topics, null, 2)}\n`);
  return topics;
}

export async function submitMessage(topicId: string, payer: Party, message: string, key: string): Promise<TxRecord & { replayed: boolean }> {
  const record = await executeOnce({
    key,
    payer,
    maxFeeHbar: config.hcsMaxFeeHbar,
    build: () => new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(message),
  });
  if (!record.succeeded) throw new Error(`HCS message failed with ${record.result} (${record.hashscanUrl})`);
  return record;
}

/** Searches the whole registry for a fingerprint. Throws if it cannot finish, so uploads fail closed. */
export async function findFingerprint(fingerprint: string): Promise<(RegistryEntry & { sequence: number; hashscanUrl: string }) | undefined> {
  const { registryTopicId } = await ensureTopics();
  for await (const item of mirrorPages<MirrorTopicMessage>(`/topics/${registryTopicId}/messages?order=asc&limit=100`, "messages", 1000)) {
    let entry: RegistryEntry;
    try {
      entry = JSON.parse(Buffer.from(item.message, "base64").toString("utf8")) as RegistryEntry;
    } catch {
      continue;
    }
    if (entry.type === "invoice.registered" && entry.fingerprint === fingerprint) {
      return { ...entry, sequence: item.sequence_number, hashscanUrl: hashscan.transaction(item.consensus_timestamp) };
    }
  }
  return undefined;
}

export function signMessage(signer: Party, message: string): string {
  return Buffer.from(signer.key.sign(Buffer.from(message, "utf8"))).toString("hex");
}

export function verifyMessage(publicKeyRaw: string, message: string, signatureHex: string): boolean {
  return PublicKey.fromStringECDSA(publicKeyRaw).verify(Buffer.from(message, "utf8"), Buffer.from(signatureHex, "hex"));
}

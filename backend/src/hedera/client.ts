import { AccountId, Client, Hbar, PrivateKey, Timestamp, Transaction, TransactionId } from "@hiero-ledger/sdk";
import { config, crashPoint, hashscan } from "../config.js";
import { ApiError } from "../errors.js";
import { save, state } from "../store.js";
import type { TxRecord } from "../types.js";
import { findTransaction, getAccount, mirrorGet, poll, sleep, type MirrorTransaction } from "./mirror.js";

export interface Party {
  role: string;
  name: string;
  id: string;
  evm: string;
  key: PrivateKey;
  client: Client;
}

export const ROLES = {
  ADMIN: "admin",
  BUSINESS: "business",
  BUYER: "buyer",
  APEX: "Apex Infra Pvt Ltd",
  NOVA: "Nova Retail",
  INVESTOR: "investor",
  RISK_AGENT: "risk agent",
  POOL: "POOL",
  REPAYMENT: "REPAYMENT",
} as const;
export type RolePrefix = keyof typeof ROLES;

const VALID_DURATION_SECONDS = 120;
const VALID_START_BACKDATE_MS = 10_000; // Avoids INVALID_TRANSACTION_START when a node's clock lags.
const RECONCILE_MARGIN_SECONDS = 30;
const PRECHECK_RETRIES = 6;
const PRECHECK_RETRY_DELAY_MS = 3_000;

const parties = new Map<RolePrefix, Promise<Party>>();

function parseKey(envName: string): PrivateKey {
  const value = process.env[envName]?.trim().replace(/^0x/i, "");
  if (!value) throw new Error(`Missing ${envName} in the environment`);
  try {
    return /^[0-9a-f]{64}$/i.test(value) ? PrivateKey.fromStringECDSA(value) : PrivateKey.fromStringDer(value);
  } catch {
    // The original error is dropped on purpose so key material cannot reach the logs.
    throw new Error(`${envName} could not be parsed as a private key`);
  }
}

async function loadParty(prefix: RolePrefix): Promise<Party> {
  const id = process.env[`${prefix}_ID`]?.trim();
  if (!id) throw new Error(`Missing ${prefix}_ID in the environment`);
  const key = parseKey(`${prefix}_KEY`);
  const account = await poll(`mirror record of ${id}`, () => getAccount(id));
  if (key.publicKey.toStringRaw().toLowerCase() !== account.key?.key.toLowerCase()) {
    throw new Error(`${prefix}_KEY does not belong to account ${id}`);
  }
  return { role: prefix, name: ROLES[prefix], id, evm: account.evm_address, key, client: Client.forTestnet().setOperator(AccountId.fromString(id), key) };
}

export function getParty(prefix: RolePrefix): Promise<Party> {
  let party = parties.get(prefix);
  if (!party) {
    party = loadParty(prefix);
    parties.set(prefix, party);
  }
  return party;
}

/** The server can only sign for accounts whose keys it holds. */
export async function getSigner(accountId: string): Promise<Party> {
  const prefix = (Object.keys(ROLES) as RolePrefix[]).find((candidate) => process.env[`${candidate}_ID`]?.trim() === accountId);
  if (!prefix) throw new ApiError(422, "NO_SIGNING_KEY", `The server holds no key for account ${accountId}, so it cannot sign for it`);
  return getParty(prefix);
}

export const knownAccountName = (accountId: string) =>
  (Object.keys(ROLES) as RolePrefix[]).find((prefix) => process.env[`${prefix}_ID`]?.trim() === accountId);

export const isKnownAccount = (accountId: string) => knownAccountName(accountId) !== undefined;

export const allParties = () => Promise.all((Object.keys(ROLES) as RolePrefix[]).map((prefix) => getParty(prefix)));

function newTransactionId(payer: Party) {
  return TransactionId.withValidStart(AccountId.fromString(payer.id), Timestamp.fromDate(new Date(Date.now() - VALID_START_BACKDATE_MS)));
}

/**
 * Sends under a fixed transaction ID. Retries reuse that ID, so the network treats them as
 * duplicates of a single transaction and they cannot apply twice.
 */
async function submit(payer: Party, id: TransactionId, maxFeeHbar: number, build: () => Transaction) {
  for (let attempt = 0; ; attempt++) {
    try {
      const transaction = build()
        .setTransactionId(id)
        .setTransactionValidDuration(VALID_DURATION_SECONDS)
        .setMaxTransactionFee(new Hbar(maxFeeHbar))
        .freezeWith(payer.client);
      await transaction.execute(payer.client);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("DUPLICATE_TRANSACTION")) return;
      if (!message.includes("INVALID_TRANSACTION_START") || attempt >= PRECHECK_RETRIES) throw error;
      await sleep(PRECHECK_RETRY_DELAY_MS);
    }
  }
}

async function recordOutcome(key: string, payerName: string, transaction: MirrorTransaction): Promise<TxRecord> {
  const contractResult =
    transaction.name === "CONTRACTCALL"
      ? await poll(`contract result of ${transaction.transaction_id}`, () =>
          mirrorGet<{ error_message?: string | null; call_result?: string }>(`/contracts/results/${transaction.transaction_id}`),
        )
      : undefined;
  const record: TxRecord = {
    key,
    status: "done",
    transactionId: transaction.transaction_id,
    payer: payerName,
    succeeded: transaction.result === "SUCCESS",
    result: transaction.result,
    consensusTimestamp: transaction.consensus_timestamp,
    hashscanUrl: hashscan.transaction(transaction.consensus_timestamp),
    feeHbar: Number(transaction.charged_tx_fee) / 1e8,
    entityId: transaction.entity_id ?? null,
    ...(contractResult ? { errorMessage: contractResult.error_message ?? null, ...(contractResult.call_result ? { callResult: contractResult.call_result } : {}) } : {}),
  };
  state.ledger[key] = record;
  save();
  return record;
}

export interface ExecuteOptions {
  key: string;
  payer: Party;
  maxFeeHbar: number;
  build: () => Transaction;
  /** Runs only when about to send. May return an earlier chain transaction to adopt instead. */
  beforeSend?: () => Promise<MirrorTransaction | undefined>;
  crashAfterSend?: string;
}

/**
 * Runs a transaction at most once per key. Its ID is saved as an intent before sending. After a
 * crash, the next call looks that ID up on the mirror node, waiting out its validity window, and
 * only sends again once the chain shows it failed or expired.
 */
export async function executeOnce(options: ExecuteOptions): Promise<TxRecord & { replayed: boolean }> {
  const { key, payer, maxFeeHbar, build, beforeSend, crashAfterSend } = options;
  if (maxFeeHbar > config.maxStepHbar) {
    throw new ApiError(402, "APPROVAL_REQUIRED", `${key} could cost ${maxFeeHbar} HBAR, above the ${config.maxStepHbar} HBAR limit. Get approval first.`);
  }

  const existing = state.ledger[key];
  if (existing?.status === "done" && existing.succeeded) return { ...existing, replayed: true };

  if (existing?.status === "sending") {
    const deadline = (existing.validUntilUnix ?? 0) + RECONCILE_MARGIN_SECONDS;
    let transaction = await findTransaction(existing.transactionId);
    while (!transaction && Date.now() / 1000 < deadline) {
      await sleep(2_000);
      transaction = await findTransaction(existing.transactionId);
    }
    if (transaction?.result === "SUCCESS") return { ...(await recordOutcome(key, existing.payer, transaction)), replayed: true };
    // It failed or expired without reaching consensus, so it changed nothing. Falls through.
  }

  delete state.ledger[key];
  save();

  const adopted = await beforeSend?.();
  if (adopted) return { ...(await recordOutcome(key, payer.name, adopted)), replayed: true };

  const id = newTransactionId(payer);
  const validStart = id.validStart?.seconds?.toNumber() ?? Math.floor(Date.now() / 1000);
  state.ledger[key] = {
    key,
    status: "sending",
    transactionId: id.toString(),
    payer: payer.name,
    validUntilUnix: validStart + VALID_DURATION_SECONDS,
  };
  save();

  await submit(payer, id, maxFeeHbar, build);
  if (crashAfterSend) crashPoint(crashAfterSend);

  const transaction = await poll(`mirror record of ${id.toString()}`, () => findTransaction(id.toString()));
  return { ...(await recordOutcome(key, payer.name, transaction)), replayed: false };
}


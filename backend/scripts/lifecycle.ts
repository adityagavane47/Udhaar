/**
 * Runs the bond lifecycle for UDH2611051641, settling in uINR:
 *   1. Top up the buyer from treasury.
 *   2. Pause test: a transfer must fail while paused, then unpause.
 *   3. Freeze test: frozen units must not move, then unfreeze.
 *   4. Repayment: buyer pays REPAYMENT, detected through the mirror node. Then, per holder:
 *      pay units x face value, record it as paid, and burn with fullRedeemAtMaturity.
 *
 * Usage:
 *   npm run lifecycle              Dry run: checks state and prints the cost. Sends nothing.
 *   npm run lifecycle -- --execute Runs it on testnet and spends test HBAR.
 *
 * Rerunning can never pay a holder twice. Before a payment, its client-generated transaction
 * ID is saved as an intent. A rerun resolves that intent against the mirror node, then also
 * searches the chain for an earlier payout, so even a lost record cannot cause a second one.
 *
 * Keys are read from the repo-root .env and must never be logged.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { getBytes, Interface, type InterfaceAbi } from "ethers";
import {
  AccountId,
  Client,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  PrivateKey,
  Status,
  Timestamp,
  Transaction,
  TransactionId,
  TransactionReceiptQuery,
  TransferTransaction,
} from "@hiero-ledger/sdk";

const require = createRequire(import.meta.url);
const assetAbi = (
  require("@hashgraph/asset-tokenization-contracts/artifacts/contracts/facets/IAsset.sol/IAsset.json") as { abi: InterfaceAbi }
).abi;
const assetInterface = new Interface(assetAbi);

const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
const HASHSCAN = "https://hashscan.io/testnet";
const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));
const BOND_SYMBOL = "UDH2611051641";
const BOND_PATH = fileURLToPath(new URL(`../deployments/${BOND_SYMBOL}.json`, import.meta.url));
const UINR_PATH = fileURLToPath(new URL("../deployments/uINR.json", import.meta.url));
const UINR_TOKEN_ID = "0.0.11327250";

/** Converts whole uINR to base units (2 decimals). */
const uinr = (whole: number) => whole * 100;

const TOP_UP_AMOUNT = uinr(1_000);
const REPAYMENT_AMOUNT = uinr(500_000);
const FACE_VALUE_UINR = 1_000;
const PAUSE_TEST_UNITS = 1n;
const FREEZE_UNITS = 50n;

const TOP_UP_MEMO = `${BOND_SYMBOL} top-up`;
const PAYOUT_MEMO = `${BOND_SYMBOL} payout`;

const MAX_STEP_HBAR = 15; // Anything above this needs the user's OK, so the script refuses it.
const CONTRACT_GAS_LIMIT = 1_000_000;
const HTS_MAX_FEE_HBAR = 2;
const VALID_DURATION_SECONDS = 120;
const VALID_START_BACKDATE_MS = 10_000; // Avoids INVALID_TRANSACTION_START when a node's clock lags.
const RECONCILE_MARGIN_SECONDS = 30;

const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 2_000;
const PRECHECK_RETRIES = 6;
const PRECHECK_RETRY_DELAY_MS = 3_000;
const MAX_HISTORY_PAGES = 200;
const SIMULATED_CRASH_EXIT_CODE = 75;

interface Party {
  name: string;
  id: string;
  evm: string;
  key: PrivateKey;
  client: Client;
}

interface MirrorTransaction {
  transaction_id: string;
  consensus_timestamp: string;
  charged_tx_fee: number;
  memo_base64: string;
  nonce: number;
  result: string;
  token_transfers?: { account: string; amount: number; token_id: string }[];
  assessed_custom_fees?: { amount: number }[];
}

interface Step {
  label: string;
  payer: string;
  status: string;
  transactionId: string;
  hashscan: string;
  feeHbar: number;
  revertReason?: string;
}

interface TransferEntry {
  status: "sending" | "confirmed";
  from: string;
  to: string;
  amountBaseUnits: number;
  memo: string;
  transactionId: string;
  validUntilUnix?: number;
  hashscan?: string;
  feeHbar?: number;
}

interface HolderEntry {
  name: string;
  evm: string;
  accountId: string;
  units: string;
  amountBaseUnits: number;
  paid: boolean;
  paymentTransactionId?: string;
  paymentHashscan?: string;
  burned: boolean;
  burnTransactionId?: string;
  burnHashscan?: string;
}

interface Lifecycle {
  status: "in-progress" | "complete" | "failed";
  uinrTokenId: string;
  pauseTest: "pending" | "passed";
  freezeTest: "pending" | "passed";
  blockedReason?: string;
  transfers: Record<string, TransferEntry>;
  repaymentDetected?: { transactionId: string; hashscan: string; from: string; memo: string; amountBaseUnits: number };
  holders?: HolderEntry[];
  steps: Step[];
  balances?: Record<string, { bondUnits: string; uinr: string }>;
  error?: string;
}

interface BondRecord {
  symbol: string;
  status: string;
  bond: { contractId: string; evmAddress: string; hashscan: string };
  lifecycle?: Lifecycle;
  [key: string]: unknown;
}

/** A compliance control did not hold. Reruns stop until a person has reviewed it. */
class ControlFailure extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const formatUinr = (baseUnits: number) => (baseUnits / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 });
const toMirrorId = (id: string) => {
  const [account = "", timestamp = ""] = id.split("@");
  const [seconds = "", nanos = ""] = timestamp.split(".");
  return `${account}-${seconds}-${nanos.padStart(9, "0")}`;
};
const linkFor = (consensusTimestamp: string) => `${HASHSCAN}/transaction/${consensusTimestamp}`;

async function mirrorGet<T>(path: string): Promise<T | undefined> {
  const response = await fetch(`${MIRROR}${path}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Mirror node returned ${response.status} for ${path}`);
  return (await response.json()) as T;
}

async function poll<T>(description: string, attempt: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const value = await attempt();
    if (value !== undefined) return value;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function findTransaction(id: string) {
  const found = await mirrorGet<{ transactions: MirrorTransaction[] }>(`/transactions/${toMirrorId(id)}`);
  return found?.transactions.find((entry) => entry.nonce === 0);
}

/** Waits until the mirror node has indexed past `seconds`, so history searches cannot miss earlier work. */
async function waitForMirrorToReach(seconds: number) {
  await poll("the mirror node to catch up", async () => {
    const latest = await mirrorGet<{ transactions: MirrorTransaction[] }>("/transactions?limit=1&order=desc");
    const timestamp = Number(latest?.transactions[0]?.consensus_timestamp ?? 0);
    return timestamp >= seconds ? true : undefined;
  });
}

/** Searches uINR transfers into `toId` with this memo. If the search cannot finish, it throws rather than answer. */
async function findTransfersInto(toId: string, memo: string, sinceTimestamp: string) {
  const matches: MirrorTransaction[] = [];
  let path: string | null = `/transactions?account.id=${toId}&transactiontype=cryptotransfer&result=success&order=asc&limit=100&timestamp=gte:${sinceTimestamp}`;
  for (let page = 0; path; page++) {
    if (page >= MAX_HISTORY_PAGES) throw new Error(`Search of ${toId} history did not finish, so it is unsafe to continue`);
    const body: { transactions: MirrorTransaction[]; links: { next: string | null } } | undefined =
      await mirrorGet(path);
    if (!body) throw new Error(`Search of ${toId} history failed, so it is unsafe to continue`);
    for (const transaction of body.transactions) {
      const decoded = Buffer.from(transaction.memo_base64 ?? "", "base64").toString("utf8");
      const credited = transaction.token_transfers?.some(
        (move) => move.token_id === UINR_TOKEN_ID && move.account === toId && move.amount > 0,
      );
      if (decoded === memo && credited) matches.push(transaction);
    }
    path = body.links.next ? body.links.next.replace(/^\/api\/v1/, "") : null;
  }
  return matches;
}

const movedTo = (transaction: MirrorTransaction, accountId: string) =>
  transaction.token_transfers?.find((move) => move.token_id === UINR_TOKEN_ID && move.account === accountId)?.amount ?? 0;

function decodeRevert(data: string | null | undefined): { name: string; text: string } {
  if (!data || data === "0x") return { name: "none", text: "no revert data" };
  const parsed = assetInterface.parseError(data);
  return parsed ? { name: parsed.name, text: `${parsed.name}(${parsed.args.join(", ")})` } : { name: "unknown", text: data };
}

async function simulate(from: string, to: string, signature: string, params: readonly unknown[] = []) {
  const response = await fetch(`${MIRROR}/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ block: "latest", data: assetInterface.encodeFunctionData(signature, params), estimate: false, from, gas: CONTRACT_GAS_LIMIT, to }),
  });
  const body = (await response.json()) as { result?: string; _status?: { messages?: { message?: string; data?: string; detail?: string }[] } };
  if (response.ok) return { ok: true as const, result: body.result ?? "0x" };
  const message = body._status?.messages?.[0];
  return { ok: false as const, error: message?.data ? decodeRevert(message.data) : { name: "unknown", text: message?.detail ?? message?.message ?? `HTTP ${response.status}` } };
}

function parseKey(envName: string): PrivateKey {
  const value = process.env[envName]?.trim().replace(/^0x/i, "");
  if (!value) throw new Error(`Missing ${envName} in .env`);
  try {
    return /^[0-9a-f]{64}$/i.test(value) ? PrivateKey.fromStringECDSA(value) : PrivateKey.fromStringDer(value);
  } catch {
    // The original error is dropped on purpose so key material cannot reach the logs.
    throw new Error(`${envName} could not be parsed as a private key`);
  }
}

async function loadParty(prefix: string, name: string): Promise<Party> {
  const id = process.env[`${prefix}_ID`]?.trim();
  if (!id) throw new Error(`Missing ${prefix}_ID in .env`);
  const key = parseKey(`${prefix}_KEY`);
  const account = await poll(`mirror record of ${id}`, () => mirrorGet<{ evm_address: string; key: { key: string } }>(`/accounts/${id}`));
  if (key.publicKey.toStringRaw().toLowerCase() !== account.key.key.toLowerCase()) {
    throw new Error(`${prefix}_KEY does not belong to account ${id}`);
  }
  return { name, id, evm: account.evm_address, key, client: Client.forTestnet().setOperator(AccountId.fromString(id), key) };
}

function newTransactionId(payer: Party) {
  return TransactionId.withValidStart(AccountId.fromString(payer.id), Timestamp.fromDate(new Date(Date.now() - VALID_START_BACKDATE_MS)));
}

/**
 * Sends a transaction under a fixed ID. Retries reuse that ID, so the network treats them as
 * duplicates of one transaction and they cannot apply twice.
 */
async function submit(payer: Party, id: TransactionId, maxFeeHbar: number, build: () => Transaction) {
  if (maxFeeHbar > MAX_STEP_HBAR) throw new Error(`A step could cost ${maxFeeHbar} HBAR, above the ${MAX_STEP_HBAR} HBAR limit: get approval first`);
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

async function settle(payer: Party, id: TransactionId) {
  const receipt = await new TransactionReceiptQuery().setTransactionId(id).setValidateStatus(false).execute(payer.client);
  const transaction = await poll(`mirror record of ${id.toString()}`, () => findTransaction(id.toString()));
  return { status: receipt.status, transaction };
}

async function main() {
  const flags = process.argv.slice(2);
  const known = new Set(["--execute", "--simulate-crash-after-payout-send"]);
  const unknownFlag = flags.find((flag) => !known.has(flag));
  if (unknownFlag) throw new Error(`Unknown option: ${unknownFlag}`);
  const execute = flags.includes("--execute");
  const simulateCrash = flags.includes("--simulate-crash-after-payout-send");

  loadEnv({ path: ENV_PATH, quiet: true });

  if (!existsSync(BOND_PATH) || !existsSync(UINR_PATH)) throw new Error("Deployment records are missing");
  const record = JSON.parse(readFileSync(BOND_PATH, "utf8")) as BondRecord;
  const uinrRecord = JSON.parse(readFileSync(UINR_PATH, "utf8")) as { tokenId: string };
  if (record.status !== "complete") throw new Error(`${BOND_SYMBOL} issuance is not complete`);
  if (uinrRecord.tokenId !== UINR_TOKEN_ID) throw new Error("uINR.json does not match the expected token");
  const bond = record.bond.evmAddress;
  const bondId = record.bond.contractId;

  const parties: Party[] = [];
  const load = async (prefix: string, name: string) => {
    const party = await loadParty(prefix, name);
    parties.push(party);
    return party;
  };

  try {
    const admin = await load("ADMIN", "admin");
    const business = await load("BUSINESS", "business");
    const investor = await load("INVESTOR", "investor");
    const buyer = await load("BUYER", "buyer");
    const repayment = await load("REPAYMENT", "REPAYMENT");
    const pool = await load("POOL", "POOL");
    const riskAgent = await load("RISK_AGENT", "risk agent");
    const everyone = [admin, business, investor, buyer, repayment, pool, riskAgent];

    const readBond = async <T>(signature: string, params: readonly unknown[] = []): Promise<T> => {
      const call = await simulate(admin.evm, bond, signature, params);
      if (!call.ok) throw new Error(`Read of ${signature} failed: ${call.error.text}`);
      return assetInterface.decodeFunctionResult(signature, call.result)[0] as T;
    };
    /** Mirror state lags consensus by a few seconds, so reads after a write retry until they match. */
    const expectBond = async (signature: string, params: readonly unknown[], expected: unknown) => {
      let actual: unknown;
      for (let i = 0; i < POLL_ATTEMPTS; i++) {
        actual = await readBond(signature, params);
        if (actual === expected) return;
        await sleep(POLL_INTERVAL_MS);
      }
      throw new Error(`${signature} returned ${String(actual)}, expected ${String(expected)}`);
    };
    const uinrBalance = async (accountId: string) => {
      const body = await mirrorGet<{ tokens: { balance: number }[] }>(`/accounts/${accountId}/tokens?token.id=${UINR_TOKEN_ID}`);
      return body?.tokens[0]?.balance ?? 0;
    };

    const fees = await mirrorGet<{ fees: { gas: number; transaction_type: string }[] }>("/network/fees");
    const gasPrice = fees?.fees.find((fee) => fee.transaction_type === "ContractCall")?.gas;
    if (!gasPrice) throw new Error("Mirror node did not report a contract gas price");
    // Gas-limit cost, plus a margin for the small fixed part of the transaction fee.
    const contractMaxFeeHbar = Math.ceil((CONTRACT_GAS_LIMIT * gasPrice) / 1e8) + 1;

    const printBalances = async () => {
      const balances: Record<string, { bondUnits: string; uinr: string }> = {};
      console.log(`\n${"Account".padEnd(12)}${"ID".padEnd(15)}${"Bond units".padStart(11)}${"uINR".padStart(16)}`);
      for (const party of everyone) {
        const units = await readBond<bigint>("balanceOf(address)", [party.evm]);
        const held = await uinrBalance(party.id);
        balances[party.name] = { bondUnits: units.toString(), uinr: formatUinr(held) };
        console.log(`${party.name.padEnd(12)}${party.id.padEnd(15)}${units.toString().padStart(11)}${formatUinr(held).padStart(16)}`);
      }
      console.log(`Bond total supply: ${await readBond<bigint>("totalSupply()")}`);
      return balances;
    };

    const printLinks = (lifecycle: Lifecycle) => {
      console.log("\nHashScan links:");
      console.log(`  Bond ${bondId}: ${record.bond.hashscan}`);
      for (const [key, entry] of Object.entries(lifecycle.transfers)) {
        console.log(`  uINR ${key} (${formatUinr(entry.amountBaseUnits)}): ${entry.hashscan ?? entry.transactionId}`);
      }
      for (const step of lifecycle.steps) {
        console.log(`  ${step.label} [${step.status}]: ${step.hashscan}`);
      }
    };

    if (record.lifecycle?.status === "complete") {
      console.log("Lifecycle already complete: nothing to send.");
      printLinks(record.lifecycle);
      await printBalances();
      return;
    }
    if (record.lifecycle?.blockedReason) throw new Error(`Blocked until reviewed: ${record.lifecycle.blockedReason}`);

    const maturity = await readBond<bigint>("getMaturityDate()");
    const nominal = await readBond<bigint>("getNominalValue()");
    const holderCount = await readBond<bigint>("getTotalSecurityHolders()");
    console.log(`Bond ${bondId}: paused ${await readBond<boolean>("paused()")}, supply ${await readBond<bigint>("totalSupply()")}, holders ${holderCount}`);
    console.log(`Maturity ${new Date(Number(maturity) * 1000).toISOString()}, face value ${nominal}`);
    console.log(`Admin ${admin.id}, buyer uINR ${formatUinr(await uinrBalance(buyer.id))}, REPAYMENT uINR ${formatUinr(await uinrBalance(repayment.id))}`);

    const htsEstimate = 0.03;
    const estimates: [string, string, number, number][] = [
      ["uINR top-up", "admin", htsEstimate, HTS_MAX_FEE_HBAR],
      ["Pause, rejected transfer, unpause", "admin, business", ((80_000 + 80_000 + 56_000) * gasPrice) / 1e8, contractMaxFeeHbar * 3],
      ["Freeze, rejected transfer, unfreeze", "admin, investor", ((270_000 + 80_000 + 270_000) * gasPrice) / 1e8, contractMaxFeeHbar * 3],
      ["uINR repayment", "buyer", htsEstimate, HTS_MAX_FEE_HBAR],
      [`uINR payouts x ${holderCount}`, "REPAYMENT", htsEstimate * Number(holderCount), HTS_MAX_FEE_HBAR * Number(holderCount)],
      [`Burn x ${holderCount}`, "admin", (300_000 * gasPrice * Number(holderCount)) / 1e8, contractMaxFeeHbar * Number(holderCount)],
    ];
    console.log(`\nEstimated cost at ${gasPrice} tinybar per gas (no single transaction can exceed ${Math.max(contractMaxFeeHbar, HTS_MAX_FEE_HBAR)} HBAR):`);
    for (const [label, payer, expected, ceiling] of estimates) {
      console.log(`  ${label.padEnd(38)} ${payer.padEnd(16)} ~${expected.toFixed(2)} HBAR (limit ${ceiling})`);
    }
    console.log(`  Total ~${estimates.reduce((sum, [, , expected]) => sum + expected, 0).toFixed(2)} HBAR`);

    const redemption = await simulate(admin.evm, bond, "fullRedeemAtMaturity(address)", [investor.evm]);
    console.log(`Simulated fullRedeemAtMaturity(investor): ${redemption.ok ? "passes" : redemption.error.text}`);

    if (!execute) {
      console.log("\nDry run only: no transactions sent. Re-run with --execute to spend test HBAR.");
      return;
    }

    const lifecycle: Lifecycle = record.lifecycle ?? {
      status: "in-progress",
      uinrTokenId: UINR_TOKEN_ID,
      pauseTest: "pending",
      freezeTest: "pending",
      transfers: {},
      steps: [],
    };
    record.lifecycle = lifecycle;
    lifecycle.status = "in-progress";
    delete lifecycle.error;
    /** Writes to a temp file and renames, so a crash mid-write cannot corrupt the payment record. */
    const save = () => {
      const temporary = `${BOND_PATH}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
      renameSync(temporary, BOND_PATH);
    };
    save();

    const report = (step: Step, outcome: string) => {
      lifecycle.steps.push(step);
      save();
      console.log(`${outcome}: ${step.label} | ${step.feeHbar} HBAR\n  ${step.hashscan}`);
    };

    /** Calls the bond and records the outcome, without deciding whether a revert is acceptable. */
    const callBond = async (label: string, signer: Party, signature: string, params: readonly unknown[]) => {
      const id = newTransactionId(signer);
      console.log(`  sending ${label}: ${id.toString()}`);
      await submit(signer, id, contractMaxFeeHbar, () =>
        new ContractExecuteTransaction()
          .setContractId(ContractId.fromString(bondId))
          .setGas(CONTRACT_GAS_LIMIT)
          .setFunctionParameters(getBytes(assetInterface.encodeFunctionData(signature, params))),
      );
      const { status, transaction } = await settle(signer, id);
      const result = await poll(`contract result of ${id.toString()}`, () =>
        mirrorGet<{ error_message?: string | null }>(`/contracts/results/${toMirrorId(id.toString())}`),
      );
      const revert = status === Status.Success ? undefined : decodeRevert(result.error_message);
      const step: Step = {
        label,
        payer: signer.name,
        status: status.toString(),
        transactionId: id.toString(),
        hashscan: linkFor(transaction.consensus_timestamp),
        feeHbar: Number(transaction.charged_tx_fee) / 1e8,
        ...(revert ? { revertReason: revert.text } : {}),
      };
      return { step, revertName: revert?.name };
    };
    const mustSucceed = async (label: string, signer: Party, signature: string, params: readonly unknown[]) => {
      const { step } = await callBond(label, signer, signature, params);
      if (step.status !== Status.Success.toString()) {
        lifecycle.steps.push(step);
        throw new Error(`${label} failed with ${step.status}: ${step.revertReason ?? "no reason"} (${step.hashscan})`);
      }
      report(step, "OK");
    };
    /** Only the named revert counts as proof, so an unrelated failure cannot pass the test. */
    const mustRevert = async (label: string, signer: Party, signature: string, params: readonly unknown[], expectedError: string) => {
      const { step, revertName } = await callBond(label, signer, signature, params);
      lifecycle.steps.push(step);
      if (step.status === Status.Success.toString()) {
        throw new ControlFailure(`${label} SUCCEEDED when it had to fail (${step.hashscan})`);
      }
      if (revertName !== expectedError) {
        throw new ControlFailure(`${label} failed for the wrong reason: ${step.revertReason ?? "unknown"}, expected ${expectedError} (${step.hashscan})`);
      }
      lifecycle.steps.pop();
      report(step, "REJECTED AS EXPECTED");
      console.log(`  reason: ${step.revertReason}`);
    };

    const uinrCreated = await mirrorGet<{ created_timestamp: string }>(`/tokens/${UINR_TOKEN_ID}`);
    if (!uinrCreated) throw new Error("uINR token not found on the mirror node");
    const sinceTimestamp = uinrCreated.created_timestamp;

    /**
     * Sends uINR at most once per key. Order matters: resolve any saved intent, search the chain,
     * save a new intent, and only then send. A failure after sending leaves the intent in place.
     */
    const sendUinrOnce = async (key: string, from: Party, toId: string, amount: number, memo: string, crashAfterSend = false) => {
      const finish = (entry: TransferEntry, transaction: MirrorTransaction) => {
        const fees = (transaction.assessed_custom_fees ?? []).filter((fee) => fee.amount > 0);
        if (movedTo(transaction, toId) !== amount || fees.length > 0) {
          throw new Error(`${key}: expected ${amount} with no fee, got ${movedTo(transaction, toId)} and ${JSON.stringify(fees)}`);
        }
        const confirmed: TransferEntry = {
          status: "confirmed",
          from: entry.from,
          to: entry.to,
          amountBaseUnits: amount,
          memo,
          transactionId: entry.transactionId,
          hashscan: linkFor(transaction.consensus_timestamp),
          feeHbar: Number(transaction.charged_tx_fee) / 1e8,
        };
        lifecycle.transfers[key] = confirmed;
        save();
        return confirmed;
      };

      const existing = lifecycle.transfers[key];
      if (existing?.status === "confirmed") {
        console.log(`SKIP (already confirmed): ${key}\n  ${existing.hashscan}`);
        return existing;
      }

      if (existing?.status === "sending") {
        console.log(`  resolving unconfirmed ${key}: ${existing.transactionId}`);
        const deadline = (existing.validUntilUnix ?? 0) + RECONCILE_MARGIN_SECONDS;
        let transaction = await findTransaction(existing.transactionId);
        while (!transaction && Date.now() / 1000 < deadline) {
          await sleep(POLL_INTERVAL_MS);
          transaction = await findTransaction(existing.transactionId);
        }
        if (transaction?.result === "SUCCESS") {
          const confirmed = finish(existing, transaction);
          console.log(`RECOVERED (it had already gone through, so not sent again): ${key}\n  ${confirmed.hashscan}`);
          return confirmed;
        }
        // It failed or expired without reaching consensus, so it moved nothing. Falls through to the search.
        delete lifecycle.transfers[key];
        save();
      }

      const earlier = await findTransfersInto(toId, memo, sinceTimestamp);
      const previous = earlier.find((transaction) => movedTo(transaction, from.id) < 0);
      if (previous) {
        const recovered: TransferEntry = {
          status: "sending",
          from: from.id,
          to: toId,
          amountBaseUnits: amount,
          memo,
          transactionId: previous.transaction_id,
        };
        const confirmed = finish(recovered, previous);
        console.log(`RECOVERED (found on chain, so not sent again): ${key}\n  ${confirmed.hashscan}`);
        return confirmed;
      }

      // Checked only now: an earlier payment already found above must not be mistaken for missing funds.
      await poll(`${from.name} to hold ${formatUinr(amount)} uINR for ${key}`, async () =>
        (await uinrBalance(from.id)) >= amount ? true : undefined,
      );

      const id = newTransactionId(from);
      const validStart = id.validStart?.seconds?.toNumber() ?? Math.floor(Date.now() / 1000);
      const intent: TransferEntry = {
        status: "sending",
        from: from.id,
        to: toId,
        amountBaseUnits: amount,
        memo,
        transactionId: id.toString(),
        validUntilUnix: validStart + VALID_DURATION_SECONDS,
      };
      lifecycle.transfers[key] = intent;
      save();

      console.log(`  sending ${key} (${formatUinr(amount)} uINR): ${id.toString()}`);
      await submit(from, id, HTS_MAX_FEE_HBAR, () =>
        new TransferTransaction()
          .addTokenTransfer(UINR_TOKEN_ID, from.id, -amount)
          .addTokenTransfer(UINR_TOKEN_ID, toId, amount)
          .setTransactionMemo(memo),
      );
      if (crashAfterSend) {
        console.log(`SIMULATED CRASH after sending ${key}, before recording it.`);
        process.exit(SIMULATED_CRASH_EXIT_CODE);
      }
      const { status, transaction } = await settle(from, id);
      if (status !== Status.Success) {
        delete lifecycle.transfers[key];
        save();
        throw new Error(`${key} failed with ${status.toString()} (${linkFor(transaction.consensus_timestamp)})`);
      }
      const confirmed = finish(intent, transaction);
      console.log(`OK: ${key} | ${confirmed.feeHbar} HBAR\n  ${confirmed.hashscan}`);
      return confirmed;
    };

    try {
      await waitForMirrorToReach(Math.floor(Date.now() / 1000));

      // 1. Top-up
      console.log("\n1. Buyer top-up");
      await sendUinrOnce("top-up", admin, buyer.id, TOP_UP_AMOUNT, TOP_UP_MEMO);

      // 2. Pause test
      console.log("\n2. Pause test");
      if (lifecycle.pauseTest === "passed") {
        console.log("SKIP (already passed)");
      } else {
        let applied = await readBond<boolean>("paused()");
        try {
          if (!applied) {
            await mustSucceed("Pause bond", admin, "pause()", []);
            applied = true;
            await expectBond("paused()", [], true);
          }
          await mustRevert(`Paused: business -> investor ${PAUSE_TEST_UNITS} unit`, business, "transfer(address,uint256)", [investor.evm, PAUSE_TEST_UNITS], "IsPaused");
        } finally {
          // Always unpause, or a failed test would leave the bond stuck paused.
          if (applied) await mustSucceed("Unpause bond", admin, "unpause()", []);
        }
        await expectBond("paused()", [], false);
        const restored = await simulate(business.evm, bond, "transfer(address,uint256)", [investor.evm, PAUSE_TEST_UNITS]);
        if (!restored.ok) throw new Error(`Transfers did not resume after unpause: ${restored.error.text}`);
        console.log("OK: after unpausing, the same transfer simulates successfully.");
        lifecycle.pauseTest = "passed";
        save();
      }

      // 3. Freeze test
      console.log("\n3. Freeze test");
      if (lifecycle.freezeTest === "passed") {
        console.log("SKIP (already passed)");
      } else {
        let frozen = await readBond<bigint>("getFrozenTokens(address)", [investor.evm]);
        if (frozen !== 0n && frozen !== FREEZE_UNITS) throw new Error(`Investor has ${frozen} frozen units, expected 0 or ${FREEZE_UNITS}`);
        const held = (await readBond<bigint>("balanceOf(address)", [investor.evm])) + frozen;
        if (held <= FREEZE_UNITS) throw new Error(`Investor holds ${held} units, too few for this test`);
        try {
          if (frozen === 0n) {
            await mustSucceed(`Freeze ${FREEZE_UNITS} investor units`, admin, "freezePartialTokens(address,uint256)", [investor.evm, FREEZE_UNITS]);
            frozen = FREEZE_UNITS;
            await expectBond("getFrozenTokens(address)", [investor.evm], FREEZE_UNITS);
          }
          await expectBond("balanceOf(address)", [investor.evm], held - FREEZE_UNITS);
          // Sending only 50 would use the 50 free units. Sending all of them must touch frozen units.
          await mustRevert(`Frozen: investor -> business ${held} units (includes the frozen ${FREEZE_UNITS})`, investor, "transfer(address,uint256)", [business.evm, held], "InsufficientBalance");
          const freeUnits = await simulate(investor.evm, bond, "transfer(address,uint256)", [business.evm, held - FREEZE_UNITS]);
          if (!freeUnits.ok) throw new Error(`The unfrozen units should still move: ${freeUnits.error.text}`);
          console.log(`OK: the ${held - FREEZE_UNITS} unfrozen units still simulate as transferable.`);
        } finally {
          // Always unfreeze, or a failed test would leave units frozen and unredeemable.
          if (frozen !== 0n) await mustSucceed(`Unfreeze ${FREEZE_UNITS} investor units`, admin, "unfreezePartialTokens(address,uint256)", [investor.evm, FREEZE_UNITS]);
        }
        await expectBond("getFrozenTokens(address)", [investor.evm], 0n);
        await expectBond("balanceOf(address)", [investor.evm], held);
        lifecycle.freezeTest = "passed";
        save();
      }

      // 4. Repayment
      console.log("\n4. Repayment");
      await sendUinrOnce("repayment", buyer, repayment.id, REPAYMENT_AMOUNT, BOND_SYMBOL);

      const detected = await poll("the repayment on the mirror node", async () => {
        const matches = await findTransfersInto(repayment.id, BOND_SYMBOL, sinceTimestamp);
        return matches.find(
          (transaction) =>
            transaction.transaction_id.startsWith(`${buyer.id}-`) &&
            movedTo(transaction, buyer.id) === -REPAYMENT_AMOUNT &&
            movedTo(transaction, repayment.id) === REPAYMENT_AMOUNT,
        );
      });
      lifecycle.repaymentDetected = {
        transactionId: detected.transaction_id,
        hashscan: linkFor(detected.consensus_timestamp),
        from: buyer.id,
        memo: BOND_SYMBOL,
        amountBaseUnits: REPAYMENT_AMOUNT,
      };
      save();
      console.log(`Detected via mirror node: buyer ${buyer.id}, memo ${BOND_SYMBOL}, ${formatUinr(REPAYMENT_AMOUNT)} uINR\n  ${lifecycle.repaymentDetected.hashscan}`);

      // Holder snapshot: taken once, before anyone is paid. A rerun checks the chain against it.
      const readChainHolders = async () => {
        const total = await readBond<bigint>("getTotalSecurityHolders()");
        if (total === 0n) return [] as string[];
        const list = await readBond<string[]>("getSecurityHolders(uint256,uint256)", [0n, total]);
        return Array.from(list).map((address) => address.toLowerCase());
      };
      if (Date.now() / 1000 < Number(maturity)) throw new Error("The bond has not matured yet");
      if (nominal !== BigInt(FACE_VALUE_UINR)) throw new Error(`Bond face value is ${nominal}, expected ${FACE_VALUE_UINR}`);

      if (!lifecycle.holders) {
        const snapshot: HolderEntry[] = [];
        let totalUnits = 0n;
        for (const address of await readChainHolders()) {
          const units = await readBond<bigint>("balanceOf(address)", [address]);
          const frozen = await readBond<bigint>("getFrozenTokens(address)", [address]);
          if (frozen !== 0n) throw new Error(`${address} has ${frozen} frozen units: unfreeze before paying out`);
          if (units === 0n) continue;
          const account = await mirrorGet<{ account: string }>(`/accounts/${address}`);
          if (!account) throw new Error(`Could not resolve holder ${address} to an account`);
          // Dry-run every burn first, so nobody is paid for a burn that would then be refused.
          const canBurn = await simulate(admin.evm, bond, "fullRedeemAtMaturity(address)", [address]);
          if (!canBurn.ok) throw new Error(`Burn for ${account.account} would fail: ${canBurn.error.text}`);
          totalUnits += units;
          snapshot.push({
            name: everyone.find((party) => party.id === account.account)?.name ?? account.account,
            evm: address,
            accountId: account.account,
            units: units.toString(),
            amountBaseUnits: Number(units) * uinr(FACE_VALUE_UINR),
            paid: false,
            burned: false,
          });
        }
        const supply = await readBond<bigint>("totalSupply()");
        if (totalUnits !== supply) throw new Error(`Holders have ${totalUnits} units but supply is ${supply}: some may be locked or held`);
        const owed = snapshot.reduce((sum, holder) => sum + holder.amountBaseUnits, 0);
        if (owed !== REPAYMENT_AMOUNT) throw new Error(`Holders are owed ${formatUinr(owed)} uINR but the repayment is ${formatUinr(REPAYMENT_AMOUNT)}`);
        lifecycle.holders = snapshot;
        save();
      }

      const known = new Set(lifecycle.holders.map((holder) => holder.evm));
      for (const address of await readChainHolders()) {
        const units = await readBond<bigint>("balanceOf(address)", [address]);
        if (units > 0n && !known.has(address)) throw new Error(`${address} now holds ${units} units but is not in the snapshot: review before paying`);
      }

      console.log(`Holders: ${lifecycle.holders.map((holder) => `${holder.name} ${holder.units} units`).join(", ")}`);

      for (const holder of lifecycle.holders) {
        console.log(`\nHolder ${holder.name} (${holder.accountId}): ${holder.units} units, ${formatUinr(holder.amountBaseUnits)} uINR`);
        const units = await readBond<bigint>("balanceOf(address)", [holder.evm]);
        if (units !== BigInt(holder.units) && !(holder.paid && units === 0n)) {
          throw new Error(`${holder.name} now holds ${units} units, but the snapshot says ${holder.units}: review before continuing`);
        }

        if (!holder.paid) {
          const payment = await sendUinrOnce(`payout:${holder.accountId}`, repayment, holder.accountId, holder.amountBaseUnits, PAYOUT_MEMO, simulateCrash);
          // Recorded as paid before the burn, so a burn failure can only ever retry the burn.
          holder.paid = true;
          holder.paymentTransactionId = payment.transactionId;
          if (payment.hashscan) holder.paymentHashscan = payment.hashscan;
          save();
        } else {
          console.log(`SKIP payment (already paid): ${holder.paymentHashscan}`);
        }

        if (holder.burned) {
          console.log(`SKIP burn (already burned): ${holder.burnHashscan}`);
          continue;
        }
        if (units === 0n) {
          holder.burned = true;
          save();
          console.log("SKIP burn (no units left on chain)");
          continue;
        }
        const { step } = await callBond(`Burn ${holder.units} units of ${holder.name}`, admin, "fullRedeemAtMaturity(address)", [holder.evm]);
        if (step.status !== Status.Success.toString()) {
          lifecycle.steps.push(step);
          throw new Error(`${step.label} failed with ${step.status}: ${step.revertReason ?? "no reason"} (${step.hashscan}). ${holder.name} is paid and will not be paid again; rerun to retry the burn.`);
        }
        holder.burned = true;
        holder.burnTransactionId = step.transactionId;
        holder.burnHashscan = step.hashscan;
        report(step, "OK");
        await expectBond("balanceOf(address)", [holder.evm], 0n);
      }

      await expectBond("totalSupply()", [], 0n);
      lifecycle.balances = await printBalances();
      lifecycle.status = "complete";
      save();
      printLinks(lifecycle);
      console.log(`\nDone. Saved to backend/deployments/${BOND_SYMBOL}.json`);
    } catch (error) {
      lifecycle.status = "failed";
      lifecycle.error = error instanceof Error ? error.message : "Unknown error";
      if (error instanceof ControlFailure) lifecycle.blockedReason = error.message;
      save();
      throw error;
    }
  } finally {
    for (const party of parties) party.client.close();
  }
}

main().catch((error: unknown) => {
  // Message only: full error objects are never logged, so nothing else can leak.
  console.error(`\nFAILED: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});

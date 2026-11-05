/**
 * Creates Udhaar Rupee (uINR), a simulated HTS test stablecoin, with a 1% fee to POOL,
 * then proves the fee rules with real transfers.
 *
 * Usage:
 *   npm run create-stablecoin              Dry run: checks accounts and prints the plan.
 *   npm run create-stablecoin -- --execute Runs it on testnet and spends test HBAR.
 *
 * Re-running resumes from backend/deployments/uINR.json, skipping completed steps, so a
 * failure part-way cannot create a second token or mint twice.
 *
 * New account keys are appended to the repo-root .env and must never be logged.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  CustomFractionalFee,
  FeeAssessmentMethod,
  Hbar,
  PrivateKey,
  Status,
  TokenCreateTransaction,
  TokenMintTransaction,
  TokenSupplyType,
  TokenType,
  Transaction,
  TransactionResponse,
  TransferTransaction,
} from "@hiero-ledger/sdk";

const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
const HASHSCAN = "https://hashscan.io/testnet";
const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));
const OUTPUT_DIR = fileURLToPath(new URL("../deployments/", import.meta.url));
const OUTPUT_PATH = `${OUTPUT_DIR}uINR.json`;

const TOKEN_NAME = "Udhaar Rupee";
const TOKEN_SYMBOL = "uINR";
const TOKEN_MEMO = "Simulated test stablecoin. Not real money.";
const DECIMALS = 2;

/** Converts whole uINR to base units (2 decimals). */
const uinr = (whole: number) => whole * 100;

const MINT_AMOUNT = uinr(1_000_000);
const INVESTOR_FUNDING = uinr(200_000);
const BUYER_FUNDING = uinr(500_000);
const FUNDING_TEST_AMOUNT = uinr(1_000);
const FUNDING_TEST_FEE = FUNDING_TEST_AMOUNT / 100;
const REPAYMENT_IN_AMOUNT = uinr(500);
const PAYOUT_AMOUNT = uinr(200);

// Hedera requires every collector to have a fee with a positive rate, and a zero rate is
// rejected. This fraction floors to 0 for any transfer below 10^15 base units, far above the
// supply, and it was confirmed to charge nothing on a throwaway token on 5 Nov 2026.
const REPAYMENT_FEE_DENOMINATOR = 1_000_000_000_000_000;

const NEW_ACCOUNT_HBAR = 5;
const TOKEN_CREATE_MAX_FEE_HBAR = 60;
const TRANSFER_MAX_FEE_HBAR = 5;
const MIN_ADMIN_HBAR = 60;

const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 2_000;
const PRECHECK_RETRIES = 6;
const PRECHECK_RETRY_DELAY_MS = 3_000;

interface Party {
  name: string;
  id: string;
  evm: string;
  key: PrivateKey;
  client: Client;
}

interface MirrorAccount {
  account: string;
  evm_address: string;
  key: { _type: string; key: string };
  balance: { balance: number };
}

interface MirrorTransaction {
  consensus_timestamp: string;
  charged_tx_fee: number;
  nonce: number;
  result: string;
  token_transfers?: { account: string; amount: number; token_id: string }[];
  assessed_custom_fees?: { amount: number; collector_account_id: string; effective_payer_account_ids: string[] }[];
}

interface Step {
  label: string;
  payer: string;
  status: string;
  transactionId: string;
  hashscan: string;
  feeHbar: number;
}

interface TokenRecord {
  symbol: string;
  name: string;
  status: "in-progress" | "complete" | "failed";
  network: "testnet";
  simulatedData: true;
  decimals: number;
  memo: string;
  tokenId: string | null;
  hashscan: string | null;
  treasury: string | null;
  supplyKeyHolder: "admin";
  feeScheduleKeyHolder: "admin";
  adminKey: null;
  fees: { collector: string; collectorId: string | null; rate: string; netOfTransfers: boolean; allCollectorsExempt: boolean }[];
  accounts: Record<string, { id: string; hashscan: string }>;
  balancesBaseUnits: Record<string, number> | null;
  steps: Step[];
  totalFeeHbar: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const formatUinr = (baseUnits: number) => (baseUnits / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 });

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
  const account = await poll(`mirror record of ${id}`, () => mirrorGet<MirrorAccount>(`/accounts/${id}`));
  if (key.publicKey.toStringRaw().toLowerCase() !== account.key.key.toLowerCase()) {
    throw new Error(`${prefix}_KEY does not belong to account ${id}`);
  }
  return {
    name,
    id,
    evm: account.evm_address,
    key,
    client: Client.forTestnet().setOperator(AccountId.fromString(id), key),
  };
}

/** Appends without rewriting, so existing .env entries cannot be damaged. */
function saveAccountToEnv(prefix: string, id: string, key: PrivateKey) {
  const current = readFileSync(ENV_PATH);
  const separator = current.length > 0 && current[current.length - 1] !== 0x0a ? "\n" : "";
  const values = { [`${prefix}_ID`]: id, [`${prefix}_KEY`]: key.toStringRaw(), [`${prefix}_EVM`]: `0x${key.publicKey.toEvmAddress()}` };
  const lines = Object.entries(values).map(([name, value]) => `${name}=${value}\n`);
  appendFileSync(ENV_PATH, `${separator}${lines.join("")}`);
  Object.assign(process.env, values);
}

/**
 * Builds, signs and sends a transaction. A precheck rejection means it never reached
 * consensus, so retrying a rebuilt copy with a new transaction ID cannot apply it twice.
 */
async function send<T extends Transaction>(payer: Party, build: () => T, extraSigners: PrivateKey[] = []) {
  for (let attempt = 0; ; attempt++) {
    try {
      const transaction = build().freezeWith(payer.client);
      for (const signer of extraSigners) await transaction.sign(signer);
      return await transaction.execute(payer.client);
    } catch (error) {
      const retryable = error instanceof Error && error.message.includes("INVALID_TRANSACTION_START");
      if (!retryable || attempt >= PRECHECK_RETRIES) throw error;
      await sleep(PRECHECK_RETRY_DELAY_MS);
    }
  }
}

async function confirm(label: string, payer: Party, response: TransactionResponse) {
  const transactionId = response.transactionId.toString();
  console.log(`  sent ${label}: ${transactionId}`);
  const receipt = await response.getReceiptQuery().setValidateStatus(false).execute(payer.client);
  const [account = "", timestamp = ""] = transactionId.split("@");
  const [seconds = "", nanos = ""] = timestamp.split(".");
  const mirrorId = `${account}-${seconds}-${nanos.padStart(9, "0")}`;
  const transaction = await poll(`mirror record of ${transactionId}`, async () => {
    const found = await mirrorGet<{ transactions: MirrorTransaction[] }>(`/transactions/${mirrorId}`);
    return found?.transactions.find((entry) => entry.nonce === 0);
  });
  const step: Step = {
    label,
    payer: payer.name,
    status: receipt.status.toString(),
    transactionId,
    hashscan: `${HASHSCAN}/transaction/${transaction.consensus_timestamp}`,
    feeHbar: Number(transaction.charged_tx_fee) / 1e8,
  };
  if (receipt.status !== Status.Success) throw new Error(`${label} failed with ${step.status} (${step.hashscan})`);
  return { receipt, step, transaction };
}

function assertTransfer(label: string, tokenId: string, transaction: MirrorTransaction, expectedMoves: Record<string, number>, expectedFee: { collector: string; payer: string; amount: number } | null) {
  const moves = (transaction.token_transfers ?? []).filter((move) => move.token_id === tokenId && move.amount !== 0);
  const actual = Object.fromEntries(moves.map((move) => [move.account, move.amount]));
  const keys = new Set([...Object.keys(actual), ...Object.keys(expectedMoves)]);
  for (const account of keys) {
    if (actual[account] !== expectedMoves[account]) {
      throw new Error(`${label}: ${account} moved ${actual[account] ?? 0}, expected ${expectedMoves[account] ?? 0}`);
    }
  }
  const fees = (transaction.assessed_custom_fees ?? []).filter((fee) => fee.amount > 0);
  if (!expectedFee) {
    if (fees.length > 0) throw new Error(`${label}: expected no fee, but ${JSON.stringify(fees)} was charged`);
    return;
  }
  const fee = fees[0];
  const matches =
    fees.length === 1 &&
    fee?.amount === expectedFee.amount &&
    fee.collector_account_id === expectedFee.collector &&
    fee.effective_payer_account_ids.length === 1 &&
    fee.effective_payer_account_ids[0] === expectedFee.payer;
  if (!matches) throw new Error(`${label}: unexpected fee ${JSON.stringify(fees)}`);
}

async function expectBalance(tokenId: string, party: { name: string; id: string }, expected: number) {
  let actual: number | undefined;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const body = await mirrorGet<{ tokens: { balance: number }[] }>(`/accounts/${party.id}/tokens?token.id=${tokenId}`);
    actual = body?.tokens[0]?.balance;
    if (actual === expected) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${party.name} holds ${actual ?? "no"} base units, expected ${expected}`);
}

async function verifyTokenConfig(tokenId: string, admin: Party, pool: Party, repayment: Party) {
  const token = await poll(`mirror record of ${tokenId}`, () =>
    mirrorGet<{
      name: string;
      symbol: string;
      decimals: string;
      treasury_account_id: string;
      total_supply: string;
      supply_type: string;
      admin_key: unknown;
      supply_key: { key: string } | null;
      fee_schedule_key: { key: string } | null;
      custom_fees: {
        fractional_fees: { collector_account_id: string; net_of_transfers: boolean; all_collectors_are_exempt: boolean; amount: { numerator: number; denominator: number } }[];
      };
    }>(`/tokens/${tokenId}`),
  );
  const adminPublic = admin.key.publicKey.toStringRaw().toLowerCase();
  const [poolFee, repaymentFee, ...otherFees] = token.custom_fees.fractional_fees;
  const checks: [string, boolean][] = [
    ["name", token.name === TOKEN_NAME],
    ["symbol", token.symbol === TOKEN_SYMBOL],
    ["decimals", Number(token.decimals) === DECIMALS],
    ["treasury is admin", token.treasury_account_id === admin.id],
    ["infinite supply", token.supply_type === "INFINITE"],
    ["supply key is admin", token.supply_key?.key.toLowerCase() === adminPublic],
    ["fee schedule key is admin", token.fee_schedule_key?.key.toLowerCase() === adminPublic],
    ["exactly two fee rows", Boolean(poolFee && repaymentFee) && otherFees.length === 0],
    ["1% collected by POOL", poolFee?.collector_account_id === pool.id && poolFee.amount.numerator === 1 && poolFee.amount.denominator === 100],
    ["POOL fee is net of transfers", poolFee?.net_of_transfers === true],
    ["POOL fee exempts all collectors", poolFee?.all_collectors_are_exempt === true],
    ["REPAYMENT is a collector", repaymentFee?.collector_account_id === repayment.id],
    ["REPAYMENT fee exempts all collectors", repaymentFee?.all_collectors_are_exempt === true],
  ];
  const failed = checks.filter(([, passed]) => !passed).map(([name]) => name);
  if (failed.length > 0) throw new Error(`Token settings do not match: ${failed.join(", ")}`);
  console.log(`OK: token settings verified (${checks.length} checks).`);
}

function newRecord(): TokenRecord {
  return {
    symbol: TOKEN_SYMBOL,
    name: TOKEN_NAME,
    status: "in-progress",
    network: "testnet",
    simulatedData: true,
    decimals: DECIMALS,
    memo: TOKEN_MEMO,
    tokenId: null,
    hashscan: null,
    treasury: null,
    supplyKeyHolder: "admin",
    feeScheduleKeyHolder: "admin",
    adminKey: null,
    fees: [
      { collector: "POOL", collectorId: null, rate: "1/100", netOfTransfers: true, allCollectorsExempt: true },
      { collector: "REPAYMENT", collectorId: null, rate: `1/${REPAYMENT_FEE_DENOMINATOR} (rounds to zero)`, netOfTransfers: false, allCollectorsExempt: true },
    ],
    accounts: {},
    balancesBaseUnits: null,
    steps: [],
    totalFeeHbar: 0,
  };
}

async function main() {
  const flags = process.argv.slice(2);
  const unknownFlag = flags.find((flag) => flag !== "--execute");
  if (unknownFlag) throw new Error(`Unknown option: ${unknownFlag}`);
  const execute = flags.includes("--execute");

  loadEnv({ path: ENV_PATH, quiet: true });

  const clients: Client[] = [];
  const load = async (prefix: string, name: string) => {
    const party = await loadParty(prefix, name);
    clients.push(party.client);
    return party;
  };

  try {
    const admin = await load("ADMIN", "admin");
    const investor = await load("INVESTOR", "investor");
    const buyer = await load("BUYER", "buyer");
    const businessId = process.env.BUSINESS_ID?.trim();
    if (!businessId) throw new Error("Missing BUSINESS_ID in .env");
    const business = { name: "business", id: businessId };

    const adminAccount = await poll("admin account", () => mirrorGet<MirrorAccount>(`/accounts/${admin.id}`));
    const adminHbar = adminAccount.balance.balance / 1e8;
    const existing = existsSync(OUTPUT_PATH) ? (JSON.parse(readFileSync(OUTPUT_PATH, "utf8")) as TokenRecord) : null;
    if (existing?.status === "complete") throw new Error(`${TOKEN_SYMBOL} is already complete: ${existing.tokenId}`);

    console.log(`Admin ${admin.id}: ${adminHbar.toFixed(4)} HBAR`);
    console.log(`Investor ${investor.id}, buyer ${buyer.id}, business ${business.id}`);
    console.log(`Existing POOL: ${process.env.POOL_ID ?? "none"}, REPAYMENT: ${process.env.REPAYMENT_ID ?? "none"}, record: ${existing ? existing.status : "none"}`);
    console.log("Expected cost: about 29.5 HBAR token, 5.7 HBAR per new account, under 2 HBAR for mint and transfers.");

    if (!execute) {
      console.log("\nDry run only: no transactions sent. Re-run with --execute to spend test HBAR.");
      return;
    }
    if (adminHbar < MIN_ADMIN_HBAR) throw new Error(`Admin needs at least ${MIN_ADMIN_HBAR} HBAR`);

    mkdirSync(OUTPUT_DIR, { recursive: true });
    const record = existing ?? newRecord();
    record.status = "in-progress";
    delete record.error;
    const save = () => {
      record.totalFeeHbar = Number(record.steps.reduce((sum, step) => sum + step.feeHbar, 0).toFixed(8));
      writeFileSync(OUTPUT_PATH, `${JSON.stringify(record, null, 2)}\n`);
    };
    const isDone = (label: string) => record.steps.some((step) => step.label === label);
    const report = (step: Step) => {
      record.steps.push(step);
      save();
      console.log(`OK: ${step.label} | ${step.feeHbar} HBAR\n  ${step.hashscan}`);
    };

    try {
      const ensureAccount = async (prefix: "POOL" | "REPAYMENT") => {
        const label = `Create ${prefix} account`;
        if (!process.env[`${prefix}_ID`]) {
          const key = PrivateKey.generateECDSA();
          const response = await send(admin, () =>
            new AccountCreateTransaction()
              .setECDSAKeyWithAlias(key)
              .setInitialBalance(new Hbar(NEW_ACCOUNT_HBAR))
              .setMaxAutomaticTokenAssociations(-1)
              .setAccountMemo(`Udhaar ${prefix} (testnet)`),
          );
          // Save before any further await, so a later failure cannot lose the key.
          const accountReceipt = await response.getReceiptQuery().execute(admin.client);
          const newId = accountReceipt.accountId?.toString();
          if (!newId) throw new Error(`${label} returned no account ID`);
          saveAccountToEnv(prefix, newId, key);
          console.log(`  saved ${prefix}_ID, ${prefix}_KEY and ${prefix}_EVM to .env`);
          report((await confirm(label, admin, response)).step);
        }
        const party = await load(prefix, prefix);
        record.accounts[prefix] = { id: party.id, hashscan: `${HASHSCAN}/account/${party.id}` };
        return party;
      };
      const pool = await ensureAccount("POOL");
      const repayment = await ensureAccount("REPAYMENT");
      const [poolFee, repaymentFee] = record.fees;
      if (poolFee) poolFee.collectorId = pool.id;
      if (repaymentFee) repaymentFee.collectorId = repayment.id;
      record.treasury = admin.id;
      record.accounts.investor = { id: investor.id, hashscan: `${HASHSCAN}/account/${investor.id}` };
      record.accounts.buyer = { id: buyer.id, hashscan: `${HASHSCAN}/account/${buyer.id}` };
      record.accounts.business = { id: business.id, hashscan: `${HASHSCAN}/account/${business.id}` };
      save();

      if (!record.tokenId) {
        const response = await send(
          admin,
          () =>
            new TokenCreateTransaction()
              .setTokenName(TOKEN_NAME)
              .setTokenSymbol(TOKEN_SYMBOL)
              .setTokenMemo(TOKEN_MEMO)
              .setTokenType(TokenType.FungibleCommon)
              .setSupplyType(TokenSupplyType.Infinite)
              .setDecimals(DECIMALS)
              .setInitialSupply(0)
              .setTreasuryAccountId(admin.id)
              .setSupplyKey(admin.key.publicKey)
              .setFeeScheduleKey(admin.key.publicKey)
              .setCustomFees([
                new CustomFractionalFee()
                  .setFeeCollectorAccountId(pool.id)
                  .setNumerator(1)
                  .setDenominator(100)
                  .setAssessmentMethod(FeeAssessmentMethod.Exclusive)
                  .setAllCollectorsAreExempt(true),
                new CustomFractionalFee()
                  .setFeeCollectorAccountId(repayment.id)
                  .setNumerator(1)
                  .setDenominator(REPAYMENT_FEE_DENOMINATOR)
                  .setAssessmentMethod(FeeAssessmentMethod.Inclusive)
                  .setAllCollectorsAreExempt(true),
              ])
              .setMaxTransactionFee(new Hbar(TOKEN_CREATE_MAX_FEE_HBAR)),
          // Hedera requires fractional fee collectors to sign the token creation.
          [pool.key, repayment.key],
        );
        const created = await confirm("Create uINR token", admin, response);
        const newTokenId = created.receipt.tokenId?.toString();
        if (!newTokenId) throw new Error("Token creation returned no token ID");
        record.tokenId = newTokenId;
        record.hashscan = `${HASHSCAN}/token/${newTokenId}`;
        report(created.step);
        console.log(`  token ${newTokenId}\n  ${record.hashscan}`);
      }
      const tokenId = record.tokenId;
      if (!tokenId) throw new Error("Token ID missing from record");

      const once = async (label: string, payer: Party, run: () => Promise<TransactionResponse>, verify?: (transaction: MirrorTransaction) => void) => {
        if (isDone(label)) {
          console.log(`SKIP (already done): ${label}`);
          return;
        }
        const { step, transaction } = await confirm(label, payer, await run());
        verify?.(transaction);
        report(step);
      };
      const transfer = (from: Party, to: { id: string }, amount: number) =>
        send(from, () =>
          new TransferTransaction()
            .addTokenTransfer(tokenId, from.id, -amount)
            .addTokenTransfer(tokenId, to.id, amount)
            .setMaxTransactionFee(new Hbar(TRANSFER_MAX_FEE_HBAR)),
        );

      await once(`Mint ${formatUinr(MINT_AMOUNT)} uINR to treasury`, admin, () =>
        send(admin, () => new TokenMintTransaction().setTokenId(tokenId).setAmount(MINT_AMOUNT)),
      );

      const fundLabel = (name: string, amount: number) => `Send ${formatUinr(amount)} uINR to ${name}`;
      await once(fundLabel("investor", INVESTOR_FUNDING), admin, () => transfer(admin, investor, INVESTOR_FUNDING), (transaction) =>
        assertTransfer("Treasury to investor", tokenId, transaction, { [admin.id]: -INVESTOR_FUNDING, [investor.id]: INVESTOR_FUNDING }, null),
      );
      await once(fundLabel("buyer", BUYER_FUNDING), admin, () => transfer(admin, buyer, BUYER_FUNDING), (transaction) =>
        assertTransfer("Treasury to buyer", tokenId, transaction, { [admin.id]: -BUYER_FUNDING, [buyer.id]: BUYER_FUNDING }, null),
      );

      await verifyTokenConfig(tokenId, admin, pool, repayment);

      console.log("\nTesting investor -> business (sender pays 1% on top, to POOL)...");
      await once(`Test: investor -> business ${formatUinr(FUNDING_TEST_AMOUNT)} uINR`, investor, () => transfer(investor, business, FUNDING_TEST_AMOUNT), (transaction) =>
        assertTransfer(
          "Investor to business",
          tokenId,
          transaction,
          { [investor.id]: -(FUNDING_TEST_AMOUNT + FUNDING_TEST_FEE), [business.id]: FUNDING_TEST_AMOUNT, [pool.id]: FUNDING_TEST_FEE },
          { collector: pool.id, payer: investor.id, amount: FUNDING_TEST_FEE },
        ),
      );

      console.log("\nTesting buyer -> REPAYMENT and REPAYMENT -> investor (both must be fee-free)...");
      await once(`Test: buyer -> REPAYMENT ${formatUinr(REPAYMENT_IN_AMOUNT)} uINR`, buyer, () => transfer(buyer, repayment, REPAYMENT_IN_AMOUNT), (transaction) =>
        assertTransfer("Buyer to REPAYMENT", tokenId, transaction, { [buyer.id]: -REPAYMENT_IN_AMOUNT, [repayment.id]: REPAYMENT_IN_AMOUNT }, null),
      );
      await once(`Test: REPAYMENT -> investor payout ${formatUinr(PAYOUT_AMOUNT)} uINR`, repayment, () => transfer(repayment, investor, PAYOUT_AMOUNT), (transaction) =>
        assertTransfer("REPAYMENT payout", tokenId, transaction, { [repayment.id]: -PAYOUT_AMOUNT, [investor.id]: PAYOUT_AMOUNT }, null),
      );

      console.log("\nVerifying final balances...");
      const balances: [{ name: string; id: string }, number][] = [
        [admin, MINT_AMOUNT - INVESTOR_FUNDING - BUYER_FUNDING],
        [investor, INVESTOR_FUNDING - FUNDING_TEST_AMOUNT - FUNDING_TEST_FEE + PAYOUT_AMOUNT],
        [buyer, BUYER_FUNDING - REPAYMENT_IN_AMOUNT],
        [business, FUNDING_TEST_AMOUNT],
        [pool, FUNDING_TEST_FEE],
        [repayment, REPAYMENT_IN_AMOUNT - PAYOUT_AMOUNT],
      ];
      for (const [party, expected] of balances) {
        await expectBalance(tokenId, party, expected);
        console.log(`  ${party.name.padEnd(10)} ${formatUinr(expected)} uINR`);
      }
      record.balancesBaseUnits = Object.fromEntries(balances.map(([party, expected]) => [party.name, expected]));
      record.status = "complete";
      save();

      console.log(`\nDone. Token ${tokenId} | total fees ${record.totalFeeHbar} HBAR`);
      console.log(`${record.hashscan}\nSaved: backend/deployments/uINR.json`);
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : "Unknown error";
      save();
      throw error;
    }
  } finally {
    for (const client of clients) client.close();
  }
}

main().catch((error: unknown) => {
  // Message only: full error objects are never logged, so nothing else can leak.
  console.error(`\nFAILED: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});

/**
 * Issues one ATS v8 bond on Hedera testnet and proves its allowlist works:
 * deploy -> allowlist business + investor -> issue 500 units to business ->
 * business -> investor transfer succeeds -> business -> buyer transfer is rejected.
 *
 * Usage:
 *   npm run issue-bond              Dry run: checks accounts, simulates the deploy
 *                                   and prints the cost. Sends no transactions.
 *   npm run issue-bond -- --execute Runs it on testnet and spends test HBAR.
 *
 * Keys are read from the repo-root .env and must never be logged.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { AbiCoder, getBytes, hexlify, id as keccakId, Interface, toUtf8Bytes, ZeroAddress, type InterfaceAbi } from "ethers";
import { AccountId, Client, ContractExecuteTransaction, ContractId, Hbar, PrivateKey, Status } from "@hiero-ledger/sdk";

const require = createRequire(import.meta.url);
const ARTIFACTS = "@hashgraph/asset-tokenization-contracts/artifacts/contracts";
const factoryAbi = (require(`${ARTIFACTS}/factory/IFactory.sol/IFactory.json`) as { abi: InterfaceAbi }).abi;
const assetAbi = (require(`${ARTIFACTS}/facets/IAsset.sol/IAsset.json`) as { abi: InterfaceAbi }).abi;
const factoryInterface = new Interface(factoryAbi);
const assetInterface = new Interface(assetAbi);

const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
const HASHSCAN = "https://hashscan.io/testnet";

// ATS v8 testnet deployment (apps/ats/web/.env.example at tag v.8.0.0-ats).
const FACTORY_ID = "0.0.9213391";
const RESOLVER_ID = "0.0.9212226";
const BOND_CONFIG_KEY = `0x${"0".repeat(63)}2`;
const BOND_CONFIG_VERSION = 1;

const UNITS = 500n;
const FACE_VALUE = 1000n;
const CURRENCY = "INR";
const TRANSFER_UNITS = 100n;
const START_DELAY_SECONDS = 60;
const MATURITY_DELAY_SECONDS = 10 * 60;

const REGULATION_TYPE_REG_S = 1;
const REGULATION_SUBTYPE_NONE = 0;

// Role hashes from contracts/constants/roles.sol in the pinned v8 package.
const ROLES = {
  DEFAULT_ADMIN: `0x${"0".repeat(64)}`,
  ISSUER: "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f",
  CONTROL_LIST: "0x6ed9a91e996c6475ecdc28ecbdbe9bd1122fc62b30cdbe6da8271884b51ec74d",
  PAUSER: "0x3cb8b459fdb6e7dc3d2a2aa529e530f885d45e03584adb438423209c86a2731f",
  FREEZE_MANAGER: "0x71ae38482e1ab1c28e767d64766d686215b490c8c1bd7dfe6b101525187c2155",
  MATURITY_REDEEMER: "0x433f48f8aca23480f6ab07666cbc9131d32a0b4672033453f65e18f4dd390523",
  MATURITY_MANAGER: "0xc20b7fd7efe1a2c9f69003a21c2c55c79ef84e16252b62599246ff01f6207314",
} as const;

// Gas limits follow the ATS SDK's Constants.ts, except deploy, where 10M is what recent
// successful calls used. `expected` is the highest gas seen on comparable live ATS calls,
// except the rejected transfer, which is a rough figure from another function's early revert.
const GAS = {
  deploy: { limit: 10_000_000, expected: 8_100_000 },
  allowlist: { limit: 1_200_000, expected: 130_000 },
  issue: { limit: 7_000_000, expected: 460_000 },
  transfer: { limit: 1_200_000, expected: 450_000 },
  rejectedTransfer: { limit: 1_200_000, expected: 100_000 },
} as const;

const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 2_000;

interface Account {
  name: string;
  id: string;
  evm: string;
  balanceTinybar: bigint;
}

interface Signer extends Account {
  client: Client;
}

interface MirrorAccount {
  account: string;
  evm_address: string;
  key: { _type: string; key: string };
  balance: { balance: number };
}

interface MirrorContractResult {
  call_result?: string;
  error_message?: string | null;
  gas_used?: number;
  timestamp: string;
}

interface Step {
  label: string;
  payer: string;
  status: string;
  transactionId: string;
  hashscan: string;
  gasUsed: number | null;
  feeHbar: number | null;
  revertReason?: string;
}

interface SentCall extends Step {
  callResult?: string;
  errorMessage?: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tinybarToHbar = (tinybar: bigint | number) => (Number(tinybar) / 1e8).toFixed(4);

async function mirrorGet<T>(path: string): Promise<T | undefined> {
  const response = await fetch(`${MIRROR}${path}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Mirror node returned ${response.status} for ${path}`);
  return (await response.json()) as T;
}

async function mirrorRequire<T>(path: string): Promise<T> {
  const value = await mirrorGet<T>(path);
  if (value === undefined) throw new Error(`Mirror node has no record at ${path}`);
  return value;
}

async function poll<T>(description: string, attempt: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const value = await attempt();
    if (value !== undefined) return value;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/** Runs a call against mirror node state. Free, and sends nothing to the network. */
async function simulate(from: string, to: string, data: string, gas: number) {
  const response = await fetch(`${MIRROR}/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ block: "latest", data, estimate: false, from, gas, to }),
  });
  const body = (await response.json()) as {
    result?: string;
    _status?: { messages?: { message?: string; data?: string; detail?: string }[] };
  };
  if (response.ok) return { ok: true as const, result: body.result ?? "0x" };
  const message = body._status?.messages?.[0];
  const reason = message?.data ? decodeRevert(message.data) : (message?.detail ?? message?.message);
  return { ok: false as const, error: reason ?? `HTTP ${response.status}` };
}

function decodeRevert(data: string | null | undefined): string {
  if (!data || data === "0x") return "no revert data";
  const parsed = assetInterface.parseError(data) ?? factoryInterface.parseError(data);
  return parsed ? `${parsed.name}(${parsed.args.join(", ")})` : data;
}

function readEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function parseEcdsaKey(envName: string): PrivateKey {
  const value = readEnv(envName).replace(/^0x/i, "");
  try {
    return /^[0-9a-f]{64}$/i.test(value) ? PrivateKey.fromStringECDSA(value) : PrivateKey.fromStringDer(value);
  } catch {
    // The original error is dropped on purpose so key material cannot reach the logs.
    throw new Error(`${envName} could not be parsed as a private key`);
  }
}

async function loadAccount(prefix: string, label: string): Promise<Account> {
  const id = readEnv(`${prefix}_ID`);
  const record = await mirrorRequire<MirrorAccount>(`/accounts/${id}`);
  if (record.key._type !== "ECDSA_SECP256K1") throw new Error(`${label} (${id}) is not an ECDSA account`);
  const declaredEvm = process.env[`${prefix}_EVM`]?.trim();
  if (declaredEvm && declaredEvm.toLowerCase() !== record.evm_address.toLowerCase()) {
    throw new Error(`${prefix}_EVM does not match the mirror node's address for ${id}`);
  }
  return { name: label, id, evm: record.evm_address, balanceTinybar: BigInt(record.balance.balance) };
}

async function loadSigner(prefix: string, label: string): Promise<Signer> {
  const account = await loadAccount(prefix, label);
  const key = parseEcdsaKey(`${prefix}_KEY`);
  const record = await mirrorRequire<MirrorAccount>(`/accounts/${account.id}`);
  if (key.publicKey.toStringRaw().toLowerCase() !== record.key.key.toLowerCase()) {
    throw new Error(`${prefix}_KEY does not belong to account ${account.id}`);
  }
  return { ...account, client: Client.forTestnet().setOperator(AccountId.fromString(account.id), key) };
}

/** Builds a valid demo ISIN. The ZZ prefix is not a real country, so it cannot collide with a real security. */
function buildDemoIsin(unixSeconds: number): string {
  const body = `ZZ${unixSeconds.toString(36).toUpperCase().padStart(9, "0")}`;
  const digits = [...body].map((char) => parseInt(char, 36)).join("");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = Number(digits[digits.length - 1 - i]);
    const value = i % 2 === 0 ? digit * 2 : digit;
    sum += value > 9 ? value - 9 : value;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

function buildSymbol(now: Date): string {
  return `UDH${now.toISOString().slice(2, 16).replace(/[-T:]/g, "")}`;
}

function buildDeployParams(admin: Account, resolverEvm: string, symbol: string, isin: string, start: number, maturity: number) {
  const rbacs = Object.values(ROLES).map((role) => ({ role, members: [admin.evm] }));
  const bondData = {
    security: {
      resolver: resolverEvm,
      maxSupply: UNITS,
      resolverProxyConfiguration: { key: BOND_CONFIG_KEY, version: BOND_CONFIG_VERSION },
      erc20MetadataInfo: { name: `Udhaar demo invoice ${symbol}`, symbol, isin, decimals: 0 },
      rbacs,
      externalPauses: [],
      externalControlLists: [],
      externalKycLists: [],
      compliance: ZeroAddress,
      identityRegistry: ZeroAddress,
      arePartitionsProtected: false,
      isMultiPartition: false,
      isControllable: true,
      isWhiteList: true,
      clearingActive: false,
      internalKycActivated: false,
      erc20VotesActivated: false,
    },
    bondDetails: {
      currency: hexlify(toUtf8Bytes(CURRENCY)),
      nominalValue: FACE_VALUE,
      nominalValueDecimals: 0,
      startingDate: start,
      maturityDate: maturity,
    },
    proceedRecipients: [],
    proceedRecipientsData: [],
  };
  const regulation = {
    regulationType: REGULATION_TYPE_REG_S,
    regulationSubType: REGULATION_SUBTYPE_NONE,
    additionalSecurityData: {
      countriesControlListType: false,
      listOfCountries: "",
      info: "Simulated hackathon data. Not a real security.",
    },
  };
  return [bondData, regulation] as const;
}

async function sendCall(
  signer: Signer,
  contractId: string,
  contractInterface: Interface,
  signature: string,
  params: readonly unknown[],
  gas: number,
  gasPriceTinybar: number,
  label: string,
): Promise<SentCall> {
  const data = contractInterface.encodeFunctionData(signature, params);
  const maxFeeTinybar = Math.ceil(gas * gasPriceTinybar * 1.5) + 100_000_000;
  const response = await new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(contractId))
    .setGas(gas)
    .setFunctionParameters(getBytes(data))
    .setMaxTransactionFee(Hbar.fromTinybars(maxFeeTinybar))
    .execute(signer.client);

  const transactionId = response.transactionId.toString();
  console.log(`  sent ${label}: ${transactionId}`);
  const receipt = await response.getReceiptQuery().setValidateStatus(false).execute(signer.client);

  const [payer = "", timestamp = ""] = transactionId.split("@");
  const [seconds = "", nanos = ""] = timestamp.split(".");
  const mirrorId = `${payer}-${seconds}-${nanos.padStart(9, "0")}`;
  const result = await poll(`mirror record of ${transactionId}`, () =>
    mirrorGet<MirrorContractResult>(`/contracts/results/${mirrorId}`),
  );
  const transactions = await poll(`fee record of ${transactionId}`, () =>
    mirrorGet<{ transactions: { charged_tx_fee: number; nonce: number }[] }>(`/transactions/${mirrorId}`),
  );
  const parent = transactions.transactions.find((transaction) => transaction.nonce === 0);

  return {
    label,
    payer: signer.name,
    status: receipt.status.toString(),
    transactionId,
    hashscan: `${HASHSCAN}/transaction/${result.timestamp}`,
    gasUsed: result.gas_used ?? null,
    feeHbar: parent ? Number(parent.charged_tx_fee) / 1e8 : null,
    callResult: result.call_result,
    errorMessage: result.error_message,
    ...(receipt.status === Status.Success ? {} : { revertReason: decodeRevert(result.error_message) }),
  };
}

function toStep(call: SentCall): Step {
  const { callResult: _callResult, errorMessage: _errorMessage, ...step } = call;
  return step;
}

async function readBond<T>(bond: string, from: string, signature: string, params: readonly unknown[] = []): Promise<T> {
  const call = await simulate(from, bond, assetInterface.encodeFunctionData(signature, params), 1_000_000);
  if (!call.ok) throw new Error(`Read of ${signature} failed: ${call.error}`);
  return assetInterface.decodeFunctionResult(signature, call.result)[0] as T;
}

/** Mirror node state lags consensus by a few seconds, so reads after a write retry until they match. */
async function expectBond(bond: string, from: string, signature: string, params: readonly unknown[], expected: unknown) {
  let actual: unknown;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const call = await simulate(from, bond, assetInterface.encodeFunctionData(signature, params), 1_000_000);
    if (call.ok) {
      actual = assetInterface.decodeFunctionResult(signature, call.result)[0];
      if (actual === expected) return;
    } else {
      actual = call.error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${signature} returned ${String(actual)}, expected ${String(expected)}`);
}

function printCosts(admin: Account, business: Account, gasPriceTinybar: number) {
  const rows: [string, string, number, number][] = [
    ["Deploy bond", admin.name, GAS.deploy.expected, GAS.deploy.limit],
    ["Allowlist business", admin.name, GAS.allowlist.expected, GAS.allowlist.limit],
    ["Allowlist investor", admin.name, GAS.allowlist.expected, GAS.allowlist.limit],
    ["Issue 500 units", admin.name, GAS.issue.expected, GAS.issue.limit],
    ["Transfer to investor", business.name, GAS.transfer.expected, GAS.transfer.limit],
    ["Rejected transfer to buyer", business.name, GAS.rejectedTransfer.expected, GAS.rejectedTransfer.limit],
  ];
  const totals = new Map<string, { expected: number; worst: number }>();
  console.log(`\nGas price: ${gasPriceTinybar} tinybar per gas`);
  for (const [label, payer, expected, limit] of rows) {
    const expectedCost = expected * gasPriceTinybar;
    const worstCost = limit * gasPriceTinybar;
    const total = totals.get(payer) ?? { expected: 0, worst: 0 };
    totals.set(payer, { expected: total.expected + expectedCost, worst: total.worst + worstCost });
    console.log(`  ${label.padEnd(28)} ${payer.padEnd(9)} ~${tinybarToHbar(expectedCost)} HBAR (limit ${tinybarToHbar(worstCost)})`);
  }
  for (const account of [admin, business]) {
    const total = totals.get(account.name);
    if (!total) continue;
    console.log(
      `${account.name}: balance ${tinybarToHbar(account.balanceTinybar)} HBAR, expected ~${tinybarToHbar(total.expected)}, gas-limit ceiling ${tinybarToHbar(total.worst)}`,
    );
    if (account.balanceTinybar < BigInt(total.worst)) {
      throw new Error(`${account.name} (${account.id}) cannot cover the gas-limit ceiling`);
    }
  }
}

async function main() {
  const flags = process.argv.slice(2);
  const unknownFlag = flags.find((flag) => flag !== "--execute");
  if (unknownFlag) throw new Error(`Unknown option: ${unknownFlag}`);
  const execute = flags.includes("--execute");

  loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

  const admin = await loadSigner("ADMIN", "admin");
  const business = await loadSigner("BUSINESS", "business");
  try {
    const investor = await loadAccount("INVESTOR", "investor");
    const buyer = await loadAccount("BUYER", "buyer");
    for (const account of [admin, business, investor, buyer]) {
      console.log(`${account.name.padEnd(9)} ${account.id.padEnd(14)} ${account.evm}`);
    }

    const fees = await mirrorRequire<{ fees: { gas: number; transaction_type: string }[] }>("/network/fees");
    const gasPriceTinybar = fees.fees.find((fee) => fee.transaction_type === "ContractCall")?.gas;
    if (!gasPriceTinybar) throw new Error("Mirror node did not report a contract gas price");
    printCosts(admin, business, gasPriceTinybar);

    const factory = await mirrorRequire<{ evm_address: string }>(`/contracts/${FACTORY_ID}`);
    const resolver = await mirrorRequire<{ evm_address: string }>(`/contracts/${RESOLVER_ID}`);

    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const symbol = buildSymbol(now);
    const isin = buildDemoIsin(nowSeconds);
    const startingDate = nowSeconds + START_DELAY_SECONDS;
    const maturityDate = nowSeconds + MATURITY_DELAY_SECONDS;
    const deployParams = buildDeployParams(admin, resolver.evm_address, symbol, isin, startingDate, maturityDate);

    console.log(`\nSimulating deployBond for ${symbol} (ISIN ${isin})...`);
    const deployData = factoryInterface.encodeFunctionData("deployBond", deployParams);
    const simulation = await simulate(admin.evm, factory.evm_address, deployData, GAS.deploy.limit);
    if (!simulation.ok) throw new Error(`deployBond simulation failed: ${simulation.error}`);
    console.log("Simulation passed.");

    if (!execute) {
      console.log("\nDry run only: no transactions sent. Re-run with --execute to spend test HBAR.");
      return;
    }

    const outputDir = fileURLToPath(new URL("../deployments/", import.meta.url));
    const outputPath = `${outputDir}${symbol}.json`;
    if (existsSync(outputPath)) throw new Error(`${outputPath} already exists; wait a minute and retry`);
    mkdirSync(outputDir, { recursive: true });

    const steps: Step[] = [];
    const record = {
      symbol,
      status: "in-progress",
      network: "testnet",
      simulatedData: true,
      atsVersion: "8.0.0",
      factoryId: FACTORY_ID,
      resolverId: RESOLVER_ID,
      isin,
      name: `Udhaar demo invoice ${symbol}`,
      terms: {
        units: UNITS.toString(),
        decimals: 0,
        faceValue: FACE_VALUE.toString(),
        faceValueDecimals: 0,
        currency: CURRENCY,
        startingDate: new Date(startingDate * 1000).toISOString(),
        maturityDate: new Date(maturityDate * 1000).toISOString(),
        startingDateUnix: startingDate,
        maturityDateUnix: maturityDate,
      },
      bond: null as null | { contractId: string; evmAddress: string; hashscan: string },
      admin: { id: admin.id, evm: admin.evm },
      allowlist: [business, investor].map(({ name, id, evm }) => ({ name, id, evm })),
      notAllowlisted: { name: buyer.name, id: buyer.id, evm: buyer.evm },
      balances: null as null | Record<string, string>,
      steps,
      totalFeeHbar: 0,
      error: undefined as string | undefined,
    };
    const save = () => {
      record.totalFeeHbar = Number(steps.reduce((sum, step) => sum + (step.feeHbar ?? 0), 0).toFixed(8));
      writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
    };
    const report = (step: Step, outcome = "OK") => {
      steps.push(step);
      save();
      console.log(`${outcome}: ${step.label} | ${step.feeHbar ?? "?"} HBAR | gas ${step.gasUsed ?? "?"}\n  ${step.hashscan}`);
    };
    /** Sends a call that must succeed, and stops the run if it does not. */
    const mustSucceed = async (call: Promise<SentCall>) => {
      const sent = await call;
      if (sent.status !== Status.Success.toString()) {
        steps.push(toStep(sent));
        throw new Error(`${sent.label} failed with ${sent.status}: ${sent.revertReason ?? "no reason"} (${sent.hashscan})`);
      }
      return sent;
    };

    try {
      console.log("\nDeploying bond...");
      const deployment = await mustSucceed(
        sendCall(admin, FACTORY_ID, factoryInterface, "deployBond", deployParams, GAS.deploy.limit, gasPriceTinybar, "Deploy bond"),
      );
      if (!deployment.callResult) throw new Error("deployBond returned no bond address");
      const bondEvm = String(factoryInterface.decodeFunctionResult("deployBond", deployment.callResult)[0]);
      const bondContract = await poll(`mirror record of bond ${bondEvm}`, () =>
        mirrorGet<{ contract_id: string }>(`/contracts/${bondEvm}`),
      );
      const bondId = bondContract.contract_id;
      record.bond = { contractId: bondId, evmAddress: bondEvm, hashscan: `${HASHSCAN}/contract/${bondId}` };
      report(toStep(deployment));
      console.log(`  bond ${bondId} (${bondEvm})\n  ${record.bond.hashscan}`);

      console.log("\nVerifying bond terms and admin roles...");
      await expectBond(bondEvm, admin.evm, "getControlListType()", [], true);
      await expectBond(bondEvm, admin.evm, "getMaxSupply()", [], UNITS);
      await expectBond(bondEvm, admin.evm, "getMaturityDate()", [], BigInt(maturityDate));
      await expectBond(bondEvm, admin.evm, "getNominalValue()", [], FACE_VALUE);
      await expectBond(bondEvm, admin.evm, "totalSupply()", [], 0n);
      for (const [name, role] of Object.entries(ROLES)) {
        const hasRole = await readBond<boolean>(bondEvm, admin.evm, "hasRole(bytes32,address)", [role, admin.evm]);
        if (!hasRole) throw new Error(`Admin is missing role ${name}`);
      }
      console.log("OK: terms match and admin holds every role.");

      console.log("\nAllowlisting business and investor...");
      for (const account of [business, investor]) {
        const call = await mustSucceed(
          sendCall(admin, bondId, assetInterface, "addToControlList(address)", [account.evm], GAS.allowlist.limit, gasPriceTinybar, `Allowlist ${account.name}`),
        );
        report(toStep(call));
        await expectBond(bondEvm, admin.evm, "isInControlList(address)", [account.evm], true);
      }
      await expectBond(bondEvm, admin.evm, "isInControlList(address)", [buyer.evm], false);
      console.log("OK: business and investor are listed; buyer is not.");

      console.log("\nIssuing units to business...");
      const issued = await mustSucceed(
        sendCall(admin, bondId, assetInterface, "issue(address,uint256,bytes)", [business.evm, UNITS, "0x"], GAS.issue.limit, gasPriceTinybar, `Issue ${UNITS} units to business`),
      );
      report(toStep(issued));
      await expectBond(bondEvm, admin.evm, "balanceOf(address)", [business.evm], UNITS);

      console.log("\nTesting business -> investor transfer (must succeed)...");
      const transferred = await mustSucceed(
        sendCall(business, bondId, assetInterface, "transfer(address,uint256)", [investor.evm, TRANSFER_UNITS], GAS.transfer.limit, gasPriceTinybar, `Transfer ${TRANSFER_UNITS} units business -> investor`),
      );
      report(toStep(transferred));
      await expectBond(bondEvm, admin.evm, "balanceOf(address)", [investor.evm], TRANSFER_UNITS);

      console.log("\nTesting business -> buyer transfer (must be rejected)...");
      const rejected = await sendCall(
        business,
        bondId,
        assetInterface,
        "transfer(address,uint256)",
        [buyer.evm, TRANSFER_UNITS],
        GAS.rejectedTransfer.limit,
        gasPriceTinybar,
        `Transfer ${TRANSFER_UNITS} units business -> buyer (expected rejection)`,
      );
      if (rejected.status === Status.Success.toString()) {
        steps.push(toStep(rejected));
        throw new Error(`COMPLIANCE FAILURE: the transfer to the unverified buyer succeeded (${rejected.hashscan})`);
      }
      // Any revert is not proof: it must be the allowlist rejecting this specific buyer.
      const expectedRevert = `${keccakId("AccountIsBlocked(address)").slice(0, 10)}${AbiCoder.defaultAbiCoder().encode(["address"], [buyer.evm]).slice(2)}`;
      if (rejected.errorMessage?.toLowerCase() !== expectedRevert.toLowerCase()) {
        steps.push(toStep(rejected));
        throw new Error(`Transfer to buyer failed for the wrong reason: ${rejected.revertReason ?? "unknown"} (${rejected.hashscan})`);
      }
      report(toStep(rejected), "REJECTED AS EXPECTED");
      console.log(`  reason: ${rejected.revertReason}`);

      console.log("\nVerifying final balances...");
      const expectedBalances = [
        [business, UNITS - TRANSFER_UNITS],
        [investor, TRANSFER_UNITS],
        [buyer, 0n],
      ] as const;
      for (const [account, units] of expectedBalances) {
        await expectBond(bondEvm, admin.evm, "balanceOf(address)", [account.evm], units);
      }
      await expectBond(bondEvm, admin.evm, "totalSupply()", [], UNITS);
      record.balances = Object.fromEntries(expectedBalances.map(([account, units]) => [account.name, units.toString()]));
      record.status = "complete";
      save();

      console.log(`\nDone. Total fees: ${record.totalFeeHbar} HBAR`);
      console.log(`business ${UNITS - TRANSFER_UNITS} | investor ${TRANSFER_UNITS} | buyer 0`);
      console.log(`Maturity: ${record.terms.maturityDate}`);
      console.log(`Saved: backend/deployments/${symbol}.json`);
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : "Unknown error";
      save();
      throw error;
    }
  } finally {
    admin.client.close();
    business.client.close();
  }
}

main().catch((error: unknown) => {
  // Message only: full error objects are never logged, so nothing else can leak.
  console.error(`\nFAILED: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});

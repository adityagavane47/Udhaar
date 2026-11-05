import { createRequire } from "node:module";
import { ContractExecuteTransaction, ContractId } from "@hiero-ledger/sdk";
import { AbiCoder, getBytes, hexlify, Interface, toUtf8Bytes, ZeroAddress, zeroPadValue, type InterfaceAbi } from "ethers";
import { config, hashscan } from "../config.js";
import { executeOnce, getParty, type Party } from "../hedera/client.js";
import { gasPriceTinybar, getAccount, mirrorGet, mirrorPages, poll } from "../hedera/mirror.js";
import type { BondRef, TxRecord } from "../types.js";

const require = createRequire(import.meta.url);
const ARTIFACTS = "@hashgraph/asset-tokenization-contracts/artifacts/contracts";
const factoryAbi = (require(`${ARTIFACTS}/factory/IFactory.sol/IFactory.json`) as { abi: InterfaceAbi }).abi;
const assetAbi = (require(`${ARTIFACTS}/facets/IAsset.sol/IAsset.json`) as { abi: InterfaceAbi }).abi;
const factoryInterface = new Interface(factoryAbi);
const assetInterface = new Interface(assetAbi);

// Role hashes from contracts/constants/roles.sol in the pinned v8 package.
export const BOND_ROLES = {
  DEFAULT_ADMIN: `0x${"0".repeat(64)}`,
  ISSUER: "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f",
  CONTROL_LIST: "0x6ed9a91e996c6475ecdc28ecbdbe9bd1122fc62b30cdbe6da8271884b51ec74d",
  PAUSER: "0x3cb8b459fdb6e7dc3d2a2aa529e530f885d45e03584adb438423209c86a2731f",
  FREEZE_MANAGER: "0x71ae38482e1ab1c28e767d64766d686215b490c8c1bd7dfe6b101525187c2155",
  MATURITY_REDEEMER: "0x433f48f8aca23480f6ab07666cbc9131d32a0b4672033453f65e18f4dd390523",
  MATURITY_MANAGER: "0xc20b7fd7efe1a2c9f69003a21c2c55c79ef84e16252b62599246ff01f6207314",
} as const;

const REGULATION_REG_S = 1;
const REGULATION_SUBTYPE_NONE = 0;
const REDEEMED_TOPIC = assetInterface.getEvent("RedeemedByPartition")?.topicHash;

export interface Revert {
  name: string;
  text: string;
}

export function decodeRevert(data: string | null | undefined): Revert {
  if (!data || data === "0x") return { name: "none", text: "no revert data" };
  const parsed = assetInterface.parseError(data) ?? factoryInterface.parseError(data);
  return parsed ? { name: parsed.name, text: `${parsed.name}(${parsed.args.join(", ")})` } : { name: "unknown", text: data };
}

async function maxFeeHbar(gas: number) {
  // Gas-limit cost, plus a margin for the small fixed part of the transaction fee.
  return Math.ceil((gas * (await gasPriceTinybar())) / 1e8) + 1;
}

async function simulateCall(from: string, to: string, data: string, gas: number): Promise<{ ok: true; result: string } | { ok: false; revert: Revert }> {
  const response = await fetch(`${config.mirrorUrl}/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ block: "latest", data, estimate: false, from, gas, to }),
  });
  const body = (await response.json()) as { result?: string; _status?: { messages?: { message?: string; data?: string; detail?: string }[] } };
  if (response.ok) return { ok: true, result: body.result ?? "0x" };
  const message = body._status?.messages?.[0];
  return { ok: false, revert: message?.data ? decodeRevert(message.data) : { name: "unknown", text: message?.detail ?? message?.message ?? `HTTP ${response.status}` } };
}

/** Runs a bond call against current state without sending it. Free. */
export function simulate(bond: BondRef, from: string, signature: string, params: readonly unknown[] = []) {
  return simulateCall(from, bond.evm, assetInterface.encodeFunctionData(signature, params), config.contractGasLimit);
}

export async function read<T>(bond: BondRef, signature: string, params: readonly unknown[] = []): Promise<T> {
  const admin = await getParty("ADMIN");
  const call = await simulate(bond, admin.evm, signature, params);
  if (!call.ok) throw new Error(`Read of ${signature} failed: ${call.revert.text}`);
  return assetInterface.decodeFunctionResult(signature, call.result)[0] as T;
}

/** Retries a read until it matches, because mirror state lags consensus by a few seconds. */
export async function expectRead(bond: BondRef, signature: string, params: readonly unknown[], expected: unknown) {
  let actual: unknown;
  try {
    await poll(`${signature} to return ${String(expected)}`, async () => {
      actual = await read(bond, signature, params);
      return actual === expected ? true : undefined;
    });
  } catch {
    throw new Error(`${signature} returned ${String(actual)}, expected ${String(expected)}`);
  }
}

export interface BondCall {
  record: TxRecord & { replayed: boolean };
  revert?: Revert;
}

/** Sends a bond call at most once per key. A revert is returned, not thrown, so each caller decides what it means. */
export async function callBond(bond: BondRef, signer: Party, signature: string, params: readonly unknown[], key: string, crashAfterSend?: string): Promise<BondCall> {
  const data = assetInterface.encodeFunctionData(signature, params);
  const record = await executeOnce({
    key,
    payer: signer,
    maxFeeHbar: await maxFeeHbar(config.contractGasLimit),
    build: () =>
      new ContractExecuteTransaction()
        .setContractId(ContractId.fromString(bond.contractId))
        .setGas(config.contractGasLimit)
        .setFunctionParameters(getBytes(data)),
    ...(crashAfterSend ? { crashAfterSend } : {}),
  });
  return record.succeeded ? { record } : { record, revert: decodeRevert(record.errorMessage) };
}

/** Builds a valid demo ISIN. The ZZ prefix is not a real country, so it cannot collide with a real security. */
export function buildDemoIsin(unixSeconds: number): string {
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

export const buildBondSymbol = (now: Date) => `UDH${now.toISOString().slice(2, 19).replace(/[-T:]/g, "")}`;

export interface DeployBondInput {
  symbol: string;
  name: string;
  isin: string;
  units: number;
  unitFaceValue: number;
  currency: string;
  startingDateUnix: number;
  maturityDateUnix: number;
}

export async function deployBond(input: DeployBondInput, key: string): Promise<{ bond: BondRef; record: TxRecord }> {
  const admin = await getParty("ADMIN");
  const [factory, resolver] = await Promise.all([
    mirrorGet<{ evm_address: string }>(`/contracts/${config.factoryId}`),
    mirrorGet<{ evm_address: string }>(`/contracts/${config.resolverId}`),
  ]);
  if (!factory || !resolver) throw new Error("ATS factory or resolver was not found on the mirror node");

  const params = [
    {
      security: {
        resolver: resolver.evm_address,
        maxSupply: BigInt(input.units),
        resolverProxyConfiguration: { key: config.bondConfigKey, version: config.bondConfigVersion },
        erc20MetadataInfo: { name: input.name, symbol: input.symbol, isin: input.isin, decimals: 0 },
        rbacs: Object.values(BOND_ROLES).map((role) => ({ role, members: [admin.evm] })),
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
        currency: hexlify(toUtf8Bytes(input.currency)),
        nominalValue: BigInt(input.unitFaceValue),
        nominalValueDecimals: 0,
        startingDate: input.startingDateUnix,
        maturityDate: input.maturityDateUnix,
      },
      proceedRecipients: [],
      proceedRecipientsData: [],
    },
    {
      regulationType: REGULATION_REG_S,
      regulationSubType: REGULATION_SUBTYPE_NONE,
      additionalSecurityData: { countriesControlListType: false, listOfCountries: "", info: "Simulated hackathon data. Not a real security." },
    },
  ] as const;
  const data = factoryInterface.encodeFunctionData("deployBond", params);

  const simulation = await simulateCall(admin.evm, factory.evm_address, data, config.deployGasLimit);
  if (!simulation.ok) throw new Error(`deployBond simulation failed: ${simulation.revert.text}`);

  const record = await executeOnce({
    key,
    payer: admin,
    maxFeeHbar: await maxFeeHbar(config.deployGasLimit),
    build: () =>
      new ContractExecuteTransaction()
        .setContractId(ContractId.fromString(config.factoryId))
        .setGas(config.deployGasLimit)
        .setFunctionParameters(getBytes(data)),
  });
  if (!record.succeeded || !record.callResult) {
    throw new Error(`deployBond failed with ${record.result}: ${decodeRevert(record.errorMessage).text} (${record.hashscanUrl})`);
  }
  const evm = String(factoryInterface.decodeFunctionResult("deployBond", record.callResult)[0]);
  const contract = await poll(`mirror record of bond ${evm}`, () => mirrorGet<{ contract_id: string }>(`/contracts/${evm}`));
  return { bond: { symbol: input.symbol, contractId: contract.contract_id, evm }, record };
}

export const isAllowlisted = (bond: BondRef, evm: string) => read<boolean>(bond, "isInControlList(address)", [evm]);

export async function addToAllowlist(bond: BondRef, evm: string, key: string) {
  return callBond(bond, await getParty("ADMIN"), "addToControlList(address)", [evm], key);
}

export async function issueUnits(bond: BondRef, toEvm: string, units: number, key: string) {
  return callBond(bond, await getParty("ADMIN"), "issue(address,uint256,bytes)", [toEvm, BigInt(units), "0x"], key);
}

export const transferUnits = (bond: BondRef, from: Party, toEvm: string, units: number, key: string) =>
  callBond(bond, from, "transfer(address,uint256)", [toEvm, BigInt(units)], key);

export const simulateTransfer = (bond: BondRef, fromEvm: string, toEvm: string, units: number) =>
  simulate(bond, fromEvm, "transfer(address,uint256)", [toEvm, BigInt(units)]);

export async function pauseBond(bond: BondRef, key: string) {
  return callBond(bond, await getParty("ADMIN"), "pause()", [], key);
}

export async function unpauseBond(bond: BondRef, key: string) {
  return callBond(bond, await getParty("ADMIN"), "unpause()", [], key);
}

export const isPaused = (bond: BondRef) => read<boolean>(bond, "paused()");

/**
 * Freezes units with freezePartialTokens, not setAddressFrozen. In ATS v8, unfreezing through
 * setAddressFrozen adds the address to the allowlist even if it was never approved.
 */
export async function freezeUnits(bond: BondRef, evm: string, units: bigint, key: string) {
  return callBond(bond, await getParty("ADMIN"), "freezePartialTokens(address,uint256)", [evm, units], key);
}

export async function unfreezeUnits(bond: BondRef, evm: string, units: bigint, key: string) {
  return callBond(bond, await getParty("ADMIN"), "unfreezePartialTokens(address,uint256)", [evm, units], key);
}

export async function redeemAtMaturity(bond: BondRef, holderEvm: string, key: string, crashAfterSend?: string) {
  return callBond(bond, await getParty("ADMIN"), "fullRedeemAtMaturity(address)", [holderEvm], key, crashAfterSend);
}

export async function simulateRedeem(bond: BondRef, holderEvm: string) {
  const admin = await getParty("ADMIN");
  return simulate(bond, admin.evm, "fullRedeemAtMaturity(address)", [holderEvm]);
}

export interface Position {
  evm: string;
  accountId: string;
  units: bigint;
  frozen: bigint;
}

/** Current holders from the chain. `units` is what the holder owns: free balance plus frozen. */
export async function holderPositions(bond: BondRef): Promise<Position[]> {
  const total = await read<bigint>(bond, "getTotalSecurityHolders()");
  if (total === 0n) return [];
  const addresses = await read<readonly string[]>(bond, "getSecurityHolders(uint256,uint256)", [0n, total]);
  const positions: Position[] = [];
  for (const address of Array.from(addresses)) {
    const evm = address.toLowerCase();
    const [balance, frozen, account] = await Promise.all([read<bigint>(bond, "balanceOf(address)", [evm]), read<bigint>(bond, "getFrozenTokens(address)", [evm]), getAccount(evm)]);
    if (!account) throw new Error(`Could not resolve holder ${evm} to an account`);
    if (balance + frozen > 0n) positions.push({ evm, accountId: account.account, units: balance + frozen, frozen });
  }
  return positions;
}

/**
 * Units the chain shows as redeemed for this holder, read from the bond's own log history.
 *
 * This reads RedeemedByPartition, not Transfer(holder -> 0): in ATS v8 a freeze emits that same
 * Transfer, so counting it would report frozen units as burned. Mirror topic filters also need a
 * timestamp range of at most 7 days, which a 90-day bond would outlive, so logs are filtered here.
 */
export async function burnedUnits(bond: BondRef, holderEvm: string): Promise<{ total: bigint; lastTimestamp?: string }> {
  const holderTopic = zeroPadValue(holderEvm, 32).toLowerCase();
  let total = 0n;
  let lastTimestamp: string | undefined;
  for await (const log of mirrorPages<{ data: string; timestamp: string; topics: string[] }>(`/contracts/${bond.contractId}/results/logs?order=asc&limit=100`, "logs")) {
    if (log.topics[0] === REDEEMED_TOPIC && log.topics[3]?.toLowerCase() === holderTopic) {
      total += AbiCoder.defaultAbiCoder().decode(["uint256", "bytes", "bytes"], log.data)[0] as bigint;
      lastTimestamp = log.timestamp;
    }
  }
  return lastTimestamp ? { total, lastTimestamp } : { total };
}

export const bondLink = (bond: BondRef) => hashscan.contract(bond.contractId);


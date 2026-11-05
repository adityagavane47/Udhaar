import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const BACKEND_ROOT = fileURLToPath(new URL("../", import.meta.url));

loadEnv({ path: process.env.ENV_PATH ?? `${BACKEND_ROOT}../.env`, quiet: true });

function readUinrTokenId(): string {
  if (process.env.UINR_TOKEN_ID) return process.env.UINR_TOKEN_ID;
  const record = JSON.parse(readFileSync(`${BACKEND_ROOT}deployments/uINR.json`, "utf8")) as { tokenId: string };
  return record.tokenId;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mirrorUrl: "https://testnet.mirrornode.hedera.com/api/v1",
  hashscanUrl: "https://hashscan.io/testnet",
  dataDir: process.env.DATA_DIR ?? `${BACKEND_ROOT}data/`,
  hcsRecordPath: `${BACKEND_ROOT}deployments/hcs.json`,
  uinrTokenId: readUinrTokenId(),
  /** A single transaction that could cost more than this is refused until a person approves it. */
  maxStepHbar: Number(process.env.MAX_STEP_HBAR ?? 15),
  // ATS v8 testnet deployment (apps/ats/web/.env.example at tag v.8.0.0-ats).
  factoryId: "0.0.9213391",
  resolverId: "0.0.9212226",
  bondConfigKey: `0x${"0".repeat(63)}2`,
  bondConfigVersion: 1,
  deployGasLimit: 10_000_000,
  contractGasLimit: 1_000_000,
  htsMaxFeeHbar: 2,
  hcsMaxFeeHbar: 2,
  defaultUnitFaceValue: 1000,
  defaultDiscountPct: 4,
  uinrDecimals: 2,
  /** HBAR kept per pending payout. Covers the fee, plus an automatic association if one is needed. */
  payoutHbarReserve: 1,
} as const;

mkdirSync(config.dataDir, { recursive: true });

/** Whole rupees to uINR base units. */
export const toBaseUnits = (rupees: number) => Math.round(rupees * 10 ** config.uinrDecimals);
export const fromBaseUnits = (baseUnits: number) => baseUnits / 10 ** config.uinrDecimals;

export const hashscan = {
  transaction: (consensusTimestamp: string) => `${config.hashscanUrl}/transaction/${consensusTimestamp}`,
  account: (id: string) => `${config.hashscanUrl}/account/${id}`,
  contract: (id: string) => `${config.hashscanUrl}/contract/${id}`,
  token: (id: string) => `${config.hashscanUrl}/token/${id}`,
  topic: (id: string) => `${config.hashscanUrl}/topic/${id}`,
};

/** Test-only: exits at a named point to prove a crash there is safe. Does nothing unless the variable is set. */
export function crashPoint(name: string) {
  if (process.env.UDHAAR_CRASH_AT === name) {
    console.log(`SIMULATED CRASH at ${name}`);
    process.exit(75);
  }
}

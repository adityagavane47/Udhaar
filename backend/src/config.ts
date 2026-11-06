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

const PORT = Number(process.env.PORT ?? 4000);

/**
 * Minutes from now that a demo-maturity bond matures, or null when the option is off. Under 3 is refused:
 * the bond's start date is a minute ahead and the maturity must clear it.
 */
export function parseDemoMaturityMinutes(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 3 && minutes <= 1440 ? minutes : null;
}
if (process.env.DEMO_SHORT_MATURITY_MINUTES?.trim() && parseDemoMaturityMinutes(process.env.DEMO_SHORT_MATURITY_MINUTES) === null) {
  console.warn("DEMO_SHORT_MATURITY_MINUTES must be a number from 3 to 1440, so demo maturity is off.");
}

export const config = {
  port: PORT,
  /** How the server reaches its own paywall when it pays as the investor. */
  selfUrl: (process.env.SELF_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, ""),
  /** Proxies in front of the server, such as 1 on Railway or Render. Rate limits need this to see the real client IP. */
  trustProxyHops: Number(process.env.TRUST_PROXY ?? 0),
  adminTokenMinutes: Number(process.env.DEMO_ADMIN_TOKEN_MINUTES ?? 30),
  /** Demo only: lets an admin tokenize with a maturity this many minutes away. Null means off. */
  demoShortMaturityMinutes: parseDemoMaturityMinutes(process.env.DEMO_SHORT_MATURITY_MINUTES),
  investorTokenMinutes: Number(process.env.DEMO_INVESTOR_TOKEN_MINUTES ?? 30),
  facilitatorUrl: (process.env.FACILITATOR_URL ?? "https://x402.org/facilitator").replace(/\/$/, ""),
  x402Network: "hedera:testnet",
  /** ₹1.00. The 1% uINR fee rounds down, so anything under ₹1 would pay POOL nothing. */
  reportPriceBaseUnits: 100,
  /** The agent refuses to pay more than this for one report, whatever the server quotes. */
  agentMaxReportPriceBaseUnits: 200,
  /** Mirror checks after a settlement, 2 seconds apart. */
  settlementConfirmAttempts: Number(process.env.X402_CONFIRM_ATTEMPTS ?? 8),
  /** Across all callers, per UTC day. Kept in the store, so a restart doesn't reset it. */
  agentDailyRunCap: Number(process.env.AGENT_DAILY_RUN_CAP ?? 20),
  /** The most an investor's rules may allow in one run, in rupees. */
  agentMaxReportBudget: Number(process.env.AGENT_MAX_REPORT_BUDGET ?? 50),
  agentMaxInvestmentBudget: Number(process.env.AGENT_MAX_INVESTMENT_BUDGET ?? 50_000),
  mirrorUrl: "https://testnet.mirrornode.hedera.com/api/v1",
  hashscanUrl: "https://hashscan.io/testnet",
  dataDir: process.env.DATA_DIR ?? `${BACKEND_ROOT}data/`,
  /** Committed seed data, separate from dataDir so tests and deployments that move the store still find it. */
  riskDataDir: process.env.RISK_DATA_DIR ?? `${BACKEND_ROOT}data/risk/`,
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
  uinrDecimals: 2,
  /** HBAR kept per pending payout. Covers the fee, plus an automatic association if one is needed. */
  payoutHbarReserve: 1,
} as const;

mkdirSync(config.dataDir, { recursive: true });

/** Rupees to uINR base units. */
export const toBaseUnits = (rupees: number) => Math.round(rupees * 10 ** config.uinrDecimals);
export const fromBaseUnits = (baseUnits: number) => baseUnits / 10 ** config.uinrDecimals;
/** uINR's custom fee, which the sender pays on top. It rounds down on-chain, which was checked with real transfers. */
export const uinrFeeBaseUnits = (amountBaseUnits: number) => Math.floor(amountBaseUnits / 100);

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

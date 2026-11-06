/**
 * Tests admin login, the token check and the rate limits through a real server process.
 * Spends no HBAR: every request stops before a chain transaction, and the script checks that total
 * balances didn't change. Mirror node reads are the only network use.
 *
 * Usage: npm run test:auth
 * Uses a random passcode and a temporary store, so the real passcode and store are never touched.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND = fileURLToPath(new URL("../", import.meta.url));
const DATA_DIR = `${mkdtempSync(join(tmpdir(), "udhaar-auth-"))}/`;
process.env.DATA_DIR = DATA_DIR;
await import("../src/config.js"); // Loads .env, for the account IDs used below.

const PORT = 4101;
const BASE = `http://localhost:${PORT}`;
const PASSCODE = randomBytes(16).toString("hex");
const NONE = "0.0.1";

type Json = Record<string, any>;
interface Reply {
  status: number;
  json: Json;
  headers: Headers;
}

let failures = 0;
let passes = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) passes++;
  else failures++;
  if (!condition) console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
}
const code = (reply: Reply) => `${reply.status} ${reply.json.error?.code ?? "ok"}`;

async function request(method: string, path: string, options: { body?: unknown; token?: string; auth?: string } = {}): Promise<Reply> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.auth ? { authorization: options.auth } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Json) : {}, headers: response.headers };
}

const login = (passcode = PASSCODE) => request("POST", "/auth/demo-admin", { body: { passcode } });

let serverOutput = "";
async function withServer(env: Record<string, string>, run: () => Promise<void>) {
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: BACKEND,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, DEMO_ADMIN_PASSCODE: PASSCODE, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        up = (await fetch(`${BASE}/health`)).ok;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!up) throw new Error(`Server did not start: ${serverOutput.slice(-500)}`);
    await run();
  } finally {
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      });
    }
  }
}

async function totalHbar() {
  const { json } = await request("GET", "/balances");
  return (json.accounts as Json[]).reduce((sum, account) => sum + Number(account.hbar), 0);
}

/** Each admin route, and the error a valid token reaches for an ID that doesn't exist. */
const ADMIN_ROUTES: [string, unknown, string][] = [
  ["/invoices/NOPE/tokenize", {}, "INVOICE_NOT_FOUND"],
  ["/kyc/NOPE/approve", undefined, "KYC_NOT_FOUND"],
  ["/kyc/NOPE/reject", undefined, "KYC_NOT_FOUND"],
  ["/tokens/NOPE/pause", undefined, "TOKEN_NOT_FOUND"],
  ["/tokens/NOPE/unpause", undefined, "TOKEN_NOT_FOUND"],
  ["/tokens/NOPE/freeze", { accountId: NONE }, "TOKEN_NOT_FOUND"],
  ["/tokens/NOPE/unfreeze", { accountId: NONE }, "TOKEN_NOT_FOUND"],
];

/** Every route sharing the 20-a-minute limit. None gets as far as the chain with these bodies. */
const HBAR_ROUTES: [string, unknown, "admin" | "investor" | undefined][] = [
  ["/invoices", {}, undefined],
  ["/invoices/NOPE/confirm", undefined, undefined],
  ["/invoices/NOPE/buy", { units: 1 }, "investor"],
  ["/invoices/NOPE/pay-supplier", { units: 1, supplierId: NONE }, undefined],
  ["/invoices/NOPE/repay", undefined, undefined],
  ["/kyc/NOPE/approve", undefined, "admin"],
  ["/tokens/NOPE/pause", undefined, "admin"],
  ["/tokens/NOPE/unpause", undefined, "admin"],
  ["/tokens/NOPE/freeze", { accountId: NONE }, "admin"],
  ["/tokens/NOPE/unfreeze", { accountId: NONE }, "admin"],
];

let startHbar = 0;
let endHbar = 0;
let leaked = "";

try {
  console.log("1. No passcode configured");
  await withServer({ DEMO_ADMIN_PASSCODE: "  " }, async () => {
    const reply = await login("anything");
    check("login is off", code(reply) === "503 ADMIN_AUTH_NOT_CONFIGURED", code(reply));
    const route = await request("POST", "/tokens/NOPE/pause");
    check("admin route stays locked", code(route) === "401 ADMIN_TOKEN_REQUIRED", code(route));
    check("startup warning shown", serverOutput.includes("DEMO_ADMIN_PASSCODE is not set"));
  });

  console.log("2. Login and token checks");
  let oldToken = "";
  await withServer({}, async () => {
    startHbar = await totalHbar();

    const wrong = await login("wrong");
    check("wrong passcode refused", code(wrong) === "401 INVALID_PASSCODE" && !wrong.json.token, code(wrong));
    const missing = await request("POST", "/auth/demo-admin", { body: {} });
    check("missing passcode refused", code(missing) === "400 VALIDATION_ERROR", code(missing));

    const good = await login();
    const token = good.json.token as string;
    oldToken = token;
    check("right passcode returns a token", good.status === 200 && good.json.ok === true && good.json.tokenType === "Bearer" && Boolean(token), code(good));
    check("token lasts 30 minutes", good.json.expiresInSeconds === 1800 && Math.abs(Date.parse(good.json.expiresAt) - Date.now() - 1_800_000) < 10_000);
    check("login response has a HashScan link", String(good.json.hashscanUrl).startsWith("https://hashscan.io/testnet/"));

    const [expiresAt = "", signature = ""] = token.split(".");
    const forgedExpiry = `${Number(expiresAt) + 86_400_000}.${signature}`;
    for (const [path, body, notFound] of ADMIN_ROUTES) {
      const options = body === undefined ? {} : { body };
      const none = await request("POST", path, options);
      check(`${path} without a token`, code(none) === "401 ADMIN_TOKEN_REQUIRED", code(none));
      const basic = await request("POST", path, { ...options, auth: "Basic abc" });
      check(`${path} with the wrong scheme`, code(basic) === "401 ADMIN_TOKEN_REQUIRED", code(basic));
      const garbage = await request("POST", path, { ...options, token: "garbage" });
      check(`${path} with a garbage token`, code(garbage) === "401 ADMIN_TOKEN_INVALID", code(garbage));
      const forged = await request("POST", path, { ...options, token: forgedExpiry });
      check(`${path} with a changed expiry`, code(forged) === "401 ADMIN_TOKEN_INVALID", code(forged));
      const valid = await request("POST", path, { ...options, token });
      check(`${path} with a valid token`, code(valid) === `404 ${notFound}`, code(valid));
    }

    const preflight = await fetch(`${BASE}/tokens/NOPE/pause`, { method: "OPTIONS", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    check("browser preflight allows the Authorization header", preflight.ok && (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase().includes("authorization"));

    // KYC with no live bonds touches no chain, so these run end to end for free.
    const investorId = process.env.INVESTOR_ID?.trim() ?? "";
    const businessId = process.env.BUSINESS_ID?.trim() ?? "";
    const first = await request("POST", "/kyc", { body: { fullName: "Auth Test One", walletAddress: investorId, country: "IN" } });
    const firstId = first.json.request?.id as string;
    check("KYC stays public to submit", first.status === 201, code(first));
    const rejected = await request("POST", `/kyc/${firstId}/reject`, { token });
    check("reject works with a token", rejected.status === 200 && rejected.json.request.status === "rejected" && String(rejected.json.hashscanUrl).includes(investorId), code(rejected));
    const rejectedAgain = await request("POST", `/kyc/${firstId}/reject`, { token });
    check("rejecting twice changes nothing", rejectedAgain.status === 200, code(rejectedAgain));
    const approveRejected = await request("POST", `/kyc/${firstId}/approve`, { token });
    check("a rejected request can't be approved", code(approveRejected) === "409 KYC_REJECTED", code(approveRejected));

    const second = await request("POST", "/kyc", { body: { fullName: "Auth Test Two", walletAddress: businessId, country: "IN" } });
    const secondId = second.json.request?.id as string;
    const approved = await request("POST", `/kyc/${secondId}/approve`, { token });
    check("approve works with a token", approved.status === 200 && approved.json.request.status === "approved", code(approved));
    const rejectApproved = await request("POST", `/kyc/${secondId}/reject`, { token });
    check("an approved request can't be rejected", code(rejectApproved) === "409 KYC_ALREADY_APPROVED", code(rejectApproved));

    const entries = (await request("GET", "/audit")).json.entries as Json[];
    check("rejection is audited once", entries.filter((entry) => entry.type === "kyc_reject").length === 1);
  });

  console.log("3. Tokens don't survive a restart, and they expire");
  await withServer({ DEMO_ADMIN_TOKEN_MINUTES: "0.02" }, async () => {
    const old = await request("POST", "/tokens/NOPE/pause", { token: oldToken });
    check("token from before the restart", code(old) === "401 ADMIN_TOKEN_INVALID", code(old));
    const token = (await login()).json.token as string;
    const fresh = await request("POST", "/tokens/NOPE/pause", { token });
    check("short-lived token works at first", code(fresh) === "404 TOKEN_NOT_FOUND", code(fresh));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const expired = await request("POST", "/tokens/NOPE/pause", { token });
    check("token after it expires", code(expired) === "401 ADMIN_TOKEN_EXPIRED", code(expired));
  });

  console.log("4. Rate limit on routes that spend HBAR");
  await withServer({}, async () => {
    const token = (await login()).json.token as string;
    const investorToken = (await request("POST", "/auth/demo-investor")).json.token as string;
    const callRoute = ([path, body, auth]: (typeof HBAR_ROUTES)[number]) => request("POST", path, { ...(body === undefined ? {} : { body }), ...(auth === "admin" ? { token } : auth === "investor" ? { token: investorToken } : {}) });

    for (let i = 0; i < 25; i++) await request("POST", "/tokens/NOPE/pause");
    const afterUnauthed = await request("POST", "/tokens/NOPE/pause", { token });
    check("requests without a token don't use up the limit", code(afterUnauthed) === "404 TOKEN_NOT_FOUND", code(afterUnauthed));

    // One request is already counted above.
    for (let i = 0; i < 19; i++) {
      const reply = await callRoute(HBAR_ROUTES[i % HBAR_ROUTES.length] as (typeof HBAR_ROUTES)[number]);
      check(`request ${i + 2} of 20 is allowed`, reply.status !== 429, code(reply));
    }
    for (const route of HBAR_ROUTES) {
      const reply = await callRoute(route);
      check(`${route[0]} is limited`, code(reply) === "429 RATE_LIMITED", code(reply));
      check(`${route[0]} says when to retry`, reply.json.error?.retryAfterSeconds > 0 && Number(reply.headers.get("retry-after")) > 0);
    }

    const stillOpen = await request("GET", "/health");
    check("reads aren't limited", stillOpen.status === 200);
    const reject = await request("POST", "/kyc/NOPE/reject", { token });
    check("KYC reject isn't limited, because it spends nothing", code(reject) === "404 KYC_NOT_FOUND", code(reject));

    for (let i = 0; i < 5; i++) {
      const reply = await request("POST", "/invoices/NOPE/tokenize", { body: {}, token });
      check(`tokenize ${i + 1} of 5 is allowed`, code(reply) === "404 INVOICE_NOT_FOUND", code(reply));
    }
    const sixth = await request("POST", "/invoices/NOPE/tokenize", { body: {}, token });
    check("tokenize 6 is limited", code(sixth) === "429 RATE_LIMITED", code(sixth));
  });

  console.log("5. Rate limit on failed logins");
  await withServer({}, async () => {
    for (let i = 0; i < 12; i++) {
      const good = await login();
      check(`successful login ${i + 1} doesn't count`, good.status === 200, code(good));
    }
    for (let i = 0; i < 10; i++) {
      const bad = await login("wrong");
      check(`failed login ${i + 1} of 10 gets an answer`, code(bad) === "401 INVALID_PASSCODE", code(bad));
    }
    const locked = await login();
    check("locked after 10 failures, even with the right passcode", code(locked) === "429 RATE_LIMITED", code(locked));
    endHbar = await totalHbar();
  });

  check("no HBAR spent", startHbar > 0 && startHbar === endHbar, `${startHbar} then ${endHbar}`);

  const store = readFileSync(`${DATA_DIR}store.json`, "utf8");
  if (serverOutput.includes(PASSCODE)) leaked += " server output";
  if (store.includes(PASSCODE)) leaked += " store";
  check("passcode isn't in the logs or the store", leaked === "", leaked);
} finally {
  rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(`\n${passes} passed, ${failures} failed. HBAR across all accounts: ${startHbar.toFixed(4)} before, ${endHbar.toFixed(4)} after.`);
process.exit(failures ? 1 : 0);

/**
 * Tests the KYC wallet check: the mirror node lookup, the two warning rules, and approval that asks for
 * confirmation when there are warnings.
 *
 * Spends no HBAR and sends no transaction. The store is a temporary directory, with no bonds in it, so
 * an approval has nothing to put on a chain. The mirror node is replaced by canned answers.
 *
 * Usage: npm run test:wallet-check
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = `${mkdtempSync(join(tmpdir(), "udhaar-wallet-"))}/`;
process.env.DEMO_ADMIN_PASSCODE = "wallet-check-test-passcode";

let passes = 0;
let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) passes++;
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const { checkWallet, mirrorWalletReader, loadBlocklist, NEW_ACCOUNT_DAYS } = await import("../src/walletCheck.js");
type WalletReader = import("../src/walletCheck.js").WalletReader;
const { approveKyc, ensureWalletCheck, useWalletReader } = await import("../src/kyc.js");
const { state } = await import("../src/store.js");
const { createApp } = await import("../src/app.js");
const { ApiError } = await import("../src/errors.js");
type KycRequest = import("../src/types.js").KycRequest;

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const WALLET = "0.0.5000";
const [BAD] = [...loadBlocklist().keys()];

const reader = (over: { ageDays?: number; accounts?: string[]; transfers?: number; count?: number; capped?: boolean; missing?: boolean; fail?: boolean }): WalletReader => ({
  async createdAt() {
    if (over.fail) throw new Error("Mirror node returned 502");
    return over.missing ? undefined : new Date(NOW - (over.ageDays ?? 30) * DAY);
  },
  async counterparties() {
    return { transfers: over.transfers ?? 12, accounts: over.accounts ?? ["0.0.2000", "0.0.2001"] };
  },
  async transactionCount() {
    return { count: over.count ?? 40, capped: over.capped ?? false };
  },
});

console.log("The two rules");
{
  const clean = await checkWallet(WALLET, reader({ ageDays: 30 }), NOW);
  check("an old account with ordinary counterparties is clean", clean.status === "clean" && clean.warnings.length === 0);
  check("the facts are reported", clean.accountAgeDays === 30 && clean.transactionCount === 40 && clean.transfersChecked === 12 && clean.counterpartiesChecked === 2 && clean.accountCreatedAt === new Date(NOW - 30 * DAY).toISOString());
  check("the check says its blocklist is mock and links the account", clean.blocklist === "mock" && clean.source === "mirror" && clean.hashscanUrl === `https://hashscan.io/testnet/account/${WALLET}`);

  const young = await checkWallet(WALLET, reader({ ageDays: 3 }), NOW);
  check("under 7 days old is a warning", young.status === "warnings" && young.warnings.length === 1 && young.warnings[0]?.code === "ACCOUNT_TOO_NEW" && /3 days old/.test(young.warnings[0]?.message ?? ""));
  check("6 days old is a warning, 7 days is not", (await checkWallet(WALLET, reader({ ageDays: 6 }), NOW)).status === "warnings" && (await checkWallet(WALLET, reader({ ageDays: NEW_ACCOUNT_DAYS }), NOW)).status === "clean");
  check("an account made today says less than a day", /less than a day/.test((await checkWallet(WALLET, reader({ ageDays: 0 }), NOW)).warnings[0]?.message ?? ""));

  const listed = await checkWallet(WALLET, reader({ accounts: ["0.0.2000", BAD as string] }), NOW);
  check("a blocklisted counterparty is a warning that names it and says why", listed.status === "warnings" && listed.warnings.length === 1 && listed.warnings[0]?.code === "BLOCKLISTED_COUNTERPARTY" && listed.warnings[0].accountId === BAD && /blocklist: Fictional/.test(listed.warnings[0].message), JSON.stringify(listed.warnings));
  const both = await checkWallet(WALLET, reader({ ageDays: 1, accounts: [...loadBlocklist().keys()].slice(0, 2) }), NOW);
  check("each blocklisted account and the age each get their own warning", both.warnings.length === 3 && both.status === "warnings");
}

console.log("When the chain can't be read");
{
  const down = await checkWallet(WALLET, reader({ fail: true }), NOW);
  check("a mirror failure is 'unavailable' and claims nothing", down.status === "unavailable" && down.warnings.length === 0 && /502/.test(down.note ?? ""));
  const missing = await checkWallet(WALLET, reader({ missing: true }), NOW);
  check("an account the mirror doesn't know is 'unavailable'", missing.status === "unavailable" && /not found/.test(missing.note ?? ""));
}

console.log("The mirror node lookup");
{
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  const page = (n: number, withNext: boolean) => ({ transactions: Array.from({ length: 100 }, (_, i) => ({ transfers: [{ account: WALLET }, { account: `0.0.${3000 + n * 100 + i}` }] })), links: { next: withNext ? `/api/v1/transactions?account.id=${WALLET}&order=desc&limit=100&timestamp=lt:${n}` : null } });
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("/accounts/")) return json({ created_timestamp: `${Math.floor((NOW - 10 * DAY) / 1000)}.123456789` });
    if (url.includes("transactiontype=cryptotransfer")) {
      return json({ transactions: [
        { transfers: [{ account: WALLET }, { account: "0.0.98" }, { account: "0.0.3" }], token_transfers: [{ account: WALLET }, { account: "0.0.7000" }] },
        { transfers: [{ account: WALLET }], nft_transfers: [{ sender_account_id: WALLET, receiver_account_id: "0.0.7001" }] },
      ] });
    }
    return json(page(urls.filter((u) => u.includes("order=desc&limit=100")).length, true));
  }) as typeof fetch;
  try {
    const created = await mirrorWalletReader.createdAt(WALLET);
    check("the creation date comes from created_timestamp", created?.getTime() === Math.floor((NOW - 10 * DAY) / 1000) * 1000);
    const moves = await mirrorWalletReader.counterparties(WALLET, 100);
    check("counterparties come from hbar, token and NFT transfers, without the wallet itself", moves.transfers === 2 && ["0.0.98", "0.0.3", "0.0.7000", "0.0.7001"].every((id) => moves.accounts.includes(id)) && !moves.accounts.includes(WALLET), JSON.stringify(moves));
    check("it asks for the latest 100 crypto transfers", urls.some((u) => u.includes(`account.id=${WALLET}`) && u.includes("transactiontype=cryptotransfer") && u.includes("limit=100") && u.includes("order=desc")));
    const counted = await mirrorWalletReader.transactionCount(WALLET, 5);
    check("the transaction count stops at 5 pages and says it was capped", counted.count === 500 && counted.capped === true, JSON.stringify(counted));
    check("it followed the mirror's next links", urls.filter((u) => u.includes("timestamp=lt:")).length >= 4);
    // A short last page ends the count even though the mirror still sends a next link.
    globalThis.fetch = (async () => new Response(JSON.stringify({ transactions: Array.from({ length: 47 }, () => ({ transfers: [] })), links: { next: "/api/v1/transactions?x=1" } }), { status: 200 })) as typeof fetch;
    const short = await mirrorWalletReader.transactionCount(WALLET, 5);
    check("47 transactions is counted as 47 and not capped", short.count === 47 && short.capped === false, JSON.stringify(short));
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("Approval");
const request = (id: string, over: Partial<KycRequest> = {}): KycRequest => {
  const value = { id, fullName: "Test Applicant", walletAddress: WALLET, country: "India", status: "pending", submittedAt: new Date().toISOString(), hashscanUrl: `https://hashscan.io/testnet/account/${WALLET}`, pendingBonds: [], ...over } as KycRequest;
  state.kyc[id] = value;
  return value;
};
const refused = (work: () => Promise<unknown>) => work().then(() => undefined, (error: unknown) => (error instanceof ApiError ? error : undefined));
{
  useWalletReader(reader({ ageDays: 2 }));
  request("kyc-warn");
  const blocked = await refused(() => approveKyc("kyc-warn"));
  check("approving with a warning is refused until it is confirmed", blocked?.code === "WALLET_CHECK_WARNINGS" && blocked.status === 409 && /1 warning/.test(blocked.message), blocked?.code);
  check("the refusal carries the warnings and no HashScan link", Array.isArray((blocked?.details as { warnings?: string[] }).warnings) && (blocked?.details as { hashscanUrl?: string }).hashscanUrl === undefined);
  check("nothing changed: still pending", state.kyc["kyc-warn"]?.status === "pending");
  const approved = await approveKyc("kyc-warn", { confirmWarnings: true });
  check("with confirmation it is approved", approved.request.status === "approved");
  check("the audit log records that warnings were confirmed", state.audit.some((entry) => entry.type === "kyc_approve" && /1 wallet-check warning confirmed/.test(entry.description)));

  useWalletReader(reader({ ageDays: 60 }));
  request("kyc-clean");
  check("a clean wallet is approved without confirmation", (await approveKyc("kyc-clean")).request.status === "approved");

  useWalletReader(reader({ fail: true }));
  request("kyc-down");
  check("an unavailable check also needs confirmation", (await refused(() => approveKyc("kyc-down")))?.code === "WALLET_CHECK_WARNINGS");
  check("and then approves", (await approveKyc("kyc-down", { confirmWarnings: true })).request.status === "approved");
  check("approving an approved request again needs no confirmation", (await approveKyc("kyc-warn")).request.status === "approved");

  useWalletReader(reader({ ageDays: 60 }));
  const old = request("kyc-old", { ...({ walletScan: "not_checked", walletScanNote: "The wallet scan (F19) is not built yet." } as object) });
  await ensureWalletCheck(old);
  check("the old placeholder fields are dropped", !("walletScan" in old) && !("walletScanNote" in old) && old.walletCheck?.status === "clean");
  const first = old.walletCheck;
  await ensureWalletCheck(old);
  check("a finished check is not run again", old.walletCheck === first);
}

console.log("Routes");
{
  useWalletReader(reader({ ageDays: 1, accounts: [BAD as string] }));
  request("kyc-route", { walletAddress: "0.0.5001" });
  const server = createApp().listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const json = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${base}${path}`, init);
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const list = await json("/kyc?walletAddress=0.0.5001");
    const item = list.body.requests[0];
    check("GET /kyc runs the check and returns it", item.walletCheck?.status === "warnings" && item.walletCheck.warnings.length === 2 && item.walletCheck.hashscanUrl.includes("/account/0.0.5001"));
    check("GET /kyc carries no 'not built' placeholder", !JSON.stringify(list.body).match(/not built|F19|walletScan/i));
    const login = await json("/auth/demo-admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: process.env.DEMO_ADMIN_PASSCODE }) });
    const auth = { "content-type": "application/json", authorization: `Bearer ${login.body.token}` };
    check("approving needs an admin token", (await json("/kyc/kyc-route/approve", { method: "POST" })).status === 401);
    check("an unknown body field is refused", (await json("/kyc/kyc-route/approve", { method: "POST", headers: auth, body: JSON.stringify({ confirm: true }) })).status === 400);
    const withWarnings = await json("/kyc/kyc-route/approve", { method: "POST", headers: auth, body: "{}" });
    check("POST /kyc/:id/approve with warnings: 409 WALLET_CHECK_WARNINGS and no hashscanUrl", withWarnings.status === 409 && withWarnings.body.error.code === "WALLET_CHECK_WARNINGS" && withWarnings.body.error.hashscanUrl === undefined, JSON.stringify(withWarnings.body).slice(0, 200));
    const confirmed = await json("/kyc/kyc-route/approve", { method: "POST", headers: auth, body: JSON.stringify({ confirmWarnings: true }) });
    check("with confirmWarnings it is approved", confirmed.status === 200 && confirmed.body.request.status === "approved");
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
setTimeout(() => process.exit(failures ? 1 : 0), 200);

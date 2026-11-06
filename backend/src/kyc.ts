import { randomUUID } from "node:crypto";
import { addToAllowlist, isAllowlisted } from "./ats/bond.js";
import { hashscan } from "./config.js";
import { ApiError } from "./errors.js";
import { getAccount } from "./hedera/mirror.js";
import { audit, save, state } from "./store.js";
import type { Invoice, KycRequest, Link } from "./types.js";
import { checkWallet, mirrorWalletReader, type WalletReader } from "./walletCheck.js";

export interface AllowlistResult {
  invoiceId: string;
  symbol: string;
  tokenId: string;
  ok: boolean;
  alreadyListed?: boolean;
  reason?: string;
  hashscanUrl: string;
  txId?: string;
}

/** Bonds that can still gain holders: tokenized, not archived, and with no repayment started. */
export const liveInvoices = (): Invoice[] =>
  Object.values(state.invoices).filter((invoice) => !invoice.archived && invoice.tokenization?.status === "complete" && invoice.tokenization.bond && !invoice.repayment && invoice.status !== "repaid");

export function getKyc(id: string): KycRequest {
  const request = state.kyc[id];
  if (!request) throw new ApiError(404, "KYC_NOT_FOUND", `KYC request ${id} not found`);
  return request;
}

export async function submitKyc(input: { fullName: string; walletAddress: string; country: string }) {
  const existing = Object.values(state.kyc).find((request) => request.walletAddress === input.walletAddress && request.status !== "rejected");
  if (existing) return { request: existing, created: false };

  const account = await getAccount(input.walletAddress);
  if (!account || account.deleted) throw new ApiError(422, "WALLET_NOT_FOUND", `Account ${input.walletAddress} was not found on testnet`);

  const request: KycRequest = {
    id: `kyc-${randomUUID().slice(0, 8)}`,
    ...input,
    status: "pending",
    submittedAt: new Date().toISOString(),
    hashscanUrl: hashscan.account(input.walletAddress),
    pendingBonds: [],
  };
  state.kyc[request.id] = request;
  save();
  await ensureWalletCheck(request);
  // Personal details stay off-chain and out of the audit text: only the wallet is named.
  audit({ type: "kyc_submit", description: `KYC submitted for ${input.walletAddress}`, actor: input.walletAddress, hashscanUrl: request.hashscanUrl });
  return { request, created: true };
}

let walletReader: WalletReader = mirrorWalletReader;
/** Test-only: swaps where the wallet check reads the chain. */
export const useWalletReader = (reader: WalletReader) => {
  walletReader = reader;
};

/** An unavailable result is tried again, but not more than once a minute. */
const RETRY_UNAVAILABLE_MS = 60_000;

/** Runs the wallet check if this request has no usable result yet, and saves it. Never throws. */
export async function ensureWalletCheck(request: KycRequest): Promise<KycRequest["walletCheck"]> {
  const stale = request as KycRequest & { walletScan?: unknown; walletScanNote?: unknown };
  const had = request.walletCheck;
  const usable = had && (had.status !== "unavailable" || Date.now() - Date.parse(had.checkedAt) < RETRY_UNAVAILABLE_MS);
  // Requests saved before the check existed carry two placeholder fields. They are dropped, not shown.
  const hadStale = "walletScan" in stale || "walletScanNote" in stale;
  if (hadStale) {
    delete stale.walletScan;
    delete stale.walletScanNote;
  }
  if (usable) {
    if (hadStale) save();
    return had;
  }
  request.walletCheck = await checkWallet(request.walletAddress, walletReader);
  save();
  return request.walletCheck;
}

/** Adds a wallet to one bond's allowlist. A failure, such as a paused bond, is reported rather than thrown. */
async function allowlistOnBond(request: KycRequest, invoice: Invoice): Promise<AllowlistResult> {
  const bond = invoice.tokenization?.bond;
  if (!bond) throw new Error(`${invoice.id} has no bond`);
  const base = { invoiceId: invoice.id, symbol: bond.symbol, tokenId: bond.contractId };
  const account = await getAccount(request.walletAddress);
  if (!account) return { ...base, ok: false, reason: "wallet not found", hashscanUrl: hashscan.contract(bond.contractId) };

  if (await isAllowlisted(bond, account.evm_address)) return { ...base, ok: true, alreadyListed: true, hashscanUrl: hashscan.contract(bond.contractId) };

  const call = await addToAllowlist(bond, account.evm_address, `${bond.symbol}:allowlist:${request.walletAddress}`);
  const url = call.record.hashscanUrl ?? hashscan.contract(bond.contractId);
  if (call.revert || !call.record.succeeded) {
    return { ...base, ok: false, reason: call.revert?.text ?? call.record.result ?? "unknown", hashscanUrl: url, txId: call.record.transactionId };
  }
  return { ...base, ok: true, hashscanUrl: url, txId: call.record.transactionId };
}

/**
 * Approval works with wallet warnings, but only when the caller confirms them. A check that could not run
 * counts the same way, because "unknown" is not "clean".
 */
export async function approveKyc(id: string, options: { confirmWarnings?: boolean } = {}) {
  const request = getKyc(id);
  if (request.status === "rejected") throw new ApiError(409, "KYC_REJECTED", `KYC request ${id} was rejected`, { hashscanUrl: request.hashscanUrl });
  const check = await ensureWalletCheck(request);
  const concerns = check?.status === "warnings" ? check.warnings.map((warning) => warning.message) : check?.status === "unavailable" ? [check.note ?? "The wallet check could not run"] : [];
  if (concerns.length > 0 && !options.confirmWarnings && request.status !== "approved") {
    throw new ApiError(409, "WALLET_CHECK_WARNINGS", `The wallet check for ${request.walletAddress} found ${concerns.length === 1 ? "1 warning" : `${concerns.length} warnings`}: ${concerns.join("; ")}. Send confirmWarnings: true to approve anyway`, { warnings: concerns, walletCheck: check });
  }

  request.status = "approved";
  save();

  const results: AllowlistResult[] = [];
  for (const invoice of liveInvoices()) results.push(await allowlistOnBond(request, invoice));
  request.pendingBonds = results.filter((result) => !result.ok).map((result) => result.tokenId);
  const firstTx = results.find((result) => result.txId);
  if (firstTx) request.hashscanUrl = firstTx.hashscanUrl;
  save();

  audit({ type: "kyc_approve", description: `${request.walletAddress} approved and added to ${results.filter((result) => result.ok).length} of ${results.length} live bonds${concerns.length > 0 ? `, with ${concerns.length} wallet-check ${concerns.length === 1 ? "warning" : "warnings"} confirmed` : ""}`, actor: "admin", hashscanUrl: request.hashscanUrl, ...(firstTx?.txId ? { txId: firstTx.txId } : {}) });

  const links: Link[] = [
    { label: "Wallet", url: hashscan.account(request.walletAddress) },
    ...results.map((result) => ({ label: `Allowlist on ${result.symbol}`, url: result.hashscanUrl, ...(result.txId ? { txId: result.txId } : {}) })),
  ];
  return { request, results, links, tx: { hashscanUrl: request.hashscanUrl, txId: firstTx?.txId ?? "" } };
}

/** Off-chain, so it spends no HBAR. An approved wallet is refused, because rejecting it wouldn't take it off any allowlist. */
export function rejectKyc(id: string) {
  const request = getKyc(id);
  if (request.status === "approved") throw new ApiError(409, "KYC_ALREADY_APPROVED", `KYC request ${id} is already approved, and the wallet may be on bond allowlists`, { hashscanUrl: request.hashscanUrl });
  if (request.status !== "rejected") {
    request.status = "rejected";
    save();
    audit({ type: "kyc_reject", description: `KYC rejected for ${request.walletAddress}`, actor: "admin", hashscanUrl: request.hashscanUrl });
  }
  return { request, links: [{ label: "Wallet", url: hashscan.account(request.walletAddress) }], tx: { hashscanUrl: request.hashscanUrl, txId: "" } };
}

/** Retries wallets a paused bond refused earlier. Called after unpausing. */
export async function syncPendingAllowlists(invoice: Invoice): Promise<AllowlistResult[]> {
  const tokenId = invoice.tokenization?.bond?.contractId;
  if (!tokenId) return [];
  const results: AllowlistResult[] = [];
  for (const request of Object.values(state.kyc)) {
    if (request.status === "approved" && request.pendingBonds.includes(tokenId)) {
      const result = await allowlistOnBond(request, invoice);
      results.push(result);
      if (result.ok) request.pendingBonds = request.pendingBonds.filter((pending) => pending !== tokenId);
    }
  }
  save();
  return results;
}

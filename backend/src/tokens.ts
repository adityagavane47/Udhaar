import { randomUUID } from "node:crypto";
import { expectRead, freezeUnits, isPaused, pauseBond, read, unfreezeUnits, unpauseBond, type BondCall } from "./ats/bond.js";
import { hashscan } from "./config.js";
import { ApiError } from "./errors.js";
import { getAccount, waitForMirrorToReach } from "./hedera/mirror.js";
import { accountName, hasDemoMaturity, holdersOf } from "./invoices.js";
import { syncPendingAllowlists } from "./kyc.js";
import { audit, save, state } from "./store.js";
import type { AuditType, BondRef, Invoice } from "./types.js";

function invoiceForToken(tokenId: string): { invoice: Invoice; bond: BondRef } {
  const invoice = Object.values(state.invoices).find((candidate) => candidate.tokenization?.bond?.contractId === tokenId || candidate.tokenization?.bond?.symbol === tokenId);
  const bond = invoice?.tokenization?.bond;
  if (!invoice || !bond) throw new ApiError(404, "TOKEN_NOT_FOUND", `Token ${tokenId} not found`);
  return { invoice, bond };
}

/** Records a control action, and turns a revert into a clean error that still links the failed transaction. */
function finishControl(call: BondCall, invoice: Invoice, bond: BondRef, type: AuditType, description: string, revertCodes: Record<string, { status: number; code: string; message: string }>) {
  const url = call.record.hashscanUrl ?? hashscan.contract(bond.contractId);
  const link = { label: description, url, txId: call.record.transactionId };
  if (call.revert || !call.record.succeeded) {
    audit({ type, description: `${description}: rejected, ${call.revert?.text ?? call.record.result}`, actor: "admin", hashscanUrl: url, txId: call.record.transactionId, invoiceId: invoice.id, status: "rejected" });
    const mapped = call.revert ? revertCodes[call.revert.name] : undefined;
    throw new ApiError(mapped?.status ?? 422, mapped?.code ?? "CONTROL_REJECTED", mapped?.message ?? `${description} was rejected: ${call.revert?.text ?? call.record.result}`, { hashscanUrl: url, txId: call.record.transactionId, links: [link, { label: "Bond", url: hashscan.contract(bond.contractId) }] });
  }
  invoice.links.push(link);
  invoice.hashscanUrl = url;
  save();
  audit({ type, description, actor: "admin", hashscanUrl: url, txId: call.record.transactionId, invoiceId: invoice.id });
  return { tx: { hashscanUrl: url, txId: call.record.transactionId }, links: [link, { label: "Bond", url: hashscan.contract(bond.contractId) }] };
}

export async function pauseToken(tokenId: string) {
  const { invoice, bond } = invoiceForToken(tokenId);
  const call = await pauseBond(bond, `${bond.symbol}:pause:${randomUUID()}`);
  const result = finishControl(call, invoice, bond, "token_pause", `Paused ${bond.symbol}`, { IsPaused: { status: 409, code: "ALREADY_PAUSED", message: `${bond.symbol} is already paused` } });
  await expectRead(bond, "paused()", [], true);
  return { tokenId: bond.contractId, paused: true, ...result };
}

export async function unpauseToken(tokenId: string) {
  const { invoice, bond } = invoiceForToken(tokenId);
  const call = await unpauseBond(bond, `${bond.symbol}:unpause:${randomUUID()}`);
  const result = finishControl(call, invoice, bond, "token_unpause", `Unpaused ${bond.symbol}`, { IsUnpaused: { status: 409, code: "NOT_PAUSED", message: `${bond.symbol} is not paused` } });
  await expectRead(bond, "paused()", [], false);
  const allowlistRetries = await syncPendingAllowlists(invoice);
  return { tokenId: bond.contractId, paused: false, allowlistRetries, ...result };
}

async function holderEvm(accountId: string) {
  const account = await getAccount(accountId);
  if (!account) throw new ApiError(422, "ACCOUNT_NOT_FOUND", `Account ${accountId} was not found`);
  return account.evm_address;
}

/** Freezes the given units, or everything the holder can move if `units` is left out. */
export async function freezeHolder(tokenId: string, input: { accountId: string; units?: number | undefined }) {
  const { invoice, bond } = invoiceForToken(tokenId);
  const evm = await holderEvm(input.accountId);
  await waitForMirrorToReach();
  const free = await read<bigint>(bond, "balanceOf(address)", [evm]);
  const frozenBefore = await read<bigint>(bond, "getFrozenTokens(address)", [evm]);
  const units = input.units !== undefined ? BigInt(input.units) : free;
  if (units === 0n) throw new ApiError(409, "NOTHING_TO_FREEZE", `${input.accountId} has no units to freeze`, { hashscanUrl: hashscan.contract(bond.contractId) });
  if (units > free) throw new ApiError(409, "INSUFFICIENT_UNITS", `${input.accountId} has ${free} units that can be frozen`, { hashscanUrl: hashscan.contract(bond.contractId) });

  const call = await freezeUnits(bond, evm, units, `${bond.symbol}:freeze:${randomUUID()}`);
  const result = finishControl(call, invoice, bond, "holder_freeze", `Froze ${units} units of ${accountName(input.accountId)} on ${bond.symbol}`, { IsPaused: { status: 409, code: "BOND_PAUSED", message: `${bond.symbol} is paused` } });
  await expectRead(bond, "getFrozenTokens(address)", [evm], frozenBefore + units);
  return { tokenId: bond.contractId, accountId: input.accountId, frozen: true, frozenUnits: Number(frozenBefore + units), freeUnits: Number(free - units), ...result };
}

/** Unfreezes the given units, or everything frozen if `units` is left out. */
export async function unfreezeHolder(tokenId: string, input: { accountId: string; units?: number | undefined }) {
  const { invoice, bond } = invoiceForToken(tokenId);
  const evm = await holderEvm(input.accountId);
  await waitForMirrorToReach();
  const frozenBefore = await read<bigint>(bond, "getFrozenTokens(address)", [evm]);
  const free = await read<bigint>(bond, "balanceOf(address)", [evm]);
  const units = input.units !== undefined ? BigInt(input.units) : frozenBefore;
  if (units === 0n || units > frozenBefore) throw new ApiError(409, "NOTHING_TO_UNFREEZE", `${input.accountId} has ${frozenBefore} frozen units`, { hashscanUrl: hashscan.contract(bond.contractId) });

  const call = await unfreezeUnits(bond, evm, units, `${bond.symbol}:unfreeze:${randomUUID()}`);
  const result = finishControl(call, invoice, bond, "holder_unfreeze", `Unfroze ${units} units of ${accountName(input.accountId)} on ${bond.symbol}`, { IsPaused: { status: 409, code: "BOND_PAUSED", message: `${bond.symbol} is paused` } });
  await expectRead(bond, "getFrozenTokens(address)", [evm], frozenBefore - units);
  return { tokenId: bond.contractId, accountId: input.accountId, frozen: frozenBefore - units > 0n, frozenUnits: Number(frozenBefore - units), freeUnits: Number(free + units), ...result };
}

export async function listTokens() {
  const tokens = [];
  for (const invoice of Object.values(state.invoices)) {
    const plan = invoice.tokenization;
    const bond = plan?.bond;
    if (!plan || !bond || plan.status !== "complete") continue;
    tokens.push({
      tokenId: bond.contractId,
      symbol: bond.symbol,
      invoiceId: invoice.id,
      buyerName: invoice.buyerName,
      totalUnits: plan.units,
      unitFaceValue: plan.unitFaceValue,
      maturityDate: new Date(plan.maturityDateUnix * 1000).toISOString(),
      ...(hasDemoMaturity(invoice) ? { demoMaturity: true } : {}),
      paused: await isPaused(bond),
      holders: (await holdersOf(invoice.id)).holders,
      hashscanUrl: hashscan.contract(bond.contractId),
    });
  }
  return tokens;
}


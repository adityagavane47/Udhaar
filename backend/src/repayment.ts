import { crashPoint, fromBaseUnits, hashscan, toBaseUnits, config } from "./config.js";
import { ApiError } from "./errors.js";
import { burnedUnits, holderPositions, read, redeemAtMaturity, simulateRedeem, type Position } from "./ats/bond.js";
import { getParty, getSigner, knownAccountName, ROLES, type Party } from "./hedera/client.js";
import { getAccount, poll, waitForMirrorToReach } from "./hedera/mirror.js";
import { audit, save, state } from "./store.js";
import type { BondRef, Invoice, Link, Repayment, RepaymentHolder } from "./types.js";
import { canReceiveUinr, findTransfersInto, movedAmount, sendUinrOnce } from "./uinr.js";

const payoutMemo = (symbol: string) => `${symbol} payout`;

const holderName = (accountId: string) => {
  const known = knownAccountName(accountId);
  return known ? ROLES[known] : accountId;
};

/** Stops the repayment for a person to look at. Nothing more is burned or paid until then. */
function needsReview(invoice: Invoice, repayment: Repayment, reason: string): ApiError {
  repayment.status = "needs_review";
  repayment.reviewReason = reason;
  save();
  return new ApiError(409, "REPAYMENT_NEEDS_REVIEW", reason, { links: invoice.links, ...(invoice.hashscanUrl ? { hashscanUrl: invoice.hashscanUrl } : {}) });
}

/**
 * Every check that could strand a holder. With burn-first, a holder whose payout fails has nothing
 * left but the promise, so all of this must hold before the buyer pays or anything burns.
 */
async function preflight(invoice: Invoice, bond: BondRef, positions: Position[], repaymentAccount: Party) {
  const unitFace = invoice.unitFaceValue ?? config.defaultUnitFaceValue;
  const owedBase = positions.reduce((sum, position) => sum + toBaseUnits(Number(position.units) * unitFace), 0);
  const supply = await read<bigint>(bond, "totalSupply()");
  const supplyHeld = positions.reduce((sum, position) => sum + position.units, 0n);
  if (supplyHeld !== supply) throw new ApiError(409, "HOLDERS_DO_NOT_MATCH_SUPPLY", `Holders have ${supplyHeld} units but supply is ${supply}: some may be locked or held`);
  if (owedBase !== toBaseUnits(invoice.amount)) {
    throw new ApiError(409, "AMOUNT_MISMATCH", `Holders are owed ${fromBaseUnits(owedBase)} uINR but the invoice amount is ${invoice.amount}`);
  }
  for (const position of positions) {
    if (position.frozen > 0n) throw new ApiError(409, "HOLDER_FROZEN", `${position.accountId} has ${position.frozen} frozen units: unfreeze before repaying`);
    const receivable = await canReceiveUinr(position.accountId);
    if (!receivable.ok) throw new ApiError(409, "HOLDER_CANNOT_RECEIVE_UINR", `${position.accountId} cannot receive uINR: ${receivable.reason}`);
    const canBurn = await simulateRedeem(bond, position.evm);
    if (!canBurn.ok) throw new ApiError(409, "BURN_WOULD_FAIL", `Burning ${position.accountId}'s units would fail: ${canBurn.revert.text}`);
  }
  const account = await getAccount(repaymentAccount.id);
  const neededHbar = positions.length * config.payoutHbarReserve;
  const heldHbar = (account?.balance.balance ?? 0) / 1e8;
  if (heldHbar < neededHbar) throw new ApiError(409, "REPAYMENT_NEEDS_HBAR", `REPAYMENT holds ${heldHbar} HBAR but ${positions.length} payouts need about ${neededHbar}`);
}

const collectLinks = (invoice: Invoice, repayment: Repayment): Link[] => {
  const links: Link[] = [];
  if (repayment.detected) links.push({ label: "Buyer repayment", url: repayment.detected.hashscanUrl, txId: repayment.detected.transactionId });
  for (const holder of repayment.holders ?? []) {
    if (holder.burnHashscanUrl) links.push({ label: `Burn ${holder.units} units of ${holder.name}`, url: holder.burnHashscanUrl, ...(holder.burnTxId ? { txId: holder.burnTxId } : {}) });
    if (holder.paymentHashscanUrl) links.push({ label: `Pay ${holder.name}`, url: holder.paymentHashscanUrl, ...(holder.paymentTxId ? { txId: holder.paymentTxId } : {}) });
  }
  if (invoice.tokenization?.bond) links.push({ label: "Bond", url: hashscan.contract(invoice.tokenization.bond.contractId) });
  return links;
};

/**
 * Buyer pays REPAYMENT, the holder snapshot is saved, then each holder is burned and paid.
 *
 * Why this cannot pay twice:
 *  - Payment is per holder per bond, under one ledger key and one on-chain memo.
 *  - The saved snapshot fixes who is owed what. A rerun never re-derives it.
 *  - sendUinrOnce resolves any saved intent, then searches the chain for that memo.
 *
 * Why a burned holder cannot be lost:
 *  - preflight() proves the payout can land before anything burns.
 *  - The chain's burn log must match the snapshot before paying, and a rerun resumes from there.
 */
export async function repayInvoice(invoice: Invoice): Promise<{ repayment: Repayment; links: Link[] }> {
  const tokenization = invoice.tokenization;
  const bond = tokenization?.bond;
  if (!tokenization || tokenization.status !== "complete" || !bond) throw new ApiError(409, "NOT_TOKENIZED", `${invoice.id} has not been tokenized`);

  if (invoice.repayment?.status === "complete") return { repayment: invoice.repayment, links: collectLinks(invoice, invoice.repayment) };
  if (invoice.repayment?.status === "needs_review") {
    throw new ApiError(409, "REPAYMENT_NEEDS_REVIEW", invoice.repayment.reviewReason ?? "Review required", { links: invoice.links });
  }
  if (Date.now() / 1000 < tokenization.maturityDateUnix) {
    throw new ApiError(409, "NOT_MATURED", `${tokenization.symbol} matures at ${new Date(tokenization.maturityDateUnix * 1000).toISOString()}`, { maturityDate: new Date(tokenization.maturityDateUnix * 1000).toISOString(), hashscanUrl: hashscan.contract(bond.contractId) });
  }

  const buyer = await getSigner(invoice.buyerId);
  const repaymentAccount = await getParty("REPAYMENT");
  const symbol = bond.symbol;
  const amountBase = toBaseUnits(invoice.amount);

  const repayment: Repayment = invoice.repayment ?? { status: "in_progress" };

  if (!repayment.holders) {
    // An investor who has paid but not yet received units would be missing from the snapshot.
    const unfinished = Object.values(state.purchases).find((purchase) => purchase.invoiceId === invoice.id && purchase.status !== "complete");
    if (unfinished) throw new ApiError(409, "PURCHASE_PENDING", `Purchase ${unfinished.id} is unfinished: retry POST /invoices/${invoice.id}/buy first`, { purchaseId: unfinished.id, hashscanUrl: hashscan.contract(bond.contractId) });

    await waitForMirrorToReach();
    if (await read<boolean>(bond, "paused()")) throw new ApiError(409, "BOND_PAUSED", `${symbol} is paused: unpause before repaying`, { hashscanUrl: hashscan.contract(bond.contractId) });
    await preflight(invoice, bond, await holderPositions(bond), repaymentAccount);

    // Only now does the repayment count as started. Failed checks leave the invoice fully usable.
    invoice.repayment = repayment;
    save();

    const payment = await sendUinrOnce({ key: `${symbol}:repayment`, from: buyer, toId: repaymentAccount.id, amountBaseUnits: amountBase, memo: symbol });
    if (!payment.replayed) {
      audit({ type: "buyer_payment", description: `${invoice.buyerName} paid ${invoice.amount} uINR to REPAYMENT for ${invoice.id}`, actor: buyer.name, hashscanUrl: payment.hashscanUrl ?? "", txId: payment.transactionId, invoiceId: invoice.id });
    }

    const detected = await poll("the repayment on the mirror node", async () => {
      const matches = await findTransfersInto(repaymentAccount.id, symbol);
      return matches.find((transaction) => transaction.transaction_id.startsWith(`${buyer.id}-`) && movedAmount(transaction, buyer.id) === -amountBase && movedAmount(transaction, repaymentAccount.id) === amountBase);
    });
    repayment.detected = { transactionId: detected.transaction_id, hashscanUrl: hashscan.transaction(detected.consensus_timestamp), from: buyer.id, memo: symbol, amountBaseUnits: amountBase };
    save();

    // Saved before the first burn. From here on this snapshot, not the chain, decides who is owed.
    await waitForMirrorToReach();
    const positions = await holderPositions(bond);
    await preflight(invoice, bond, positions, repaymentAccount);
    const unitFace = invoice.unitFaceValue ?? config.defaultUnitFaceValue;
    repayment.holders = positions.map((position): RepaymentHolder => ({
      name: holderName(position.accountId),
      evm: position.evm,
      accountId: position.accountId,
      units: Number(position.units),
      amountBaseUnits: toBaseUnits(Number(position.units) * unitFace),
      burned: false,
      paid: false,
    }));
    save();
  }

  const holders = repayment.holders;
  if (!holders) throw new Error("Holder snapshot is missing");

  await waitForMirrorToReach();

  for (const holder of holders) {
    if (!holder.burned) {
      const key = `${symbol}:burn:${holder.accountId}`;
      const expected = BigInt(holder.units);
      const units = await read<bigint>(bond, "balanceOf(address)", [holder.evm]);
      const earlier = await burnedUnits(bond, holder.evm);
      const untouched = units === expected && earlier.total === 0n;
      const alreadyBurned = units === 0n && earlier.total === expected;
      const entry = state.ledger[key];
      if (!untouched && !alreadyBurned && !entry) {
        throw needsReview(invoice, repayment, `${holder.name} holds ${units} units with ${earlier.total} burned, but the snapshot says ${holder.units}`);
      }

      if (alreadyBurned && !entry) {
        // The record of this burn was lost, but the chain proves it happened, so it is not sent again.
        if (earlier.lastTimestamp) holder.burnHashscanUrl = hashscan.transaction(earlier.lastTimestamp);
      } else {
        const burn = await redeemAtMaturity(bond, holder.evm, key, "burn-sent");
        if (burn.revert || !burn.record.succeeded) {
          throw new ApiError(502, "BURN_FAILED", `Burn for ${holder.name} failed: ${burn.revert?.text ?? burn.record.result}. No payment was made; retry this route.`, {
            ...(burn.record.hashscanUrl ? { hashscanUrl: burn.record.hashscanUrl } : {}),
            links: collectLinks(invoice, repayment),
          });
        }
        holder.burnTxId = burn.record.transactionId;
        if (burn.record.hashscanUrl) holder.burnHashscanUrl = burn.record.hashscanUrl;
      }

      // The chain, not the record, must agree on what was burned before any money moves.
      const onChain = await poll(`the burn log for ${holder.name}`, async () => {
        const logged = await burnedUnits(bond, holder.evm);
        return logged.total > 0n ? logged.total : undefined;
      });
      if (onChain !== expected) throw needsReview(invoice, repayment, `${holder.name} burned ${onChain} units but the snapshot says ${holder.units}: not paid`);

      holder.burned = true;
      save();
      audit({
        type: "units_burn",
        description: `Burned ${holder.units} units of ${symbol} held by ${holder.name}`,
        actor: "admin",
        ...(holder.burnHashscanUrl ? { hashscanUrl: holder.burnHashscanUrl } : {}),
        ...(holder.burnTxId ? { txId: holder.burnTxId } : {}),
        invoiceId: invoice.id,
      });
      crashPoint("burned-recorded");
    }

    if (!holder.paid) {
      const payment = await sendUinrOnce({
        key: `${symbol}:payout:${holder.accountId}`,
        from: repaymentAccount,
        toId: holder.accountId,
        amountBaseUnits: holder.amountBaseUnits,
        memo: payoutMemo(symbol),
        crashAfterSend: "payout-sent",
      });
      holder.paid = true;
      holder.paymentTxId = payment.transactionId;
      if (payment.hashscanUrl) holder.paymentHashscanUrl = payment.hashscanUrl;
      save();
      audit({ type: "holder_payout", description: `Paid ${fromBaseUnits(holder.amountBaseUnits)} uINR to ${holder.name} for ${holder.units} units of ${symbol}`, actor: "REPAYMENT", ...(payment.hashscanUrl ? { hashscanUrl: payment.hashscanUrl } : {}), txId: payment.transactionId, invoiceId: invoice.id });
    }
  }

  await poll("bond supply to reach zero", async () => ((await read<bigint>(bond, "totalSupply()")) === 0n ? true : undefined), 15).catch(() => {
    throw needsReview(invoice, repayment, `${symbol} still has units after every snapshot holder was burned`);
  });

  repayment.status = "complete";
  invoice.status = "repaid";
  invoice.retainedUnits = 0;
  const links = collectLinks(invoice, repayment);
  const last = links.at(-2);
  if (last) invoice.hashscanUrl = last.url;
  invoice.links.push(...links.filter((link) => !invoice.links.some((existing) => existing.url === link.url)));
  save();
  return { repayment, links };
}

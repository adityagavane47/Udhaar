import { createHash, randomUUID } from "node:crypto";
import { addToAllowlist, buildBondSymbol, buildDemoIsin, deployBond, expectRead, holderPositions, issueUnits, read, simulateTransfer, transferUnits, type Revert } from "./ats/bond.js";
import { config, fromBaseUnits, hashscan, toBaseUnits, uinrFeeBaseUnits } from "./config.js";
import { ApiError } from "./errors.js";
import { ensureTopics, findFingerprint, signMessage, submitMessage } from "./hcs.js";
import { getParty, getSigner, knownAccountName, ROLES } from "./hedera/client.js";
import { getAccount, waitForMirrorToReach } from "./hedera/mirror.js";
import { discountedUnitPrice } from "./risk/scorecard.js";
import { assessForTokenizing, isSeededInvoiceId } from "./risk/service.js";
import { checkNewInvoice } from "./trust/service.js";
import { audit, save, state } from "./store.js";
import { ensureRepaymentSchedule } from "./schedule.js";
import type { Invoice, Link, Purchase } from "./types.js";
import { sendUinrOnce, uinrBalance } from "./uinr.js";

export interface CreateInvoiceInput {
  supplierId: string;
  buyerId: string;
  supplierName?: string | undefined;
  buyerName?: string | undefined;
  amount: number;
  dueDate: string;
  issueDate?: string | undefined;
  invoiceNumber?: string | undefined;
  pdfName?: string | undefined;
  /** The signed QR from the (mock) IRP. Optional. If sent, it must verify and match every field. */
  signedQr?: string | undefined;
}

export interface TokenizeInput {
  /** Demo only. Needs DEMO_SHORT_MATURITY_MINUTES: matures that many minutes from now. */
  demoMaturity?: boolean | undefined;
  maturityMinutes?: number | undefined;
  maturityDate?: string | undefined;
  unitFaceValue?: number | undefined;
}

export const accountName = (accountId: string) => {
  const known = knownAccountName(accountId);
  if (known) return ROLES[known];
  const kyc = Object.values(state.kyc).find((request) => request.walletAddress === accountId);
  return kyc?.fullName ?? accountId;
};

export function getInvoice(id: string): Invoice {
  const invoice = state.invoices[id];
  if (invoice) return invoice;
  if (isSeededInvoiceId(id)) throw new ApiError(409, "SEEDED_INVOICE", `${id} is simulated demo data, so it can be viewed and scored but nothing can be done with it`);
  throw new ApiError(404, "INVOICE_NOT_FOUND", `Invoice ${id} not found`);
}

export const unitPrice = (invoice: Invoice) => discountedUnitPrice(invoice.unitFaceValue ?? config.defaultUnitFaceValue, invoice.discountPct ?? 0);

/** True when the bond matures well before the invoice is due, which only demos do. Worked out from what is stored, so no bond escapes the label. */
export const hasDemoMaturity = (invoice: Invoice) => {
  const maturity = invoice.tokenization?.maturityDateUnix;
  return maturity !== undefined && maturity * 1000 < Date.parse(invoice.dueDate) - 3_600_000;
};

export const invoiceView = (invoice: Invoice) => ({
  ...invoice,
  ...(hasDemoMaturity(invoice) ? { demoMaturity: true } : {}),
  hashscanUrl: invoice.hashscanUrl ?? hashscan.account(invoice.supplierId),
  ...(invoice.tokenId ? { unitPrice: unitPrice(invoice), availableUnits: invoice.retainedUnits ?? 0 } : {}),
});

function addLink(invoice: Invoice, link: Link) {
  invoice.links.push(link);
  invoice.hashscanUrl = link.url;
  save();
}

/** Covers what identifies an invoice, and leaves out IDs, timestamps and the PDF name, so a re-upload matches. */
function fingerprintOf(input: CreateInvoiceInput): string {
  const canonical = JSON.stringify({
    supplierId: input.supplierId,
    buyerId: input.buyerId,
    amount: input.amount,
    dueDate: new Date(input.dueDate).toISOString().slice(0, 10),
    invoiceNumber: input.invoiceNumber?.trim().toLowerCase() ?? "",
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function duplicateError(originalId: string, url: string, fingerprint: string, actor: string) {
  audit({ type: "duplicate_rejected", description: `Duplicate of ${originalId} rejected`, actor, hashscanUrl: url, invoiceId: originalId, status: "rejected" });
  return new ApiError(409, "DUPLICATE_INVOICE", `This invoice is already registered as ${originalId}`, { originalId, fingerprint, hashscanUrl: url, links: [{ label: "Original HCS registration", url }] });
}

export async function createInvoice(input: CreateInvoiceInput) {
  if (input.buyerId === input.supplierId) throw new ApiError(422, "SAME_PARTY", "Supplier and buyer must be different accounts");
  await getSigner(input.buyerId);
  await getSigner(input.supplierId);

  // Trust limits and the e-invoice check come first, so a refusal costs nothing and writes nothing.
  const eInvoice = await checkNewInvoice(input);

  const fingerprint = fingerprintOf(input);
  const topics = await ensureTopics();

  let invoice = Object.values(state.invoices).find((candidate) => candidate.fingerprint === fingerprint);
  if (invoice?.registered) throw duplicateError(invoice.id, invoice.links[0]?.url ?? hashscan.topic(topics.registryTopicId), fingerprint, accountName(input.supplierId));

  // The chain is the authority, so a lost local store still cannot allow double financing.
  const onChain = await findFingerprint(fingerprint);
  if (onChain && onChain.invoiceId !== invoice?.id) throw duplicateError(onChain.invoiceId, onChain.hashscanUrl, fingerprint, accountName(input.supplierId));

  if (!invoice) {
    const id = `INV-${String(state.nextInvoiceNumber).padStart(4, "0")}`;
    state.nextInvoiceNumber += 1;
    invoice = {
      id,
      supplierId: input.supplierId,
      supplierName: input.supplierName ?? accountName(input.supplierId),
      buyerId: input.buyerId,
      buyerName: input.buyerName ?? accountName(input.buyerId),
      amount: input.amount,
      issueDate: input.issueDate ? new Date(input.issueDate).toISOString() : new Date().toISOString(),
      dueDate: new Date(input.dueDate).toISOString(),
      status: "submitted",
      ...(input.invoiceNumber ? { invoiceNumber: input.invoiceNumber } : {}),
      ...(input.pdfName ? { pdfName: input.pdfName } : {}),
      ...(eInvoice ? { signedQr: eInvoice.signedQr, eInvoice: { source: "mock" as const, irn: eInvoice.irn, verifiedAt: new Date().toISOString() } } : {}),
      fingerprint,
      registered: false,
      links: [],
      amountPaidBy: {},
    };
    state.invoices[id] = invoice;
    save();
  }

  // Only the hash and our own ID go on-chain: no names, amounts or other business data.
  const admin = await getParty("ADMIN");
  const message = JSON.stringify({ v: 1, type: "invoice.registered", fingerprint, invoiceId: invoice.id });
  const record = await submitMessage(topics.registryTopicId, admin, message, `hcs:register:${fingerprint}`);
  invoice.registered = true;
  addLink(invoice, { label: "HCS registration", url: record.hashscanUrl ?? hashscan.topic(topics.registryTopicId), txId: record.transactionId });
  invoice.links.push({ label: "HCS registry topic", url: hashscan.topic(topics.registryTopicId) });
  save();
  audit({ type: "invoice_upload", description: `${invoice.id} fingerprint written to the HCS registry`, actor: invoice.supplierName, ...(record.hashscanUrl ? { hashscanUrl: record.hashscanUrl } : {}), txId: record.transactionId, invoiceId: invoice.id });

  return { invoice: invoiceView(invoice), tx: { hashscanUrl: record.hashscanUrl ?? "", txId: record.transactionId } };
}

export async function confirmInvoice(invoiceId: string) {
  const invoice = getInvoice(invoiceId);
  if (!invoice.registered) throw new ApiError(409, "NOT_REGISTERED", `${invoice.id} is not registered on HCS yet: retry POST /invoices`);
  if (invoice.confirmation) {
    return { invoice: invoiceView(invoice), tx: { hashscanUrl: invoice.confirmation.hashscanUrl, txId: state.ledger[`hcs:confirm:${invoice.id}`]?.transactionId ?? "" } };
  }
  if (invoice.status !== "submitted") throw new ApiError(409, "BAD_STATUS", `${invoice.id} is ${invoice.status}, so it cannot be confirmed`);

  const buyer = await getSigner(invoice.buyerId);
  const topics = await ensureTopics();
  const key = `hcs:confirm:${invoice.id}`;
  const payload = invoice.confirmationPayload ?? JSON.stringify({ v: 1, type: "invoice.confirmed", invoiceId: invoice.id, fingerprint: invoice.fingerprint, buyer: buyer.id, confirmedAt: new Date().toISOString() });
  invoice.confirmationPayload = payload;
  save();

  const signature = signMessage(buyer, payload);
  const envelope = JSON.stringify({ payload, signature, publicKey: buyer.key.publicKey.toStringRaw(), signer: buyer.id });
  const record = await submitMessage(topics.confirmationTopicId, buyer, envelope, key);

  invoice.confirmation = { message: payload, signature, signedBy: buyer.id, hashscanUrl: record.hashscanUrl ?? "" };
  invoice.status = "buyer_confirmed";
  addLink(invoice, { label: "Buyer confirmation", url: record.hashscanUrl ?? hashscan.topic(topics.confirmationTopicId), txId: record.transactionId });
  audit({ type: "buyer_confirm", description: `${invoice.buyerName} confirmed ${invoice.id}`, actor: buyer.name, ...(record.hashscanUrl ? { hashscanUrl: record.hashscanUrl } : {}), txId: record.transactionId, invoiceId: invoice.id });
  return { invoice: invoiceView(invoice), tx: { hashscanUrl: record.hashscanUrl ?? "", txId: record.transactionId } };
}

/** Grade D stops here, before any plan is saved or HBAR spent. An engine failure is also an error, so nothing is priced without a real score. */
async function riskCheckBeforeTokenizing(invoiceId: string) {
  const risk = await assessForTokenizing(invoiceId);
  if (risk.grade === "D") {
    audit({ type: "risk_blocked", description: `${invoiceId} refused: grade D (${risk.fraudFlags.join(", ") || "score under 50"})`, actor: "risk engine", hashscanUrl: risk.hashscanUrl, invoiceId, status: "rejected" });
    throw new ApiError(409, "RISK_BLOCKED", `${invoiceId} is grade D, so it can't be tokenized`, { grade: risk.grade, riskScore: risk.riskScore, fraudFlags: risk.fraudFlags, reasons: risk.reasons, hashscanUrl: risk.hashscanUrl });
  }
  return risk;
}

export async function tokenizeInvoice(invoiceId: string, input: TokenizeInput) {
  if (input.demoMaturity) {
    if (config.demoShortMaturityMinutes === null) throw new ApiError(422, "DEMO_MATURITY_DISABLED", "Demo maturity is off: set DEMO_SHORT_MATURITY_MINUTES (3 to 1440) on the server and restart it");
    if (input.maturityMinutes !== undefined || input.maturityDate !== undefined) throw new ApiError(422, "MATURITY_CONFLICT", "Send demoMaturity, or maturityMinutes, or maturityDate, not more than one");
  }
  if (isSeededInvoiceId(invoiceId)) await riskCheckBeforeTokenizing(invoiceId);
  const invoice = getInvoice(invoiceId);
  if (invoice.tokenization?.status === "complete") {
    return { invoice: invoiceView(invoice), tx: { hashscanUrl: hashscan.contract(invoice.tokenId ?? ""), txId: state.ledger[`${invoice.symbol}:deploy`]?.transactionId ?? "" }, replayed: true };
  }
  if (!invoice.tokenization && !["buyer_confirmed", "risk_checked"].includes(invoice.status)) {
    throw new ApiError(409, "BAD_STATUS", `${invoice.id} is ${invoice.status}: only buyer-confirmed invoices can be tokenized`);
  }

  // The plan is saved once, so a retry resumes the same bond and cannot deploy a second one.
  if (!invoice.tokenization) {
    const risk = await riskCheckBeforeTokenizing(invoice.id);
    // The discount is worked out from the invoice's due date, so a demo's early maturity can't change it.
    if (risk.suggestedDiscountPct === null) throw new ApiError(422, "BAD_DUE_DATE", `${invoice.id} can't be priced: its due date ${invoice.dueDate} has passed or is too far away`, { hashscanUrl: risk.hashscanUrl });
    const now = new Date();
    const nowUnix = Math.floor(now.getTime() / 1000);
    const maturity = input.demoMaturity && config.demoShortMaturityMinutes !== null ? nowUnix + Math.round(config.demoShortMaturityMinutes * 60) : input.maturityMinutes !== undefined ? nowUnix + Math.round(input.maturityMinutes * 60) : Math.floor(new Date(input.maturityDate ?? invoice.dueDate).getTime() / 1000);
    if (maturity <= nowUnix) throw new ApiError(422, "BAD_MATURITY", "Maturity must be in the future");
    const unitFaceValue = input.unitFaceValue ?? config.defaultUnitFaceValue;
    if (invoice.amount % unitFaceValue !== 0) throw new ApiError(422, "BAD_FACE_VALUE", `Amount ${invoice.amount} does not divide into whole units of ${unitFaceValue}`);
    const symbol = buildBondSymbol(now);
    invoice.tokenization = {
      status: "in_progress",
      symbol,
      isin: buildDemoIsin(nowUnix),
      name: `Udhaar demo invoice ${invoice.id}`,
      units: invoice.amount / unitFaceValue,
      unitFaceValue,
      discountPct: risk.suggestedDiscountPct,
      startingDateUnix: nowUnix + 60,
      maturityDateUnix: Math.max(maturity, nowUnix + 60),
    };
    invoice.grade = risk.grade;
    invoice.gradedAt = risk.scoredAt;
    save();
  }

  const plan = invoice.tokenization;
  const links: Link[] = [];
  const business = await getSigner(invoice.supplierId);

  if (!plan.bond) {
    const { bond, record } = await deployBond(
      { symbol: plan.symbol, name: plan.name, isin: plan.isin, units: plan.units, unitFaceValue: plan.unitFaceValue, currency: "INR", startingDateUnix: plan.startingDateUnix, maturityDateUnix: plan.maturityDateUnix },
      `${plan.symbol}:deploy`,
    );
    plan.bond = bond;
    if (record.consensusTimestamp) plan.deployedAt = record.consensusTimestamp;
    save();
    if (record.hashscanUrl) links.push({ label: "Deploy bond", url: record.hashscanUrl, txId: record.transactionId });
  }
  const bond = plan.bond;
  if (!bond) throw new Error("Bond reference is missing");
  links.push({ label: "Bond", url: hashscan.contract(bond.contractId) });

  await expectRead(bond, "getMaxSupply()", [], BigInt(plan.units));
  await expectRead(bond, "getMaturityDate()", [], BigInt(plan.maturityDateUnix));
  await expectRead(bond, "getNominalValue()", [], BigInt(plan.unitFaceValue));

  const approved = Object.values(state.kyc).filter((request) => request.status === "approved").map((request) => request.walletAddress);
  for (const accountId of [...new Set([business.id, ...approved])]) {
    const account = await getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} was not found`);
    const call = await addToAllowlist(bond, account.evm_address, `${plan.symbol}:allowlist:${accountId}`);
    if (call.revert || !call.record.succeeded) throw new Error(`Allowlisting ${accountId} failed: ${call.revert?.text ?? call.record.result} (${call.record.hashscanUrl})`);
    if (call.record.hashscanUrl) links.push({ label: `Allowlist ${accountName(accountId)}`, url: call.record.hashscanUrl, txId: call.record.transactionId });
    await expectRead(bond, "isInControlList(address)", [account.evm_address], true);
  }

  const issue = await issueUnits(bond, business.evm, plan.units, `${plan.symbol}:issue`);
  if (issue.revert || !issue.record.succeeded) throw new Error(`Issuing units failed: ${issue.revert?.text ?? issue.record.result} (${issue.record.hashscanUrl})`);
  if (issue.record.hashscanUrl) links.push({ label: `Issue ${plan.units} units to ${business.name}`, url: issue.record.hashscanUrl, txId: issue.record.transactionId });
  await expectRead(bond, "balanceOf(address)", [business.evm], BigInt(plan.units));

  plan.status = "complete";
  invoice.status = "tokenized";
  invoice.tokenId = bond.contractId;
  invoice.symbol = plan.symbol;
  invoice.maturityDate = new Date(plan.maturityDateUnix * 1000).toISOString();
  invoice.totalUnits = plan.units;
  invoice.unitFaceValue = plan.unitFaceValue;
  invoice.retainedUnits = plan.units;
  invoice.discountPct = plan.discountPct;
  invoice.links.push(...links);
  invoice.hashscanUrl = hashscan.contract(bond.contractId);
  save();
  const deploy = state.ledger[`${plan.symbol}:deploy`];
  audit({ type: "token_create", description: `Bond ${bond.contractId} (${plan.symbol}) created for ${invoice.id}: ${plan.units} units of ₹${plan.unitFaceValue}`, actor: "admin", hashscanUrl: hashscan.contract(bond.contractId), ...(deploy ? { txId: deploy.transactionId } : {}), invoiceId: invoice.id });

  // The repayment is scheduled on Hedera now that the maturity is known. If that fails, the watcher tries again and manual repay still works.
  try {
    await ensureRepaymentSchedule(invoice);
  } catch (error) {
    console.error(`Could not schedule the repayment of ${invoice.id}: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  return { invoice: invoiceView(invoice), links, tx: { hashscanUrl: hashscan.contract(bond.contractId), txId: deploy?.transactionId ?? "" }, replayed: false };
}

function liveBond(invoice: Invoice) {
  const bond = invoice.tokenization?.bond;
  if (!bond || invoice.tokenization?.status !== "complete") throw new ApiError(409, "NOT_TOKENIZED", `${invoice.id} has not been tokenized`);
  if (invoice.status === "repaid" || invoice.repayment) throw new ApiError(409, "REPAYMENT_STARTED", `${invoice.id} is being or has been repaid, so its units can no longer move`, { hashscanUrl: hashscan.contract(bond.contractId) });
  return bond;
}

function throwForTransferRevert(revert: Revert, bondUrl: string, investor: string): never {
  const details = { hashscanUrl: bondUrl, reason: revert.text };
  if (revert.name === "AccountIsBlocked") throw new ApiError(422, "NOT_ALLOWLISTED", `The token rejected this: ${investor} is not KYC-approved. No money moved.`, details);
  if (revert.name === "IsPaused") throw new ApiError(409, "BOND_PAUSED", "The token is paused. No money moved.", details);
  if (revert.name === "InsufficientBalance") throw new ApiError(409, "INSUFFICIENT_UNITS", "Not enough transferable units are available. No money moved.", details);
  throw new ApiError(422, "TRANSFER_WOULD_FAIL", `The token would reject this: ${revert.text}. No money moved.`, details);
}

/**
 * Investor pays the business, then the business sends units. These are two transactions and cannot
 * be atomic, so everything that could stop the second is checked before the first. If the second
 * still fails, the purchase stays "paid" and a retry finishes it without charging again.
 */
export async function buyUnits(invoiceId: string, input: { investorId: string; units: number; idempotencyKey?: string | undefined }) {
  const invoice = getInvoice(invoiceId);
  const bond = invoice.tokenization?.bond;
  const investor = await getSigner(input.investorId);

  const key = input.idempotencyKey ? `${invoice.id}:${input.investorId}:${input.idempotencyKey}` : undefined;
  let purchase = (key ? state.purchases[key] : undefined) ??
    Object.values(state.purchases).find((candidate) => candidate.invoiceId === invoice.id && candidate.investorId === input.investorId && candidate.status !== "complete");
  if (purchase && purchase.status !== "complete" && purchase.units !== input.units) {
    throw new ApiError(409, "PURCHASE_IN_PROGRESS", `A purchase of ${purchase.units} units is unfinished. Retry with those units to finish it.`, { purchaseId: purchase.id, hashscanUrl: hashscan.account(input.investorId) });
  }
  if (purchase?.status === "complete") {
    return { purchase, invoice: invoiceView(invoice), tx: { hashscanUrl: purchase.unitsHashscanUrl ?? "", txId: "" }, replayed: true };
  }

  const activeBond = liveBond(invoice);
  if (!bond) throw new Error("Bond reference is missing");
  const bondUrl = hashscan.contract(activeBond.contractId);
  const business = await getSigner(invoice.supplierId);
  const symbol = activeBond.symbol;

  if (!purchase) {
    if (Date.now() / 1000 >= (invoice.tokenization?.maturityDateUnix ?? 0)) throw new ApiError(409, "MATURED", `${symbol} has matured, so it can no longer be bought`, { hashscanUrl: bondUrl });

    await waitForMirrorToReach();
    const canTransfer = await simulateTransfer(activeBond, business.evm, investor.evm, input.units);
    if (!canTransfer.ok) throwForTransferRevert(canTransfer.revert, bondUrl, input.investorId);

    const price = unitPrice(invoice);
    const amountBaseUnits = input.units * toBaseUnits(price);
    const feeBaseUnits = uinrFeeBaseUnits(amountBaseUnits);
    const held = await uinrBalance(investor.id);
    if (held < amountBaseUnits + feeBaseUnits) {
      throw new ApiError(422, "INSUFFICIENT_UINR", `${investor.name} holds ${fromBaseUnits(held)} uINR but needs ${fromBaseUnits(amountBaseUnits + feeBaseUnits)} including the 1% fee`, { hashscanUrl: hashscan.account(investor.id) });
    }
    purchase = { id: randomUUID(), invoiceId: invoice.id, investorId: input.investorId, units: input.units, unitPrice: price, amountBaseUnits, feeBaseUnits, status: "pending" };
    state.purchases[key ?? purchase.id] = purchase;
    save();
  }

  const payment = await sendUinrOnce({
    key: `${symbol}:buy:${purchase.id}:payment`,
    from: investor,
    toId: business.id,
    amountBaseUnits: purchase.amountBaseUnits,
    memo: `${symbol} buy ${purchase.id.slice(0, 8)}`,
    expectedFeeBaseUnits: purchase.feeBaseUnits,
  });
  purchase.status = "paid";
  if (payment.hashscanUrl) purchase.paymentHashscanUrl = payment.hashscanUrl;
  save();

  const units = await transferUnits(activeBond, business, investor.evm, purchase.units, `${symbol}:buy:${purchase.id}:units`);
  if (units.revert || !units.record.succeeded) {
    throw new ApiError(502, "UNITS_PENDING", `The investor paid but the units did not move: ${units.revert?.text ?? units.record.result}. Retry this route to finish; the investor will not be charged again.`, {
      purchaseId: purchase.id,
      ...(units.record.hashscanUrl ? { hashscanUrl: units.record.hashscanUrl } : {}),
      links: [...(payment.hashscanUrl ? [{ label: "Payment", url: payment.hashscanUrl, txId: payment.transactionId }] : []), { label: "Bond", url: bondUrl }],
    });
  }

  purchase.status = "complete";
  if (units.record.hashscanUrl) purchase.unitsHashscanUrl = units.record.hashscanUrl;
  invoice.status = "funded";
  invoice.retainedUnits = (invoice.retainedUnits ?? 0) - purchase.units;
  invoice.amountPaidBy[input.investorId] = fromBaseUnits(toBaseUnits(invoice.amountPaidBy[input.investorId] ?? 0) + purchase.amountBaseUnits);
  const links: Link[] = [
    ...(payment.hashscanUrl ? [{ label: "Payment to business", url: payment.hashscanUrl, txId: payment.transactionId }] : []),
    ...(units.record.hashscanUrl ? [{ label: "Units to investor", url: units.record.hashscanUrl, txId: units.record.transactionId }] : []),
  ];
  invoice.links.push(...links);
  invoice.hashscanUrl = units.record.hashscanUrl ?? invoice.hashscanUrl ?? bondUrl;
  save();
  audit({ type: "units_buy", description: `${accountName(input.investorId)} bought ${purchase.units} units of ${invoice.id} for ${fromBaseUnits(purchase.amountBaseUnits)} uINR`, actor: investor.name, ...(units.record.hashscanUrl ? { hashscanUrl: units.record.hashscanUrl } : {}), txId: units.record.transactionId, invoiceId: invoice.id });
  return { purchase, invoice: invoiceView(invoice), links, tx: { hashscanUrl: units.record.hashscanUrl ?? "", txId: units.record.transactionId }, replayed: false };
}

export async function paySupplier(invoiceId: string, input: { supplierId: string; units: number; amount?: number | undefined; idempotencyKey?: string | undefined }) {
  const invoice = getInvoice(invoiceId);
  const bond = liveBond(invoice);
  const bondUrl = hashscan.contract(bond.contractId);
  const business = await getSigner(invoice.supplierId);

  const supplier = await getAccount(input.supplierId);
  if (!supplier) throw new ApiError(422, "SUPPLIER_NOT_FOUND", `Account ${input.supplierId} was not found`, { hashscanUrl: bondUrl });
  if (input.supplierId === business.id) throw new ApiError(422, "SAME_PARTY", "A business cannot pay itself", { hashscanUrl: bondUrl });

  await waitForMirrorToReach();
  const held = await read<bigint>(bond, "balanceOf(address)", [business.evm]);
  if (held < BigInt(input.units)) throw new ApiError(409, "INSUFFICIENT_UNITS", `${business.name} has ${held} transferable units, fewer than the ${input.units} requested`, { hashscanUrl: bondUrl });

  // Sent even if the supplier looks unverified, so the token's own rejection is on-chain as proof.
  const key = `${bond.symbol}:supplier:${input.idempotencyKey ?? randomUUID()}`;
  const call = await transferUnits(bond, business, supplier.evm_address, input.units, key);
  const url = call.record.hashscanUrl ?? bondUrl;

  if (call.revert || !call.record.succeeded) {
    const reason = call.revert?.text ?? call.record.result ?? "unknown";
    audit({ type: "transfer_rejected", description: `${input.units} units of ${invoice.id} to ${accountName(input.supplierId)} rejected: ${reason}`, actor: business.name, hashscanUrl: url, txId: call.record.transactionId, invoiceId: invoice.id, status: "rejected" });
    const details = { hashscanUrl: url, txId: call.record.transactionId, reason, links: [{ label: "Rejected transfer", url, txId: call.record.transactionId }, { label: "Bond", url: bondUrl }] };
    if (call.revert?.name === "AccountIsBlocked") throw new ApiError(422, "SUPPLIER_NOT_VERIFIED", `The token rejected this transfer: ${accountName(input.supplierId)} is not KYC-verified. No units moved.`, details);
    if (call.revert?.name === "IsPaused") throw new ApiError(409, "BOND_PAUSED", "The token is paused. No units moved.", details);
    throw new ApiError(422, "TRANSFER_REJECTED", `The token rejected this transfer: ${reason}. No units moved.`, details);
  }

  invoice.retainedUnits = (invoice.retainedUnits ?? 0) - input.units;
  const credited = input.amount ?? input.units * (invoice.unitFaceValue ?? config.defaultUnitFaceValue);
  invoice.amountPaidBy[input.supplierId] = (invoice.amountPaidBy[input.supplierId] ?? 0) + credited;
  addLink(invoice, { label: `${input.units} units to ${accountName(input.supplierId)}`, url, txId: call.record.transactionId });
  audit({ type: "units_transfer", description: `${input.units} units of ${invoice.id} sent to ${accountName(input.supplierId)} (₹${credited})`, actor: business.name, hashscanUrl: url, txId: call.record.transactionId, invoiceId: invoice.id });
  return { invoice: invoiceView(invoice), tx: { hashscanUrl: url, txId: call.record.transactionId }, links: [{ label: "Transfer", url, txId: call.record.transactionId }] };
}

export async function holdersOf(invoiceId: string) {
  const invoice = getInvoice(invoiceId);
  const bond = invoice.tokenization?.bond;
  if (!bond) return { invoiceId: invoice.id, tokenId: null, holders: [], repaidHolders: [], hashscanUrl: invoice.hashscanUrl ?? hashscan.account(invoice.supplierId) };
  const positions = await holderPositions(bond);
  return {
    invoiceId: invoice.id,
    tokenId: bond.contractId,
    holders: positions.map((position) => ({
      accountId: position.accountId,
      name: accountName(position.accountId),
      units: Number(position.units),
      amountPaid: invoice.amountPaidBy[position.accountId] ?? 0,
      frozen: position.frozen > 0n,
      frozenUnits: Number(position.frozen),
      hashscanUrl: hashscan.account(position.accountId),
    })),
    // Burned units are gone from the chain, so the saved snapshot is what shows who was repaid.
    repaidHolders: invoice.repayment?.holders ?? [],
    hashscanUrl: hashscan.contract(bond.contractId),
  };
}


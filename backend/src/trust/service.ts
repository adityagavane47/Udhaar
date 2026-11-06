/**
 * The trust layer: company trust scores, the per-invoice checklist, the per-invoice limit and the
 * e-invoice check at upload. External data (GST registry, credit profiles, e-invoice signer) is MOCK
 * and says so. Anything read from Hedera comes through a ChainReader.
 *
 * A failure anywhere ends in an error, as in the risk engine: there is no fallback score.
 */
import { config, hashscan } from "../config.js";
import { ApiError } from "../errors.js";
import { knownAccountName, ROLES } from "../hedera/client.js";
import { loadDataset, type Company, type RiskDataset } from "../risk/dataset.js";
import { assess, companyFor, subjectOf, type Subject } from "../risk/service.js";
import { state } from "../store.js";
import type { Invoice, Link } from "../types.js";
import { mirrorChain, type ChainReader } from "./chain.js";
import { loadTrustData, MOCK_SOURCE, normalizeName, validateUdyam, verifyGstin, type ExternalProfile, type GstVerification, type StepStatus } from "./data.js";
import { verifyEInvoice, type EInvoiceFields, type EInvoiceVerification } from "./irp.js";
import { computeTrust, limitFor, type RepaymentEvent, type TrustScore } from "./score.js";

const DAY_MS = 86_400_000;
const rupees = (value: number) => `₹${Math.round(value).toLocaleString("en-IN")}`;
const isAccountId = (ref: string) => /^0\.0\.\d+$/.test(ref);

export type ItemStatus = "pass" | "warn" | "fail" | "not_provided";

export interface ChecklistItem {
  id: string;
  label: string;
  status: ItemStatus;
  detail: string;
  proofUrl?: string;
  /** mock: made-up outside data. hedera: read from the chain. udhaar: worked out from the (simulated) risk dataset. */
  source: "mock" | "hedera" | "udhaar";
}

interface Party {
  ref: string;
  name: string;
  company: Company | undefined;
  profile: ExternalProfile | undefined;
  /** Hedera accounts that stand for this company. */
  accounts: string[];
}

function accountDisplayName(accountId: string): string {
  const known = knownAccountName(accountId);
  if (known) return ROLES[known];
  return Object.values(state.kyc).find((request) => request.walletAddress === accountId)?.fullName ?? accountId;
}

/** Takes a Hedera account, a dataset company ID or a (mock) GSTIN. Undefined if it is none of them. */
function resolveParty(ref: string, dataset: RiskDataset, displayName?: string): Party | undefined {
  const { profiles } = loadTrustData();
  let company = companyFor(ref, dataset);
  if (!company) {
    const byGstin = [...profiles.entries()].find(([, profile]) => profile.gstin === ref.toUpperCase());
    company = byGstin ? dataset.companies.get(byGstin[0]) : undefined;
  }
  if (!company && !isAccountId(ref)) return undefined;
  const accounts = new Set<string>();
  if (isAccountId(ref)) accounts.add(ref);
  if (company) for (const [account, companyId] of dataset.accountLinks) if (companyId === company.id) accounts.add(account);
  return { ref, name: company?.name ?? displayName ?? accountDisplayName(ref), company, profile: company ? profiles.get(company.id) : undefined, accounts: [...accounts] };
}

const invoiceLinks = (event: RepaymentEvent): Link => ({ label: `Repayment of ${event.invoiceId}`, url: event.hashscanUrl, txId: event.transactionId });

/** Repayments the chain confirms, for any of the given accounts, whether they were the buyer or the supplier. */
export async function repaymentEvents(accounts: string[], chain: ChainReader = mirrorChain, invoices: Invoice[] = Object.values(state.invoices)): Promise<RepaymentEvent[]> {
  const events: RepaymentEvent[] = [];
  for (const invoice of invoices) {
    const role = accounts.includes(invoice.buyerId) ? "buyer" : accounts.includes(invoice.supplierId) ? "supplier" : undefined;
    const detected = invoice.repayment?.detected;
    if (!role || !detected) continue;
    const proof = await chain.repayment(detected.transactionId, invoice.buyerId);
    if (!proof) continue;
    const paid = Date.parse(proof.paidAt);
    const due = Date.parse(invoice.dueDate);
    // Paid by the end of the due day counts as on time, the same as the scorecard's date comparison.
    const onTime = Math.floor(paid / DAY_MS) <= Math.floor(due / DAY_MS);
    events.push({ invoiceId: invoice.id, role, amount: invoice.amount, dueDate: invoice.dueDate, paidAt: proof.paidAt, onTime, daysLate: Math.max(0, (paid - due) / DAY_MS), transactionId: detected.transactionId, hashscanUrl: detected.hashscanUrl });
  }
  return events.sort((a, b) => a.paidAt.localeCompare(b.paidAt));
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "TRUST_UNAVAILABLE", `The trust check failed, so no result was produced: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

async function scoreParty(party: Party, dataset: RiskDataset, chain: ChainReader, now: number) {
  const events = await repaymentEvents(party.accounts, chain);
  const trust = computeTrust({ name: party.name, company: party.company, profile: party.profile, events, history: dataset.invoices, referenceDate: dataset.referenceDate, now });
  return { events, trust };
}

const profileView = (profile: ExternalProfile | undefined) => (profile ? { source: MOCK_SOURCE, ...profile } : { source: MOCK_SOURCE, note: "No (mock) external profile for this company" });

/** GET /trust/company/:id */
export async function companyTrust(ref: string, chain: ChainReader = mirrorChain, now = Date.now()) {
  return guarded(async () => {
    const dataset = loadDataset();
    const party = resolveParty(ref, dataset);
    if (!party) throw new ApiError(404, "COMPANY_NOT_FOUND", `No company, GSTIN or Hedera account matches ${ref}`);
    const { events, trust } = await scoreParty(party, dataset, chain, now);
    const firstAccount = party.accounts[0];
    return {
      companyId: party.company?.id ?? party.ref,
      name: party.name,
      inDataset: party.company !== undefined,
      accounts: party.accounts,
      ...trust,
      externalProfile: profileView(party.profile),
      repayments: events,
      hashscanUrl: events[0]?.hashscanUrl ?? (firstAccount ? hashscan.account(firstAccount) : hashscan.token(config.uinrTokenId)),
      links: [...events.map(invoiceLinks), ...party.accounts.map((account) => ({ label: `Account ${account}`, url: hashscan.account(account) }))],
    };
  });
}

function combine(statuses: ItemStatus[]): ItemStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  if (statuses.includes("not_provided")) return "not_provided";
  return "pass";
}

type Side = { role: "Seller" | "Buyer"; party: Party; gst: GstVerification | undefined };

function gstItem(id: string, label: string, sides: Side[], pick: (gst: GstVerification) => { status: ItemStatus; detail: string }): ChecklistItem {
  const parts = sides.map((side) => {
    if (!side.gst) return { status: "not_provided" as ItemStatus, text: `${side.role} ${side.party.name}: no GSTIN on record` };
    const picked = pick(side.gst);
    return { status: picked.status, text: `${side.role} ${side.party.name}: ${picked.detail}` };
  });
  return { id, label, status: combine(parts.map((part) => part.status)), detail: parts.map((part) => part.text).join(". "), source: "mock" };
}

const stepOf = (gst: GstVerification, step: string) => gst.steps.find((entry) => entry.step === step);
const asItem = (status: StepStatus): ItemStatus => status;

/** The date the e-invoice is checked against: the invoice's date, as YYYY-MM-DD. */
const dayOf = (iso: string) => iso.slice(0, 10);

function eInvoiceFields(invoice: Pick<Invoice, "amount" | "issueDate" | "invoiceNumber">, sellerGstin: string, buyerGstin: string): EInvoiceFields {
  return { sellerGstin, buyerGstin, invoiceNumber: invoice.invoiceNumber ?? "", amount: invoice.amount, date: dayOf(invoice.issueDate) };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

async function chainItems(subject: Subject, invoice: Invoice | undefined, chain: ChainReader): Promise<ChecklistItem[]> {
  if (!invoice) {
    const simulated = "This invoice is simulated and has no on-chain record";
    return [
      { id: "buyerConfirmed", label: "Buyer confirmed", status: "not_provided", detail: simulated, source: "hedera" },
      { id: "notFinancedBefore", label: "Not financed before", status: "not_provided", detail: simulated, source: "hedera" },
    ];
  }

  let confirmed: ChecklistItem;
  if (!invoice.confirmation) {
    confirmed = { id: "buyerConfirmed", label: "Buyer confirmed", status: "warn", detail: `${invoice.buyerName} has not confirmed this invoice yet`, source: "hedera" };
  } else {
    const timestamp = invoice.confirmation.hashscanUrl.split("/").pop() ?? "";
    const proof = await chain.confirmation({ consensusTimestamp: timestamp, invoiceId: invoice.id, fingerprint: invoice.fingerprint, buyerAccountId: invoice.buyerId });
    confirmed = !proof
      ? { id: "buyerConfirmed", label: "Buyer confirmed", status: "fail", detail: "The confirmation is saved here but was not found on the HCS confirmations topic", proofUrl: invoice.confirmation.hashscanUrl, source: "hedera" }
      : proof.valid
        ? { id: "buyerConfirmed", label: "Buyer confirmed", status: "pass", detail: `${invoice.buyerName} signed it: HCS confirmations topic ${proof.topicId}, sequence number ${proof.sequence}`, proofUrl: invoice.confirmation.hashscanUrl, source: "hedera" }
        : { id: "buyerConfirmed", label: "Buyer confirmed", status: "fail", detail: `The message on HCS (sequence ${proof.sequence}) is not a valid confirmation: ${proof.problem}`, proofUrl: invoice.confirmation.hashscanUrl, source: "hedera" };
  }

  const registered = await chain.registry(invoice.fingerprint);
  const financed: ChecklistItem = !registered
    ? { id: "notFinancedBefore", label: "Not financed before", status: "warn", detail: "This invoice's fingerprint is not in the HCS registry yet, so double financing can't be ruled out", source: "hedera" }
    : registered.invoiceId === invoice.id
      ? { id: "notFinancedBefore", label: "Not financed before", status: "pass", detail: `Its fingerprint is in the HCS registry once, as ${invoice.id}, sequence number ${registered.sequence}`, proofUrl: registered.hashscanUrl, source: "hedera" }
      : { id: "notFinancedBefore", label: "Not financed before", status: "fail", detail: `The registry already holds this fingerprint as ${registered.invoiceId} (sequence ${registered.sequence})`, proofUrl: registered.hashscanUrl, source: "hedera" };
  return [confirmed, financed];
}

/** GET /trust/:invoiceId */
export async function invoiceTrust(invoiceId: string, chain: ChainReader = mirrorChain, now = Date.now()) {
  return guarded(async () => {
    const dataset = loadDataset();
    const subject = subjectOf(invoiceId, dataset);
    const invoice = state.invoices[invoiceId];
    const seller = resolveParty(subject.supplierRef, dataset, subject.supplierName) as Party;
    const buyer = resolveParty(subject.buyerRef, dataset, subject.buyerName) as Party;
    // Named as the invoice names them, so a real invoice's own party name is what gets compared with the registry.
    seller.name = subject.supplierName;
    buyer.name = subject.buyerName;

    const [sellerScore, buyerScore, assessment, chainChecks] = await Promise.all([
      scoreParty(seller, dataset, chain, now),
      scoreParty(buyer, dataset, chain, now),
      assess(subject, dataset, dataset.graph),
      chainItems(subject, invoice, chain),
    ]);

    const sides: Side[] = [seller, buyer].map((party, index) => ({ role: index === 0 ? ("Seller" as const) : ("Buyer" as const), party, gst: party.profile ? verifyGstin(party.profile.gstin, party.name) : undefined }));
    const items: ChecklistItem[] = [];

    items.push(gstItem("gstinValid", "GSTIN valid", sides, (gst) => ({ status: asItem(gst.checksum), detail: stepOf(gst, "checksum")?.detail ?? "" })));
    items.push(gstItem("gstActive", "GST status Active", sides, (gst) => {
      const step = stepOf(gst, "status");
      if (step) return { status: asItem(step.status), detail: step.detail };
      return { status: "not_provided", detail: gst.checksum === "fail" ? "not checked, the GSTIN failed its checksum" : "not checked, the GSTIN is not in the (mock) registry" };
    }));
    items.push(gstItem("nameMatches", "Name matches the company", sides, (gst) => {
      const step = stepOf(gst, "name");
      if (step) return { status: asItem(step.status), detail: step.detail };
      return { status: "not_provided", detail: "not checked, an earlier GST check failed" };
    }));
    items.push(gstItem("gstFiling", "GST filing regular", sides, (gst) => {
      const step = stepOf(gst, "filing");
      if (step) return { status: asItem(step.status), detail: step.detail };
      return { status: "not_provided", detail: "not checked, an earlier GST check failed" };
    }));

    const udyam = seller.profile?.udyam;
    if (udyam === undefined || udyam === null) {
      items.push({ id: "udyam", label: "Udyam registration format", status: "not_provided", detail: `${seller.name} has no Udyam number on record`, source: "mock" });
    } else {
      const check = validateUdyam(udyam);
      items.push({ id: "udyam", label: "Udyam registration format", status: check.valid ? "pass" : "fail", detail: check.valid ? `${udyam} has a valid format (format only: not checked against the Udyam portal)` : `${udyam}: ${check.reason}`, source: "mock" });
    }

    if (!invoice?.signedQr) {
      items.push({ id: "eInvoice", label: "E-invoice signature verified", status: "not_provided", detail: invoice ? "No signed e-invoice QR was provided with this invoice" : "This invoice is simulated and has no e-invoice", source: "mock" });
    } else if (!seller.profile || !buyer.profile) {
      items.push({ id: "eInvoice", label: "E-invoice signature verified", status: "fail", detail: "A signed QR was provided but a party's GSTIN is not on record, so it can't be matched", source: "mock" });
    } else {
      const check = verifyEInvoice(invoice.signedQr, eInvoiceFields(invoice, seller.profile.gstin, buyer.profile.gstin));
      items.push({ id: "eInvoice", label: "E-invoice signature verified", status: check.verified ? "pass" : "fail", detail: check.verified ? `The (mock) IRP's signature is valid and every field matches. IRN ${check.irn}` : (check.reason ?? "verification failed"), source: "mock" });
    }

    items.push(...chainChecks);

    // Amount against what the seller usually bills, using the scorecard's bands: up to 2× fine, up to 10× a warning, beyond that a failure.
    const past = seller.company ? dataset.invoices.filter((entry) => entry.supplierId === seller.company?.id && entry.id !== subject.id && entry.status !== "open").map((entry) => entry.amount) : [];
    if (past.length < 3) {
      items.push({ id: "amountNormal", label: "Amount normal", status: "not_provided", detail: `${seller.name} has too little (simulated) billing history to say what is normal`, source: "udhaar" });
    } else {
      const usual = median(past);
      const ratio = subject.amount / usual;
      items.push({ id: "amountNormal", label: "Amount normal", status: ratio <= 2 ? "pass" : ratio <= 10 ? "warn" : "fail", detail: `${rupees(subject.amount)} is ${ratio < 10 ? Math.round(ratio * 10) / 10 : Math.round(ratio)}× the ${rupees(usual)} ${seller.name} usually bills`, source: "udhaar" });
    }

    const ring = assessment.card.fraudFlags;
    const bothKnown = assessment.supplier !== undefined && assessment.buyer !== undefined;
    items.push(!bothKnown
      ? { id: "noFraudRing", label: "No fraud ring", status: "not_provided", detail: "Both companies must be in the dataset to look for rings, shared directors or shared addresses", source: "udhaar" }
      : ring.length === 0
        ? { id: "noFraudRing", label: "No fraud ring", status: "pass", detail: "No circular billing, shared director or shared address between the two companies", source: "udhaar" }
        : { id: "noFraudRing", label: "No fraud ring", status: "fail", detail: assessment.card.reasons.filter((reason) => reason.startsWith("Fraud:")).join(" "), source: "udhaar" });

    const dues = buyer.profile?.msme1DuesOver45DaysInr;
    items.push(dues === undefined
      ? { id: "buyerMsme1Dues", label: "Buyer MSME-1 dues", status: "not_provided", detail: `${buyer.name} has no (mock) MSME-1 record`, source: "mock" }
      : { id: "buyerMsme1Dues", label: "Buyer MSME-1 dues", status: dues === 0 ? "pass" : dues <= 1_000_000 ? "warn" : "fail", detail: dues === 0 ? `${buyer.name} reports no dues to small suppliers over 45 days` : `${buyer.name} reports ${rupees(dues)} owed to small suppliers for over 45 days (MSME-1)`, source: "mock" });

    const complaints = buyer.profile?.samadhaanComplaints;
    items.push(complaints === undefined
      ? { id: "buyerSamadhaanComplaints", label: "Buyer Samadhaan complaints", status: "not_provided", detail: `${buyer.name} has no (mock) MSME Samadhaan record`, source: "mock" }
      : { id: "buyerSamadhaanComplaints", label: "Buyer Samadhaan complaints", status: complaints === 0 ? "pass" : complaints <= 2 ? "warn" : "fail", detail: complaints === 0 ? `${buyer.name} has no delayed-payment complaints on MSME Samadhaan` : `${buyer.name} has ${complaints} delayed-payment complaint${complaints === 1 ? "" : "s"} on MSME Samadhaan`, source: "mock" });

    const count = (status: ItemStatus) => items.filter((item) => item.status === status).length;
    const summary = { pass: count("pass"), warn: count("warn"), fail: count("fail"), notProvided: count("not_provided") };
    const view = (party: Party, scored: { events: RepaymentEvent[]; trust: TrustScore }) => ({ name: party.name, companyId: party.company?.id ?? party.ref, inDataset: party.company !== undefined, ...scored.trust, repayments: scored.events });

    return {
      invoiceId: subject.id,
      seeded: subject.seeded,
      externalDataSource: MOCK_SOURCE,
      seller: view(seller, sellerScore),
      buyer: view(buyer, buyerScore),
      checklist: items,
      summary,
      overall: summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass",
      hashscanUrl: subject.hashscanUrl,
      links: [...subject.links, ...items.filter((item) => item.proofUrl).map((item) => ({ label: item.label, url: item.proofUrl as string }))],
    };
  });
}

/** What POST /invoices needs from the trust layer before anything is written or spent. */
export interface NewInvoiceCheck {
  supplierId: string;
  buyerId: string;
  amount: number;
  invoiceNumber?: string | undefined;
  issueDate?: string | undefined;
  signedQr?: string | undefined;
}

/**
 * Refuses an invoice above either party's per-invoice limit, and one whose signed e-invoice QR is
 * not valid or does not match. Returns the verified e-invoice to save. Runs before the registry
 * write, so a refusal costs nothing.
 */
export async function checkNewInvoice(input: NewInvoiceCheck, chain: ChainReader = mirrorChain): Promise<{ signedQr: string; irn: string } | undefined> {
  return guarded(async () => {
    const dataset = loadDataset();
    const seller = resolveParty(input.supplierId, dataset);
    const buyer = resolveParty(input.buyerId, dataset);

    for (const [role, party] of [["supplier", seller], ["buyer", buyer]] as const) {
      if (!party) continue;
      const limit = limitFor(await repaymentEvents(party.accounts, chain));
      if (limit.perInvoiceInr !== null && input.amount > limit.perInvoiceInr) {
        throw new ApiError(422, "TRUST_LIMIT_EXCEEDED", `${rupees(input.amount)} is above the ${rupees(limit.perInvoiceInr)} per-invoice limit for the ${role}, ${party.name}. ${limit.reason}`, { party: role, limit, hashscanUrl: hashscan.token(config.uinrTokenId) });
      }
    }

    if (input.signedQr === undefined) return undefined;
    if (!input.invoiceNumber) throw new ApiError(422, "EINVOICE_NEEDS_INVOICE_NUMBER", "invoiceNumber is required when a signed e-invoice QR is sent, because it is one of the fields checked");
    if (!seller?.profile || !buyer?.profile) throw new ApiError(422, "EINVOICE_PARTY_UNKNOWN", "A signed e-invoice QR can only be checked when both parties have a GSTIN on record");
    const date = input.issueDate ? new Date(input.issueDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    const check: EInvoiceVerification = verifyEInvoice(input.signedQr, { sellerGstin: seller.profile.gstin, buyerGstin: buyer.profile.gstin, invoiceNumber: input.invoiceNumber, amount: input.amount, date });
    if (!check.verified) {
      throw new ApiError(422, check.signatureValid ? "EINVOICE_MISMATCH" : "EINVOICE_SIGNATURE_INVALID", `The e-invoice was refused: ${check.reason ?? "verification failed"}`, { source: MOCK_SOURCE, mismatches: check.mismatches, hashscanUrl: hashscan.token(config.uinrTokenId) });
    }
    return { signedQr: input.signedQr, irn: check.irn ?? "" };
  });
}

/** The (mock) GSTIN for an account, company ID or GSTIN, for tools that sign e-invoices. */
export function gstinOf(ref: string): string | undefined {
  return resolveParty(ref, loadDataset())?.profile?.gstin;
}

export { eInvoiceFields, normalizeName };

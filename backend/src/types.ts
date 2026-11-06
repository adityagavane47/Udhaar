// Field names follow web/lib/types.ts wherever the frontend already has a shape.

export interface Link {
  label: string;
  url: string;
  txId?: string;
}

/** One transaction in the at-most-once ledger. Saved as "sending" before it goes to the network. */
export interface TxRecord {
  key: string;
  status: "sending" | "done";
  transactionId: string;
  payer: string;
  validUntilUnix?: number;
  succeeded?: boolean;
  result?: string;
  consensusTimestamp?: string;
  hashscanUrl?: string;
  feeHbar?: number;
  errorMessage?: string | null;
  callResult?: string;
  entityId?: string | null;
}

export type InvoiceStatus = "submitted" | "buyer_confirmed" | "buyer_rejected" | "risk_checked" | "tokenized" | "funded" | "repaid";

export interface BondRef {
  symbol: string;
  contractId: string;
  evm: string;
}

export interface Tokenization {
  status: "in_progress" | "complete";
  symbol: string;
  isin: string;
  name: string;
  units: number;
  unitFaceValue: number;
  discountPct: number;
  startingDateUnix: number;
  maturityDateUnix: number;
  bond?: BondRef;
  /** Consensus timestamp of the deploy, which bounds searches of this bond's history. */
  deployedAt?: string;
}

export interface RepaymentHolder {
  name: string;
  evm: string;
  accountId: string;
  units: number;
  amountBaseUnits: number;
  burned: boolean;
  burnTxId?: string;
  burnHashscanUrl?: string;
  paid: boolean;
  paymentTxId?: string;
  paymentHashscanUrl?: string;
}

export interface Repayment {
  status: "in_progress" | "complete" | "needs_review";
  reviewReason?: string;
  detected?: { transactionId: string; hashscanUrl: string; from: string; memo: string; amountBaseUnits: number };
  holders?: RepaymentHolder[];
}

export interface Purchase {
  id: string;
  invoiceId: string;
  investorId: string;
  units: number;
  unitPrice: number;
  amountBaseUnits: number;
  feeBaseUnits: number;
  status: "pending" | "paid" | "complete";
  paymentHashscanUrl?: string;
  unitsHashscanUrl?: string;
}

export interface Invoice {
  id: string;
  supplierId: string;
  supplierName: string;
  buyerId: string;
  buyerName: string;
  amount: number;
  issueDate: string;
  dueDate: string;
  status: InvoiceStatus;
  invoiceNumber?: string;
  pdfName?: string;
  fingerprint: string;
  registered: boolean;
  /** Fixed by the first attempt, so a retry resends exactly the same signed message. */
  confirmationPayload?: string;
  confirmation?: { message: string; signature: string; signedBy: string; hashscanUrl: string };
  tokenId?: string;
  symbol?: string;
  maturityDate?: string;
  totalUnits?: number;
  unitFaceValue?: number;
  retainedUnits?: number;
  discountPct?: number;
  /** Set when tokenized. The score itself is left out, because it belongs to the full report. */
  grade?: "A" | "B" | "C" | "D";
  gradedAt?: string;
  hashscanUrl?: string;
  links: Link[];
  tokenization?: Tokenization;
  /** INR-equivalent paid for units, per account. Used for Holder.amountPaid. */
  amountPaidBy: Record<string, number>;
  repayment?: Repayment;
}

export interface KycRequest {
  id: string;
  fullName: string;
  walletAddress: string;
  country: string;
  status: "pending" | "approved" | "rejected";
  submittedAt: string;
  /** "not_checked" until the wallet scan (F19) exists, because a scan that never ran must not read as clean. */
  walletScan: "clean" | "flagged" | "not_checked";
  walletScanNote?: string;
  hashscanUrl: string;
  /** Live bonds this wallet could not be added to yet, such as paused ones. Retried on unpause. */
  pendingBonds: string[];
}

export type AuditType =
  | "invoice_upload"
  | "duplicate_rejected"
  | "buyer_confirm"
  | "buyer_payment"
  | "kyc_submit"
  | "kyc_approve"
  | "kyc_reject"
  | "risk_blocked"
  | "report_paid"
  | "agent_run"
  | "token_create"
  | "token_pause"
  | "token_unpause"
  | "holder_freeze"
  | "holder_unfreeze"
  | "units_buy"
  | "units_transfer"
  | "transfer_rejected"
  | "units_burn"
  | "holder_payout";

export interface AuditEntry {
  id: string;
  type: AuditType;
  description: string;
  actor: string;
  timestamp: string;
  hashscanUrl: string;
  txId?: string;
  invoiceId?: string;
  status: "success" | "rejected";
}

/** One settled x402 payment. Saved so a payment can never be used for a second report. */
export interface ReportPayment {
  invoiceId: string;
  payer: string;
  payTo: string;
  transactionId: string;
  hashscanUrl: string;
  amountBaseUnits: number;
  feeBaseUnits: number;
  onChainConfirmed: boolean;
  settledAt: string;
}

export interface AgentRules {
  /** Rupees for this run, including the 1% uINR fee. */
  reportBudget: number;
  /** Rupees for this run, including the 1% uINR fee. */
  investmentBudget: number;
  minGrade: "A" | "B" | "C";
  /** The investor's total position in one invoice, counting units bought earlier. */
  maxUnitsPerInvoice: number;
}

export interface AgentReportReceipt {
  invoiceId: string;
  amount: number;
  feeToPool: number;
  transactionId: string;
  hashscanUrl: string;
  grade: string;
  riskScore: number;
  fraudFlags: string[];
  anomaly: boolean;
}

export interface AgentPurchaseReceipt {
  invoiceId: string;
  units: number;
  unitPrice: number;
  amount: number;
  feeToPool: number;
  paymentHashscanUrl?: string;
  unitsHashscanUrl?: string;
}

export interface AgentSkip {
  invoiceId: string;
  code: string;
  reason: string;
  paidForReport: boolean;
}

export interface AgentRun {
  runId: string;
  status: "running" | "completed" | "stopped" | "interrupted";
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
  investor: string;
  rules: AgentRules;
  endpoint?: string;
  invoicesChecked: string[];
  reports: AgentReportReceipt[];
  /** Rupees, including the 1% fee. A payment that may have gone through is counted. */
  spentOnReports: number;
  purchases: AgentPurchaseReceipt[];
  spentOnUnits: number;
  skipped: AgentSkip[];
  auditTopicId?: string;
  auditMessages: { type: string; hashscanUrl: string; txId?: string }[];
  hashscanUrl: string;
  links: Link[];
}

export interface State {
  version: 1;
  nextInvoiceNumber: number;
  invoices: Record<string, Invoice>;
  kyc: Record<string, KycRequest>;
  purchases: Record<string, Purchase>;
  ledger: Record<string, TxRecord>;
  audit: AuditEntry[];
  /** By transaction ID. */
  reportPayments: Record<string, ReportPayment>;
  /** Newest first. */
  agentRuns: AgentRun[];
}

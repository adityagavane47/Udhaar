// Udhaar type definitions. Every data shape used by the UI lives here.

export type Role = "business" | "buyer" | "investor" | "admin";

export interface Persona {
  id: Role;
  role: string;
  name: string;
  desc: string;
  locked: boolean;
  href: string;
}

export const PERSONAS: Persona[] = [
  { id: "business", role: "Business", name: "Ramesh", desc: "Cement supplier. Upload invoices, get funded, pay your own suppliers in tokens.", locked: false, href: "/business" },
  { id: "buyer", role: "Buyer", name: "BigBuild", desc: "Construction company. Confirm what you owe, repay once on the due date.", locked: false, href: "/buyer" },
  { id: "investor", role: "Investor", name: "Priya", desc: "Buy invoice tokens at a discount and collect face value at maturity.", locked: false, href: "/investor" },
  { id: "admin", role: "Admin", name: "Operator", desc: "Approve KYC, issue tokens, pause or freeze when something looks wrong.", locked: true, href: "/admin" },
];

export type InvoiceStatus =
  | "submitted"
  | "buyer_confirmed"
  | "buyer_rejected"
  | "risk_checked"
  | "tokenized"
  | "funded"
  | "repaid";

export type KycStatus = "pending" | "approved" | "rejected";
export type Grade = "A" | "B" | "C" | "D";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

/** A proof link returned by the backend. */
export interface Link {
  label: string;
  url: string;
  txId?: string;
}

export interface RepaymentHolder {
  name: string;
  evm: string;
  accountId: string;
  units: number;
  amountBaseUnits: number; // uINR x 100
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

export interface Company {
  id: string;
  name: string;
  type: "supplier" | "buyer" | "both";
  foundedYear: number;
  gstFilingRate: number; // 0-1
  city: string;
  address: string;
  phone: string;
  hederaAccount: string;
  kycVerified: boolean; // wallet is on the token allowlist
}

export interface Invoice {
  id: string;
  supplierId: string;
  supplierName: string;
  buyerId: string;
  buyerName: string;
  amount: number; // INR, display only
  issueDate: string; // ISO
  dueDate: string; // ISO
  status: InvoiceStatus;
  pdfName?: string;
  tokenId?: string;
  totalUnits?: number;
  unitFaceValue?: number;
  retainedUnits?: number; // units still held by the supplier
  discountPct?: number | null; // up to 4 decimals; null when unpriced (grade D)
  seeded?: boolean; // simulated invoice such as DEMO-RING
  grade?: Grade;
  riskScore?: number;
  fingerprint?: string; // hash written to the HCS registry
  hashscanUrl?: string; // proof of the latest on-chain step
  invoiceNumber?: string;
  links?: Link[]; // every on-chain step so far (backend only)
  symbol?: string; // bond symbol
  maturityDate?: string; // ISO; can be earlier than dueDate in demos
  unitPrice?: number; // discounted price per unit
  availableUnits?: number; // units still for sale
  registered?: boolean;
  repayment?: Repayment;
}

export interface Holder {
  accountId: string;
  name: string;
  units: number;
  amountPaid: number; // INR equivalent paid for the units
  frozen: boolean;
  frozenUnits?: number;
  hashscanUrl?: string;
  repaid?: boolean; // units were burned and paid out at maturity
}

export interface ReportSettlement {
  transactionId: string;
  hashscanUrl: string;
  payer: string;
  payTo: string;
  network: string;
  token: string;
  amount: number;
  feeToPool: number;
  onChainConfirmed: boolean;
  settledAt: string;
}

export interface RiskReport {
  invoiceId: string;
  riskScore: number;
  grade: Grade;
  confidence: Confidence;
  creditRisk: "LOW" | "MEDIUM" | "HIGH";
  fraudFlags: string[];
  anomaly: boolean;
  annualRatePct?: number | null; // 12, 16 or 20; null for grade D
  daysToDue?: number;
  suggestedDiscountPct: number | null;
  appliedDiscountPct?: number;
  reasons: string[];
  graph?: RiskGraph;
  settlement?: ReportSettlement;
  replayed?: boolean;
  paymentTx?: string; // mapped from settlement.transactionId
  hashscanUrl?: string;
  links?: Link[];
}

export interface RiskGraphNode {
  id: string;
  label: string; // people appear only as "Director A"
  type: "company" | "person" | "address";
  role?: "supplier" | "buyer";
  inDataset?: boolean;
  flagged: boolean;
}

export interface RiskGraphLink {
  source: string;
  target: string;
  type: "invoice" | "billed" | "director_of" | "registered_at";
  flagged: boolean;
}

export interface RiskGraph {
  nodes: RiskGraphNode[];
  links: RiskGraphLink[];
}

export interface KycRequest {
  id: string;
  fullName: string;
  walletAddress: string;
  country: string;
  status: KycStatus;
  submittedAt: string;
  walletScan: "clean" | "flagged" | "not_checked";
  walletScanNote?: string;
  hashscanUrl?: string;
  pendingBonds?: string[];
}

export type TransactionType =
  | "invoice_upload"
  | "buyer_confirm"
  | "buyer_reject"
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
  | "risk_report"
  | "duplicate_rejected"
  | "transfer_rejected"
  | "units_burn"
  | "holder_payout";

export interface Transaction {
  id: string;
  type: TransactionType;
  description: string;
  actor: string;
  timestamp: string; // ISO
  hashscanUrl: string;
  txId?: string;
  invoiceId?: string;
  status?: "success" | "rejected";
}

export interface Listing {
  invoiceId: string;
  buyerName: string;
  amount: number;
  returnPct: number;
  daysToMaturity: number;
  dueDate: string;
  maturityDate?: string; // bond maturity; earlier than dueDate only in demos
  annualRatePct?: number | null;
  discountPct?: number | null;
  grade?: Grade;
  availableUnits: number;
  unitPrice: number;
  unitFaceValue: number;
  tokenId?: string; // absent on blocked cards
  blocked?: boolean; // grade D: shown as BLOCKED, never buyable
}

export interface PortfolioItem {
  invoiceId: string;
  buyerName: string;
  units: number;
  amountPaid: number;
  expectedPayout: number;
  dueDate: string;
  grade?: Grade;
  repaid: boolean;
}

export interface TokenInfo {
  tokenId: string;
  symbol?: string;
  hashscanUrl?: string;
  repaid?: boolean;
  invoiceId: string;
  buyerName: string;
  totalUnits: number;
  unitFaceValue: number;
  maturityDate: string;
  dueDate?: string;
  paused: boolean;
  holders: Holder[];
}

export interface TxResult {
  hashscanUrl: string;
  txId: string;
}

export interface InvestorSession {
  token: string;
  expiresAt: string;
  expiresInSeconds?: number;
  accountId: string;
  tokenType?: "Bearer";
  hashscanUrl?: string;
  links?: Link[];
}

export type AgentMinGrade = "A" | "B" | "C";

export interface AgentRules {
  reportBudget: number;
  investmentBudget: number;
  minGrade: AgentMinGrade;
  maxUnitsPerInvoice: number;
}

export interface AgentReportItem {
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

export interface AgentPurchaseItem {
  invoiceId: string;
  units: number;
  unitPrice: number;
  amount: number;
  feeToPool: number;
  paymentHashscanUrl?: string;
  unitsHashscanUrl?: string;
}

export interface AgentSkipItem {
  invoiceId: string;
  code: string;
  reason: string;
  paidForReport: boolean;
}

export interface AgentAuditMessage {
  type: string;
  hashscanUrl: string;
  txId?: string;
}

export interface AgentRun {
  runId: string;
  status: "running" | "completed" | "stopped" | "interrupted";
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
  investor?: string;
  rules: AgentRules;
  endpoint?: string;
  invoicesChecked: string[];
  reports: AgentReportItem[];
  spentOnReports: number;
  purchases: AgentPurchaseItem[];
  spentOnUnits: number;
  skipped: AgentSkipItem[];
  auditTopicId?: string;
  auditMessages: AgentAuditMessage[];
  hashscanUrl: string;
  links?: Link[];
}

export interface BondTokenMeta {
  tokenId: string;
  invoiceId: string;
  symbol?: string;
  buyerName: string;
  unitFaceValue: number;
  holders?: { accountId: string; units: number }[];
}

export interface TokenCatalog {
  uinrTokenId: string | null;
  bonds: BondTokenMeta[];
}

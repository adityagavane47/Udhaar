// Udhaar type definitions. Every data shape used by the UI lives here.

export type Role = "business" | "buyer" | "investor" | "admin";

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
  discountPct?: number;
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

export interface RiskReport {
  invoiceId: string;
  riskScore: number;
  grade: Grade;
  confidence: Confidence;
  creditRisk: "LOW" | "MEDIUM" | "HIGH";
  fraudFlags: string[];
  anomaly: boolean;
  suggestedDiscountPct: number;
  reasons: string[];
  paymentTx: string;
  hashscanUrl: string;
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
  grade?: Grade;
  availableUnits: number;
  unitPrice: number;
  unitFaceValue: number;
  tokenId: string;
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
  paused: boolean;
  holders: Holder[];
}

export interface TxResult {
  hashscanUrl: string;
  txId: string;
}

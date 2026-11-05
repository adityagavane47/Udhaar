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
}

export interface Holder {
  accountId: string;
  name: string;
  units: number;
  amountPaid: number; // INR equivalent paid for the units
  frozen: boolean;
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
  walletScan: "clean" | "flagged";
  walletScanNote?: string;
  hashscanUrl?: string;
}

export type TransactionType =
  | "invoice_upload"
  | "buyer_confirm"
  | "buyer_reject"
  | "buyer_payment"
  | "kyc_approve"
  | "kyc_reject"
  | "token_create"
  | "token_pause"
  | "token_unpause"
  | "holder_freeze"
  | "holder_unfreeze"
  | "units_buy"
  | "units_transfer"
  | "risk_report";

export interface Transaction {
  id: string;
  type: TransactionType;
  description: string;
  actor: string;
  timestamp: string; // ISO
  hashscanUrl: string;
  invoiceId?: string;
}

export interface Listing {
  invoiceId: string;
  buyerName: string;
  amount: number;
  returnPct: number;
  daysToMaturity: number;
  grade: Grade;
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
  grade: Grade;
  repaid: boolean;
}

export interface TokenInfo {
  tokenId: string;
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

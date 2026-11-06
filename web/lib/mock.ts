// Simulated data. Never import this file from components: use lib/api.ts.
import type {
  Company,
  Holder,
  Invoice,
  KycRequest,
  RiskReport,
  Transaction,
} from "./types";

const day = 86_400_000;
export const isoIn = (days: number) => new Date(Date.now() + days * day).toISOString();

export const ACCOUNTS = {
  business: { companyId: "0.0.11310318", accountId: "0.0.11310318" },
  buyer: { companyId: "0.0.11310319", accountId: "0.0.11310319" },
  investor: { accountId: "0.0.11310320", name: "Priya Sharma" },
  admin: { accountId: "0.0.11227777" },
};

export const PAID_REPORT_FEE_USDC = 0.01;

export const companies: Company[] = [
  { id: "0.0.11310318", name: "Ramesh Cement Traders", type: "supplier", foundedYear: 2011, gstFilingRate: 0.97, city: "Pune", address: "12 MIDC Road, Pune", phone: "+91 98220 11111", hederaAccount: "0.0.11310318", kycVerified: true },
  { id: "0.0.11310319", name: "BigBuild Ltd", type: "buyer", foundedYear: 2003, gstFilingRate: 0.99, city: "Mumbai", address: "Tower 4, BKC, Mumbai", phone: "+91 22 4000 2000", hederaAccount: "0.0.11310319", kycVerified: true },
  { id: "0.0.11339577", name: "Apex Infra Pvt Ltd", type: "buyer", foundedYear: 2010, gstFilingRate: 0.88, city: "Nagpur", address: "88 Civil Lines, Nagpur", phone: "+91 712 555 0101", hederaAccount: "0.0.11339577", kycVerified: true },
  { id: "0.0.11339578", name: "Nova Retail", type: "buyer", foundedYear: 2025, gstFilingRate: 0.6, city: "Nashik", address: "5 College Road, Nashik", phone: "+91 253 555 0199", hederaAccount: "0.0.11339578", kycVerified: true },
  { id: "0.0.11310322", name: "Shree Sand Traders", type: "supplier", foundedYear: 2015, gstFilingRate: 0.93, city: "Satara", address: "River Road, Satara", phone: "+91 98900 22222", hederaAccount: "0.0.11310322", kycVerified: true },
  { id: "0.0.11327247", name: "Kumar Steel Works", type: "supplier", foundedYear: 2018, gstFilingRate: 0.9, city: "Kolhapur", address: "Industrial Estate, Kolhapur", phone: "+91 98900 33333", hederaAccount: "0.0.11327247", kycVerified: false },
];

const mk = (id: string, supplierId: string, buyerId: string, amount: number, issue: number, due: number, status: Invoice["status"], extra: Partial<Invoice> = {}): Invoice => {
  const s = companies.find((c) => c.id === supplierId)!;
  const b = companies.find((c) => c.id === buyerId)!;
  return {
    id, supplierId, supplierName: s.name, buyerId, buyerName: b.name, amount,
    issueDate: isoIn(issue), dueDate: isoIn(due), status,
    pdfName: `${id}.pdf`,
    fingerprint: `sha256:${id.toLowerCase()}-${amount}-${buyerId}`,
    hashscanUrl: "https://hashscan.io/testnet/topic/0.0.7000001",
    ...extra,
  };
};

export const invoices: Invoice[] = [
  mk("INV-0042", "0.0.11310318", "0.0.11310319", 500000, -10, 80, "funded", { tokenId: "0.0.7001001", totalUnits: 500, unitFaceValue: 1000, retainedUnits: 100, discountPct: 2.6301, grade: "A", riskScore: 85 }),
  mk("INV-0043", "0.0.11310318", "0.0.11310319", 250000, -1, 90, "submitted"),
  mk("INV-0044", "0.0.11310318", "0.0.11339577", 300000, -5, 75, "risk_checked", { grade: "B", riskScore: 72, discountPct: 3.2877 }),
  mk("INV-0045", "0.0.11310318", "0.0.11339578", 120000, -4, 60, "tokenized", { tokenId: "0.0.7001002", totalUnits: 120, unitFaceValue: 1000, retainedUnits: 0, discountPct: 3.2877, grade: "C", riskScore: 58 }),
  mk("INV-0047", "0.0.11310318", "0.0.11339577", 200000, -6, 70, "tokenized", { tokenId: "0.0.7001003", totalUnits: 200, unitFaceValue: 1000, retainedUnits: 0, discountPct: 3.0685, grade: "B", riskScore: 70 }),
  mk("INV-0046", "0.0.11310322", "0.0.11310319", 80000, -2, 85, "submitted"),
  mk("INV-0040", "0.0.11310318", "0.0.11310319", 150000, -100, -10, "repaid", { tokenId: "0.0.7000900", totalUnits: 150, unitFaceValue: 1000, discountPct: 2.9589, grade: "A", riskScore: 88 }),
  // Simulated fraud case: shown as a blocked card, tokenizing it is refused.
  mk("DEMO-RING", "0.0.11327247", "0.0.11339578", 400000, -3, 60, "risk_checked", { grade: "D", seeded: true }),
];

const h = (accountId: string, name: string, units: number, amountPaid: number): Holder => ({ accountId, name, units, amountPaid, frozen: false });

export const holdersByToken: Record<string, Holder[]> = {
  "0.0.7001001": [
    h("0.0.11310320", "Priya Sharma", 100, 97370),
    h("0.0.11320001", "Arjun Mehta", 100, 97370),
    h("0.0.11320002", "Meera Iyer", 50, 48685),
  ],
  "0.0.7001002": [],
  "0.0.7001003": [],
};

export const pausedTokens: Record<string, boolean> = {};

export const kycRequests: KycRequest[] = [
  { id: "kyc-1", fullName: "Arjun Mehta", walletAddress: "0.0.11320001", country: "India", status: "pending", submittedAt: isoIn(-1), walletCheck: { source: "mirror", checkedAt: isoIn(-1), status: "clean", accountAgeDays: 120, transactionCount: 84, transfersChecked: 40, counterpartiesChecked: 9, warnings: [], blocklist: "mock", hashscanUrl: "https://hashscan.io/testnet/account/0.0.11320001" } },
  { id: "kyc-2", fullName: "Kavita Rao", walletAddress: "0.0.11320077", country: "India", status: "pending", submittedAt: isoIn(-2), walletCheck: { source: "mirror", checkedAt: isoIn(-1), status: "warnings", accountAgeDays: 3, transactionCount: 11, transfersChecked: 11, counterpartiesChecked: 4, warnings: [{ code: "ACCOUNT_TOO_NEW", message: "The account is 3 days old, under the 7-day minimum" }, { code: "BLOCKLISTED_COUNTERPARTY", accountId: "0.0.666013", message: "Transferred with 0.0.666013, which is on the (mock) blocklist: Fictional case: reported in a made-up phishing scheme" }], blocklist: "mock", hashscanUrl: "https://hashscan.io/testnet/account/0.0.11320077" } },
];

export const transactions: Transaction[] = [
  { id: "t-1", type: "invoice_upload", description: "INV-0042 fingerprint written to HCS registry", actor: "Business", timestamp: isoIn(-10), hashscanUrl: "https://hashscan.io/testnet/transaction/0.0.11310318-1730000001-000000001", invoiceId: "INV-0042" },
  { id: "t-2", type: "buyer_confirm", description: "BigBuild Ltd confirmed INV-0042", actor: "Buyer", timestamp: isoIn(-9), hashscanUrl: "https://hashscan.io/testnet/transaction/0.0.11310319-1730000002-000000002", invoiceId: "INV-0042" },
  { id: "t-3", type: "token_create", description: "Token 0.0.7001001 created for INV-0042", actor: "Admin", timestamp: isoIn(-8), hashscanUrl: "https://hashscan.io/testnet/token/0.0.7001001", invoiceId: "INV-0042" },
  { id: "t-4", type: "units_buy", description: "Priya Sharma bought 100 units of INV-0042", actor: "Investor", timestamp: isoIn(-7), hashscanUrl: "https://hashscan.io/testnet/transaction/0.0.11310320-1730000004-000000004", invoiceId: "INV-0042" },
];

export const unlockedReports = new Set<string>();
export const investorKyc: { current: KycRequest | null } = { current: null };

export const riskReports: Record<string, Omit<RiskReport, "paymentTx" | "hashscanUrl">> = {
  "INV-0042": { invoiceId: "INV-0042", riskScore: 85, grade: "A", confidence: "HIGH", creditRisk: "LOW", fraudFlags: [], anomaly: false, annualRatePct: 12, daysToDue: 80, suggestedDiscountPct: 2.6301, reasons: ["Buyer paid 90% of past invoices on time", "Company active since 2003 with 99% GST filing", "Invoice amount is in line with the buyer's usual orders", "Other suppliers are paid on time by this buyer"] },
  "INV-0044": { invoiceId: "INV-0044", riskScore: 72, grade: "B", confidence: "MEDIUM", creditRisk: "MEDIUM", fraudFlags: [], anomaly: false, annualRatePct: 16, daysToDue: 75, suggestedDiscountPct: 3.2877, reasons: ["Buyer paid 75% of past invoices on time", "Average payment delay of 9 days", "GST filing is slightly irregular (88%)"] },
  "INV-0045": { invoiceId: "INV-0045", riskScore: 58, grade: "C", confidence: "LOW", creditRisk: "MEDIUM", fraudFlags: [], anomaly: false, annualRatePct: 20, daysToDue: 60, suggestedDiscountPct: 3.2877, reasons: ["Buyer was founded last year and has no invoice history", "Payment history set to a neutral score", "No fraud patterns found in the network"] },
  "INV-0047": { invoiceId: "INV-0047", riskScore: 70, grade: "B", confidence: "MEDIUM", creditRisk: "MEDIUM", fraudFlags: [], anomaly: false, annualRatePct: 16, daysToDue: 70, suggestedDiscountPct: 3.0685, reasons: ["Buyer paid 78% of past invoices on time", "Invoice amount is within the buyer's usual range", "Due date is 70 days away, a normal term"] },
  "DEMO-RING": { invoiceId: "DEMO-RING", riskScore: 31, grade: "D", confidence: "MEDIUM", creditRisk: "MEDIUM", fraudFlags: ["CIRCULAR_INVOICING", "SHARED_DIRECTOR"], anomaly: false, annualRatePct: null, daysToDue: 60, suggestedDiscountPct: null, reasons: ["Invoices loop between supplier and buyer through a shared director", "Billing loop detected: the same money moves in a circle", "Score capped at 49 because of the fraud flags"], graph: { nodes: [{ id: "s", label: "Kumar Steel Works", type: "company", role: "supplier", flagged: true }, { id: "b", label: "Nova Retail", type: "company", role: "buyer", flagged: true }, { id: "p", label: "Director A", type: "person", flagged: true }], links: [{ source: "s", target: "b", type: "invoice", flagged: true }, { source: "p", target: "s", type: "director_of", flagged: true }, { source: "p", target: "b", type: "director_of", flagged: true }] } }
};


/**
 * MOCK e-invoice signer, standing in for India's Invoice Registration Portal (IRP).
 *
 * The real IRP gives every e-invoice an IRN and a signed QR code, which is a JWS. This does the same
 * with its own ES256 key pair, so anything it signs proves nothing about a real invoice. The
 * private key is MOCK_IRP_PRIVATE_KEY in .env (see scripts/generate-irp-key.ts). The public key is in
 * deployments/mock-irp-public.json, and verifying needs only that.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "../config.js";
import { ApiError } from "../errors.js";

export const PUBLIC_KEY_PATH = fileURLToPath(new URL("../../deployments/mock-irp-public.json", import.meta.url));

export interface EInvoiceFields {
  sellerGstin: string;
  buyerGstin: string;
  invoiceNumber: string;
  /** Rupees. */
  amount: number;
  /** The invoice date, as YYYY-MM-DD. */
  date: string;
}

/** Claim names follow the real IRP's signed QR. Dates are ISO here, where the real one uses DD/MM/YYYY. */
export interface EInvoiceClaims {
  Irn: string;
  IrnDt: string;
  SellerGstin: string;
  BuyerGstin: string;
  DocNo: string;
  DocTyp: "INV";
  DocDt: string;
  TotInvVal: number;
  iss: "MOCK-IRP";
  mock: true;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** Indian financial year of a date, such as 2026-27. */
function financialYear(isoDay: string): string {
  const year = Number(isoDay.slice(0, 4));
  const month = Number(isoDay.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** As the real portal does it: SHA-256 of seller GSTIN, financial year, document type and number. */
export function computeIrn(sellerGstin: string, isoDay: string, docNo: string): string {
  return createHash("sha256").update(`${sellerGstin}${financialYear(isoDay)}INV${docNo}`).digest("hex");
}

function privateKey(): KeyObject {
  const encoded = process.env.MOCK_IRP_PRIVATE_KEY?.trim();
  if (!encoded) throw new ApiError(503, "MOCK_IRP_NOT_CONFIGURED", "MOCK_IRP_PRIVATE_KEY is not set: run `npm run generate-irp-key` in backend/");
  try {
    return createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new ApiError(503, "MOCK_IRP_NOT_CONFIGURED", "MOCK_IRP_PRIVATE_KEY is not a valid base64 PKCS8 key");
  }
}

interface PublicRecord {
  kid: string;
  jwk: JsonWebKey;
}

let publicCache: { record: PublicRecord; key: KeyObject } | undefined;

function publicKey() {
  if (publicCache) return publicCache;
  if (!existsSync(PUBLIC_KEY_PATH)) throw new ApiError(503, "MOCK_IRP_NOT_CONFIGURED", "deployments/mock-irp-public.json is missing: run `npm run generate-irp-key` in backend/");
  const record = JSON.parse(readFileSync(PUBLIC_KEY_PATH, "utf8")) as PublicRecord;
  publicCache = { record, key: createPublicKey({ key: record.jwk, format: "jwk" }) };
  return publicCache;
}

export const publicKeyRecord = () => JSON.parse(readFileSync(PUBLIC_KEY_PATH, "utf8")) as Record<string, unknown>;

/** A signed e-invoice: the IRN and the JWS that a real IRP would print as a QR code. */
export function signEInvoice(fields: EInvoiceFields, now = new Date()): { irn: string; signedQr: string; claims: EInvoiceClaims } {
  const claims: EInvoiceClaims = {
    Irn: computeIrn(fields.sellerGstin, fields.date, fields.invoiceNumber),
    IrnDt: now.toISOString(),
    SellerGstin: fields.sellerGstin,
    BuyerGstin: fields.buyerGstin,
    DocNo: fields.invoiceNumber,
    DocTyp: "INV",
    DocDt: fields.date,
    TotInvVal: fields.amount,
    iss: "MOCK-IRP",
    mock: true,
  };
  const { record } = publicKey();
  const input = `${b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: record.kid }))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign("sha256", Buffer.from(input), { key: privateKey(), dsaEncoding: "ieee-p1363" });
  return { irn: claims.Irn, signedQr: `${input}.${b64url(signature)}`, claims };
}

export interface FieldMismatch {
  field: keyof EInvoiceFields | "irn";
  expected: string | number;
  found: string | number | undefined;
}

export interface EInvoiceVerification {
  source: "mock";
  /** True only when the signature is good and every field matches. */
  verified: boolean;
  signatureValid: boolean;
  reason?: string;
  irn?: string;
  mismatches: FieldMismatch[];
}

/** Checks the signature with the public key, then every field against what the invoice says. Any difference fails it. */
export function verifyEInvoice(signedQr: string, expected: EInvoiceFields): EInvoiceVerification {
  const bad = (reason: string, extra: Partial<EInvoiceVerification> = {}): EInvoiceVerification => ({ source: "mock", verified: false, signatureValid: false, reason, mismatches: [], ...extra });
  const parts = signedQr.trim().split(".");
  if (parts.length !== 3) return bad("The signed QR is not a JWS: it needs three dot-separated parts");
  const [header64 = "", payload64 = "", signature64 = ""] = parts;

  let header: { alg?: string; kid?: string };
  let claims: Partial<EInvoiceClaims>;
  try {
    header = JSON.parse(Buffer.from(header64, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(payload64, "base64url").toString("utf8"));
  } catch {
    return bad("The signed QR could not be read");
  }
  // Only ES256 is accepted, so a token can't pick a weaker algorithm for itself.
  if (header.alg !== "ES256") return bad(`Unsupported algorithm ${String(header.alg)}: only ES256 is accepted`);
  const { record, key } = publicKey();
  if (header.kid !== record.kid) return bad("The signed QR was signed by a key this server does not know");

  const signatureValid = verify("sha256", Buffer.from(`${header64}.${payload64}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature64, "base64url"));
  if (!signatureValid) return bad("The signature does not match: the signed QR was changed or was not signed by the (mock) IRP");

  const mismatches: FieldMismatch[] = [];
  const compare = (field: FieldMismatch["field"], want: string | number, found: string | number | undefined) => {
    if (want !== found) mismatches.push({ field, expected: want, found });
  };
  compare("sellerGstin", expected.sellerGstin, claims.SellerGstin);
  compare("buyerGstin", expected.buyerGstin, claims.BuyerGstin);
  compare("invoiceNumber", expected.invoiceNumber, claims.DocNo);
  compare("amount", expected.amount, claims.TotInvVal);
  compare("date", expected.date, claims.DocDt);
  compare("irn", computeIrn(expected.sellerGstin, expected.date, expected.invoiceNumber), claims.Irn);

  const result: EInvoiceVerification = { source: "mock", verified: mismatches.length === 0, signatureValid: true, mismatches, ...(claims.Irn ? { irn: claims.Irn } : {}) };
  if (mismatches.length > 0) result.reason = `The signature is good but ${mismatches.map((item) => item.field).join(", ")} ${mismatches.length === 1 ? "does" : "do"} not match the invoice`;
  return result;
}

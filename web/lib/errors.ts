import type { Link } from "./types";

/** An error returned by the backend ({ error: { code, message, hashscanUrl?, links? } }). */
export class ApiError extends Error {
  code: string;
  status: number;
  hashscanUrl?: string;
  links?: Link[];
  details: Record<string, unknown>;

  constructor(code: string, message: string, status = 0, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = extra;
    this.hashscanUrl = typeof extra.hashscanUrl === "string" ? extra.hashscanUrl : undefined;
    this.links = Array.isArray(extra.links) ? (extra.links as Link[]) : undefined;
  }
}

/** The invoice's fingerprint is already in the HCS registry. */
export class DuplicateInvoiceError extends ApiError {
  originalId?: string;

  constructor(originalId: string | undefined, hashscanUrl: string, message = "Duplicate invoice: already financed.") {
    super("DUPLICATE_INVOICE", message, 409, { hashscanUrl });
    this.name = "DuplicateInvoiceError";
    this.originalId = originalId;
  }
}


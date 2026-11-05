import type { Link } from "./types.js";

/** An expected failure, returned to the client as { error: { code, message, ... } }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: { hashscanUrl?: string; links?: Link[]; [key: string]: unknown } = {},
  ) {
    super(message);
  }
}

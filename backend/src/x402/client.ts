import { x402Client, x402HTTPClient } from "@x402/core/client";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { config, uinrFeeBaseUnits } from "../config.js";
import type { Party } from "../hedera/client.js";

export interface ReportQuote {
  amountBaseUnits: number;
  feeBaseUnits: number;
  totalBaseUnits: number;
  asset: string;
  payTo: string;
  network: string;
  scheme: string;
}

/** A report call that didn't return a report. `maybeCharged` is true when the money may have moved. */
export class ReportCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly maybeCharged: boolean,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Thrown by an `approve` check to refuse a quote before anything is signed. */
export class QuoteRefused extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Refuses a quote for anything but a report at a normal price, paid in uINR to the risk agent. */
export function assertQuoteAllowed(quote: ReportQuote, allowedPayTo: string, allowedToken: string) {
  if (quote.scheme !== "exact" || quote.network !== config.x402Network) throw new QuoteRefused(`The quote is for ${quote.scheme} on ${quote.network}`, "QUOTE_NOT_ALLOWED");
  if (quote.asset !== allowedToken) throw new QuoteRefused(`The quote asks for token ${quote.asset}`, "QUOTE_NOT_ALLOWED");
  if (quote.payTo !== allowedPayTo) throw new QuoteRefused(`The quote pays ${quote.payTo}, which isn't the risk agent`, "QUOTE_NOT_ALLOWED");
  if (!Number.isInteger(quote.amountBaseUnits) || quote.amountBaseUnits <= 0 || quote.amountBaseUnits > config.agentMaxReportPriceBaseUnits) throw new QuoteRefused(`The quote of ${quote.amountBaseUnits} base units is outside the agent's limit`, "QUOTE_NOT_ALLOWED");
}

const clients = new Map<string, x402HTTPClient>();

function clientFor(payer: Party): x402HTTPClient {
  let client = clients.get(payer.id);
  if (!client) {
    const signer = createClientHederaSigner(payer.id, payer.key, { network: config.x402Network });
    // The client only pays well-known tokens unless told otherwise. This allows uINR, up to the agent's price limit.
    const base = new x402Client()
      .register(config.x402Network, new ExactHederaScheme(signer))
      .setSpendControls({ allowedAssets: [{ network: config.x402Network, asset: config.uinrTokenId, maxAmountPerPayment: String(config.agentMaxReportPriceBaseUnits) }] });
    client = new x402HTTPClient(base);
    clients.set(payer.id, client);
  }
  return client;
}

async function failure(response: Response, maybeCharged: boolean): Promise<ReportCallError> {
  const body = (await response.json().catch(() => ({}))) as { error?: string | { code?: string; message?: string; [key: string]: unknown }; reason?: string };
  // API errors are objects. A 402's `error` is x402's own reason code, as text.
  if (typeof body.error === "string") return new ReportCallError(body.reason ?? `The payment was refused: ${body.error}`, response.status, "PAYMENT_REFUSED", maybeCharged, { reason: body.error });
  const { code, message, ...details } = body.error ?? {};
  return new ReportCallError(message ?? `The report route returned ${response.status}`, response.status, code ?? `HTTP_${response.status}`, maybeCharged, details);
}

/**
 * Asks for the report, reads the 402 quote, lets `approve` accept or refuse it, then signs and
 * retries. Nothing is signed until `approve` returns. No person is involved at any step.
 */
export async function payForReport<T>(url: string, payer: Party, approve: (quote: ReportQuote) => void): Promise<T> {
  let first: Response;
  try {
    first = await fetch(url);
  } catch (error) {
    throw new ReportCallError(`The report route can't be reached: ${error instanceof Error ? error.message : "unknown error"}`, 503, "REPORT_ROUTE_UNREACHABLE", false);
  }
  if (first.status !== 402) throw await failure(first, false);

  const client = clientFor(payer);
  const required = client.getPaymentRequiredResponse((name) => first.headers.get(name), await first.clone().json().catch(() => undefined));
  const offer = required.accepts[0];
  if (!offer || required.accepts.length !== 1) throw new QuoteRefused(`Expected one payment option and got ${required.accepts.length}`, "QUOTE_NOT_UNDERSTOOD");

  const amountBaseUnits = Number(offer.amount);
  const feeBaseUnits = uinrFeeBaseUnits(amountBaseUnits);
  approve({ amountBaseUnits, feeBaseUnits, totalBaseUnits: amountBaseUnits + feeBaseUnits, asset: offer.asset, payTo: offer.payTo, network: offer.network, scheme: offer.scheme });

  const payment = await client.createPaymentPayload(required);
  let paid: Response;
  try {
    paid = await fetch(url, { headers: client.encodePaymentSignatureHeader(payment) });
  } catch (error) {
    throw new ReportCallError(`The paid request failed, so the payment may have gone through: ${error instanceof Error ? error.message : "unknown error"}`, 502, "PAID_REQUEST_FAILED", true);
  }
  if (paid.ok) return (await paid.json()) as T;
  // 402, 429 and 503 all happen before settlement. Anything else might be after it.
  throw await failure(paid, ![402, 429, 503].includes(paid.status));
}

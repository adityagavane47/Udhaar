import { Transaction } from "@hiero-ledger/sdk";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { config, fromBaseUnits, hashscan, uinrFeeBaseUnits } from "../config.js";
import { ApiError } from "../errors.js";
import { findTransaction, poll, toMirrorTransactionId } from "../hedera/mirror.js";
import { audit, save, state } from "../store.js";
import type { Link, ReportPayment } from "../types.js";
import { movedAmount } from "../uinr.js";

export type Charge =
  | { paid: false; headers: Record<string, string>; body: object }
  | { paid: true; headers: Record<string, string>; settlement: ReturnType<typeof settlementView> };

let ready: Promise<x402ResourceServer> | undefined;

/** Connects on first use and retries after a failure, so a facilitator outage doesn't need a restart. */
function resourceServer(): Promise<x402ResourceServer> {
  ready ??= (async () => {
    const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitatorUrl })).register(config.x402Network, new ExactHederaScheme());
    await server.initialize();
    return server;
  })().catch((error: unknown) => {
    ready = undefined;
    throw unavailable(error);
  });
  return ready;
}

const unavailable = (error: unknown) =>
  new ApiError(503, "FACILITATOR_UNAVAILABLE", `The payment facilitator can't be reached, so nothing was charged: ${error instanceof Error ? error.message : "unknown error"}`, { hashscanUrl: hashscan.token(config.uinrTokenId) });

/** With no receiving account the route stays locked. It never falls back to free. */
export function reportPayTo(): string {
  const payTo = process.env.RISK_AGENT_ID?.trim();
  if (!payTo) throw new ApiError(503, "PAYWALL_NOT_CONFIGURED", "RISK_AGENT_ID is not set on the server, so reports can't be sold", { hashscanUrl: hashscan.token(config.uinrTokenId) });
  return payTo;
}

const priceSummary = () => {
  const fee = uinrFeeBaseUnits(config.reportPriceBaseUnits);
  return {
    price: fromBaseUnits(config.reportPriceBaseUnits),
    payerTotal: fromBaseUnits(config.reportPriceBaseUnits + fee),
    currency: "uINR",
    token: config.uinrTokenId,
    decimals: config.uinrDecimals,
    amountBaseUnits: config.reportPriceBaseUnits,
    payerFeePct: 1,
    payTo: reportPayTo(),
    network: config.x402Network,
  };
};

/** What an agent reads to find the paid endpoint and what it costs, starting from only the base URL. */
export const serviceManifest = (baseUrl: string) => ({
  services: [
    {
      name: "Udhaar invoice risk report",
      description: "Full risk report for one invoice: score, grade, fraud and anomaly flags, reasons and a graph of the parties.",
      method: "GET",
      url: `${baseUrl}/risk/{invoiceId}/report`,
      freePreview: `${baseUrl}/risk/{invoiceId}/summary`,
      listings: `${baseUrl}/invoices`,
      scheme: "exact",
      facilitator: config.facilitatorUrl,
      ...priceSummary(),
    },
  ],
  hashscanUrl: hashscan.token(config.uinrTokenId),
  links: [{ label: "uINR token", url: hashscan.token(config.uinrTokenId) }],
});

async function requirementsFor(server: x402ResourceServer): Promise<PaymentRequirements[]> {
  const fee = uinrFeeBaseUnits(config.reportPriceBaseUnits);
  return server.buildPaymentRequirements({
    scheme: "exact",
    network: config.x402Network,
    payTo: reportPayTo(),
    maxTimeoutSeconds: 120,
    price: {
      amount: String(config.reportPriceBaseUnits),
      asset: config.uinrTokenId,
      extra: { name: "uINR", decimals: config.uinrDecimals, payerFeePct: 1, payerTotal: String(config.reportPriceBaseUnits + fee) },
    },
  });
}

/** The ID is in the signed bytes, so a payment can be recognised before anything is sent. */
function paymentTransactionId(payload: PaymentPayload): string {
  const transaction = (payload.payload as { transaction?: unknown }).transaction;
  if (typeof transaction !== "string") throw new Error("The payment has no transaction");
  const id = Transaction.fromBytes(Buffer.from(transaction, "base64")).transactionId?.toString();
  if (!id) throw new Error("The payment's transaction has no ID");
  return id;
}

function settlementView(payment: ReportPayment) {
  return {
    transactionId: payment.transactionId,
    hashscanUrl: payment.hashscanUrl,
    payer: payment.payer,
    payTo: payment.payTo,
    network: config.x402Network,
    token: config.uinrTokenId,
    amount: fromBaseUnits(payment.amountBaseUnits),
    feeToPool: fromBaseUnits(payment.feeBaseUnits),
    onChainConfirmed: payment.onChainConfirmed,
    settledAt: payment.settledAt,
  };
}

export const settlementOf = settlementView;

async function findOnChain(transactionId: string) {
  try {
    return await poll(`settlement ${transactionId}`, () => findTransaction(transactionId), config.settlementConfirmAttempts);
  } catch {
    return undefined;
  }
}

const inFlight = new Set<string>();

/**
 * Checks a report payment and settles it. The caller has already scored the invoice, so a report
 * that can't be produced is never charged for.
 */
export async function chargeForReport(invoiceId: string, paymentHeader: string | undefined, resourceUrl: string): Promise<Charge> {
  const summary = priceSummary();
  const server = await resourceServer();
  let requirements: PaymentRequirements[];
  try {
    requirements = await requirementsFor(server);
  } catch (error) {
    throw unavailable(error);
  }

  const paymentRequired = async (error: string, reason?: string): Promise<Charge> => {
    const required = await server.createPaymentRequiredResponse(requirements, { url: resourceUrl, description: `Risk report for invoice ${invoiceId}`, mimeType: "application/json" }, error);
    return {
      paid: false,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) },
      body: {
        ...required,
        payment: { ...summary, resource: resourceUrl },
        ...(reason ? { reason } : {}),
        hashscanUrl: hashscan.token(config.uinrTokenId),
        links: [{ label: "uINR token", url: hashscan.token(config.uinrTokenId) }, { label: "Receiving account", url: hashscan.account(summary.payTo) }] satisfies Link[],
      },
    };
  };

  if (!paymentHeader) return paymentRequired("payment_required");

  let payload: PaymentPayload;
  let transactionId: string;
  try {
    payload = decodePaymentSignatureHeader(paymentHeader);
    transactionId = paymentTransactionId(payload);
  } catch {
    return paymentRequired("invalid_payment", "The payment header could not be read");
  }
  const matched = server.findMatchingRequirements(requirements, payload);
  if (!matched) return paymentRequired("payment_requirements_mismatch", "The payment doesn't match this price, token, account or network");

  // One payment buys one report. The chain refuses a resend too, but this also covers an outage below.
  if (state.reportPayments[transactionId] || inFlight.has(transactionId)) return paymentRequired("payment_already_used", "This payment has already been used");
  inFlight.add(transactionId);
  try {
    let payer: string | undefined;
    try {
      const verification = await server.verifyPayment(payload, matched);
      if (!verification.isValid) return await paymentRequired(verification.invalidReason ?? "invalid_payment", verification.invalidMessage);
      payer = verification.payer;
    } catch (error) {
      throw unavailable(error);
    }

    let settled: SettleResponse | undefined;
    try {
      settled = await server.settlePayment(payload, matched);
    } catch (error) {
      // A facilitator's refusal is final. Anything else, like a timeout, might still have gone through.
      const refusal = error as { errorReason?: unknown; errorMessage?: unknown };
      if (typeof refusal.errorReason === "string") return await paymentRequired(refusal.errorReason, typeof refusal.errorMessage === "string" ? refusal.errorMessage : undefined);
    }
    if (settled && !settled.success) return await paymentRequired(settled.errorReason ?? "settlement_failed", settled.errorMessage);

    const proof = { hashscanUrl: hashscan.transaction(toMirrorTransactionId(transactionId)) };
    if (settled && toMirrorTransactionId(settled.transaction) !== toMirrorTransactionId(transactionId)) {
      throw new ApiError(502, "SETTLEMENT_MISMATCH", "The facilitator reported a different transaction from the one signed, so no report was released", proof);
    }

    // The facilitator is a third party, so the chain gets the last word before the report is released.
    const onChain = await findOnChain(transactionId);
    if (onChain && (onChain.result !== "SUCCESS" || movedAmount(onChain, summary.payTo) !== config.reportPriceBaseUnits)) {
      throw new ApiError(502, "SETTLEMENT_MISMATCH", "The transaction on-chain didn't pay the report price to the receiving account, so no report was released", proof);
    }
    if (!onChain && !settled) {
      throw new ApiError(502, "SETTLEMENT_UNCONFIRMED", "The facilitator didn't answer and the payment isn't on-chain yet, so no report was released. Check the link before paying again", proof);
    }

    const payment: ReportPayment = {
      invoiceId,
      payer: settled?.payer ?? payer ?? "",
      payTo: summary.payTo,
      transactionId,
      hashscanUrl: onChain ? hashscan.transaction(onChain.consensus_timestamp) : proof.hashscanUrl,
      amountBaseUnits: config.reportPriceBaseUnits,
      feeBaseUnits: onChain ? (onChain.assessed_custom_fees ?? []).reduce((sum, fee) => sum + fee.amount, 0) : uinrFeeBaseUnits(config.reportPriceBaseUnits),
      onChainConfirmed: onChain !== undefined,
      settledAt: new Date().toISOString(),
    };
    state.reportPayments[transactionId] = payment;
    save();
    audit({ type: "report_paid", description: `Risk report for ${invoiceId} sold for ${fromBaseUnits(payment.amountBaseUnits)} uINR over x402`, actor: payment.payer || "x402 client", hashscanUrl: payment.hashscanUrl, txId: transactionId, invoiceId });
    return {
      paid: true,
      headers: settled ? { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) } : {},
      settlement: settlementView(payment),
    };
  } finally {
    inFlight.delete(transactionId);
  }
}

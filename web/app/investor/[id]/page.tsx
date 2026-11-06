"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Async,
  AsyncButton,
  DemoMaturityTag,
  Field,
  GradeBadge,
  HashscanLink,
  InvestorNav,
  MiniGraph,
  PageHeader,
  PortalGuard,
  StampBadge,
} from "@/components/common";
import { TrustPanel } from "@/components/trust";
import { useAsync } from "@/hooks/use-async";
import { ApiError, buyRiskReport, buyUnits, getListing, getNav, isReportUnlocked } from "@/lib/api";
import { daysUntil, demoMaturityText, inr, inrPrice, pct, termText } from "@/lib/utils";
import type { NavInfo, RiskReport } from "@/lib/types";

type NavOutcome = { kind: "ok"; nav: NavInfo } | { kind: "unavailable" } | { kind: "hidden" };

/** NAV is a nice-to-have: any failure except NOT_PRICED hides the line, so the page keeps working. */
function NavToday({ invoiceId }: { invoiceId: string }) {
  const outcome = useAsync<NavOutcome>(() =>
    getNav(invoiceId).then(
      (nav): NavOutcome => ({ kind: "ok", nav }),
      (e): NavOutcome => (e instanceof ApiError && e.code === "NOT_PRICED" ? { kind: "unavailable" } : { kind: "hidden" }),
    ),
  ).data;
  if (!outcome || outcome.kind === "hidden") return null;
  const line = "mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-xs";
  if (outcome.kind === "unavailable") return <dd className={`${line} text-[#5A5E78]`}>NAV not available</dd>;
  const n = outcome.nav;
  if (n.status === "overdue") return <dd className={`${line} font-semibold text-[#B3261E]`}>Overdue</dd>;
  if (n.nav == null) return null;
  return (
    <dd className={`${line} text-[#5A5E78]`}>
      <span>
        NAV today: <span className="font-semibold text-[#1B2340]">{inrPrice(n.nav)}</span> per token ·{" "}
        {n.daysRemaining} {n.daysRemaining === 1 ? "day" : "days"} to maturity
      </span>
      {n.lastPublished?.hashscanUrl && (
        <a
          href={n.lastPublished.hashscanUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="whitespace-nowrap font-medium text-[#B3261E] underline-offset-4 hover:text-[#1B2340] hover:underline"
        >
          Published on Hedera ↗
        </a>
      )}
    </dd>
  );
}

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const listing = useAsync(() => getListing(id));
  const unlocked = useAsync(() => isReportUnlocked(id));
  const [report, setReport] = useState<RiskReport | null>(null);
  const shown = report ?? unlocked.data;
  const [units, setUnits] = useState("10");

  return (
    <PortalGuard>
      <div className="space-y-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <InvestorNav />
          <Link
            href="/investor"
            className="font-mono text-xs uppercase tracking-[0.08em] text-[#B3261E] no-underline hover:text-[#1B2340] hover:underline"
          >
            ← Back to marketplace
          </Link>
        </div>
        <Async state={listing}>
          {(l) => (
            <>
              <PageHeader
                folio={l.blocked ? "Folio · Blocked invoice" : `Folio · Invoice Bond ${l.tokenId}`}
                title={`${l.buyerName} · ${l.invoiceId}`}
                subtitle={l.blocked ? "Grade D · refused by the risk engine · no units for sale" : `Token ${l.tokenId} · ${l.availableUnits} units available`}
              />
              <div className="grid gap-8 lg:grid-cols-2">
                <Card className="khata-ruled relative">
                  <div
                    aria-hidden="true"
                    className="absolute top-0 bottom-0 left-3 w-0.5 bg-[#B3261E]"
                  />
                  <CardHeader className="pl-7">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle>Invoice folio</CardTitle>
                      <StampBadge label={l.blocked ? "BLOCKED" : "TOKENIZED"} tone="red" doubleBorder />
                    </div>
                  </CardHeader>
                  <CardContent className="pl-7">
                    <dl className="grid grid-cols-2 gap-6 text-sm">
                      <div>
                        <dt className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                          Amount
                        </dt>
                        <dd className="mt-1 font-mono text-2xl font-semibold text-[#1B2340]">
                          {inr(l.amount)}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                          Grade
                        </dt>
                        <dd className="mt-1">
                          <GradeBadge grade={l.grade} />
                        </dd>
                      </div>
                      <div>
                        <dt className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                          Return
                        </dt>
                        <dd className="mt-1 font-mono text-2xl font-semibold text-[#2F6B4F]">
                          {pct(l.returnPct)}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                          Due in
                        </dt>
                        <dd className="mt-1 font-mono text-2xl font-semibold text-[#1B2340]">
                          {daysUntil(l.dueDate)} days
                        </dd>
                        {(l.demoMaturity || demoMaturityText(l.maturityDate, l.dueDate)) && (
                          <dd className="mt-1 flex flex-wrap items-center gap-2 font-mono text-xs font-semibold text-[#B3261E]">
                            <DemoMaturityTag show={l.demoMaturity} />
                            {demoMaturityText(l.maturityDate, l.dueDate)}
                          </dd>
                        )}
                      </div>
                      <div className="col-span-2">
                        <dt className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                          Unit price
                        </dt>
                        <dd className="mt-1 font-mono font-semibold text-[#1B2340]">
                          {inrPrice(l.unitPrice)}{" "}
                          <span className="font-normal text-[#5A5E78]">
                            (face {inr(l.unitFaceValue)})
                          </span>
                        </dd>
                        {!l.blocked && <NavToday invoiceId={l.invoiceId} />}
                      </div>
                      <div className="col-span-2">
                        <dt className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                          Rate and term
                        </dt>
                        <dd className="mt-1 font-mono font-semibold text-[#1B2340]">
                          {termText(l.annualRatePct, l.dueDate, l.grade)}
                          {!l.blocked && l.discountPct != null && (
                            <span className="font-normal text-[#5A5E78]"> · {pct(l.discountPct)} discount</span>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                          Units available
                        </dt>
                        <dd className="mt-1 font-mono font-semibold text-[#1B2340]">
                          {l.availableUnits}
                        </dd>
                      </div>
                    </dl>
                  </CardContent>
                </Card>

                {l.blocked ? (
                  <Card>
                    <CardHeader>
                      <CardTitle>Not for sale</CardTitle>
                      <CardDescription>
                        The risk engine graded this invoice D, so it cannot be tokenized or bought.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <StampBadge label="BLOCKED · GRADE D" tone="red" doubleBorder />
                    </CardContent>
                  </Card>
                ) : (
                <Card>
                  <CardHeader>
                    <CardTitle>Buy units</CardTitle>
                    <CardDescription>
                      Only KYC-approved wallets can hold this token.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    <Field
                      label="Units"
                      hint={`Total ${inrPrice((Number(units) || 0) * l.unitPrice)} · pays out ${inr((Number(units) || 0) * l.unitFaceValue)} on the due date${demoMaturityText(l.maturityDate, l.dueDate) ? ` (${demoMaturityText(l.maturityDate, l.dueDate)})` : ""}`}
                    >
                      <Input
                        type="number"
                        min={1}
                        max={l.availableUnits}
                        value={units}
                        onChange={(e) => setUnits(e.target.value)}
                      />
                    </Field>
                    <AsyncButton
                      action={() => buyUnits({ invoiceId: l.invoiceId, units: Number(units) })}
                      pendingMessage="Paying uINR and transferring bond units on Hedera…"
                      onDone={listing.reload}
                      disabled={!Number(units)}
                    >
                      Buy units
                    </AsyncButton>
                  </CardContent>
                </Card>
                )}
              </div>

              <TrustPanel invoiceId={l.invoiceId} />

              <Card>
                <CardHeader>
                  <CardTitle>Risk report</CardTitle>
                  <CardDescription>
                    Explainable score, paid per report in uINR over x402.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {shown ? (
                    <div className="space-y-6">
                      {(shown.settlement?.transactionId || shown.paymentTx || shown.replayed) && (
                        <div className="flex flex-wrap items-center justify-between gap-3 border border-[#C9B98F] bg-[#F1E8D2]/70 px-3.5 py-2.5 font-mono text-xs text-[#1B2340]">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold uppercase tracking-[0.06em] text-[#2F6B4F]">
                              Paid over x402
                            </span>
                            {(shown.settlement?.transactionId ?? shown.paymentTx) && (
                              <span className="break-all text-[#5A5E78]">
                                · {shown.settlement?.transactionId ?? shown.paymentTx}
                              </span>
                            )}
                            {shown.replayed && (
                              <StampBadge
                                label="Already purchased, no charge"
                                tone="green"
                                tilt={false}
                                className="px-2 py-0 text-[11px] normal-case"
                              />
                            )}
                          </div>
                          <HashscanLink
                            href={shown.settlement?.hashscanUrl || shown.hashscanUrl}
                          />
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-6">
                        <div>
                          <p className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                            Score
                          </p>
                          <p className="font-mono text-4xl font-semibold text-[#1B2340]">
                            {shown.riskScore}
                            <span className="text-lg text-[#5A5E78]">/100</span>
                          </p>
                        </div>
                        <div>
                          <p className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                            Confidence
                          </p>
                          <Badge
                            variant={
                              shown.confidence === "HIGH"
                                ? "green"
                                : shown.confidence === "MEDIUM"
                                  ? "blue"
                                  : "amber"
                            }
                          >
                            {shown.confidence}
                          </Badge>
                        </div>
                        <div>
                          <p className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                            Grade
                          </p>
                          <GradeBadge grade={shown.grade} />
                        </div>
                        <div>
                          <p className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                            Fraud flags
                          </p>
                          <p className="font-mono font-medium text-[#1B2340]">
                            {shown.fraudFlags.length === 0 ? "None" : shown.fraudFlags.join(", ")}
                          </p>
                        </div>
                        {shown.anomaly && (
                          <div>
                            <p className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                              Anomaly
                            </p>
                            <Badge variant="amber">Warning</Badge>
                          </div>
                        )}
                      </div>
                      <div>
                        <p className="mb-2 font-mono text-xs uppercase tracking-[0.06em] text-[#1B2340]">
                          Price
                        </p>
                        <p className="font-mono text-sm text-[#1B2340]">
                          {shown.grade === "D" || shown.annualRatePct == null
                            ? "Not listed: grade D."
                            : `${termText(shown.annualRatePct, l.dueDate, shown.grade)}${
                                shown.suggestedDiscountPct != null
                                  ? ` · ${pct(shown.suggestedDiscountPct)} discount`
                                  : " · no suggested discount"
                              }`}
                          {shown.appliedDiscountPct != null &&
                            ` · applied ${pct(shown.appliedDiscountPct)}`}
                        </p>
                      </div>
                      <div>
                        <p className="mb-2 font-mono text-xs uppercase tracking-[0.06em] text-[#1B2340]">
                          Why this score
                        </p>
                        <ul className="list-disc space-y-1 pl-5 text-sm text-[#1B2340]">
                          {shown.reasons.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      </div>
                      {shown.graph && shown.graph.nodes.length > 0 && (
                        <div>
                          <p className="mb-2 font-mono text-xs uppercase tracking-[0.06em] text-[#1B2340]">
                            Who is linked (people masked)
                          </p>
                          <MiniGraph graph={shown.graph} />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-start gap-3">
                      <p className="flex items-center gap-2 font-mono text-sm text-[#5A5E78]">
                        <Lock className="h-4 w-4" /> Score, confidence and reasons are locked behind
                        x402.
                      </p>
                      <AsyncButton
                        variant="outline"
                        action={() => buyRiskReport(id)}
                        pendingMessage="Paying ₹1.01 in uINR over x402 on Hedera…"
                        pendingHint="settling a paid report usually takes 5–15 seconds, please keep this page open"
                        onDone={(r) => setReport(r as RiskReport)}
                      >
                        <Lock className="h-4 w-4" /> Buy report · ₹1.01
                      </AsyncButton>
                      <p className="font-mono text-xs text-[#5A5E78]">
                        ₹1.00 plus the 1% uINR fee (₹0.01 to the pool). Usually takes 5 to 15
                        seconds.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </Async>
      </div>
    </PortalGuard>
  );
}

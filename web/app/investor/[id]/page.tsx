"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Async, AsyncButton, Field, GradeBadge, HashscanLink, PageHeader } from "@/components/common";
import { useAsync } from "@/hooks/use-async";
import { buyRiskReport, buyUnits, getListing, isReportUnlocked } from "@/lib/api";
import { inr } from "@/lib/utils";
import type { RiskReport } from "@/lib/types";

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const listing = useAsync(() => getListing(id));
  const unlocked = useAsync(() => isReportUnlocked(id));
  const [report, setReport] = useState<RiskReport | null>(null);
  const shown = report ?? unlocked.data;
  const [units, setUnits] = useState("10");

  return (
    <div className="space-y-8">
      <Link href="/investor" className="text-sm text-indigo-600 hover:underline">← Back to marketplace</Link>
      <Async state={listing}>
        {(l) => (
          <>
            <PageHeader title={`${l.buyerName} · ${l.invoiceId}`} subtitle={`Token ${l.tokenId}`} />
            <div className="grid gap-8 lg:grid-cols-2">
              <Card>
                <CardHeader><CardTitle>Invoice</CardTitle></CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-6 text-sm">
                    <div><dt className="text-slate-500">Amount</dt><dd className="mt-1 text-xl font-semibold">{inr(l.amount)}</dd></div>
                    <div><dt className="text-slate-500">Grade</dt><dd className="mt-1"><GradeBadge grade={l.grade} /></dd></div>
                    <div><dt className="text-slate-500">Return</dt><dd className="mt-1 text-xl font-semibold text-emerald-600">{l.returnPct}%</dd></div>
                    <div><dt className="text-slate-500">Days to maturity</dt><dd className="mt-1 text-xl font-semibold">{l.daysToMaturity}</dd></div>
                    <div><dt className="text-slate-500">Unit price</dt><dd className="mt-1 font-medium">{inr(l.unitPrice)} <span className="text-slate-400">(face {inr(l.unitFaceValue)})</span></dd></div>
                    <div><dt className="text-slate-500">Units available</dt><dd className="mt-1 font-medium">{l.availableUnits}</dd></div>
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Buy units</CardTitle>
                  <CardDescription>Only KYC-approved wallets can hold this token.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <Field label="Units" hint={`Total ${inr((Number(units) || 0) * l.unitPrice)} · pays out ${inr((Number(units) || 0) * l.unitFaceValue)} in ${l.daysToMaturity} days`}>
                    <Input type="number" min={1} max={l.availableUnits} value={units} onChange={(e) => setUnits(e.target.value)} />
                  </Field>
                  <AsyncButton action={() => buyUnits({ invoiceId: l.invoiceId, units: Number(units) })} pendingMessage="Paying uINR and transferring bond units on Hedera…" onDone={listing.reload} disabled={!Number(units)}>
                    Buy units
                  </AsyncButton>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Risk report</CardTitle>
                <CardDescription>Explainable score, sold per call over x402.</CardDescription>
              </CardHeader>
              <CardContent>
                {shown ? (
                  <div className="space-y-6">
                    <div className="flex flex-wrap items-center gap-6">
                      <div><p className="text-sm text-slate-500">Score</p><p className="text-4xl font-semibold">{shown.riskScore}<span className="text-lg text-slate-400">/100</span></p></div>
                      <div><p className="text-sm text-slate-500">Confidence</p><Badge variant={shown.confidence === "HIGH" ? "green" : shown.confidence === "MEDIUM" ? "blue" : "amber"}>{shown.confidence}</Badge></div>
                      <div><p className="text-sm text-slate-500">Grade</p><GradeBadge grade={shown.grade} /></div>
                      <div><p className="text-sm text-slate-500">Fraud flags</p><p className="font-medium">{shown.fraudFlags.length === 0 ? "None" : shown.fraudFlags.join(", ")}</p></div>
                      <HashscanLink href={shown.hashscanUrl} />
                    </div>
                    <div>
                      <p className="mb-2 text-sm font-medium text-slate-700">Why this score</p>
                      <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
                        {shown.reasons.map((r) => <li key={r}>{r}</li>)}
                      </ul>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-start gap-4">
                    <p className="flex items-center gap-2 text-sm text-slate-500"><Lock className="h-4 w-4" /> Score, confidence and reasons are locked.</p>
                    <AsyncButton variant="outline" action={() => buyRiskReport(id)} onDone={(r) => setReport(r as RiskReport)}>
                      <Lock className="h-4 w-4" /> Get full risk report: 0.01 USDC
                    </AsyncButton>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}


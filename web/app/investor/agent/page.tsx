"use client";
import * as React from "react";
import { AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import {
  Async,
  Empty,
  ErrorNote,
  Field,
  GradeBadge,
  HashscanLink,
  InvestorNav,
  PageHeader,
  Pending,
  PortalGuard,
  StampBadge,
  type StampTone,
} from "@/components/common";
import { useAsync } from "@/hooks/use-async";
import { getAgentRuns, runAgent } from "@/lib/api";
import type { AgentMinGrade, AgentRun, Grade } from "@/lib/types";
import { errLink, errMsg, fmtDateTime, inrPrice } from "@/lib/utils";

const STATUS_TONE: Record<AgentRun["status"], StampTone> = {
  completed: "green",
  running: "blue",
  stopped: "red",
  interrupted: "amber",
};

function toGrade(g: string): Grade | undefined {
  return g === "A" || g === "B" || g === "C" || g === "D" ? g : undefined;
}

export default function InvestorAgentPage() {
  const pastRuns = useAsync(getAgentRuns);
  const [reportBudget, setReportBudget] = React.useState("5");
  const [investmentBudget, setInvestmentBudget] = React.useState("5000");
  const [minGrade, setMinGrade] = React.useState<AgentMinGrade>("B");
  const [maxUnitsPerInvoice, setMaxUnitsPerInvoice] = React.useState("5");

  const busyRef = React.useRef(false);
  const receiptRef = React.useRef<HTMLElement | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errorUrl, setErrorUrl] = React.useState<string | undefined>();
  const [selectedRun, setSelectedRun] = React.useState<AgentRun | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setRunning(true);
    setError(null);
    setErrorUrl(undefined);
    try {
      const receipt = await runAgent({
        reportBudget: Number(reportBudget),
        investmentBudget: Number(investmentBudget),
        minGrade,
        maxUnitsPerInvoice: Number(maxUnitsPerInvoice),
      });
      setSelectedRun(receipt);
      pastRuns.reload();
    } catch (err) {
      setError(errMsg(err));
      setErrorUrl(errLink(err));
    } finally {
      busyRef.current = false;
      setRunning(false);
    }
  }

  function openReceipt(run: AgentRun) {
    setSelectedRun(run);
    requestAnimationFrame(() => {
      receiptRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  const activeReceipt = selectedRun ?? pastRuns.data?.[0] ?? null;

  return (
    <PortalGuard>
      <div className="space-y-10">
        <InvestorNav />

        <div className="space-y-3">
          <PageHeader
            folio="Folio · Investor Agent (x402 · HCS)"
            title="Auto-invest agent"
            subtitle="Autonomous rule-based pass over live invoice bonds"
          />
          <p className="max-w-3xl text-base leading-relaxed text-[#1B2340]">
            The agent pays for each risk report over x402 and buys what passes these rules, with no
            approval needed after it starts — the rules are enforced in code, not by AI.
          </p>
        </div>

        <Card className="khata-ruled relative">
          <div
            aria-hidden="true"
            className="absolute top-0 bottom-0 left-3 w-0.5 bg-[#B3261E] sm:left-5"
          />
          <CardHeader className="pl-7 sm:pl-10">
            <CardTitle>Agent rules</CardTitle>
            <CardDescription>
              Every field is required and bounds one pass across the marketplace.
            </CardDescription>
          </CardHeader>
          <CardContent className="pl-7 sm:pl-10">
            <form onSubmit={onSubmit} className="space-y-6">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field
                  label="Report budget (₹)"
                  hint="Rupees for this run, includes the 1% uINR fee · maximum ₹50."
                >
                  <Input
                    required
                    type="number"
                    min={0.01}
                    max={50}
                    step="any"
                    value={reportBudget}
                    onChange={(e) => setReportBudget(e.target.value)}
                  />
                </Field>
                <Field
                  label="Investment budget (₹)"
                  hint="Rupees for this run, includes the 1% uINR fee · maximum ₹50,000."
                >
                  <Input
                    required
                    type="number"
                    min={1}
                    max={50000}
                    step="any"
                    value={investmentBudget}
                    onChange={(e) => setInvestmentBudget(e.target.value)}
                  />
                </Field>
                <Field
                  label="Minimum grade"
                  hint="Only Grade A, B or C can be selected (Grade D is never eligible)."
                >
                  <Select
                    required
                    value={minGrade}
                    onChange={(e) => setMinGrade(e.target.value as AgentMinGrade)}
                  >
                    <option value="A">Grade A (80+ score · 12% a year)</option>
                    <option value="B">Grade B (65–79 score · 16% a year)</option>
                    <option value="C">Grade C (50–64 score · 20% a year)</option>
                  </Select>
                </Field>
                <Field
                  label="Max units per invoice"
                  hint="Positive whole number. This is your total position in an invoice, including units already held."
                >
                  <Input
                    required
                    type="number"
                    min={1}
                    step={1}
                    value={maxUnitsPerInvoice}
                    onChange={(e) => setMaxUnitsPerInvoice(e.target.value)}
                  />
                </Field>
              </div>

              <p className="border-l-2 border-[#B3261E] bg-[#FBF6EA]/90 py-2 pl-3 font-mono text-xs text-[#1B2340]">
                Note: invoices with a fraud flag or an anomaly warning are always skipped, regardless
                of minimum grade.
              </p>

              <div className="space-y-3">
                <Button type="submit" loading={running} disabled={running}>
                  Run agent
                </Button>
                <Pending
                  active={running}
                  message="Running auto-invest agent over x402 and Hedera (usually 1–2 minutes)…"
                  hint="an agent pass usually takes 1–2 minutes — please keep this page open"
                />
                <ErrorNote message={error} href={errorUrl} />
              </div>
            </form>
          </CardContent>
        </Card>

        {activeReceipt && (
          <section ref={receiptRef} id="agent-receipt" className="space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-serif text-3xl font-normal text-[#1B2340]">Run receipt</h2>
              <span className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                {activeReceipt.runId}
              </span>
            </div>
            <ReceiptCard receipt={activeReceipt} />
          </section>
        )}

        <section className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-serif text-3xl font-normal text-[#1B2340]">Past runs</h2>
            <span className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
              Newest first · click any run to inspect its receipt
            </span>
          </div>
          <Async state={pastRuns}>
            {(runs) =>
              runs.length === 0 ? (
                <Empty>No agent runs recorded yet.</Empty>
              ) : (
                <Card className="khata-ruled relative">
                  <div
                    aria-hidden="true"
                    className="absolute top-0 bottom-0 left-3 w-0.5 bg-[#B3261E]"
                  />
                  <CardContent className="overflow-x-auto p-0 pl-5">
                    <table className="w-full text-sm">
                      <thead className="border-b-2 border-[#1B2340] text-left font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                        <tr>
                          {[
                            "Run",
                            "Started",
                            "Status",
                            "Checked",
                            "Reports spent",
                            "Units spent",
                            "Audit",
                            "",
                          ].map((h) => (
                            <th key={h} className="px-4 py-3.5 font-semibold">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#A9BEDB] font-mono">
                        {runs.map((r) => {
                          const isViewing = activeReceipt?.runId === r.runId;
                          return (
                            <tr
                              key={r.runId}
                              className={isViewing ? "bg-[#F1E8D2]/70" : undefined}
                            >
                              <td className="px-4 py-3.5 text-xs font-semibold text-[#1B2340]">
                                {r.runId}
                              </td>
                              <td className="px-4 py-3.5 text-xs text-[#5A5E78]">
                                {fmtDateTime(r.startedAt)}
                              </td>
                              <td className="px-4 py-3.5">
                                <StampBadge
                                  label={r.status.toUpperCase()}
                                  tone={STATUS_TONE[r.status] ?? "navy"}
                                  doubleBorder={r.status === "completed" || r.status === "stopped"}
                                  tilt={false}
                                />
                              </td>
                              <td className="px-4 py-3.5 text-xs">{r.invoicesChecked.length}</td>
                              <td className="px-4 py-3.5 text-xs">
                                {inrPrice(r.spentOnReports)} / {inrPrice(r.rules.reportBudget)}
                              </td>
                              <td className="px-4 py-3.5 text-xs">
                                {inrPrice(r.spentOnUnits)} / {inrPrice(r.rules.investmentBudget)}
                              </td>
                              <td className="px-4 py-3.5 text-xs">
                                <HashscanLink href={r.hashscanUrl} label="HCS log" />
                              </td>
                              <td className="px-4 py-3.5 text-right">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={isViewing ? "default" : "outline"}
                                  onClick={() => openReceipt(r)}
                                >
                                  {isViewing ? "Viewing" : "Open receipt"}
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              )
            }
          </Async>
        </section>
      </div>
    </PortalGuard>
  );
}

function ReceiptCard({ receipt }: { receipt: AgentRun }) {
  const halted = receipt.status === "stopped" || receipt.status === "interrupted";

  return (
    <Card className="khata-ruled relative">
      <div
        aria-hidden="true"
        className="absolute top-0 bottom-0 left-3 w-0.5 bg-[#B3261E] sm:left-5"
      />
      <CardHeader className="pl-7 sm:pl-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-3">
              <span>Receipt · {receipt.runId}</span>
              <StampBadge
                label={receipt.status.toUpperCase()}
                tone={STATUS_TONE[receipt.status] ?? "navy"}
                doubleBorder={receipt.status === "completed" || halted}
              />
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              Started {fmtDateTime(receipt.startedAt)}
              {receipt.finishedAt ? ` · finished ${fmtDateTime(receipt.finishedAt)}` : ""}
              {` · min grade ${receipt.rules.minGrade} · max ${receipt.rules.maxUnitsPerInvoice} units/invoice`}
            </CardDescription>
          </div>
          <HashscanLink
            href={receipt.hashscanUrl}
            label={
              receipt.auditTopicId ? `HCS audit log (${receipt.auditTopicId})` : "HCS audit log"
            }
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-8 pl-7 sm:pl-10">
        {halted && (
          <div
            role="alert"
            className="flex flex-wrap items-start gap-3 border-2 border-[#B3261E] bg-[#FBF6EA] p-4 text-sm text-[#B3261E]"
          >
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="space-y-1">
              <p className="font-mono text-xs font-semibold uppercase tracking-[0.06em]">
                Run {receipt.status} before completing
              </p>
              <p className="font-semibold text-[#1B2340]">
                {receipt.stopReason || "The run stopped early."}
              </p>
              <p className="font-mono text-xs text-[#5A5E78]">
                Spent on this run: <strong className="text-[#1B2340]">{inrPrice(receipt.spentOnReports)}</strong>{" "}
                of {inrPrice(receipt.rules.reportBudget)} on reports ·{" "}
                <strong className="text-[#1B2340]">{inrPrice(receipt.spentOnUnits)}</strong> of{" "}
                {inrPrice(receipt.rules.investmentBudget)} on units.
              </p>
            </div>
          </div>
        )}

        {/* Top-level summary metrics */}
        <dl className="grid gap-4 border border-[#C9B98F] bg-[#FBF6EA]/90 p-4 sm:grid-cols-3">
          <div>
            <dt className="font-mono text-xs uppercase tracking-[0.06em] text-[#B3261E]">
              Invoices checked ({receipt.invoicesChecked.length})
            </dt>
            <dd className="mt-1 font-mono text-sm font-semibold text-[#1B2340]">
              {receipt.invoicesChecked.length === 0
                ? "None"
                : receipt.invoicesChecked.join(", ")}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-xs uppercase tracking-[0.06em] text-[#B3261E]">
              Report spending vs budget
            </dt>
            <dd className="mt-1 font-mono text-xl font-semibold text-[#1B2340]">
              {inrPrice(receipt.spentOnReports)}{" "}
              <span className="text-sm font-normal text-[#5A5E78]">
                / {inrPrice(receipt.rules.reportBudget)}
              </span>
            </dd>
          </div>
          <div>
            <dt className="font-mono text-xs uppercase tracking-[0.06em] text-[#B3261E]">
              Unit purchases vs budget
            </dt>
            <dd className="mt-1 font-mono text-xl font-semibold text-[#1B2340]">
              {inrPrice(receipt.spentOnUnits)}{" "}
              <span className="text-sm font-normal text-[#5A5E78]">
                / {inrPrice(receipt.rules.investmentBudget)}
              </span>
            </dd>
          </div>
        </dl>

        {/* Paid reports */}
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-serif text-2xl text-[#1B2340]">
              Paid risk reports ({receipt.reports.length})
            </h3>
            <span className="font-mono text-xs text-[#5A5E78]">
              Spent {inrPrice(receipt.spentOnReports)} of {inrPrice(receipt.rules.reportBudget)}
            </span>
          </div>
          {receipt.reports.length === 0 ? (
            <p className="font-mono text-xs text-[#5A5E78]">No reports purchased in this run.</p>
          ) : (
            <div className="overflow-x-auto border border-[#C9B98F] bg-[#FBF6EA]/90">
              <table className="w-full text-sm">
                <thead className="border-b border-[#1B2340] text-left font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                  <tr>
                    {["Invoice", "Grade", "Score", "Flags / anomaly", "Paid", "Settlement", ""].map(
                      (h) => (
                        <th key={h} className="px-3 py-2.5 font-semibold">
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#A9BEDB] font-mono text-xs">
                  {receipt.reports.map((r, idx) => {
                    const g = toGrade(r.grade);
                    return (
                      <tr key={`${r.invoiceId}-${r.transactionId || idx}`}>
                        <td className="px-3 py-2.5 font-semibold text-[#1B2340]">{r.invoiceId}</td>
                        <td className="px-3 py-2.5">
                          {g ? <GradeBadge grade={g} /> : <Badge>{r.grade}</Badge>}
                        </td>
                        <td className="px-3 py-2.5">{r.riskScore}/100</td>
                        <td className="px-3 py-2.5">
                          {r.fraudFlags.length > 0
                            ? r.fraudFlags.join(", ")
                            : r.anomaly
                              ? "Anomaly warning"
                              : "Clean"}
                        </td>
                        <td className="px-3 py-2.5">
                          {inrPrice(r.amount + r.feeToPool)}{" "}
                          <span className="text-[#5A5E78]">
                            ({inrPrice(r.amount)} + {inrPrice(r.feeToPool)} fee)
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-[#5A5E78]">{r.transactionId || "—"}</td>
                        <td className="px-3 py-2.5 text-right">
                          <HashscanLink href={r.hashscanUrl} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Purchases */}
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-serif text-2xl text-[#1B2340]">
              Purchases ({receipt.purchases.length})
            </h3>
            <span className="font-mono text-xs text-[#5A5E78]">
              Spent {inrPrice(receipt.spentOnUnits)} of {inrPrice(receipt.rules.investmentBudget)}
            </span>
          </div>
          {receipt.purchases.length === 0 ? (
            <p className="font-mono text-xs text-[#5A5E78]">No units bought in this run.</p>
          ) : (
            <div className="overflow-x-auto border border-[#C9B98F] bg-[#FBF6EA]/90">
              <table className="w-full text-sm">
                <thead className="border-b border-[#1B2340] text-left font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                  <tr>
                    {["Invoice", "Units", "Unit price", "Total spent", "On-chain proofs"].map(
                      (h) => (
                        <th key={h} className="px-3 py-2.5 font-semibold">
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#A9BEDB] font-mono text-xs">
                  {receipt.purchases.map((p, idx) => (
                    <tr key={`${p.invoiceId}-${idx}`}>
                      <td className="px-3 py-2.5 font-semibold text-[#1B2340]">{p.invoiceId}</td>
                      <td className="px-3 py-2.5">{p.units}</td>
                      <td className="px-3 py-2.5">{inrPrice(p.unitPrice)}</td>
                      <td className="px-3 py-2.5">
                        {inrPrice(p.amount + p.feeToPool)}{" "}
                        <span className="text-[#5A5E78]">
                          ({inrPrice(p.amount)} + {inrPrice(p.feeToPool)} fee)
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-3">
                          <HashscanLink href={p.paymentHashscanUrl} label="Payment" />
                          <HashscanLink href={p.unitsHashscanUrl} label="Units" />
                          {!p.paymentHashscanUrl && !p.unitsHashscanUrl && (
                            <span className="text-[#5A5E78]">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Skipped invoices */}
        <div className="space-y-2.5">
          <h3 className="font-serif text-2xl text-[#1B2340]">
            Skipped invoices ({receipt.skipped.length})
          </h3>
          {receipt.skipped.length === 0 ? (
            <p className="font-mono text-xs text-[#5A5E78]">No invoices skipped in this run.</p>
          ) : (
            <div className="overflow-x-auto border border-[#C9B98F] bg-[#FBF6EA]/90">
              <table className="w-full text-sm">
                <thead className="border-b border-[#1B2340] text-left font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                  <tr>
                    {["Invoice", "Code", "Reason", "Report charge"].map((h) => (
                      <th key={h} className="px-3 py-2.5 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#A9BEDB] font-mono text-xs">
                  {receipt.skipped.map((s, idx) => (
                    <tr key={`${s.invoiceId}-${s.code}-${idx}`}>
                      <td className="px-3 py-2.5 font-semibold text-[#1B2340]">{s.invoiceId}</td>
                      <td className="px-3 py-2.5">
                        <Badge>{s.code}</Badge>
                      </td>
                      <td className="px-3 py-2.5 font-sans text-sm text-[#1B2340]">{s.reason}</td>
                      <td className="px-3 py-2.5">
                        {s.paidForReport ? (
                          <StampBadge label="Report paid" tone="blue" tilt={false} />
                        ) : (
                          <span className="text-[#5A5E78]">Not paid</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* HCS audit messages if present */}
        {receipt.auditMessages && receipt.auditMessages.some((m) => Boolean(m.hashscanUrl)) && (
          <div className="space-y-2 border-t border-[#C9B98F] pt-4">
            <p className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
              Recorded HCS audit messages
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {receipt.auditMessages
                .filter((m) => Boolean(m.hashscanUrl))
                .map((m, idx) => (
                  <HashscanLink
                    key={`${m.type}-${m.txId ?? idx}`}
                    href={m.hashscanUrl}
                    label={m.type}
                  />
                ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}


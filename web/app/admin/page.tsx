"use client";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Async,
  AsyncButton,
  Empty,
  GradeBadge,
  HashscanLink,
  InvoiceStamp,
  PageHeader,
  PortalGuard,
  StampBadge,
} from "@/components/common";
import { useAsync } from "@/hooks/use-async";
import {
  createToken,
  getAuditLog,
  getAwaitingTokenization,
  getKycRequests,
  getTokens,
  reviewKyc,
  setHolderFrozen,
  setTokenPaused,
} from "@/lib/api";
import { RATE_BY_GRADE, demoMaturityText, fmtDate, fmtDateTime, inr, pct, termText } from "@/lib/utils";
import type { TokenInfo } from "@/lib/types";

export default function AdminPage() {
  const kyc = useAsync(getKycRequests);
  const queue = useAsync(getAwaitingTokenization);
  const tokens = useAsync(getTokens);
  const audit = useAsync(getAuditLog);
  // Refresh after a pause so each HashScan link stays visible for a moment.
  const refresh = () =>
    setTimeout(() => {
      kyc.reload();
      queue.reload();
      tokens.reload();
      audit.reload();
    }, 3500);
  const refreshNow = () => {
    tokens.reload();
    audit.reload();
  };

  return (
    <PortalGuard>
      <div className="space-y-10">
        <PageHeader
          folio="Folio · Operator (Admin · 0.0.11227777)"
          title="Operator khata"
          subtitle="Platform operator · approvals, tokens and compliance"
        />

        <Card className="khata-ruled relative">
          <div
            aria-hidden="true"
            className="absolute top-0 bottom-0 left-3 w-0.5 bg-[#B3261E] sm:left-5"
          />
          <CardHeader className="pl-7 sm:pl-10">
            <CardTitle>KYC approvals</CardTitle>
            <CardDescription>
              Every applicant&apos;s wallet is scanned against known scam wallets.
            </CardDescription>
          </CardHeader>
          <CardContent className="pl-7 sm:pl-10">
            <Async state={kyc}>
              {(list) =>
                list.length === 0 ? (
                  <Empty>No requests.</Empty>
                ) : (
                  <ul className="divide-y divide-[#A9BEDB]">
                    {list.map((k) => (
                      <li
                        key={k.id}
                        className="flex flex-wrap items-center justify-between gap-4 py-5"
                      >
                        <div className="space-y-1.5">
                          <p className="font-serif text-2xl text-[#1B2340]">
                            {k.fullName}{" "}
                            <span className="font-mono text-sm font-normal text-[#5A5E78]">
                              · {k.walletAddress} · {k.country}
                            </span>
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge
                              variant={
                                k.walletScan === "clean"
                                  ? "green"
                                  : k.walletScan === "flagged"
                                    ? "red"
                                    : "default"
                              }
                            >
                              Wallet scan:{" "}
                              {k.walletScan === "not_checked"
                                ? "not checked (simulated)"
                                : k.walletScan}
                            </Badge>
                            {k.walletScanNote && (
                              <span className="font-mono text-xs text-[#B3261E]">
                                {k.walletScanNote}
                              </span>
                            )}
                          </div>
                        </div>
                        {k.status === "pending" ? (
                          <div className="flex flex-wrap items-start gap-3">
                            <AsyncButton
                              action={() => reviewKyc(k.id, true)}
                              onDone={refresh}
                              disabled={k.walletScan === "flagged"}
                              pendingMessage="Adding the wallet to the token allowlist on Hedera…"
                            >
                              Approve
                            </AsyncButton>
                            <AsyncButton
                              variant="outline"
                              action={() => reviewKyc(k.id, false)}
                              onDone={refresh}
                            >
                              Reject
                            </AsyncButton>
                          </div>
                        ) : (
                          <div className="flex items-center gap-3">
                            <StampBadge
                              label={k.status === "approved" ? "CONFIRMED" : "BLOCKED"}
                              tone={k.status === "approved" ? "green" : "red"}
                              doubleBorder
                            />
                            <HashscanLink href={k.hashscanUrl} />
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )
              }
            </Async>
          </CardContent>
        </Card>

        <Card className="khata-ruled relative">
          <div
            aria-hidden="true"
            className="absolute top-0 bottom-0 left-3 w-0.5 bg-[#B3261E] sm:left-5"
          />
          <CardHeader className="pl-7 sm:pl-10">
            <CardTitle>Awaiting tokenization</CardTitle>
            <CardDescription>
              Buyer-confirmed invoices. Tokens are 1,000 per unit, KYC-only.
            </CardDescription>
          </CardHeader>
          <CardContent className="pl-7 sm:pl-10">
            <Async state={queue}>
              {(list) =>
                list.length === 0 ? (
                  <Empty>No invoices waiting.</Empty>
                ) : (
                  <ul className="divide-y divide-[#A9BEDB]">
                    {list.map((i) => (
                      <li
                        key={i.id}
                        className="flex flex-wrap items-center justify-between gap-4 py-5"
                      >
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2.5">
                            <span className="font-mono text-base font-semibold text-[#1B2340]">
                              {i.id}
                            </span>
                            <span className="font-serif text-2xl text-[#1B2340]">
                              {i.supplierName} → {i.buyerName}
                            </span>
                            <InvoiceStamp status={i.status} />
                          </div>
                          <p className="font-mono text-sm text-[#5A5E78]">
                            <strong className="font-semibold text-[#1B2340]">
                              {inr(i.amount)}
                            </strong>{" "}
                            · due {fmtDate(i.dueDate)}\n                            {i.grade ? ` · ${termText(RATE_BY_GRADE[i.grade], i.dueDate, i.grade)}` : " · not graded yet"}\n                            {i.discountPct != null ? ` · ${pct(i.discountPct)} discount` : ""}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-start gap-3">
                          <GradeBadge grade={i.grade} className="mt-2" />
                          <CreateToken id={i.id} onDone={refresh} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )
              }
            </Async>
          </CardContent>
        </Card>

        <section className="space-y-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-serif text-3xl font-normal text-[#1B2340]">
              Token controls and repayment
            </h2>
            <span className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
              ATS security tokens · pause, freeze &amp; redemption
            </span>
          </div>
          <Async state={tokens}>
            {(list) =>
              list.length === 0 ? (
                <Empty>No tokens yet.</Empty>
              ) : (
                <>
                  {list.map((t) => (
                    <TokenCard key={t.tokenId} t={t} onDone={refreshNow} />
                  ))}
                </>
              )
            }
          </Async>
        </section>

        <Card className="khata-ruled relative">
          <div
            aria-hidden="true"
            className="absolute top-0 bottom-0 left-3 w-0.5 bg-[#B3261E] sm:left-5"
          />
          <CardHeader className="pl-7 sm:pl-10">
            <CardTitle>Audit log</CardTitle>
            <CardDescription>Every action, with its transaction.</CardDescription>
          </CardHeader>
          <CardContent className="pl-7 sm:pl-10">
            <Async state={audit}>
              {(list) => (
                <ul className="divide-y divide-[#A9BEDB]">
                  {list.map((t) => (
                    <li
                      key={t.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-3.5 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-[#5A5E78]">
                          {fmtDateTime(t.timestamp)}
                        </span>
                        <Badge>{t.actor}</Badge>
                        {t.type === "duplicate_rejected" && (
                          <StampBadge label="DUPLICATE" tone="red" tilt={false} />
                        )}
                        {(t.type === "risk_blocked" ||
                          (t.status === "rejected" && t.type !== "duplicate_rejected")) && (
                          <StampBadge label="BLOCKED" tone="red" tilt={false} />
                        )}
                        <span className="font-mono text-xs sm:text-sm">{t.description}</span>
                      </div>
                      <HashscanLink href={t.hashscanUrl} />
                    </li>
                  ))}
                </ul>
              )}
            </Async>
          </CardContent>
        </Card>
      </div>
    </PortalGuard>
  );
}

function CreateToken({ id, onDone }: { id: string; onDone: () => void }) {
  const [minutes, setMinutes] = useState("");
  return (
    <div className="flex flex-wrap items-start gap-3">
      <Input
        type="number"
        min={1}
        value={minutes}
        onChange={(e) => setMinutes(e.target.value)}
        placeholder="Maturity in min (demo)"
        aria-label="Maturity in minutes (demo)"
        className="w-48"
      />
      <AsyncButton
        action={() => createToken(id, { maturityMinutes: Number(minutes) || undefined })}
        onDone={onDone}
        pendingMessage="Deploying the bond on Hedera. This takes about a minute…"
      >
        Create token
      </AsyncButton>
    </div>
  );
}

function TokenCard({ t, onDone }: { t: TokenInfo; onDone: () => void }) {
  return (
    <Card className="khata-ruled relative">
      <div
        aria-hidden="true"
        className="absolute top-0 bottom-0 left-3 w-0.5 bg-[#B3261E] sm:left-5"
      />
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-4 pl-7 sm:pl-10">
        <div>
          <CardTitle>
            <span className="font-mono text-xl font-semibold">{t.invoiceId}</span> · {t.buyerName}
            {t.symbol ? ` (${t.symbol})` : ""}
          </CardTitle>
          <CardDescription className="font-mono text-xs">
            Token {t.tokenId} · {t.totalUnits} units of {inr(t.unitFaceValue)}
            {demoMaturityText(t.maturityDate, t.dueDate ?? t.maturityDate) && (
              <span className="font-semibold text-[#B3261E]">
                {" "}
                · {demoMaturityText(t.maturityDate, t.dueDate ?? t.maturityDate)}
              </span>
            )}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {t.hashscanUrl && <HashscanLink href={t.hashscanUrl} />}
          <StampBadge
            label={t.repaid ? "REPAID" : t.paused ? "BLOCKED · PAUSED" : "TOKENIZED"}
            tone={t.repaid ? "green" : t.paused ? "red" : "red"}
            doubleBorder
          />
          {!t.repaid && (
            <AsyncButton
              variant={t.paused ? "default" : "destructive"}
              size="sm"
              action={() => setTokenPaused(t.tokenId, !t.paused)}
              pendingMessage={
                t.paused ? "Unpausing token on Hedera…" : "Pausing token on Hedera…"
              }
              onDone={onDone}
            >
              {t.paused ? "Unpause token" : "Pause token"}
            </AsyncButton>
          )}
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto pl-7 sm:pl-10">
        {t.holders.length === 0 ? (
          <Empty>No holders yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b-2 border-[#1B2340] text-left font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
              <tr>
                {[
                  "Holder",
                  "Account",
                  "Units",
                  "Amount paid",
                  "Repayment at maturity",
                  "Status",
                  "",
                ].map((h) => (
                  <th key={h} className="py-3 pr-4 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#A9BEDB] font-mono">
              {t.holders.map((h) => (
                <tr key={h.accountId}>
                  <td className="py-4 pr-4 font-sans font-medium text-[#1B2340]">{h.name}</td>
                  <td className="py-4 pr-4 text-xs text-[#5A5E78]">{h.accountId}</td>
                  <td className="py-4 pr-4">{h.units}</td>
                  <td className="py-4 pr-4">{h.repaid ? "—" : inr(h.amountPaid)}</td>
                  <td className="py-4 pr-4 font-semibold text-[#2F6B4F]">
                    {inr(h.units * t.unitFaceValue)}
                  </td>
                  <td className="py-4 pr-4">
                    <StampBadge
                      label={h.repaid ? "REPAID" : h.frozen ? "BLOCKED · FROZEN" : "FUNDED"}
                      tone={h.repaid ? "green" : h.frozen ? "red" : "green"}
                      doubleBorder={h.repaid}
                    />
                  </td>
                  <td className="py-4">
                    {h.repaid ? (
                      <HashscanLink href={h.hashscanUrl} />
                    ) : (
                      <AsyncButton
                        variant="outline"
                        size="sm"
                        action={() => setHolderFrozen(t.tokenId, h.accountId, !h.frozen)}
                        pendingMessage={
                          h.frozen ? "Unfreezing holder on Hedera…" : "Freezing holder on Hedera…"
                        }
                        onDone={onDone}
                      >
                        {h.frozen ? "Unfreeze" : "Freeze"}
                      </AsyncButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

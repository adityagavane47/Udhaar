"use client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Async, AsyncButton, Empty, GradeBadge, HashscanLink, PageHeader } from "@/components/common";
import { useAsync } from "@/hooks/use-async";
import {
  createToken, getAuditLog, getAwaitingTokenization, getKycRequests, getTokens, reviewKyc,
  setHolderFrozen, setTokenPaused,
} from "@/lib/api";
import { fmtDate, fmtDateTime, inr } from "@/lib/utils";
import type { TokenInfo } from "@/lib/types";

export default function AdminPage() {
  const kyc = useAsync(getKycRequests);
  const queue = useAsync(getAwaitingTokenization);
  const tokens = useAsync(getTokens);
  const audit = useAsync(getAuditLog);
  // Refresh after a pause so each HashScan link stays visible for a moment.
  const refresh = () => setTimeout(() => { kyc.reload(); queue.reload(); tokens.reload(); audit.reload(); }, 3500);
  const refreshNow = () => { tokens.reload(); audit.reload(); };

  return (
    <div className="space-y-10">
      <PageHeader title="Admin" subtitle="Platform operator · approvals, tokens and compliance" />

      <Card>
        <CardHeader>
          <CardTitle>KYC approvals</CardTitle>
          <CardDescription>Every applicant&apos;s wallet is scanned against known scam wallets.</CardDescription>
        </CardHeader>
        <CardContent>
          <Async state={kyc}>
            {(list) => list.length === 0 ? <Empty>No requests.</Empty> : (
              <ul className="divide-y divide-slate-100">
                {list.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-center justify-between gap-4 py-5">
                    <div className="space-y-1">
                      <p className="font-semibold text-slate-900">{k.fullName} <span className="font-normal text-slate-400">· {k.walletAddress} · {k.country}</span></p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={k.walletScan === "clean" ? "green" : "red"}>Wallet scan: {k.walletScan}</Badge>
                        {k.walletScanNote && <span className="text-xs text-red-700">{k.walletScanNote}</span>}
                      </div>
                    </div>
                    {k.status === "pending" ? (
                      <div className="flex flex-wrap items-start gap-3">
                        <AsyncButton action={() => reviewKyc(k.id, true)} onDone={refresh}>Approve</AsyncButton>
                        <AsyncButton variant="outline" action={() => reviewKyc(k.id, false)} onDone={refresh}>Reject</AsyncButton>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <Badge variant={k.status === "approved" ? "green" : "red"} className="capitalize">{k.status}</Badge>
                        <HashscanLink href={k.hashscanUrl} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Awaiting tokenization</CardTitle>
          <CardDescription>Buyer-confirmed, risk-checked invoices. Tokens are 1,000 per unit, KYC-only.</CardDescription>
        </CardHeader>
        <CardContent>
          <Async state={queue}>
            {(list) => list.length === 0 ? <Empty>No invoices waiting.</Empty> : (
              <ul className="divide-y divide-slate-100">
                {list.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-4 py-5">
                    <div>
                      <p className="font-semibold text-slate-900">{i.id} · {i.supplierName} → {i.buyerName}</p>
                      <p className="text-sm text-slate-500">{inr(i.amount)} · due {fmtDate(i.dueDate)} · discount {i.discountPct}%</p>
                    </div>
                    <div className="flex items-start gap-3">
                      <GradeBadge grade={i.grade} className="mt-2" />
                      <AsyncButton action={() => createToken(i.id)} onDone={refresh}>Create token</AsyncButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </CardContent>
      </Card>

      <section className="space-y-6">
        <h2 className="text-xl font-semibold text-slate-900">Token controls and repayment</h2>
        <Async state={tokens}>
          {(list) => list.length === 0 ? <Empty>No tokens yet.</Empty> : <>{list.map((t) => <TokenCard key={t.tokenId} t={t} onDone={refreshNow} />)}</>}
        </Async>
      </section>

      <Card>
        <CardHeader><CardTitle>Audit log</CardTitle><CardDescription>Every action, with its transaction.</CardDescription></CardHeader>
        <CardContent>
          <Async state={audit}>
            {(list) => (
              <ul className="divide-y divide-slate-100">
                {list.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                    <div>
                      <span className="mr-3 text-slate-400">{fmtDateTime(t.timestamp)}</span>
                      <Badge className="mr-2">{t.actor}</Badge>
                      {t.description}
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
  );
}

function TokenCard({ t, onDone }: { t: TokenInfo; onDone: () => void }) {
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle>{t.invoiceId} · {t.buyerName}</CardTitle>
          <CardDescription>Token {t.tokenId} · {t.totalUnits} units of {inr(t.unitFaceValue)} · matures {fmtDate(t.maturityDate)}</CardDescription>
        </div>
        <div className="flex items-start gap-3">
          <Badge variant={t.paused ? "red" : "green"}>{t.paused ? "Paused" : "Active"}</Badge>
          <AsyncButton variant={t.paused ? "default" : "destructive"} size="sm" action={() => setTokenPaused(t.tokenId, !t.paused)} onDone={onDone}>
            {t.paused ? "Unpause token" : "Pause token"}
          </AsyncButton>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {t.holders.length === 0 ? <Empty>No holders yet.</Empty> : (
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>{["Holder", "Account", "Units", "Amount paid", "Repayment at maturity", "Status", ""].map((h) => <th key={h} className="py-3 pr-4 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {t.holders.map((h) => (
                <tr key={h.accountId}>
                  <td className="py-4 pr-4 font-medium">{h.name}</td>
                  <td className="py-4 pr-4 font-mono text-xs text-slate-500">{h.accountId}</td>
                  <td className="py-4 pr-4">{h.units}</td>
                  <td className="py-4 pr-4">{inr(h.amountPaid)}</td>
                  <td className="py-4 pr-4 font-medium text-emerald-700">{inr(h.units * t.unitFaceValue)}</td>
                  <td className="py-4 pr-4"><Badge variant={h.frozen ? "red" : "green"}>{h.frozen ? "Frozen" : "Active"}</Badge></td>
                  <td className="py-4">
                    <AsyncButton variant="outline" size="sm" action={() => setHolderFrozen(t.tokenId, h.accountId, !h.frozen)} onDone={onDone}>
                      {h.frozen ? "Unfreeze" : "Freeze"}
                    </AsyncButton>
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


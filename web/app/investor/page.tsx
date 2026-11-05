"use client";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Async, Empty, ErrorNote, Field, GradeBadge, PageHeader } from "@/components/common";
import { useAsync } from "@/hooks/use-async";
import { getListings, getMyKyc, getPortfolio, submitKyc } from "@/lib/api";
import { errMsg, fmtDate, inr } from "@/lib/utils";

export default function InvestorPage() {
  const kyc = useAsync(getMyKyc);
  const listings = useAsync(getListings);
  const portfolio = useAsync(getPortfolio);

  return (
    <div className="space-y-12">
      <PageHeader title="Investor portal" subtitle="Priya Sharma · buy invoice units at a discount, repaid at maturity" />

      <Async state={kyc}>{(k) => <KycSection kyc={k} onDone={kyc.reload} />}</Async>

      <section>
        <h2 className="mb-4 text-xl font-semibold text-slate-900">Marketplace</h2>
        <Async state={listings}>
          {(list) =>
            list.length === 0 ? <Empty>No live invoices right now.</Empty> : (
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((l) => (
                  <Link key={l.invoiceId} href={`/investor/${l.invoiceId}`} className="group">
                    <Card className="h-full transition-shadow group-hover:shadow-md">
                      <CardContent className="space-y-5 p-6">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold text-slate-900">{l.buyerName}</p>
                            <p className="text-xs text-slate-400">{l.invoiceId}</p>
                          </div>
                          <GradeBadge grade={l.grade} />
                        </div>
                        <p className="text-2xl font-semibold tracking-tight">{inr(l.amount)}</p>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-500">Return <b className="text-emerald-600">{l.returnPct}%</b></span>
                          <span className="text-slate-500"><b className="text-slate-800">{l.daysToMaturity}</b> days</span>
                        </div>
                        <p className="text-xs text-slate-400">{l.availableUnits} units left · {inr(l.unitPrice)} each</p>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            )
          }
        </Async>
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold text-slate-900">Portfolio</h2>
        <Async state={portfolio}>
          {(items) =>
            items.length === 0 ? <Empty>You hold no units yet.</Empty> : (
              <Card>
                <CardContent className="overflow-x-auto p-0">
                  <table className="w-full text-sm">
                    <thead className="border-b border-slate-100 text-left text-slate-500">
                      <tr>{["Invoice", "Grade", "Units", "Paid", "Expected payout", "Maturity", "Status"].map((h) => <th key={h} className="px-6 py-4 font-medium">{h}</th>)}</tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {items.map((p) => (
                        <tr key={p.invoiceId}>
                          <td className="px-6 py-4 font-medium">{p.buyerName}<span className="block text-xs text-slate-400">{p.invoiceId}</span></td>
                          <td className="px-6 py-4"><GradeBadge grade={p.grade} /></td>
                          <td className="px-6 py-4">{p.units}</td>
                          <td className="px-6 py-4">{inr(p.amountPaid)}</td>
                          <td className="px-6 py-4 font-medium text-emerald-700">{inr(p.expectedPayout)}</td>
                          <td className="px-6 py-4">{fmtDate(p.dueDate)}</td>
                          <td className="px-6 py-4"><Badge variant={p.repaid ? "green" : "default"}>{p.repaid ? "Repaid" : "Active"}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )
          }
        </Async>
      </section>
    </div>
  );
}

function KycSection({ kyc, onDone }: { kyc: Awaited<ReturnType<typeof getMyKyc>>; onDone: () => void }) {
  const [fullName, setFullName] = useState("Priya Sharma");
  const [wallet, setWallet] = useState("0.0.11310320");
  const [country, setCountry] = useState("India");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try { await submitKyc({ fullName, walletAddress: wallet, country }); onDone(); }
    catch (err) { setError(errMsg(err)); }
    finally { setLoading(false); }
  }

  if (kyc) {
    const v = { pending: "amber", approved: "green", rejected: "red" } as const;
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
          <div>
            <p className="font-semibold text-slate-900">KYC status</p>
            <p className="text-sm text-slate-500">
              {kyc.status === "pending" && "Waiting for admin approval (simulated)."}
              {kyc.status === "approved" && "Your wallet is verified and can buy any listed invoice."}
              {kyc.status === "rejected" && "Your application was rejected."}
            </p>
          </div>
          <Badge variant={v[kyc.status]} className="capitalize">{kyc.status}</Badge>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Complete KYC</CardTitle>
        <CardDescription>Simulated. Only &quot;wallet verified&quot; is stored on-chain, never personal data.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-5 sm:grid-cols-3">
          <Field label="Full name"><Input required value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
          <Field label="Hedera wallet"><Input required value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0.0.12345" /></Field>
          <Field label="Country"><Input required value={country} onChange={(e) => setCountry(e.target.value)} /></Field>
          <div className="space-y-3 sm:col-span-3">
            <Button type="submit" loading={loading}>Submit for KYC</Button>
            <ErrorNote message={error} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}


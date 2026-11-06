"use client";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
} from "@/components/common";
import { useAsync } from "@/hooks/use-async";
import { getListings, getMyKyc, getPortfolio, submitKyc } from "@/lib/api";
import { demoMaturityText, errMsg, fmtDate, inr, inrPrice, pct, termText } from "@/lib/utils";

export default function InvestorPage() {
  const kyc = useAsync(getMyKyc);
  const listings = useAsync(getListings);
  const portfolio = useAsync(getPortfolio);

  return (
    <PortalGuard>
      <div className="space-y-10">
        <InvestorNav />

        <PageHeader
          folio="Folio · Investor (Priya · 0.0.11310320)"
          title="Investor khata"
          subtitle="Priya Sharma · buy invoice units at a discount, repaid at maturity"
        />

        <Async state={kyc}>{(k) => <KycSection kyc={k} onDone={kyc.reload} />}</Async>

        <section>
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-serif text-3xl font-normal text-[#1B2340]">Marketplace</h2>
            <span className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
              Buyer-confirmed invoice bonds
            </span>
          </div>
          <Async state={listings}>
            {(list) =>
              list.length === 0 ? (
                <Empty>No live invoices right now.</Empty>
              ) : (
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((l) => (
                    <Link
                      key={l.invoiceId}
                      href={`/investor/${l.invoiceId}`}
                      className="group text-[#1B2340] no-underline hover:text-[#1B2340]"
                    >
                      <Card className="khata-ruled relative h-full transition-transform group-hover:-translate-x-1 group-hover:-translate-y-1">
                        <div
                          aria-hidden="true"
                          className="absolute top-0 bottom-0 left-3 w-0.5 bg-[#B3261E]"
                        />
                        <CardContent className="space-y-5 py-6 pr-6 pl-7">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="font-serif text-2xl text-[#1B2340]">{l.buyerName}</p>
                              <p className="font-mono text-xs text-[#5A5E78]">
                                {l.invoiceId}
                                {l.tokenId ? ` · bond ${l.tokenId}` : " · simulated fraud case"}
                              </p>
                            </div>
                            <div className="flex flex-col items-end gap-1">
                              {l.blocked ? (
                                <StampBadge label="BLOCKED" tone="red" doubleBorder />
                              ) : (
                                <StampBadge label="TOKENIZED" tone="red" doubleBorder />
                              )}
                              <GradeBadge grade={l.grade} />
                            </div>
                          </div>
                          <p className="font-mono text-3xl font-semibold tracking-tight text-[#1B2340]">
                            {inr(l.amount)}
                          </p>
                          {l.blocked ? (
                            <p className="font-mono text-xs text-[#B3261E]">
                              Not listed · grade D · fraud flags found. No units for sale.
                            </p>
                          ) : (
                            <>
                              <div className="flex justify-between font-mono text-sm">
                                <span className="text-[#5A5E78]">
                                  Return <b className="text-[#2F6B4F]">{pct(l.returnPct)}</b>
                                </span>
                              </div>
                              <p className="font-mono text-xs font-semibold text-[#1B2340]">
                                {termText(l.annualRatePct, l.dueDate, l.grade)}
                              </p>
                              {demoMaturityText(l.maturityDate, l.dueDate) && (
                                <p className="font-mono text-xs font-semibold text-[#B3261E]">
                                  {demoMaturityText(l.maturityDate, l.dueDate)}
                                </p>
                              )}
                              <p className="font-mono text-xs text-[#5A5E78]">
                                {l.availableUnits} units left · {inrPrice(l.unitPrice)} each (face{" "}
                                {inr(l.unitFaceValue)})
                                {l.discountPct != null ? ` · ${pct(l.discountPct)} off` : ""}
                              </p>
                            </>
                          )}
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
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-serif text-3xl font-normal text-[#1B2340]">Portfolio</h2>
            <span className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
              Holdings and maturity payouts
            </span>
          </div>
          <Async state={portfolio}>
            {(items) =>
              items.length === 0 ? (
                <Empty>You hold no units yet.</Empty>
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
                            "Invoice",
                            "Grade",
                            "Units",
                            "Paid",
                            "Expected payout",
                            "Maturity",
                            "Status",
                          ].map((h) => (
                            <th key={h} className="px-4 py-4 font-semibold">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#A9BEDB] font-mono">
                        {items.map((p) => (
                          <tr key={p.invoiceId}>
                            <td className="px-4 py-4 font-sans font-medium text-[#1B2340]">
                              {p.buyerName}
                              <span className="block font-mono text-xs text-[#5A5E78]">
                                {p.invoiceId}
                              </span>
                            </td>
                            <td className="px-4 py-4">
                              <GradeBadge grade={p.grade} />
                            </td>
                            <td className="px-4 py-4">{p.units}</td>
                            <td className="px-4 py-4">{inrPrice(p.amountPaid)}</td>
                            <td className="px-4 py-4 font-semibold text-[#2F6B4F]">
                              {inr(p.expectedPayout)}
                            </td>
                            <td className="px-4 py-4">{fmtDate(p.dueDate)}</td>
                            <td className="px-4 py-4">
                              <StampBadge
                                label={p.repaid ? "REPAID" : "FUNDED"}
                                tone={p.repaid ? "green" : "blue"}
                                doubleBorder={p.repaid}
                              />
                            </td>
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
    </PortalGuard>
  );
}

function KycSection({
  kyc,
  onDone,
}: {
  kyc: Awaited<ReturnType<typeof getMyKyc>>;
  onDone: () => void;
}) {
  const [fullName, setFullName] = useState("Priya Sharma");
  const [wallet, setWallet] = useState("0.0.11310320");
  const [country, setCountry] = useState("India");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await submitKyc({ fullName, walletAddress: wallet, country });
      onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }

  if (kyc) {
    const tone = { pending: "amber", approved: "green", rejected: "red" } as const;
    const label = {
      pending: "SUBMITTED · KYC PENDING",
      approved: "CONFIRMED · KYC APPROVED",
      rejected: "BLOCKED · KYC REJECTED",
    } as const;
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
          <div>
            <p className="font-serif text-2xl text-[#1B2340]">KYC status</p>
            <p className="text-sm text-[#5A5E78]">
              {kyc.status === "pending" && "Waiting for admin approval (simulated)."}
              {kyc.status === "approved" &&
                "Your wallet is verified and can buy any listed invoice."}
              {kyc.status === "rejected" && "Your application was rejected."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <StampBadge
              label={label[kyc.status]}
              tone={tone[kyc.status]}
              doubleBorder={kyc.status === "approved"}
            />
            <HashscanLink href={kyc.hashscanUrl} />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Complete KYC</CardTitle>
        <CardDescription>
          Simulated. Only &quot;wallet verified&quot; is stored on-chain, never personal data.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-5 sm:grid-cols-3">
          <Field label="Full name">
            <Input required value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <Field label="Hedera wallet">
            <Input
              required
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              placeholder="0.0.12345"
            />
          </Field>
          <Field label="Country">
            <Input required value={country} onChange={(e) => setCountry(e.target.value)} />
          </Field>
          <div className="space-y-3 sm:col-span-3">
            <Button type="submit" loading={loading}>
              Submit for KYC
            </Button>
            <Pending active={loading} message="Recording your KYC request on Hedera…" />
            <ErrorNote message={error} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

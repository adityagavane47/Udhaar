"use client";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Async, Empty, HashscanLink, PageHeader, PortalGuard, StampBadge } from "@/components/common";
import { BreakdownList, ScoreDial, SourceLabel } from "@/components/trust";
import { useAsync } from "@/hooks/use-async";
import { getCompanyTrust } from "@/lib/api";
import { fmtDate, inr } from "@/lib/utils";

export default function CompanyTrustPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const company = useAsync(() => getCompanyTrust(decodeURIComponent(id)));

  return (
    <PortalGuard>
      <div className="space-y-8">
        <button
          type="button"
          onClick={() => router.back()}
          className="cursor-pointer bg-transparent font-mono text-xs uppercase tracking-[0.08em] text-[#B3261E] hover:text-[#1B2340] hover:underline"
        >
          ← Back
        </button>
        <Async state={company}>
          {(c) => (
            <>
              <PageHeader
                folio="Folio · Company trust"
                title={c.name}
                subtitle={`${c.companyId} · scores and repayment history · outside data is mock data`}
              />
              <div className="grid gap-8 lg:grid-cols-2">
                <Card className="khata-ruled relative">
                  <CardHeader>
                    <CardTitle>Udhaar Trust Score</CardTitle>
                    <CardDescription>
                      {c.limit.reason}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <ScoreDial score={c.score} title="Trust score" caption={`${c.points}/100 points`} />
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      {c.newOnUdhaar && <StampBadge label="New on Udhaar" tone="blue" tilt={false} />}
                      <HashscanLink href={c.hashscanUrl} />
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>How it is worked out</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <BreakdownList breakdown={c.breakdown} />
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle>Repayment history</CardTitle>
                    <SourceLabel source="hedera" />
                  </div>
                  <CardDescription>
                    Each repayment is read from the mirror node and compared with its due date.
                  </CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto p-0">
                  {c.repayments.length === 0 ? (
                    <div className="p-6">
                      <Empty>No repayments on Udhaar yet.</Empty>
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="border-b-2 border-[#1B2340] text-left font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                        <tr>
                          {["Invoice", "Role", "Amount", "Due", "Paid", "Result", "Proof"].map((h) => (
                            <th key={h} className="px-4 py-3 font-semibold">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#A9BEDB] font-mono">
                        {c.repayments.map((r) => (
                          <tr key={r.transactionId}>
                            <td className="px-4 py-3">{r.invoiceId}</td>
                            <td className="px-4 py-3 capitalize">{r.role}</td>
                            <td className="px-4 py-3">{inr(r.amount)}</td>
                            <td className="px-4 py-3">{fmtDate(r.dueDate)}</td>
                            <td className="px-4 py-3">{fmtDate(r.paidAt)}</td>
                            <td className="px-4 py-3">
                              <StampBadge
                                label={r.onTime ? "On time" : `${r.daysLate}d late`}
                                tone={r.onTime ? "green" : "amber"}
                                tilt={false}
                              />
                            </td>
                            <td className="px-4 py-3">
                              <HashscanLink href={r.hashscanUrl} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle>Outside profile</CardTitle>
                    <SourceLabel source="mock-external" />
                  </div>
                  <CardDescription>Made-up bureau, registry and complaint data for the demo.</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-6 font-mono text-sm sm:grid-cols-3">
                    {[
                      ["GSTIN (mock)", c.externalProfile.gstin],
                      ["Udyam", c.externalProfile.udyam ?? "none"],
                      ["Bureau score (mock)", String(c.externalProfile.bureauScore)],
                      ["Credit rating", c.externalProfile.creditRating ?? "none"],
                      ["MSME-1 dues over 45 days", inr(c.externalProfile.msme1DuesOver45DaysInr)],
                      ["Samadhaan complaints", String(c.externalProfile.samadhaanComplaints)],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-xs uppercase tracking-[0.06em] text-[#5A5E78]">{k}</dt>
                        <dd className="mt-1 font-semibold text-[#1B2340]">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            </>
          )}
        </Async>
      </div>
    </PortalGuard>
  );
}

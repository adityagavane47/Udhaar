"use client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Async, AsyncButton, Empty, PageHeader } from "@/components/common";
import { useAsync } from "@/hooks/use-async";
import { confirmInvoice, getBuyerToConfirm, getBuyerUpcoming, payInvoice, rejectInvoice } from "@/lib/api";
import { fmtDate, inr } from "@/lib/utils";

export default function BuyerPage() {
  const toConfirm = useAsync(getBuyerToConfirm);
  const upcoming = useAsync(getBuyerUpcoming);
  // Refresh after a pause so the HashScan link stays visible for a moment.
  const refresh = () => { setTimeout(() => { toConfirm.reload(); upcoming.reload(); }, 4000); };

  return (
    <div className="space-y-10">
      <PageHeader title="Buyer portal" subtitle="BigBuild Ltd · confirm what you owe and pay on the due date" />

      <Card>
        <CardHeader>
          <CardTitle>Invoices to confirm</CardTitle>
          <CardDescription>Confirmation is recorded on-chain. Unconfirmed invoices never reach investors.</CardDescription>
        </CardHeader>
        <CardContent>
          <Async state={toConfirm}>
            {(list) =>
              list.length === 0 ? <Empty>Nothing waiting for you.</Empty> : (
                <ul className="divide-y divide-slate-100">
                  {list.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-4 py-5">
                      <div>
                        <p className="font-semibold text-slate-900">{i.id} · {i.supplierName}</p>
                        <p className="text-sm text-slate-500">{inr(i.amount)} · due {fmtDate(i.dueDate)}</p>
                      </div>
                      <div className="flex flex-wrap items-start gap-3">
                        <AsyncButton action={() => confirmInvoice(i.id)} onDone={refresh}>Confirm</AsyncButton>
                        <AsyncButton variant="outline" action={() => rejectInvoice(i.id)} onDone={refresh}>Reject</AsyncButton>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            }
          </Async>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Upcoming payments</CardTitle>
          <CardDescription>Paying on the due date repays investors automatically.</CardDescription>
        </CardHeader>
        <CardContent>
          <Async state={upcoming}>
            {(list) =>
              list.length === 0 ? <Empty>No upcoming payments.</Empty> : (
                <ul className="divide-y divide-slate-100">
                  {list.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-4 py-5">
                      <div>
                        <p className="font-semibold text-slate-900">{i.id} · {i.supplierName}</p>
                        <p className="text-sm text-slate-500">{inr(i.amount)} · due {fmtDate(i.dueDate)}</p>
                      </div>
                      {i.status === "funded" ? (
                        <AsyncButton action={() => payInvoice(i.id)} onDone={refresh}>Pay {inr(i.amount)}</AsyncButton>
                      ) : (
                        <Badge>Awaiting funding</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )
            }
          </Async>
        </CardContent>
      </Card>
    </div>
  );
}

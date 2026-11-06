"use client";
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Async,
  AsyncButton,
  DemoMaturityTag,
  Empty,
  HashscanLink,
  InvoiceStamp,
  PageHeader,
  PortalGuard,
  StampBadge,
} from "@/components/common";
import { useAsync } from "@/hooks/use-async";
import { useAuthRole } from "@/lib/auth";
import {
  confirmInvoice,
  getBuyerToConfirm,
  getBuyerUpcoming,
  payInvoice,
  rejectInvoice,
} from "@/lib/api";
import { demoMaturityText, fmtDate, fmtDateTime, inr, maturityReached } from "@/lib/utils";

/** Re-renders every 10 seconds, so a button that waits for maturity appears without a reload. */
function useTick(ms = 10_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

export default function BuyerPage() {
  useTick();
  const { persona } = useAuthRole();
  const toConfirm = useAsync(getBuyerToConfirm);
  const upcoming = useAsync(getBuyerUpcoming);
  // The header can switch buyers without leaving this page, so each switch loads that buyer's own invoices.
  const buyerId = persona?.accountId;
  const { reload: reloadToConfirm } = toConfirm;
  const { reload: reloadUpcoming } = upcoming;
  useEffect(() => {
    reloadToConfirm();
    reloadUpcoming();
  }, [buyerId, reloadToConfirm, reloadUpcoming]);
  // Refresh after a pause so the HashScan link stays visible for a moment.
  const refresh = () => {
    setTimeout(() => {
      toConfirm.reload();
      upcoming.reload();
    }, 4000);
  };

  return (
    <PortalGuard>
      <div className="space-y-10">
        <PageHeader
          folio={`Folio · Buyer (${persona?.name ?? "BigBuild"} · ${persona?.accountId ?? "0.0.11310319"})`}
          title="Buyer khata"
          subtitle={`${persona?.name ?? "BigBuild"} · confirm what you owe and pay on the due date`}
        />

        <Card className="khata-ruled relative">
          <div aria-hidden="true" className="absolute top-0 bottom-0 left-3 w-0.5 bg-[#B3261E] sm:left-5" />
          <CardHeader className="pl-7 sm:pl-10">
            <CardTitle>Invoices to confirm</CardTitle>
            <CardDescription>
              Confirmation is recorded on-chain. Unconfirmed invoices never reach investors.
            </CardDescription>
          </CardHeader>
          <CardContent className="pl-7 sm:pl-10">
            <Async state={toConfirm}>
              {(list) =>
                list.length === 0 ? (
                  <Empty>Nothing waiting for you.</Empty>
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
                              {i.supplierName}
                            </span>
                            <InvoiceStamp status={i.status} />
                          </div>
                          <p className="font-mono text-sm text-[#5A5E78]">
                            <strong className="font-semibold text-[#1B2340]">
                              {inr(i.amount)}
                            </strong>{" "}
                            · due {fmtDate(i.dueDate)}
                            {i.hashscanUrl && (
                              <>
                                {" "}
                                · <HashscanLink href={i.hashscanUrl} />
                              </>
                            )}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-start gap-3">
                          <AsyncButton
                            action={() => confirmInvoice(i.id)}
                            pendingMessage="Signing and recording buyer confirmation on Hedera…"
                            onDone={refresh}
                          >
                            Confirm
                          </AsyncButton>
                          <AsyncButton
                            variant="outline"
                            action={() => rejectInvoice(i.id)}
                            onDone={refresh}
                          >
                            Reject
                          </AsyncButton>
                        </div>
                      </li>
                    ))}
                  </ul>
                )
              }
            </Async>
          </CardContent>
        </Card>

        <Card className="khata-ruled relative">
          <div aria-hidden="true" className="absolute top-0 bottom-0 left-3 w-0.5 bg-[#B3261E] sm:left-5" />
          <CardHeader className="pl-7 sm:pl-10">
            <CardTitle>Upcoming payments</CardTitle>
            <CardDescription>
              Paying on the due date repays investors automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="pl-7 sm:pl-10">
            <Async state={upcoming}>
              {(list) =>
                list.length === 0 ? (
                  <Empty>No upcoming payments.</Empty>
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
                              {i.supplierName}
                            </span>
                            <InvoiceStamp status={i.status} />
                          </div>
                          <p className="font-mono text-sm text-[#5A5E78]">
                            <strong className="font-semibold text-[#1B2340]">
                              {inr(i.amount)}
                            </strong>{" "}
                            · due {fmtDate(i.dueDate)}
                            {i.tokenId ? ` · bond ${i.tokenId}` : ""}{" "}
                            <DemoMaturityTag show={i.demoMaturity} />
                            {demoMaturityText(i.maturityDate, i.dueDate) && (
                              <span className="font-semibold text-[#B3261E]">
                                {" "}
                                · {demoMaturityText(i.maturityDate, i.dueDate)}
                              </span>
                            )}
                            {i.hashscanUrl && (
                              <>
                                {" "}
                                · <HashscanLink href={i.hashscanUrl} />
                              </>
                            )}
                          </p>
                        </div>
                        {i.status === "funded" && !maturityReached(i.maturityDate, i.dueDate) ? (
                          <StampBadge
                            label={`Repay opens ${fmtDateTime(i.maturityDate ?? i.dueDate)}`}
                            tone="amber"
                            tilt={false}
                          />
                        ) : i.status === "funded" ? (
                          <AsyncButton
                            action={() => payInvoice(i.id)}
                            pendingMessage="Settling repayment and redeeming holder units on Hedera…"
                            onDone={refresh}
                          >
                            Pay {inr(i.amount)}
                          </AsyncButton>
                        ) : (
                          <StampBadge label="AWAITING FUNDING" tone="amber" tilt={false} />
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
    </PortalGuard>
  );
}

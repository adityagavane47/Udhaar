"use client";
import * as React from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Async, HashscanLink, StampBadge, type StampTone } from "@/components/common";
import { useAsync } from "@/hooks/use-async";
import { getInvoiceTrust } from "@/lib/api";
import type {
  ChecklistItem,
  ChecklistStatus,
  PartyTrust,
  TrustFactor,
  TrustScore,
} from "@/lib/types";
import { cn, inr } from "@/lib/utils";

const SCORE_MIN = 300;
const SCORE_MAX = 900;

const scoreColour = (n: number) => (n >= 700 ? "#2F6B4F" : n >= 500 ? "#8A4B08" : "#B3261E");

const FACTOR_NAMES: Record<keyof TrustScore["breakdown"], string> = {
  paymentHistory: "Payment history",
  companyProfile: "Company profile",
  externalObligations: "Outside obligations",
  network: "Network",
};

/** "On Hedera" for chain data, "Mock bureau data" for everything from the made-up outside datasets. */
export function SourceLabel({ source }: { source: TrustFactor["source"] }) {
  const onChain = source === "hedera";
  return (
    <span
      className={cn(
        "inline-block border px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-[0.06em]",
        onChain ? "border-[#2F6B4F] text-[#2F6B4F]" : "border-[#C9B98F] text-[#6B6F86]",
      )}
    >
      {onChain ? "On Hedera" : "Mock bureau data"}
    </span>
  );
}

/** Counts from 300 up to the score once, then stays. Skips the motion for people who ask for less. */
function useCountUp(target: number) {
  const [value, setValue] = React.useState(SCORE_MIN);
  const [finished, setFinished] = React.useState(false);
  React.useEffect(() => {
    if (finished) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const id = requestAnimationFrame(() => setFinished(true));
      return () => cancelAnimationFrame(id);
    }
    const t0 = performance.now();
    const duration = 1400;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      setValue(Math.round(SCORE_MIN + (target - SCORE_MIN) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
      else setFinished(true);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, finished]);
  return finished ? target : value;
}

/** A 300–900 gauge. With onClick it becomes a button that opens the breakdown. */
export function ScoreDial({
  score,
  title,
  caption,
  onClick,
}: {
  score: number;
  title: string;
  caption?: string;
  onClick?: () => void;
}) {
  const shown = useCountUp(score);
  const fraction = (shown - SCORE_MIN) / (SCORE_MAX - SCORE_MIN);
  const colour = scoreColour(shown);
  const body = (
    <>
      <p className="font-mono text-xs uppercase tracking-[0.08em] text-[#B3261E]">{title}</p>
      <svg viewBox="0 0 200 118" className="mx-auto mt-2 block w-full max-w-[240px]" role="img" aria-label={`${title}: ${score} out of ${SCORE_MAX}`}>
        <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="#E4D8B8" strokeWidth="14" pathLength={1} />
        <path
          d="M20 100 A80 80 0 0 1 180 100"
          fill="none"
          stroke={colour}
          strokeWidth="14"
          pathLength={1}
          strokeDasharray={`${Math.max(fraction, 0.002)} 1`}
        />
        <text x="100" y="88" textAnchor="middle" fontSize="38" fontWeight="600" fontFamily="var(--font-mono), monospace" fill="#1B2340">
          {shown}
        </text>
        <text x="20" y="116" textAnchor="middle" fontSize="10" fontFamily="var(--font-mono), monospace" fill="#6B6F86">
          {SCORE_MIN}
        </text>
        <text x="180" y="116" textAnchor="middle" fontSize="10" fontFamily="var(--font-mono), monospace" fill="#6B6F86">
          {SCORE_MAX}
        </text>
      </svg>
      {caption && <p className="mt-1 text-center font-mono text-xs text-[#5A5E78]">{caption}</p>}
    </>
  );
  if (!onClick) return <div className="text-center">{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${title}: ${score}. Open the breakdown`}
      className="block w-full cursor-pointer border border-transparent bg-transparent p-2 text-center transition-colors hover:border-[#C9B98F] hover:bg-[#F1E8D2]/50 focus-visible:border-[#1B2340] focus-visible:outline-none"
    >
      {body}
      <p className="mt-1 text-center font-mono text-[11px] uppercase tracking-[0.06em] text-[#B3261E] underline underline-offset-4">
        See how it is worked out
      </p>
    </button>
  );
}

/** Factor-by-factor list: points, a bar, the plain-English reason and where the data came from. */
export function BreakdownList({ breakdown }: { breakdown: TrustScore["breakdown"] }) {
  return (
    <ul className="space-y-4">
      {(Object.keys(FACTOR_NAMES) as (keyof TrustScore["breakdown"])[]).map((key) => {
        const f = breakdown[key];
        return (
          <li key={key} className="border-b border-dashed border-[#C9B98F] pb-4 last:border-b-0 last:pb-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-sm font-semibold text-[#1B2340]">{FACTOR_NAMES[key]}</span>
              <span className="flex items-center gap-2">
                <SourceLabel source={f.source} />
                <span className="font-mono text-sm font-semibold text-[#1B2340]">
                  {f.points}
                  <span className="font-normal text-[#5A5E78]">/{f.max}</span>
                </span>
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full bg-[#E4D8B8]" aria-hidden="true">
              <div className="h-full bg-[#1B2340]" style={{ width: `${f.max ? Math.min(100, (f.points / f.max) * 100) : 0}%` }} />
            </div>
            <p className="mt-2 text-sm text-[#1B2340]">{f.reason}</p>
          </li>
        );
      })}
    </ul>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const closeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#1B2340]/60 p-4 sm:items-center"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-lg border-2 border-[#1B2340] bg-[#FBF6EA] shadow-[6px_6px_0_#1B2340]">
        <div className="flex items-center justify-between gap-3 border-b-2 border-[#1B2340] px-5 py-3">
          <h2 className="font-serif text-2xl font-normal text-[#1B2340]">{title}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="cursor-pointer p-1 text-[#1B2340] hover:text-[#B3261E]">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-5 py-5">{children}</div>
      </div>
    </div>
  );
}

const STATUS_STAMP: Record<ChecklistStatus, { mark: string; word: string; tone: StampTone }> = {
  pass: { mark: "✓", word: "Pass", tone: "green" },
  warn: { mark: "!", word: "Warn", tone: "amber" },
  fail: { mark: "✗", word: "Fail", tone: "red" },
  not_provided: { mark: "—", word: "Not provided", tone: "navy" },
};

function ChecklistRow({ item }: { item: ChecklistItem }) {
  const st = STATUS_STAMP[item.status];
  return (
    <li className="flex gap-4 border-b border-dashed border-[#C9B98F] py-3.5 last:border-b-0">
      <span className="w-10 shrink-0 text-center" title={st.word}>
        <StampBadge
          label={<span aria-hidden="true">{st.mark}</span>}
          tone={st.tone}
          doubleBorder={item.status === "fail"}
          tilt={false}
          className="px-2 text-base leading-tight"
        />
        <span className="sr-only">{st.word}</span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-sm font-semibold text-[#1B2340]">{item.label}</p>
        <p className="mt-0.5 text-sm text-[#1B2340]">{item.detail}</p>
        {item.proofUrl && <HashscanLink href={item.proofUrl} label="Proof on HashScan" className="mt-1 inline-block" />}
      </div>
    </li>
  );
}

function PartyDial({
  party,
  title,
  onOpen,
}: {
  party: PartyTrust;
  title: string;
  onOpen: () => void;
}) {
  const { limit } = party;
  return (
    <div className="space-y-3">
      <ScoreDial score={party.score} title={title} caption={party.name} onClick={onOpen} />
      <div className="flex flex-wrap items-center justify-center gap-2">
        {party.newOnUdhaar && <StampBadge label="New on Udhaar" tone="blue" tilt={false} />}
        {limit.perInvoiceInr != null && (
          <span className="font-mono text-xs text-[#1B2340]">
            Limit <b>{inr(limit.perInvoiceInr)}</b> per invoice · {limit.onTimeRepayments} of {limit.required} on-time repayments
          </span>
        )}
      </div>
    </div>
  );
}

/** Trust check for one invoice: both scores, the 12-item checklist, and the score breakdowns on click. */
export function TrustPanel({ invoiceId }: { invoiceId: string }) {
  const trust = useAsync(() => getInvoiceTrust(invoiceId));
  const [open, setOpen] = React.useState<"seller" | "buyer" | null>(null);
  const close = React.useCallback(() => setOpen(null), []);

  return (
    <Card className="khata-ruled relative">
      <CardHeader>
        <CardTitle>Trust check</CardTitle>
        <CardDescription>
          Scores run from 300 to 900. Repayment history and the buyer&apos;s confirmation come from
          Hedera; all other outside data is mock data.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Async state={trust}>
          {(t) => {
            const person = open ? t[open] : null;
            return (
              <div className="space-y-8">
                <div className="grid gap-8 sm:grid-cols-2">
                  <PartyDial party={t.seller} title="Seller" onOpen={() => setOpen("seller")} />
                  <PartyDial party={t.buyer} title="Buyer: who repays you" onOpen={() => setOpen("buyer")} />
                </div>
                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-3 border-b-2 border-[#1B2340] pb-2">
                    <h3 className="font-serif text-2xl font-normal text-[#1B2340]">Checklist</h3>
                    <p className="font-mono text-xs text-[#5A5E78]">
                      {t.summary.pass} pass · {t.summary.warn} warn · {t.summary.fail} fail · {t.summary.notProvided} not provided
                    </p>
                  </div>
                  <ul>
                    {t.checklist.map((c) => (
                      <ChecklistRow key={c.id} item={c} />
                    ))}
                  </ul>
                </div>
                {person && (
                  <Modal title={`${person.name}: score ${person.score}`} onClose={close}>
                    <div className="space-y-5">
                      <BreakdownList breakdown={person.breakdown} />
                      <p className="font-mono text-xs text-[#5A5E78]">
                        {person.points}/100 points, shown as 300 + 6 × points.
                      </p>
                      <Link
                        href={`/trust/company/${encodeURIComponent(person.companyId)}`}
                        className="inline-block font-mono text-xs font-semibold uppercase tracking-[0.06em] text-[#B3261E] underline underline-offset-4 hover:text-[#1B2340]"
                      >
                        Company trust and repayment history →
                      </Link>
                    </div>
                  </Modal>
                )}
              </div>
            );
          }}
        </Async>
      </CardContent>
    </Card>
  );
}

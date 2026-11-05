"use client";
import * as React from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn, errLink, errMsg } from "@/lib/utils";
import type { Grade, InvoiceStatus } from "@/lib/types";

export function HashscanLink({ href, label, className }: { href?: string; label?: string; className?: string }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("whitespace-nowrap text-xs font-medium text-indigo-600 hover:text-indigo-800 hover:underline", className)}
    >
      ↗ {label ?? "HashScan"}
    </a>
  );
}

const gradeVariant = { A: "green", B: "blue", C: "amber", D: "red" } as const;
export function GradeBadge({ grade, className }: { grade?: Grade; className?: string }) {
  if (!grade) return <Badge className={className}>Ungraded</Badge>;
  return <Badge variant={gradeVariant[grade]} className={className}>Grade {grade}</Badge>;
}

export function ErrorNote({ message, href, className }: { message?: string | null; href?: string; className?: string }) {
  if (!message) return null;
  return (
    <div role="alert" className={cn("flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800", className)}>
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {message}
        {href && <> <HashscanLink href={href} /></>}
      </span>
    </div>
  );
}

/** Shown while a slow blockchain action runs, with a live timer. */
export function Pending({ active, message = "Confirming on Hedera…" }: { active: boolean; message?: string }) {
  const [secs, setSecs] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const t0 = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => { clearInterval(id); setSecs(0); };
  }, [active]);
  if (!active) return null;
  return (
    <div role="status" className="flex items-center gap-2 text-xs text-indigo-700">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span>
        {message}
        {secs >= 2 && ` ${secs}s`}
        {secs >= 6 && " · blockchain actions can take 5–15 seconds, please keep this page open"}
      </span>
    </div>
  );
}

export function SuccessNote({ children, href }: { children: React.ReactNode; href?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
      <Check className="h-4 w-4" />
      <span>{children}</span>
      <HashscanLink href={href} />
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500">{children}</div>;
}

/** Renders loading / error / data for a useAsync result. */
export function Async<T>({
  state, children,
}: {
  state: { data: T | null; loading: boolean; error: string | null };
  children: (d: T) => React.ReactNode;
}) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error && !state.data) return <ErrorNote message={state.error} />;
  if (!state.data) return null;
  return <>{children(state.data)}</>;
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-8">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{title}</h1>
      {subtitle && <p className="mt-1 text-slate-500">{subtitle}</p>}
    </div>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-6">
        <p className="text-sm text-slate-500">{label}</p>
        <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{value}</p>
        {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="text-xs text-slate-400">{hint}</span>}
    </div>
  );
}

interface AsyncButtonProps extends Omit<ButtonProps, "onClick" | "loading"> {
  action: () => Promise<unknown>;
  pendingMessage?: string;
  onDone?: (result: unknown) => void;
  type?: "button" | "submit";
}

/** Button with loading + error state; shows a HashScan link when the action returns one. */
export function AsyncButton({ action, onDone, pendingMessage, children, className, ...props }: AsyncButtonProps) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errorUrl, setErrorUrl] = React.useState<string | undefined>();
  const [url, setUrl] = React.useState<string | undefined>();

  async function run() {
    setLoading(true);
    setError(null);
    setErrorUrl(undefined);
    try {
      const res = await action();
      const u = (res as { hashscanUrl?: string } | undefined)?.hashscanUrl;
      setUrl(u);
      onDone?.(res);
    } catch (e) {
      setError(errMsg(e));
      setErrorUrl(errLink(e));
      setUrl(undefined);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="inline-flex max-w-full flex-col items-start gap-2">
      <div className="flex items-center gap-3">
        <Button type="button" className={className} loading={loading} onClick={run} {...props}>
          {children}
        </Button>
        <HashscanLink href={url} />
      </div>
      <Pending active={loading} message={pendingMessage} />
      <ErrorNote message={error} href={errorUrl} />
    </div>
  );
}

const STEPS: { key: InvoiceStatus; label: string }[] = [
  { key: "submitted", label: "Submitted" },
  { key: "buyer_confirmed", label: "Buyer confirmed" },
  { key: "risk_checked", label: "Risk checked" },
  { key: "tokenized", label: "Tokenized" },
  { key: "funded", label: "Funded" },
  { key: "repaid", label: "Repaid" },
];

export function StatusTracker({ status }: { status: InvoiceStatus }) {
  if (status === "buyer_rejected") return <Badge variant="red">Rejected by buyer</Badge>;
  const current = STEPS.findIndex((s) => s.key === status);
  return (
    <ol className="flex w-full items-start">
      {STEPS.map((s, i) => {
        const done = i <= current;
        return (
          <li key={s.key} className="flex flex-1 flex-col items-center text-center">
            <div className="flex w-full items-center">
              <div className={cn("h-0.5 flex-1", i === 0 ? "bg-transparent" : done ? "bg-indigo-500" : "bg-slate-200")} />
              <div className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold", done ? "bg-indigo-600 text-white" : "bg-slate-200 text-slate-500", i === current && "ring-4 ring-indigo-100")}>
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </div>
              <div className={cn("h-0.5 flex-1", i === STEPS.length - 1 ? "bg-transparent" : i < current ? "bg-indigo-500" : "bg-slate-200")} />
            </div>
            <span className={cn("mt-2 px-1 text-[11px] leading-tight", done ? "font-medium text-slate-800" : "text-slate-400")}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}


"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  clearAdminSession,
  isAdminSessionValid,
  readAdminSession,
  readStoredRole,
  useAuthRole,
} from "@/lib/auth";
import { cn, errLink, errMsg } from "@/lib/utils";
import type { Grade, InvoiceStatus, RiskGraph } from "@/lib/types";

export function HashscanLink({ href, label, className }: { href?: string; label?: string; className?: string }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "whitespace-nowrap font-mono text-xs font-medium text-[#B3261E] underline-offset-4 hover:text-[#1B2340] hover:underline",
        className,
      )}
    >
      ↗ {label ?? "HashScan"}
    </a>
  );
}

/** Rubber-stamp status badge in khata style. */
export type StampTone = "green" | "blue" | "amber" | "red" | "navy";
const stampStyles: Record<StampTone, string> = {
  green: "border-[#2F6B4F] text-[#2F6B4F]",
  blue: "border-[#1F5C99] text-[#1F5C99]",
  amber: "border-[#8A4B08] text-[#8A4B08]",
  red: "border-[#B3261E] text-[#B3261E]",
  navy: "border-[#1B2340] text-[#1B2340]",
};

export function StampBadge({
  label,
  tone = "navy",
  doubleBorder = false,
  tilt = true,
  className,
}: {
  label: React.ReactNode;
  tone?: StampTone;
  doubleBorder?: boolean;
  tilt?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block bg-[#FBF6EA]/90 px-2.5 py-0.5 font-mono text-xs font-semibold uppercase tracking-[0.06em]",
        doubleBorder ? "border-4 border-double" : "border-2",
        stampStyles[tone],
        tilt && "-rotate-2",
        className,
      )}
    >
      {label}
    </span>
  );
}

const statusStampMap: Record<InvoiceStatus, { label: string; tone: StampTone; double?: boolean }> = {
  submitted: { label: "SUBMITTED", tone: "amber" },
  buyer_confirmed: { label: "CONFIRMED", tone: "blue" },
  risk_checked: { label: "CONFIRMED", tone: "blue" },
  buyer_rejected: { label: "BLOCKED", tone: "red", double: true },
  tokenized: { label: "TOKENIZED", tone: "red", double: true },
  funded: { label: "FUNDED", tone: "green" },
  repaid: { label: "REPAID", tone: "green", double: true },
};

export function InvoiceStamp({ status, className }: { status: InvoiceStatus; className?: string }) {
  const cfg = statusStampMap[status] ?? { label: status.toUpperCase(), tone: "navy" as const };
  return <StampBadge label={cfg.label} tone={cfg.tone} doubleBorder={cfg.double} className={className} />;
}

const gradeVariant = { A: "green", B: "blue", C: "amber", D: "red" } as const;
export function GradeBadge({ grade, className }: { grade?: Grade; className?: string }) {
  if (!grade) return <Badge className={className}>Ungraded</Badge>;
  return (
    <Badge variant={gradeVariant[grade]} className={className}>
      Grade {grade}
    </Badge>
  );
}

export function ErrorNote({ message, href, className }: { message?: string | null; href?: string; className?: string }) {
  if (!message) return null;
  const isDup = /duplicate/i.test(message);
  const isBlocked = /blocked|rejected|not verified|not kyc|paused|frozen|flagged/i.test(message);
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-start gap-2.5 border-2 border-[#B3261E] bg-[#FBF6EA] px-3.5 py-2.5 text-sm text-[#B3261E]",
        className,
      )}
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      {(isDup || isBlocked) && (
        <StampBadge label={isDup ? "DUPLICATE" : "BLOCKED"} tone="red" tilt={false} className="px-1.5 py-0 text-[10px]" />
      )}
      <span className="flex-1">
        {message}
        {href && (
          <>
            {" "}
            <HashscanLink href={href} />
          </>
        )}
      </span>
    </div>
  );
}

/** Shown while a slow blockchain action runs, with a live timer. */
export function Pending({
  active,
  message = "Confirming on Hedera…",
  hint = "blockchain actions can take 5–15 seconds, please keep this page open",
}: {
  active: boolean;
  message?: string;
  hint?: string;
}) {
  const [secs, setSecs] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const t0 = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => {
      clearInterval(id);
      setSecs(0);
    };
  }, [active]);
  if (!active) return null;
  return (
    <div role="status" className="flex items-center gap-2 font-mono text-xs text-[#B3261E]">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span>
        {message}
        {secs >= 2 && ` ${secs}s`}
        {secs >= 6 && hint && ` · ${hint}`}
      </span>
    </div>
  );
}

export function SuccessNote({ children, href }: { children: React.ReactNode; href?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-2 border-[#2F6B4F] bg-[#FBF6EA] px-3.5 py-2 text-sm text-[#2F6B4F]">
      <Check className="h-4 w-4" />
      <span>{children}</span>
      <HashscanLink href={href} />
    </div>
  );
}

export function Loading({ label = "Reading the khata…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 font-mono text-sm text-[#5A5E78]">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-dashed border-[#C9B98F] bg-[#FBF6EA]/60 py-10 text-center font-hand text-xl text-[#5A5E78]">
      {children}
    </div>
  );
}

/** Renders loading / error / data for a useAsync result. */
export function Async<T>({
  state,
  children,
}: {
  state: { data: T | null; loading: boolean; error: string | null };
  children: (d: T) => React.ReactNode;
}) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error && !state.data) return <ErrorNote message={state.error} />;
  if (!state.data) return null;
  return <>{children(state.data)}</>;
}

export function PageHeader({
  folio,
  title,
  subtitle,
}: {
  folio?: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-8 border-b-2 border-[#1B2340] pb-5">
      {folio && (
        <p className="mb-1 font-mono text-xs uppercase tracking-[0.1em] text-[#B3261E]">{folio}</p>
      )}
      <h1 className="font-serif text-4xl font-normal tracking-tight text-[#1B2340] sm:text-5xl">
        {title}
      </h1>
      {subtitle && <p className="mt-1.5 font-mono text-xs text-[#5A5E78] sm:text-sm">{subtitle}</p>}
    </div>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-6">
        <p className="font-mono text-xs uppercase tracking-[0.08em] text-[#B3261E]">{label}</p>
        <p className="mt-2 font-mono text-3xl font-semibold tracking-tight text-[#1B2340]">
          {value}
        </p>
        {hint && <p className="mt-1.5 text-xs text-[#5A5E78]">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-xs uppercase tracking-[0.06em] text-[#1B2340]">{label}</span>
      {children}
      {hint && <span className="font-mono text-xs text-[#5A5E78]">{hint}</span>}
    </div>
  );
}

interface AsyncButtonProps extends Omit<ButtonProps, "onClick" | "loading"> {
  action: () => Promise<unknown>;
  pendingMessage?: string;
  pendingHint?: string;
  onDone?: (result: unknown) => void;
  type?: "button" | "submit";
}

/** Button with loading + error state; shows a HashScan link when the action returns one. */
export function AsyncButton({
  action,
  onDone,
  pendingMessage,
  pendingHint,
  children,
  className,
  ...props
}: AsyncButtonProps) {
  const busyRef = React.useRef(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errorUrl, setErrorUrl] = React.useState<string | undefined>();
  const [url, setUrl] = React.useState<string | undefined>();

  async function run() {
    if (busyRef.current) return;
    busyRef.current = true;
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
      busyRef.current = false;
      setLoading(false);
    }
  }

  return (
    <div className="inline-flex max-w-full flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" className={className} loading={loading} onClick={run} {...props}>
          {children}
        </Button>
        <HashscanLink href={url} />
      </div>
      <Pending active={loading} message={pendingMessage} hint={pendingHint} />
      <ErrorNote message={error} href={errorUrl} />
    </div>
  );
}

/** Sub-navigation shared across the Investor portal pages. */
export function InvestorNav() {
  const pathname = usePathname();
  const onAgent = pathname.startsWith("/investor/agent");
  const items = [
    { href: "/investor", label: "Marketplace & portfolio", active: !onAgent },
    { href: "/investor/agent", label: "Auto-invest agent", active: onAgent },
  ];
  return (
    <nav
      aria-label="Investor portal"
      className="flex flex-wrap border-2 border-[#1B2340] bg-[#FBF6EA] shadow-[4px_4px_0_#1B2340] w-fit"
    >
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            "border-r border-[#1B2340] px-4 py-2 font-mono text-xs uppercase tracking-[0.08em] no-underline transition-colors last:border-r-0",
            item.active
              ? "bg-[#1B2340] font-semibold text-[#F1E8D2] hover:bg-[#1B2340] hover:text-[#F1E8D2]"
              : "bg-[#FBF6EA] text-[#1B2340] hover:bg-[#F1E8D2] hover:text-[#B3261E]",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

const STEPS: { key: InvoiceStatus; label: string; stamp: string }[] = [
  { key: "submitted", label: "Submitted", stamp: "SUBMITTED" },
  { key: "buyer_confirmed", label: "Buyer confirmed", stamp: "CONFIRMED" },
  { key: "risk_checked", label: "Risk checked", stamp: "CHECKED" },
  { key: "tokenized", label: "Tokenized", stamp: "TOKENIZED" },
  { key: "funded", label: "Funded", stamp: "FUNDED" },
  { key: "repaid", label: "Repaid", stamp: "REPAID" },
];

export function StatusTracker({ status }: { status: InvoiceStatus }) {
  if (status === "buyer_rejected") {
    return <StampBadge label="BLOCKED · REJECTED BY BUYER" tone="red" doubleBorder />;
  }
  const current = STEPS.findIndex((s) => s.key === status);
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-6">
      {STEPS.map((s, i) => {
        const done = i <= current;
        const active = i === current;
        return (
          <li
            key={s.key}
            className={cn(
              "flex items-center gap-2 border px-2.5 py-2 font-mono text-[11px] uppercase tracking-[0.05em]",
              done
                ? active
                  ? "border-2 border-[#B3261E] bg-[#FBF6EA] font-semibold text-[#B3261E]"
                  : "border-[#2F6B4F] bg-[#FBF6EA] text-[#2F6B4F]"
                : "border-[#C9B98F] bg-[#F1E8D2]/50 text-[#6B6F86]",
            )}
          >
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center border text-[10px]",
                done
                  ? active
                    ? "border-[#B3261E] bg-[#B3261E] text-[#FBF6EA]"
                    : "border-[#2F6B4F] bg-[#2F6B4F] text-[#FBF6EA]"
                  : "border-[#C9B98F] text-[#6B6F86]",
              )}
            >
              {done ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span className="truncate">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Wraps portal pages: redirects to /login when no persona is logged in, and enforces a live admin token on /admin. */
export function PortalGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { role, adminValid, adminExpiresAt, ready } = useAuthRole();
  const isAdminRoute = pathname.startsWith("/admin");
  const liveRole = ready ? (readStoredRole() ?? role) : null;
  const liveSession = ready ? readAdminSession() : null;
  const liveAdminValid = ready ? (isAdminSessionValid(liveSession) || adminValid) : false;
  const authorized = isAdminRoute
    ? liveRole === "admin" && liveAdminValid
    : Boolean(liveRole);

  React.useEffect(() => {
    if (!ready) return;
    const storedRole = readStoredRole();
    const session = readAdminSession();
    const sessionOk = isAdminSessionValid(session);

    if (isAdminRoute) {
      if (storedRole !== "admin" || !sessionOk) {
        clearAdminSession();
        router.replace("/login?persona=admin");
        return;
      }
      const expIso = session?.expiresAt ?? adminExpiresAt;
      if (expIso) {
        const ms = Date.parse(expIso) - Date.now();
        if (ms <= 0) {
          clearAdminSession();
          router.replace("/login?persona=admin");
          return;
        }
        const id = setTimeout(() => {
          clearAdminSession();
          router.replace("/login?persona=admin");
        }, ms);
        return () => clearTimeout(id);
      }
      return;
    }

    if (!storedRole) {
      router.replace("/login");
    }
  }, [ready, isAdminRoute, authorized, adminExpiresAt, role, router]);

  if (!ready || !authorized) {
    return (
      <main className="mx-auto w-full max-w-[1240px] px-4 py-12 sm:px-6">
        <Loading label="Opening the khata…" />
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-8 sm:px-6 sm:py-10">{children}</main>
  );
}

/** Small network picture of who is linked to an invoice. The API already masks people as "Director A". */
export function MiniGraph({ graph }: { graph?: RiskGraph }) {
  if (!graph || graph.nodes.length === 0) return null;
  const W = 320;
  const H = 200;
  const cx = W / 2;
  const cy = H / 2;
  const r = Math.min(cx, cy) - 36;
  const pos = new Map(
    graph.nodes.map((n, i) => {
      const a = (2 * Math.PI * i) / graph.nodes.length - Math.PI / 2;
      return [n.id, { x: cx + r * Math.cos(a) * 1.35, y: cy + r * Math.sin(a) }] as const;
    }),
  );
  const colour = (flagged: boolean) => (flagged ? "#B3261E" : "#1B2340");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Network of linked companies, directors and addresses. People are masked."
      className="h-auto w-full max-w-sm border border-[#C9B98F] bg-[#FBF6EA]"
    >
      {graph.links.map((l, i) => {
        const a = pos.get(l.source);
        const b = pos.get(l.target);
        if (!a || !b) return null;
        return (
          <line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={colour(l.flagged)}
            strokeWidth={l.flagged ? 2 : 1}
            strokeDasharray={l.type === "invoice" ? undefined : "4 3"}
          />
        );
      })}
      {graph.nodes.map((n) => {
        const p = pos.get(n.id)!;
        const c = colour(n.flagged);
        return (
          <g key={n.id}>
            {n.type === "company" ? (
              <rect x={p.x - 9} y={p.y - 9} width={18} height={18} fill="#FBF6EA" stroke={c} strokeWidth={2} />
            ) : n.type === "person" ? (
              <circle cx={p.x} cy={p.y} r={9} fill={c} />
            ) : (
              <polygon points={`${p.x},${p.y - 10} ${p.x + 10},${p.y + 8} ${p.x - 10},${p.y + 8}`} fill="#FBF6EA" stroke={c} strokeWidth={2} />
            )}
            <text
              x={p.x}
              y={p.y + 24}
              textAnchor="middle"
              fontSize="9"
              fontFamily="var(--font-mono), monospace"
              fill={c}
            >
              {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
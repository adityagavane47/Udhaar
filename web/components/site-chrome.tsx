"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ROLES = [
  { href: "/business", label: "Business" },
  { href: "/buyer", label: "Buyer" },
  { href: "/investor", label: "Investor" },
  { href: "/admin", label: "Admin" },
];

export function Header() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-lg font-bold text-white">U</span>
          <span className="text-lg font-semibold tracking-tight text-slate-900">Udhaar</span>
        </Link>
        <nav aria-label="Role switcher" className="flex rounded-xl bg-slate-100 p-1">
          {ROLES.map((r) => (
            <Link
              key={r.href}
              href={r.href}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors sm:px-4",
                path.startsWith(r.href) ? "bg-white text-indigo-700 shadow-sm" : "text-slate-600 hover:text-slate-900",
              )}
            >
              {r.label}
            </Link>
          ))}
        </nav>
        <Badge variant="amber">Testnet</Badge>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mt-16 border-t border-slate-200 bg-white py-6 text-center text-sm text-slate-500">
      Demo: simulated KYC and data.
    </footer>
  );
}


"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { scrollToSection } from "@/components/landing/scroll-to";
import { USE_MOCK, loginDemoInvestor } from "@/lib/api";
import {
  clearAdminSession,
  clearStoredRole,
  hasAdminAccess,
  setStoredRole,
  useAuthRole,
} from "@/lib/auth";
import { ALL_PERSONAS, type Role } from "@/lib/types";
import { cn } from "@/lib/utils";

const isPortalPath = (p: string) =>
  p.startsWith("/business") ||
  p.startsWith("/buyer") ||
  p.startsWith("/investor") ||
  p.startsWith("/admin") ||
  p.startsWith("/trust");

const SECTION_LINKS = [
  ["chain", "Who waits"],
  ["folios", "How it works"],
  ["entries", "Today's entries"],
] as const;

export function Header() {
  const path = usePathname();
  const router = useRouter();
  const { persona } = useAuthRole();
  const inPortal = isPortalPath(path);

  function switchRole(next: Role, href: string) {
    if (next === "admin") {
      if (hasAdminAccess()) {
        router.push("/admin");
        return;
      }
      clearAdminSession();
      router.push("/login?persona=admin");
      return;
    }
    clearAdminSession();
    setStoredRole(next);
    if (next === "investor") {
      loginDemoInvestor().catch(() => {});
    }
    router.push(href);
  }

  function logout() {
    clearStoredRole();
    router.push("/login");
  }

  return (
    <header className="border-b-2 border-[#1B2340] bg-[#F1E8D2]">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-baseline justify-between gap-4 px-4 py-[18px] sm:px-6">
        <div className="flex flex-wrap items-baseline gap-3.5">
          <Link href="/" className="flex items-baseline gap-3.5 text-[#1B2340] no-underline hover:text-[#1B2340]">
            <span
              lang="hi"
              className="font-hand text-[34px] font-bold leading-none text-[#B3261E]"
            >
              उधार
            </span>
            <span className="font-serif text-[30px] leading-none text-[#1B2340]">Udhaar</span>
          </Link>
          <span className="border border-[#1B2340] px-2 py-[3px] font-mono text-xs uppercase tracking-[0.08em] text-[#1B2340]">
            Hedera testnet
          </span>
          {USE_MOCK && (
            <span className="border border-[#B3261E] px-2 py-[3px] font-mono text-xs uppercase tracking-[0.08em] text-[#B3261E]">
              Mock data
            </span>
          )}
        </div>

        {inPortal ? (
          <div className="flex flex-wrap items-center gap-3">
            {persona && (
              <span className="font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                Signed in as{" "}
                <strong className="font-semibold text-[#B3261E]">{persona.name}</strong> (
                {persona.role})
              </span>
            )}
            <nav
              aria-label="Role switcher"
              className="flex flex-wrap border border-[#1B2340] bg-[#FBF6EA]"
            >
              {ALL_PERSONAS.map((r) => {
                // Three buyers share /buyer, so the signed-in persona decides which one is active.
                const active = persona ? persona.id === r.id : path.startsWith(r.href);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => switchRole(r.id, r.href)}
                    className={cn(
                      "cursor-pointer border-r border-[#1B2340] px-2.5 py-1.5 font-mono text-xs uppercase tracking-[0.06em] transition-colors last:border-r-0 sm:px-3",
                      active
                        ? "bg-[#1B2340] font-semibold text-[#F1E8D2] hover:bg-[#1B2340] hover:text-[#F1E8D2]"
                        : "text-[#1B2340] hover:bg-[#F1E8D2] hover:text-[#B3261E]",
                    )}
                  >
                    {r.switchLabel ?? r.role}
                  </button>
                );
              })}
            </nav>
            <button
              type="button"
              onClick={logout}
              className="btn cursor-pointer border border-[#1B2340] bg-[#FBF6EA] px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.06em] text-[#1B2340] hover:text-[#B3261E]"
            >
              Log out
            </button>
          </div>
        ) : path === "/login" ? (
          <nav aria-label="Main" className="flex flex-wrap items-center gap-5 text-[15px]">
            {persona && (
              <Link
                href={persona.href}
                className="font-mono text-xs uppercase tracking-[0.06em] text-[#1B2340] no-underline hover:text-[#B3261E]"
              >
                Resume as {persona.name} →
              </Link>
            )}
            <Link
              href="/"
              className="btn bg-[#1B2340] px-[18px] py-3 font-semibold text-[#F1E8D2] no-underline hover:text-[#F1E8D2]"
            >
              ← Back to landing
            </Link>
          </nav>
        ) : (
          <nav
            aria-label="Main"
            className="flex flex-wrap items-center gap-5 text-[15px] sm:gap-7"
          >
            {SECTION_LINKS.map(([id, label]) => (
              <Link
                key={id}
                href={`/#${id}`}
                onClick={(e) => {
                  // On the landing page, scroll in place so no # history entry is added.
                  if (path !== "/" || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  scrollToSection(id);
                }}
                className="text-[#1B2340] no-underline hover:text-[#B3261E]"
              >
                {label}
              </Link>
            ))}
            <Link
              href="/login"
              className="btn bg-[#1B2340] px-[18px] py-3 font-semibold text-[#F1E8D2] no-underline hover:text-[#F1E8D2]"
            >
              Open the khata
            </Link>
          </nav>
        )}
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t-2 border-[#1B2340] bg-[#F1E8D2]">
      <div className="mx-auto flex max-w-[1240px] flex-wrap justify-between gap-4 px-4 py-8 font-mono text-[13px] text-[#1B2340] sm:px-6">
        <span>Built on Hedera · ATS · HTS · HCS · x402</span>
        <span>Demo: simulated KYC and data. Simulated demo data on testnet. Not real money.</span>
        <a
          href="https://github.com/adityagavane47/udhaar"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#1B2340] no-underline hover:text-[#B3261E]"
        >
          github ↗
        </a>
      </div>
    </footer>
  );
}

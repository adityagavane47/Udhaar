"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ErrorNote, PageHeader, StampBadge } from "@/components/common";
import { loginDemoAdmin, loginDemoInvestor } from "@/lib/api";
import { clearAdminSession, setStoredRole } from "@/lib/auth";
import { PERSONAS, type Persona, type Role } from "@/lib/types";
import { cn, errMsg } from "@/lib/utils";

function subscribeLocation(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
}

function readIsPersonaAdminUrl(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("persona") === "admin";
}

export default function LoginPage() {
  const router = useRouter();
  const isUrlPersonaAdmin = useSyncExternalStore(
    subscribeLocation,
    readIsPersonaAdminUrl,
    () => false,
  );
  const passcodeInputRef = useRef<HTMLInputElement | null>(null);
  const operatorCardRef = useRef<HTMLDivElement | null>(null);
  const [picked, setPicked] = useState<Persona | null>(null);
  const [passcode, setPasscode] = useState("");
  const [dismissedAdminPrompt, setDismissedAdminPrompt] = useState(false);
  const [authErr, setAuthErr] = useState<{ role: Role; msg: string } | null>(null);
  const [busyRole, setBusyRole] = useState<Role | null>(null);

  const showAdminPrompt = isUrlPersonaAdmin && !dismissedAdminPrompt;

  useEffect(() => {
    if (!showAdminPrompt) return;
    const id = requestAnimationFrame(() => {
      operatorCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      passcodeInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [showAdminPrompt]);

  async function selectOpenPersona(p: Persona) {
    if (busyRole) return;
    setAuthErr(null);
    setDismissedAdminPrompt(true);
    if (typeof window !== "undefined" && window.location.search) {
      window.history.replaceState(null, "", "/login");
    }
    clearAdminSession();
    setStoredRole(p.id);
    setPicked(p);
    if (p.id === "investor") {
      setBusyRole(p.id);
      try {
        await loginDemoInvestor();
      } catch {
        /* investorPost will refresh the session when needed */
      } finally {
        setBusyRole(null);
      }
    }
    router.push(p.href);
  }

  async function submitOperator(e: React.FormEvent<HTMLFormElement>, p: Persona) {
    e.preventDefault();
    if (busyRole) return;
    setAuthErr(null);
    const code = passcodeInputRef.current?.value ?? passcode;
    setBusyRole(p.id);
    try {
      await loginDemoAdmin(code);
      setPicked(p);
      setStoredRole("admin");
      router.push(p.href);
    } catch (err) {
      setAuthErr({ role: p.id, msg: errMsg(err) });
      passcodeInputRef.current?.focus();
    } finally {
      setBusyRole(null);
    }
  }

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-6 sm:py-16">
      <PageHeader
        folio="Bahi-khata · Entry"
        title="Open the khata"
        subtitle="every click is a real testnet transaction"
      />

      <div className="space-y-12">
        {/* Panel 1: Connect your wallet */}
        <section className="border-2 border-[#1B2340] bg-[#FBF6EA] p-6 shadow-[6px_6px_0_#1B2340] sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="space-y-2">
              <span className="font-mono text-xs uppercase tracking-[0.08em] text-[#B3261E]">
                PANEL 01 · WALLET SIGNER
              </span>
              <h2 className="m-0 font-serif text-3xl font-normal text-[#1B2340] sm:text-4xl">
                Connect your wallet
              </h2>
              <p className="m-0 max-w-xl text-base leading-[1.6] text-[#5A5E78]">
                Sign directly with HashPack or MetaMask on Hedera testnet. For the hackathon demo,
                use one of the four pre-funded testnet personas below.
              </p>
            </div>
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <div className="flex flex-wrap items-center gap-2 font-mono text-xs uppercase tracking-[0.06em] text-[#5A5E78]">
                <span className="border border-[#C9B98F] bg-[#F1E8D2] px-2.5 py-1">HashPack</span>
                <span className="border border-[#C9B98F] bg-[#F1E8D2] px-2.5 py-1">MetaMask</span>
              </div>
              <button
                type="button"
                disabled
                className="cursor-not-allowed border-2 border-[#1B2340] bg-[#1B2340]/20 px-6 py-3.5 font-mono text-sm font-semibold uppercase tracking-[0.08em] text-[#1B2340]/60"
              >
                Coming soon
              </button>
            </div>
          </div>
        </section>

        {/* Panel 2: Try the demo */}
        <section className="space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <span className="font-mono text-xs uppercase tracking-[0.08em] text-[#B3261E]">
                PANEL 02 · TESTNET PERSONAS
              </span>
              <h2 className="m-0 mt-1 font-serif text-3xl font-normal text-[#1B2340] sm:text-4xl">
                Try the demo
              </h2>
            </div>
            <StampBadge label="HEDERA TESTNET · LIVE" tone="green" tilt={false} />
          </div>

          {showAdminPrompt && (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-3 border-2 border-[#B3261E] bg-[#FBF6EA] px-4 py-3 font-mono text-xs text-[#1B2340]"
            >
              <div className="flex flex-wrap items-center gap-2.5">
                <StampBadge label="Passcode required" tone="red" tilt={false} />
                <span>Enter the Operator passcode to open the admin khata.</span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 border-2 border-[#1B2340] shadow-[6px_6px_0_#1B2340] sm:grid-cols-2 lg:grid-cols-4">
            {PERSONAS.map((p, i) => {
              const isOperatorHighlight = p.locked && showAdminPrompt;
              return (
                <div
                  key={p.id}
                  ref={p.locked ? operatorCardRef : undefined}
                  style={{ background: i % 2 ? "#FBF6EA" : "#F1E8D2" }}
                  className={cn(
                    "flex flex-col gap-3 border-b border-[#1B2340] p-7 last:border-b-0 sm:border-r sm:nth-2:border-r-0 lg:border-b-0 lg:nth-2:border-r lg:last:border-r-0",
                    isOperatorHighlight && "ring-2 ring-inset ring-[#B3261E]",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[13px] uppercase tracking-[0.08em] text-[#B3261E]">
                      {p.role}
                    </span>
                    {isOperatorHighlight && (
                      <StampBadge
                        label="PASSCODE"
                        tone="red"
                        tilt={false}
                        className="px-1.5 py-0 text-[10px]"
                      />
                    )}
                  </div>
                  <span className="font-serif text-[34px] leading-none text-[#1B2340]">
                    {p.name}
                  </span>
                  <span className="grow text-[15px] leading-[1.55] text-[#1B2340]">{p.desc}</span>

                  {p.locked ? (
                    <form
                      onSubmit={(e) => void submitOperator(e, p)}
                      className="flex flex-col gap-3"
                    >
                      <label className="flex flex-col gap-1.5 font-mono text-[13px] text-[#1B2340]">
                        Demo passcode
                        <input
                          ref={passcodeInputRef}
                          type="password"
                          name="passcode"
                          placeholder="••••••"
                          value={passcode}
                          onChange={(e) => {
                            setPasscode(e.target.value);
                            if (authErr?.role === p.id) setAuthErr(null);
                          }}
                          className="border border-[#1B2340] bg-[#FBF6EA] p-3 font-mono text-[15px] text-[#1B2340] focus:border-[#B3261E] focus:outline-none"
                        />
                      </label>
                      {authErr?.role === p.id && <ErrorNote message={authErr.msg} />}
                      <button
                        type="submit"
                        disabled={busyRole !== null}
                        className="btn mt-1.5 cursor-pointer border-0 bg-[#1B2340] px-4 py-3.5 text-left text-base font-semibold text-[#F1E8D2] hover:text-[#F1E8D2] disabled:opacity-50"
                      >
                        {busyRole === p.id ? "Checking…" : `Continue as ${p.name} →`}
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={busyRole !== null}
                        onClick={() => void selectOpenPersona(p)}
                        className="btn mt-1.5 cursor-pointer border-0 bg-[#1B2340] px-4 py-3.5 text-left text-base font-semibold text-[#F1E8D2] hover:text-[#F1E8D2] disabled:opacity-50"
                      >
                        {busyRole === p.id ? "Starting session…" : `Continue as ${p.name} →`}
                      </button>
                      {authErr?.role === p.id && <ErrorNote message={authErr.msg} className="mt-1" />}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {picked && (
            <p role="status" className="m-0 font-hand text-[22px] text-[#B3261E]">
              Opening the {picked.role.toLowerCase()} khata…
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

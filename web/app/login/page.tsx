"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorNote, PageHeader, StampBadge } from "@/components/common";
import { loginDemoAdmin } from "@/lib/api";
import { setStoredRole } from "@/lib/auth";
import { PERSONAS, type Persona } from "@/lib/types";
import { errMsg } from "@/lib/utils";

export default function LoginPage() {
  const router = useRouter();
  const [picked, setPicked] = useState<Persona | null>(null);
  const [passcode, setPasscode] = useState("");
  const [adminErr, setAdminErr] = useState<string | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);

  async function pickPersona(p: Persona) {
    setAdminErr(null);
    if (p.locked) {
      setAdminBusy(true);
      try {
        await loginDemoAdmin(passcode);
        setPicked(p);
        setStoredRole(p.id);
        router.push(p.href);
      } catch (e) {
        setAdminErr(errMsg(e));
      } finally {
        setAdminBusy(false);
      }
      return;
    }
    setPicked(p);
    setStoredRole(p.id);
    router.push(p.href);
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

          <div className="grid grid-cols-1 border-2 border-[#1B2340] shadow-[6px_6px_0_#1B2340] sm:grid-cols-2 lg:grid-cols-4">
            {PERSONAS.map((p, i) => (
              <div
                key={p.id}
                style={{ background: i % 2 ? "#FBF6EA" : "#F1E8D2" }}
                className="flex flex-col gap-3 border-b border-[#1B2340] p-7 last:border-b-0 sm:border-r sm:nth-2:border-r-0 lg:border-b-0 lg:nth-2:border-r lg:last:border-r-0"
              >
                <span className="font-mono text-[13px] uppercase tracking-[0.08em] text-[#B3261E]">
                  {p.role}
                </span>
                <span className="font-serif text-[34px] leading-none text-[#1B2340]">
                  {p.name}
                </span>
                <span className="grow text-[15px] leading-[1.55] text-[#1B2340]">{p.desc}</span>

                {p.locked && (
                  <label className="flex flex-col gap-1.5 font-mono text-[13px] text-[#1B2340]">
                    Demo passcode
                    <input
                      type="password"
                      placeholder="••••••"
                      value={passcode}
                      onChange={(e) => setPasscode(e.target.value)}
                      className="border border-[#1B2340] bg-[#FBF6EA] p-3 font-mono text-[15px] text-[#1B2340]"
                    />
                  </label>
                )}

                <button
                  type="button"
                  disabled={p.locked && adminBusy}
                  onClick={() => pickPersona(p)}
                  className="btn mt-1.5 cursor-pointer border-0 bg-[#1B2340] px-4 py-3.5 text-left text-base font-semibold text-[#F1E8D2] hover:text-[#F1E8D2] disabled:opacity-50"
                >
                  {p.locked && adminBusy ? "Checking passcode…" : `Continue as ${p.name} →`}
                </button>

                {p.locked && adminErr && <ErrorNote message={adminErr} className="mt-1" />}
              </div>
            ))}
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


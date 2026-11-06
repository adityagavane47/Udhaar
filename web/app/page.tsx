"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ErrorNote } from "@/components/common";
import { getAuditLog, loginDemoAdmin, loginDemoInvestor } from "@/lib/api";
import { clearAdminSession, setStoredRole } from "@/lib/auth";
import { PERSONAS, type Persona, type Role, type Transaction } from "@/lib/types";
import { errMsg, inr } from "@/lib/utils";

/** The worked example on the landing page: a Grade A invoice due in 90 days. */
const DEMO_GRADE = "A";
const DEMO_RATE = 12;
const DEMO_DAYS = 90;
const DEMO_PRICE = Math.round(1000 * (1 - (DEMO_RATE * DEMO_DAYS) / 365 / 100));

interface LedgerEntry {
  n: string;
  what: string;
  id: string;
  url: string;
}

const tx = (t: string) => `https://hashscan.io/testnet/transaction/${t}`;

const FALLBACK_ENTRIES: LedgerEntry[] = [
  { n: "01", what: "Invoice fingerprint written to the registry", id: "1793903625.908", url: tx("1793903625.908487879") },
  { n: "02", what: "Buyer signs the confirmation", id: "1793903629.267", url: tx("1793903629.267049104") },
  { n: "03", what: "Invoice bond deployed through ATS", id: "0.0.11328164", url: "https://hashscan.io/testnet/contract/0.0.11328164" },
  { n: "04", what: "Investor buys units in uINR, 1% to the pool", id: "1793903678.771", url: tx("1793903678.771877205") },
  { n: "05", what: "Transfer to an unverified wallet rejected by the token", id: "1793903687.945", url: tx("1793903687.945066898") },
  { n: "06", what: "Ramesh pays his supplier in invoice units", id: "1793903701.784", url: tx("1793903701.784214104") },
  { n: "07", what: "Buyer repays; every holder burned and paid", id: "1793903883.008", url: tx("1793903883.008251650") },
];

function shortChainId(entry: Transaction): string {
  const u = entry.hashscanUrl || "";
  const mTx = u.match(/\/transaction\/(\d+\.\d{3})/);
  if (mTx) return mTx[1];
  const mEntity = u.match(/\/(?:contract|token|account|topic)\/(0\.0\.\d+)/);
  if (mEntity) return mEntity[1];
  if (entry.txId) {
    const m = entry.txId.match(/@(\d+\.\d{3})/);
    if (m) return m[1];
    return entry.txId.slice(0, 18);
  }
  return u.split("/").pop()?.slice(0, 16) || entry.id;
}

export default function LandingPage() {
  const router = useRouter();
  const passcodeInputRef = useRef<HTMLInputElement | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>(FALLBACK_ENTRIES);
  const [picked, setPicked] = useState<Persona | null>(null);
  const [passcode, setPasscode] = useState("");
  const [authErr, setAuthErr] = useState<{ role: Role; msg: string } | null>(null);
  const [busyRole, setBusyRole] = useState<Role | null>(null);

  useEffect(() => {
    let live = true;
    getAuditLog()
      .then((list) => {
        if (!live || !list || list.length === 0) return;
        const mapped = list.slice(0, 7).map((item, idx): LedgerEntry => ({
          n: String(idx + 1).padStart(2, "0"),
          what: item.description,
          id: shortChainId(item),
          url: item.hashscanUrl,
        }));
        setEntries(mapped);
      })
      .catch(() => {
        /* keep FALLBACK_ENTRIES when API is down */
      });
    return () => {
      live = false;
    };
  }, []);

  async function selectOpenPersona(p: Persona) {
    if (busyRole) return;
    setAuthErr(null);
    clearAdminSession();
    setStoredRole(p.id);
    setPicked(p);
    if (p.id === "investor") {
      setBusyRole(p.id);
      try {
        await loginDemoInvestor();
      } catch {
        /* investorPost refreshes the session when needed */
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
    <div className="bg-[#F1E8D2] text-[#1B2340]">
      {/* Hero */}
      <section className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-14 px-6 pt-20 pb-24">
        <div className="flex min-w-0 flex-[1_1_460px] flex-col gap-6">
          <span className="animate-[fadeUp_.6s_ease_both] font-mono text-[13px] uppercase tracking-[0.1em] text-[#B3261E]">
            Bahi-khata, on-chain
          </span>
          <h1 className="m-0 animate-[fadeUp_.7s_.1s_ease_both] font-serif text-[clamp(48px,6.4vw,92px)] font-normal leading-[0.98] tracking-[-0.01em]">
            Every business in India runs on udhaar.{" "}
            <span className="italic text-[#B3261E]">Now it settles itself.</span>
          </h1>
          <p className="m-0 max-w-[560px] animate-[fadeUp_.7s_.25s_ease_both] text-[19px] leading-[1.6]">
            Suppliers wait months for big buyers to pay. Udhaar turns a buyer-confirmed invoice
            into a token that investors fund today, that suppliers can pass down the chain, and
            that repays every holder automatically on the due date.
          </p>
          <div className="flex animate-[fadeUp_.7s_.4s_ease_both] flex-wrap gap-3.5">
            <Link
              href="/login"
              className="btn bg-[#1B2340] px-[26px] py-4 text-[17px] font-semibold text-[#F1E8D2] no-underline hover:text-[#F1E8D2]"
            >
              Open the khata
            </Link>
            <a
              href="#entries"
              className="btn border-2 border-[#1B2340] px-6 py-3.5 text-[17px] font-semibold text-[#1B2340] no-underline hover:text-[#B3261E]"
            >
              See it on HashScan
            </a>
          </div>
        </div>

        {/* Ledger sheet */}
        <div className="relative min-w-0 flex-[1_1_480px]">
          <div className="khata-sheet relative pt-7 pr-4 pb-9 pl-12 font-hand text-[17px] leading-[44px] sm:pr-7 sm:pl-[76px] sm:text-[21px]">
            <div
              aria-hidden="true"
              className="absolute top-0 bottom-0 left-9 w-0.5 bg-[#B3261E] sm:left-[56px]"
            />
            <div className="animate-[writeIn_.8s_.2s_ease-out_both] truncate text-[20px] font-bold sm:text-[24px]">
              Khata — Shree Ganesh Cement, Pune
            </div>
            <div className="grid animate-[writeIn_1s_.8s_ease-out_both] grid-cols-[54px_minmax(0,1fr)_88px] gap-x-2 sm:grid-cols-[70px_minmax(0,1fr)_120px] sm:gap-x-3">
              <span>01 Nov</span>
              <span className="truncate">BigBuild Ltd · 1,000 bags</span>
              <span className="text-right">₹5,00,000</span>
            </div>
            <div className="grid animate-[writeIn_1s_1.4s_ease-out_both] grid-cols-[54px_minmax(0,1fr)_88px] gap-x-2 sm:grid-cols-[70px_minmax(0,1fr)_120px] sm:gap-x-3">
              <span>03 Nov</span>
              <span className="truncate">Suresh · sand, 40 loads</span>
              <span className="text-right">₹50,000</span>
            </div>
            <div className="grid animate-[writeIn_1s_2s_ease-out_both] grid-cols-[54px_minmax(0,1fr)_88px] gap-x-2 sm:grid-cols-[70px_minmax(0,1fr)_120px] sm:gap-x-3">
              <span>05 Nov</span>
              <span className="truncate">Lakshmi Transport</span>
              <span className="text-right">₹18,500</span>
            </div>
            <div className="grid animate-[writeIn_1s_2.6s_ease-out_both] grid-cols-[54px_minmax(0,1fr)_88px] gap-x-2 sm:grid-cols-[70px_minmax(0,1fr)_120px] sm:gap-x-3">
              <span>06 Nov</span>
              <span className="truncate text-[#6B6F86]">due from BigBuild: 30 Jan</span>
              <span className="text-right text-[#6B6F86]">90 days</span>
            </div>
          </div>

          <div className="pointer-events-none absolute top-[58px] right-[92px] -rotate-[9deg] animate-[stampIn_.55s_3.6s_both] border-4 border-double border-[#B3261E] bg-transparent px-4 py-2.5 text-center font-mono text-[13px] font-semibold uppercase leading-[1.4] tracking-[0.06em] text-[#B3261E] mix-blend-multiply sm:top-[62px] sm:right-[118px] sm:text-[15px]">
            Tokenized
            <br />
            500 × ₹1,000
            <br />
            <span className="text-xs font-medium">bond 0.0.11328164</span>
          </div>
          <div className="pointer-events-none absolute top-[156px] right-[88px] rotate-[4deg] animate-[stampIn_.5s_4.3s_both] border-[3px] border-[#2F6B4F] bg-transparent px-3 py-1.5 font-mono text-[13px] font-semibold uppercase tracking-[0.06em] text-[#2F6B4F] mix-blend-multiply sm:top-[160px] sm:right-[114px]">
            Paid in units
          </div>
        </div>
      </section>

      {/* The arithmetic */}
      <section aria-label="The arithmetic" className="bg-[#1B2340] text-[#F1E8D2]">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-end justify-between gap-12 px-6 py-[72px]">
          <div className="reveal min-w-0 flex-[1_1_520px] font-serif text-[clamp(40px,5.2vw,72px)] leading-[1.05]">
            Pay <span className="italic text-[#F2B544]">{inr(DEMO_PRICE)}</span> today →
            <br />
            Collect <span className="italic text-[#F2B544]">₹1,000</span> on the due date.
          </div>
          <div className="reveal flex-[0_1_380px] font-mono text-base leading-[2]">
            <div className="flex justify-between gap-6">
              <span>Invoice</span>
              <span>₹5,00,000</span>
            </div>
            <div className="flex justify-between gap-6">
              <span>÷ face value</span>
              <span>₹1,000</span>
            </div>
            <div className="flex justify-between gap-6 border-t border-[#F1E8D2] border-b-4 border-double border-b-[#F1E8D2]">
              <span>Tokens</span>
              <span>500</span>
            </div>
            <div className="flex justify-between gap-6 text-sm text-[#C9CDEB]">
              <span>Grade {DEMO_GRADE}, {DEMO_RATE}% a year, due in {DEMO_DAYS} days.</span>
            </div>
          </div>
        </div>
      </section>

      {/* Who waits */}
      <section
        id="chain"
        className="mx-auto flex max-w-[1240px] flex-wrap gap-16 px-6 py-28"
      >
        <div className="reveal flex min-w-0 flex-[1_1_380px] flex-col gap-5">
          <span className="font-mono text-[13px] uppercase tracking-[0.1em] text-[#B3261E]">
            Who waits
          </span>
          <h2 className="m-0 font-serif text-[clamp(38px,4.4vw,60px)] font-normal leading-[1.02]">
            The money stops one step too early.
          </h2>
          <p className="m-0 text-[18px] leading-[1.6]">
            India&apos;s TReDS platforms finance the supplier who sells to the big company. The
            smaller firms who supply <span className="italic">him</span> still wait. Ramesh can
            hand Suresh part of the invoice token instead of cash, and BigBuild&apos;s payment
            reaches Suresh directly.
          </p>
          <p className="m-0 font-mono text-[13px] text-[#5A5E78]">
            MSMEs are owed ₹7.34 lakh crore in delayed payments · Delayed Payments Report 3.0,
            March 2024 figures
          </p>
        </div>

        <div className="flex min-w-0 flex-[1_1_460px] flex-col">
          <div className="reveal flex flex-wrap items-baseline justify-between gap-4 border-2 border-[#1B2340] px-[26px] py-[22px]">
            <span className="font-serif text-[30px]">BigBuild Ltd</span>
            <span className="font-mono text-sm">buyer · owes ₹5,00,000</span>
          </div>
          <div className="draw ml-10 h-11 border-l-2 border-dashed border-[#1B2340]" />
          <div className="reveal flex flex-wrap items-baseline justify-between gap-4 border-2 border-[#1B2340] bg-[#FBF6EA] px-[26px] py-[22px]">
            <span className="font-serif text-[30px]">Ramesh</span>
            <span className="font-mono text-sm">tier 1 · funded today</span>
          </div>
          <div className="draw ml-10 flex h-[72px] items-center border-l-2 border-dashed border-[#B3261E] pl-5">
            <span className="write font-hand text-[22px] text-[#B3261E]">
              TReDS stops here. Udhaar keeps going.
            </span>
          </div>
          <div className="reveal flex flex-wrap items-baseline justify-between gap-4 border-2 border-[#B3261E] px-[26px] py-[22px]">
            <span className="font-serif text-[30px]">Suresh</span>
            <span className="font-mono text-sm text-[#B3261E]">tier 2 · paid in invoice units</span>
          </div>
        </div>
      </section>

      {/* Folios */}
      <section id="folios" className="border-t-2 border-b-2 border-[#1B2340]">
        <div className="reveal mx-auto grid max-w-[1240px] grid-cols-1 px-6 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-3 border-b border-[#C9B98F] py-10 sm:border-r sm:pr-7 lg:border-b-0">
            <span className="font-mono text-[13px] tracking-[0.08em] text-[#B3261E]">FOLIO 01</span>
            <h3 className="m-0 font-serif text-[32px] font-normal">Write it</h3>
            <p className="m-0 text-base leading-[1.6]">
              The invoice is uploaded and its fingerprint goes into a public registry. The same
              invoice can&apos;t be financed twice.
            </p>
          </div>
          <div className="flex flex-col gap-3 border-b border-[#C9B98F] py-10 sm:pl-7 lg:border-r lg:border-b-0 lg:px-7">
            <span className="font-mono text-[13px] tracking-[0.08em] text-[#B3261E]">FOLIO 02</span>
            <h3 className="m-0 font-serif text-[32px] font-normal">Sign it</h3>
            <p className="m-0 text-base leading-[1.6]">
              The buyer confirms the debt with a message signed by its own Hedera account. No
              signature, no listing.
            </p>
          </div>
          <div className="flex flex-col gap-3 border-b border-[#C9B98F] py-10 sm:border-r sm:border-b-0 sm:pr-7 lg:px-7">
            <span className="font-mono text-[13px] tracking-[0.08em] text-[#B3261E]">FOLIO 03</span>
            <h3 className="m-0 font-serif text-[32px] font-normal">Split it</h3>
            <p className="m-0 text-base leading-[1.6]">
              It becomes 500 tokens that only verified wallets can hold. Investors buy them, or
              Ramesh pays his suppliers with them.
            </p>
          </div>
          <div className="flex flex-col gap-3 py-10 sm:pl-7">
            <span className="font-mono text-[13px] tracking-[0.08em] text-[#B3261E]">FOLIO 04</span>
            <h3 className="m-0 font-serif text-[32px] font-normal">Settle it</h3>
            <p className="m-0 text-base leading-[1.6]">
              The buyer pays once. Every holder&apos;s tokens are burned and paid at full face
              value, automatically.
            </p>
          </div>
        </div>
      </section>

      {/* Open the khata as... */}
      <section id="open" className="mx-auto flex max-w-[1240px] flex-col gap-10 px-6 py-28">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="m-0 font-serif text-[clamp(38px,4.4vw,60px)] font-normal leading-none">
            Open the khata as…
          </h2>
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-mono text-sm">every click is a real testnet transaction</span>
            <Link
              href="/login"
              className="btn bg-[#1B2340] px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-[#F1E8D2] no-underline hover:text-[#F1E8D2]"
            >
              Open the khata →
            </Link>
          </div>
        </div>

        <div className="reveal grid grid-cols-1 border-2 border-[#1B2340] sm:grid-cols-2 lg:grid-cols-4">
          {PERSONAS.map((p, i) => (
            <div
              key={p.id}
              style={{ background: i % 2 ? "#FBF6EA" : "#F1E8D2" }}
              className="flex flex-col gap-2.5 border-b border-[#1B2340] p-7 last:border-b-0 sm:border-r sm:nth-2:border-r-0 lg:border-b-0 lg:nth-2:border-r lg:last:border-r-0"
            >
              <span className="font-mono text-[13px] uppercase tracking-[0.08em] text-[#B3261E]">
                {p.role}
              </span>
              <span className="font-serif text-[34px] leading-none">{p.name}</span>
              <span className="grow text-[15px] leading-[1.55]">{p.desc}</span>
              {p.locked ? (
                <form
                  onSubmit={(e) => void submitOperator(e, p)}
                  className="flex flex-col gap-2.5"
                >
                  <label className="flex flex-col gap-1.5 font-mono text-[13px]">
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
                      className="border border-[#1B2340] bg-[#FBF6EA] p-3 font-mono text-[15px] text-[#1B2340]"
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
          ))}
        </div>

        {picked && (
          <p role="status" className="m-0 font-hand text-[22px] text-[#B3261E]">
            Opening the {picked.role.toLowerCase()} khata…
          </p>
        )}
      </section>

      {/* Today's entries, on Hedera */}
      <section id="entries" className="bg-[#1B2340] text-[#F1E8D2]">
        <div className="mx-auto flex max-w-[1240px] flex-col gap-8 px-6 py-24">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h2 className="m-0 font-serif text-[clamp(38px,4.4vw,60px)] font-normal leading-none">
              Today&apos;s entries, <span className="italic text-[#F2B544]">on Hedera</span>
            </h2>
            <span className="font-mono text-sm text-[#C9CDEB]">
              <span
                aria-hidden="true"
                className="mr-2 inline-block h-2 w-2 animate-[pulse_1.6s_ease-in-out_infinite] rounded-full bg-[#8FE3C3]"
              />
              invoice INV-0001 · bond 0.0.11328164
            </span>
          </div>

          <div className="border-t border-[#4A5280] font-mono text-[15px]">
            {entries.map((e) => (
              <div
                key={`${e.n}-${e.id}`}
                className="reveal flex flex-wrap justify-between gap-x-6 gap-y-2 border-b border-[#4A5280] py-4"
              >
                <span className="flex-[0_0_40px] text-[#C9CDEB]">{e.n}</span>
                <span className="min-w-0 flex-[1_1_260px] break-words">{e.what}</span>
                {e.url ? (
                  <a
                    href={e.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#F2B544] no-underline hover:text-[#FBF6EA] hover:underline"
                  >
                    {e.id} ↗
                  </a>
                ) : (
                  <span className="text-[#C9CDEB]">{e.id}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

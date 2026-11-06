"use client";
import Link from "next/link";
import { useRef } from "react";
import { onAnchorClick } from "./scroll-to";
import { gsap, MOTION, ScrollTrigger, SplitText, useGSAP } from "./gsap";

const LEDGER_ROW = "ink-row ink-pending grid grid-cols-[54px_minmax(0,1fr)_88px] gap-x-2 sm:grid-cols-[70px_minmax(0,1fr)_120px] sm:gap-x-3";

/** Drops of ink thrown out by the stamp, in the stamp's own coordinates: x, y, radius. */
const SPLATTER = [
  [18, 22, 7], [6, 58, 4], [30, 118, 6], [58, 8, 3.5], [74, 136, 4], [112, 2, 5], [128, 142, 3], [176, 6, 3.5],
  [204, 138, 6], [238, 14, 5], [262, 46, 8], [276, 96, 4], [252, 126, 3.5], [44, 140, 2.5], [150, 148, 2], [282, 22, 2.5],
  [-4, 92, 3], [92, -6, 2.5], [222, -4, 2], [290, 118, 2],
] as const;

/** Writes the headline with a pen, then stamps the page. Returns nothing to clean up beyond the GSAP context. */
function writeAndStamp(section: HTMLElement, onDone: () => void) {
  const q = gsap.utils.selector(section);
  const headline = q(".ink-headline")[0] as HTMLElement;
  const nib = q(".ink-nib")[0] as HTMLElement;
  const stamp = q(".ink-stamp")[0] as HTMLElement;
  const splatter = q(".ink-splatter")[0] as HTMLElement;

  const split = SplitText.create(headline.querySelector("h1"), { type: "words,chars", aria: "auto" });
  const box = headline.getBoundingClientRect();
  const points = split.chars.map((char) => {
    const rect = char.getBoundingClientRect();
    return { x: rect.right - box.left, y: rect.top + rect.height * 0.8 - box.top };
  });
  const step = 1.15 / split.chars.length;
  const last = points[points.length - 1];

  gsap.set(split.chars, { opacity: 0 });
  gsap.set(nib, { x: points[0].x, y: points[0].y, opacity: 1 });
  gsap.set(q(".ink-row > *, .ink-title"), { opacity: 0, x: -8 });
  gsap.set(q(".ink-sub"), { opacity: 0, y: 18 });
  gsap.set(q(".ink-ledger-stamp"), { opacity: 0, scale: 2.2 });
  gsap.set(stamp, { opacity: 0, scale: 3 });
  section.dataset.inkReady = "true";

  const tl = gsap.timeline({ onComplete: onDone });

  // The pen. Letters appear left to right with the nib just ahead of them.
  tl.to(split.chars, { opacity: 1, duration: 0.05, stagger: step, ease: "none" }, 0);
  points.forEach((point, i) => tl.to(nib, { x: point.x, y: point.y, duration: step, ease: "none" }, i * step));
  tl.to(nib, {
    motionPath: { path: [{ x: last.x + 16, y: last.y - 10 }, { x: last.x + 40, y: last.y - 46 }], curviness: 1.4 },
    opacity: 0,
    duration: 0.26,
    ease: "power1.in",
  }, 1.15);

  // The ledger fills in alongside it, then the subheading and the two ledger stamps.
  tl.to(q(".ink-title, .ink-row > *"), { opacity: 1, x: 0, duration: 0.2, stagger: 0.085, ease: "power1.out" }, 0.12);
  tl.to(q(".ink-sub"), { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, 1.15);
  tl.to(q(".ink-ledger-stamp"), { opacity: 1, scale: 1, duration: 0.18, stagger: 0.18, ease: "power3.in" }, 1.3);

  // The slam: the stamp lands at 1.87s, the screen jolts and the ink flies.
  tl.set(stamp, { opacity: 1 }, 1.7);
  tl.to(stamp, { scale: 1, duration: 0.17, ease: "power4.in" }, 1.7);
  tl.to(section, {
    keyframes: { x: [0, -7, 6, -4, 2, 0], y: [0, 5, -4, 2, -1, 0] },
    duration: 0.26,
    ease: "none",
  }, 1.87);
  tl.set(section, { clearProps: "transform" }, 2.14);
  tl.fromTo(splatter, { opacity: 0.95, scale: 0.55 }, { opacity: 0, scale: 1.12, duration: 0.5, ease: "power2.out", immediateRender: false }, 1.87);

  return tl;
}

/** Phones: simple fade-ups, with no pen, no slam and no shake. */
function fadeUp(section: HTMLElement, onDone: () => void) {
  const items = gsap.utils.selector(section)(".ink-pending");
  gsap.set(items, { opacity: 0, y: 16 });
  section.dataset.inkReady = "true";
  return gsap.to(items, { opacity: 1, y: 0, duration: 0.5, stagger: 0.05, ease: "power2.out", onComplete: onDone });
}

export function LandingHero() {
  const root = useRef<HTMLElement>(null);
  const played = useRef(false);

  useGSAP((_context, contextSafe) => {
    const section = root.current;
    if (!section || !contextSafe) return;
    let cancelled = false;
    let mm: gsap.MatchMedia | undefined;

    const start = contextSafe(() => {
      // If scripts took so long that the CSS safety net already showed the page, don't hide it and start over.
      const alreadyShown = section.querySelector("h1")?.getAnimations().some((animation) => animation.playState === "finished");
      if (alreadyShown) played.current = true;
      const onDone = () => {
        played.current = true;
        ScrollTrigger.refresh();
      };
      mm = gsap.matchMedia();
      mm.add(MOTION.full, () => {
        if (played.current) section.dataset.inkReady = "true";
        else writeAndStamp(section, onDone);
      });
      mm.add(MOTION.phone, () => {
        if (played.current) section.dataset.inkReady = "true";
        else fadeUp(section, onDone);
      });
    });

    // The pen's path is measured from the letters, so give the serif a moment to arrive first.
    const fontWait = new Promise((resolve) => setTimeout(resolve, 500));
    void Promise.race([document.fonts.ready, fontWait]).then(() => {
      if (!cancelled) start();
    });

    return () => {
      cancelled = true;
      mm?.revert();
    };
  }, { scope: root });

  return (
    <section
      ref={root}
      className="landing-hero mx-auto flex max-w-[1240px] flex-wrap items-center gap-14 bg-[#F1E8D2] px-6 pt-20 pb-24"
    >
      <div className="flex min-w-0 flex-[1_1_460px] flex-col gap-6">
        <span className="font-mono text-[13px] uppercase tracking-[0.1em] text-[#B3261E]">
          Bahi-khata, on-chain
        </span>
        <div className="ink-headline relative">
          <h1 className="ink-pending m-0 font-serif text-[clamp(48px,6.4vw,92px)] font-normal leading-[0.98] tracking-[-0.01em]">
            Every business in India runs on udhaar.{" "}
            <span className="italic text-[#B3261E]">Now it settles itself.</span>
          </h1>
          <PenNib />
        </div>
        <p className="ink-sub ink-pending m-0 max-w-[560px] text-[19px] leading-[1.6]">
          Suppliers wait months for big buyers to pay. Udhaar turns a buyer-confirmed invoice
          into a token that investors fund today, that suppliers can pass down the chain, and
          that repays every holder automatically on the due date.
        </p>
        <div className="flex flex-wrap gap-3.5">
          <Link
            href="/login"
            className="btn bg-[#1B2340] px-[26px] py-4 text-[17px] font-semibold text-[#F1E8D2] no-underline hover:text-[#F1E8D2]"
          >
            Open the khata
          </Link>
          <a
            href="#entries"
            onClick={(e) => onAnchorClick(e, "entries")}
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
          <div className="ink-title ink-pending truncate text-[20px] font-bold sm:text-[24px]">
            Khata — Ramesh Cement Works
          </div>
          <div className={LEDGER_ROW}>
            <span>06 Nov</span>
            <span className="truncate">INV-0042</span>
            <span className="text-right">₹1,00,000</span>
          </div>
          <div className={LEDGER_ROW}>
            <span>06 Nov</span>
            <span className="truncate">Buyer signed</span>
            <span className="text-right">confirmed</span>
          </div>
          <div className={LEDGER_ROW}>
            <span>06 Nov</span>
            <span className="truncate">Grade A, 12%</span>
            <span className="text-right">₹970.41</span>
          </div>
          <div className={LEDGER_ROW}>
            <span>04 Feb</span>
            <span className="truncate text-[#6B6F86]">due from BigBuild</span>
            <span className="text-right text-[#6B6F86]">90 days</span>
          </div>
        </div>

        <div className="ink-ledger-stamp ink-pending pointer-events-none absolute top-[58px] right-[92px] -rotate-[9deg] border-4 border-double border-[#B3261E] bg-transparent px-4 py-2.5 text-center font-mono text-[13px] font-semibold uppercase leading-[1.4] tracking-[0.06em] text-[#B3261E] mix-blend-multiply sm:top-[62px] sm:right-[118px] sm:text-[15px]">
          Tokenized
          <br />
          100 × ₹1,000
          <br />
          <span className="text-xs font-medium">bond 0.0.11328164</span>
        </div>
        <div className="ink-ledger-stamp ink-pending pointer-events-none absolute top-[156px] right-[88px] rotate-[4deg] border-[3px] border-[#2F6B4F] bg-transparent px-3 py-1.5 font-mono text-[13px] font-semibold uppercase tracking-[0.06em] text-[#2F6B4F] mix-blend-multiply sm:top-[160px] sm:right-[114px]">
          Paid in units
        </div>

        <UdhaarStamp />
      </div>
    </section>
  );
}

function PenNib() {
  return (
    <svg
      aria-hidden="true"
      className="ink-nib pointer-events-none absolute top-0 left-0 opacity-0"
      width="34"
      height="44"
      viewBox="0 0 34 44"
      fill="none"
    >
      {/* Drawn with the tip at the top left corner, so the nib's x and y are where the ink lands. */}
      <circle cx="2" cy="2" r="4.5" fill="#1B2340" />
      <circle cx="8.5" cy="1" r="1.3" fill="#1B2340" />
      <path d="M1 1 L15 12 L31 34 L22 41 L7 22 Z" fill="#1B2340" />
      <path d="M2 2 L15 19" stroke="#F1E8D2" strokeWidth="1.2" />
      <circle cx="16" cy="20" r="2.2" fill="#F1E8D2" />
    </svg>
  );
}

function UdhaarStamp() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute -right-1 -bottom-11 w-[190px] sm:-right-3 sm:-bottom-12 sm:w-[270px]"
    >
      <svg
        className="ink-splatter absolute inset-0 h-full w-full overflow-visible opacity-0"
        viewBox="0 0 280 140"
        fill="#B3261E"
      >
        {SPLATTER.map(([cx, cy, r]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
        ))}
      </svg>
      <svg
        className="ink-stamp ink-pending relative block h-auto w-full -rotate-[7deg] mix-blend-multiply"
        viewBox="0 0 280 140"
      >
        <defs>
          {/* Holes in the ink, so it reads as rubber on paper and not a clean vector. */}
          <filter id="stamp-grain" x="-4%" y="-4%" width="108%" height="108%">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="11" />
            <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.6 2.3" result="holes" />
            <feComposite in="SourceGraphic" in2="holes" operator="in" />
          </filter>
        </defs>
        <g filter="url(#stamp-grain)" fill="none" stroke="#B3261E">
          <rect x="10" y="26" width="260" height="88" rx="6" strokeWidth="5" />
          <rect x="19" y="35" width="242" height="70" rx="3" strokeWidth="1.6" />
          <text
            x="140"
            y="88"
            fill="#B3261E"
            stroke="none"
            textAnchor="middle"
            fontSize="50"
            fontWeight="600"
            letterSpacing="5"
            style={{ fontFamily: "var(--font-mono), monospace" }}
          >
            UDHAAR
          </text>
        </g>
      </svg>
    </div>
  );
}

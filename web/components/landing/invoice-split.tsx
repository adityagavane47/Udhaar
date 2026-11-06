"use client";
import { useRef } from "react";
import { Flip, gsap, MOTION, ScrollTrigger, useGSAP } from "./gsap";

/** ₹1,00,000 at ₹1,000 face value, Grade A at 12% a year, due in 90 days: 1000 × (1 − 0.12 × 90 / 365). */
const COUNTER_TEXT = "1 invoice → 100 tokens → ₹970.41 each";
const TOKENS = Array.from({ length: 100 }, (_, i) => i);

// The perforations sit on a 620 × 300 card, cut every tenth of each side.
const CARD_W = 620;
const CARD_H = 300;
const CUTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** The odometer's strip runs 0–9 twice, so a final 0 still rolls a full turn. */
const STRIP = "0123456789".repeat(2).split("").join("\n");
const restingPercent = (digit: number) => -(10 + digit) * 5;

function Perforations({ draw }: { draw?: boolean }) {
  const props = draw ? { className: "perf-line" } : {};
  return (
    <>
      {CUTS.map((n) => (
        <line key={`v${n}`} {...props} x1={(CARD_W / 10) * n} y1={0} x2={(CARD_W / 10) * n} y2={CARD_H} />
      ))}
      {CUTS.map((n) => (
        <line key={`h${n}`} {...props} x1={0} y1={(CARD_H / 10) * n} x2={CARD_W} y2={(CARD_H / 10) * n} />
      ))}
    </>
  );
}

function Odometer({ value }: { value: string }) {
  return (
    <span className="odometer">
      {value.split("").map((char, i) =>
        /\d/.test(char) ? (
          <span key={i} className="odometer__digit">
            <span
              className="odometer__strip"
              data-digit={char}
              style={{ transform: `translateY(${restingPercent(Number(char))}%)` }}
            >
              {STRIP}
            </span>
          </span>
        ) : (
          <span key={i}>{char}</span>
        ),
      )}
    </span>
  );
}

/** The whole story, scrubbed by scroll, so scrolling back up plays it in reverse. */
function buildSplit(section: HTMLElement) {
  const q = gsap.utils.selector(section);
  const grid = q(".token-grid")[0] as HTMLElement;
  const chips = q(".token-chip") as HTMLElement[];
  const faces = q(".token-chip__face") as HTMLElement[];
  const strips = q(".odometer__strip") as HTMLElement[];

  // Where each chip starts: as one tile of the card. The grid's own layout is where it lands.
  grid.classList.add("is-on-card");
  const tiles = Flip.getState(chips);
  grid.classList.remove("is-on-card");

  gsap.set(faces, { opacity: 0 });
  gsap.set(q(".perf-line"), { drawSVG: "0%" });
  gsap.set(q(".split-counter"), { opacity: 0 });
  gsap.set(strips, { y: 0, yPercent: 0 });
  section.dataset.splitReady = "true";

  const tl = gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: { trigger: section, start: "top top", end: "bottom bottom", scrub: true },
  });

  // Perforations draw across the card.
  tl.to(q(".perf-line"), { drawSVG: "100%", duration: 0.7, stagger: 0.05, ease: "power1.inOut" }, 0.25);

  // The card becomes tiles.
  const spread = gsap.utils.distribute({ amount: 1.1, grid: [10, 10], from: "center" });
  // The words are gone before the first tile appears, so no tile is ever drawn across "due in 90 days".
  tl.to(q(".invoice-card__content"), { opacity: 0, duration: 0.2 }, 1.85);
  tl.to(faces, { opacity: 1, duration: 0.2, stagger: { amount: 0.15, grid: [10, 10], from: "random" } }, 2.05);
  tl.set(q(".invoice-card"), { opacity: 0 }, 2.3);

  // The tiles fly out, tumbling a little, and land in the grid.
  const flight = Flip.from(tiles, {
    targets: chips,
    absolute: false,
    scale: true,
    simple: true,
    duration: 2.2,
    ease: "power2.inOut",
    stagger: { amount: 1.1, grid: [10, 10], from: "center" },
  });
  tl.add(flight, 2.3);
  faces.forEach((face, i) => {
    const turn = (((i * 37) % 21) - 10) * 2.2;
    tl.to(face, { keyframes: { rotation: [0, turn, 0] }, duration: 2.2, ease: "sine.inOut" }, 2.3 + spread(i, face, faces));
  });

  // The counter rolls up as they land.
  tl.to(q(".split-counter"), { opacity: 1, duration: 0.3 }, 2.1);
  strips.forEach((strip, i) => {
    const digit = Number(strip.dataset.digit);
    tl.to(strip, { yPercent: restingPercent(digit), duration: 2, ease: "power2.inOut" }, 2.4 + i * 0.13);
  });

  tl.set({}, {}, 6.5); // Hold on the finished grid before the section scrolls away.
  return tl;
}

export function InvoiceSplit() {
  const root = useRef<HTMLElement>(null);

  useGSAP(() => {
    const section = root.current;
    if (!section) return;
    const mm = gsap.matchMedia();

    mm.add(MOTION.pinned, (context) => {
      let tl = buildSplit(section);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let width = window.innerWidth;
      let height = window.innerHeight;

      // The chips' flight is measured in pixels, so measure it again when the window changes size.
      const rebuild = context.add("rebuild", () => {
        tl.revert();
        tl = buildSplit(section);
        ScrollTrigger.refresh();
      }) as () => void;
      const onResize = () => {
        if (window.innerWidth === width && window.innerHeight === height) return;
        width = window.innerWidth;
        height = window.innerHeight;
        clearTimeout(timer);
        timer = setTimeout(rebuild, 150);
      };
      window.addEventListener("resize", onResize);
      void document.fonts.ready.then(() => ScrollTrigger.refresh());

      return () => {
        clearTimeout(timer);
        window.removeEventListener("resize", onResize);
        delete section.dataset.splitReady;
      };
    });

    mm.add(MOTION.unpinned, () => {
      for (const element of gsap.utils.selector(section)(".invoice-split__eyebrow, .invoice-card, .token-grid, .split-counter")) {
        gsap.from(element, {
          opacity: 0,
          y: 24,
          duration: 0.6,
          ease: "power2.out",
          scrollTrigger: { trigger: element, start: "top 90%", once: true },
        });
      }
    });

    return () => mm.revert();
  }, { scope: root });

  return (
    <section ref={root} className="invoice-split" aria-label="One invoice becomes a hundred tokens">
      <div className="invoice-split__stage">
        <p className="invoice-split__eyebrow">Invoice → tokens</p>

        <div className="invoice-split__board">
          <article className="invoice-card">
            <div className="invoice-card__content">
              <p className="invoice-card__number">INV-0042</p>
              <p className="invoice-card__parties">
                Ramesh Cement Works <span className="text-[#B3261E]">→</span> BigBuild Constructions
              </p>
              <p className="invoice-card__amount">₹1,00,000</p>
              <p className="invoice-card__due">due in 90 days</p>
              <p className="invoice-card__stamp">Confirmed by buyer</p>
            </div>
            <svg className="invoice-card__perf" viewBox={`0 0 ${CARD_W} ${CARD_H}`} aria-hidden="true">
              <defs>
                {/* DrawSVG uses the stroke's dashes itself, so it draws a mask that uncovers the dotted lines. */}
                <mask id="perf-reveal" maskUnits="userSpaceOnUse" x="0" y="0" width={CARD_W} height={CARD_H}>
                  <g stroke="#fff" strokeWidth="6">
                    <Perforations draw />
                  </g>
                </mask>
              </defs>
              <g mask="url(#perf-reveal)" stroke="#1B2340" strokeWidth="2" strokeLinecap="round" strokeDasharray="0.1 6">
                <Perforations />
              </g>
            </svg>
          </article>

          <div className="token-grid" aria-hidden="true">
            {TOKENS.map((i) => (
              <div key={i} className="token-chip">
                <span className="token-chip__face">₹1,000</span>
              </div>
            ))}
          </div>
        </div>

        <p className="split-counter">
          <span className="sr-only">{COUNTER_TEXT}</span>
          <span aria-hidden="true" className="split-counter__line">
            <span className="split-counter__group">
              <Odometer value="1" /> <span className="split-counter__word">invoice</span>
            </span>
            <span className="split-counter__arrow">→</span>
            <span className="split-counter__group">
              <Odometer value="100" /> <span className="split-counter__word">tokens</span>
            </span>
            <span className="split-counter__arrow">→</span>
            <span className="split-counter__group">
              <span className="odometer">₹</span>
              <Odometer value="970.41" /> <span className="split-counter__word">each</span>
            </span>
          </span>
        </p>
      </div>
    </section>
  );
}

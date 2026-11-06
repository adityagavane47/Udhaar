"use client";
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { registerLenis } from "./scroll-to";
import { gsap, MOTION, ScrollTrigger, useGSAP } from "./gsap";

/** Smooth scrolling for the landing page only: it starts on mount and is destroyed on unmount. */
export function SmoothScroll() {
  useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add(MOTION.full, () => {
      const lenis = new Lenis();
      registerLenis(lenis);
      const tick = (seconds: number) => lenis.raf(seconds * 1000);
      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(0);
      return () => {
        gsap.ticker.remove(tick);
        gsap.ticker.lagSmoothing(500, 33);
        registerLenis(null);
        lenis.destroy();
      };
    });
    return () => mm.revert();
  });
  return null;
}

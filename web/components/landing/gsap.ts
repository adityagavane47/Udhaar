"use client";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { Flip } from "gsap/Flip";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

// The one place the landing page registers GSAP's plugins. Import them from here.
gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText, DrawSVGPlugin, Flip, MotionPathPlugin);

/** Keep these in step with the landing styles in app/globals.css. */
export const MOTION = {
  /** Full hero, and smooth scrolling. */
  full: "(min-width: 768px) and (prefers-reduced-motion: no-preference)",
  /** Phones: simple fade-ups in the hero. */
  phone: "(max-width: 767.98px) and (prefers-reduced-motion: no-preference)",
  /** The pinned invoice section. Short screens, such as a phone on its side, get the static version. */
  pinned: "(scripting: enabled) and (min-width: 768px) and (min-height: 560px) and (prefers-reduced-motion: no-preference)",
  /** The static invoice section, with fade-ups. */
  unpinned: "(prefers-reduced-motion: no-preference) and (max-width: 767.98px), (prefers-reduced-motion: no-preference) and (max-height: 559.98px)",
} as const;

export { DrawSVGPlugin, Flip, gsap, MotionPathPlugin, ScrollTrigger, SplitText, useGSAP };

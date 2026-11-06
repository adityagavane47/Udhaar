import type Lenis from "lenis";

/** The landing page's Lenis, while it exists. Kept here so the header can use it without importing Lenis or GSAP. */
let active: Lenis | null = null;

export function registerLenis(lenis: Lenis | null) {
  active = lenis;
}

/**
 * Smooth-scroll to a section of the current page. No hash is written to the URL, so no history entry
 * is added and Back keeps leaving the page the way it came in.
 */
export function scrollToSection(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  if (active) {
    active.scrollTo(target);
    return;
  }
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}

/** Click handler for links shaped like href="#id": scrolls instead of navigating. */
export function onAnchorClick(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  scrollToSection(id);
}

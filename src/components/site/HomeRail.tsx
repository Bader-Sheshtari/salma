"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Horizontal story rail (homepage `display_style: carousel`, e.g. the frost
 * «صحة وحياة» City-Guides moment). Native scroll-snap does the work; the
 * arrows + counter are progressive enhancement:
 *  - carousel aria pattern: region + aria-roledescription, slides labelled
 *    "n من N", live counter;
 *  - keyboard: the arrows are real buttons; every slide's link is focusable;
 *  - prefers-reduced-motion: arrow scrolling jumps (no smooth animation).
 * RTL-aware (scrollLeft is ≤0 in RTL).
 */
export function HomeRail({
  label,
  heading,
  items,
  buttonClass,
  bodyClass,
}: {
  /** Accessible name of the carousel region (the section title). */
  label: string;
  /** Section heading row (title + rule); the controls are appended to it. */
  heading: ReactNode;
  items: ReactNode[];
  /** Identity-tinted arrow button classes. */
  buttonClass: string;
  /** Identity text colour for the counter. */
  bodyClass: string;
}) {
  const track = useRef<HTMLUListElement>(null);
  const [current, setCurrent] = useState(1);
  const [edge, setEdge] = useState({ start: true, end: true });
  const count = items.length;

  const step = useCallback(() => {
    const el = track.current;
    if (!el) return 0;
    const kids = el.children;
    if (kids.length > 1) {
      return Math.abs((kids[1] as HTMLElement).offsetLeft - (kids[0] as HTMLElement).offsetLeft);
    }
    return el.clientWidth;
  }, []);

  const sync = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const pos = Math.abs(el.scrollLeft);
    const s = step() || 1;
    const atEnd = pos >= max - 4;
    // At the far edge the last slide is in view even if it can't snap-align.
    setCurrent(atEnd && max > 4 ? count : Math.min(count, Math.round(pos / s) + 1));
    setEdge({ start: pos < 4, end: atEnd });
  }, [count, step]);

  useEffect(() => {
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [sync]);

  const go = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === "rtl";
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: (rtl ? -1 : 1) * dir * step(), behavior: reduce ? "auto" : "smooth" });
  };

  const scrollable = !(edge.start && edge.end);
  const btn = `grid size-11 place-items-center rounded-full transition-colors disabled:cursor-default disabled:opacity-40 ${buttonClass}`;

  return (
    <div role="region" aria-roledescription="carousel" aria-label={label}>
      <div className="mb-6 flex min-h-11 items-center gap-3">
        {heading}
        {count > 1 && scrollable ? (
          <div className="flex shrink-0 items-center gap-1">
            <span aria-live="polite" className={`me-2 hidden font-sans text-[13px] tracking-wide sm:inline ${bodyClass}`}>
              <b>{current}</b> / {count}
            </span>
            <button type="button" className={btn} aria-label="السابق" disabled={edge.start} onClick={() => go(-1)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-[18px]">
                <path d="m10 6 6 6-6 6" />
              </svg>
            </button>
            <button type="button" className={btn} aria-label="التالي" disabled={edge.end} onClick={() => go(1)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-[18px]">
                <path d="m14 6-6 6 6 6" />
              </svg>
            </button>
          </div>
        ) : null}
      </div>
      <ul
        ref={track}
        onScroll={() => window.requestAnimationFrame(sync)}
        className="salma-scroll -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-6 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:scroll-px-6 sm:px-6"
      >
        {items.map((item, i) => (
          <li
            key={i}
            aria-roledescription="slide"
            aria-label={`${i + 1} من ${count}`}
            className="w-[min(380px,78vw)] shrink-0 snap-start"
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

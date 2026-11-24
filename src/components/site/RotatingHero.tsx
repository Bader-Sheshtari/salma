"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Content } from "@/lib/queries";
import { Cover, coverFor, hrefFor } from "./cards";
import { LeadMeta } from "./LeadMeta";

const ROTATE_MS = 6500;

/**
 * The homepage lead card, auto-rotating through the top stories. Slides
 * cross-fade every ~6.5s. Rotation pauses on hover/focus and is disabled for
 * users who prefer reduced motion; dots let the reader jump to any story.
 *
 * Phase 2 (Direction E / refined H1 lead board): restyle only — the rotation,
 * timing, pause and reduced-motion logic above the `return` are unchanged.
 * Slides now stack in one grid cell (image 16/9, headline + excerpt + meta
 * below it) and «الأبرز» is the golden-100 editor's-pick highlight.
 */
export function RotatingHero({
  items,
  categoryNames = {},
}: {
  items: Content[];
  categoryNames?: Record<string, string>;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = items.length;

  useEffect(() => {
    if (count <= 1 || paused) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % count), ROTATE_MS);
    return () => clearInterval(t);
  }, [count, paused]);

  if (count === 0) return null;

  return (
    <div
      className="relative"
      role="region"
      aria-roledescription="carousel"
      aria-label="الأبرز"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="mb-4 flex min-h-8 items-center gap-2 border-b border-amethyst pb-2">
        {/* Golden-100 marker highlight behind the tag text (amethyst on golden: 12.2:1). */}
        <span className="bg-[linear-gradient(transparent_40%,var(--color-golden-pollen)_40%,var(--color-golden-pollen)_94%,transparent_94%)] px-1.5 text-[15px] font-bold leading-snug text-amethyst">
          الأبرز
        </span>
        {count > 1 ? (
          <span
            aria-hidden
            dir="ltr"
            className="ms-auto font-sans text-[13px] tracking-wide text-amethyst-600 md:text-[11px]"
          >
            <b>{index + 1}</b> / {count}
          </span>
        ) : null}
      </div>

      <div className="grid">
        {items.map((c, i) => (
          // The cross-fade lives on this wrapper, not the Link, so the Link's
          // own press feedback (`a:active`) stays instant instead of inheriting
          // the 700ms opacity transition. All slides share one grid cell.
          <div
            key={c.id}
            className={`[grid-area:1/1] transition-opacity duration-700 ease-in-out ${
              i === index ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            <Link
              href={hrefFor(c)}
              aria-hidden={i !== index}
              tabIndex={i === index ? 0 : -1}
              className="group block rounded-[10px]"
            >
              <div className="relative isolate aspect-video overflow-hidden rounded-[10px] bg-seashell-2">
                <Cover src={coverFor(c)} alt="صورة رئيسية" className="absolute inset-0" zoom />
              </div>
              <h2 className="mt-4 text-[length:var(--brand-fs-hero)] font-bold leading-[1.3] text-amethyst decoration-1 underline-offset-[5px] group-hover:underline">
                {c.title}
              </h2>
              {c.excerpt ? (
                <p className="mt-2 line-clamp-2 text-sm leading-[1.7] text-amethyst-600">{c.excerpt}</p>
              ) : null}
              <LeadMeta
                c={c}
                mode="time"
                categoryName={c.category_slug ? categoryNames[c.category_slug] : undefined}
              />
            </Link>
          </div>
        ))}
      </div>

      {count > 1 ? (
        // Each dot is a 44px button (apple-design §10); the visible dot is an
        // inner span — active pill 24px amethyst, inactive 8px amethyst-200.
        <div className="mt-1 -ms-2 flex items-center">
          {items.map((c, i) => (
            <button
              key={c.id}
              type="button"
              aria-label={`الخبر رقم ${i + 1}`}
              aria-current={i === index}
              onClick={() => setIndex(i)}
              className={`group grid h-11 place-items-center rounded-lg ${i === index ? "w-14" : "w-11"}`}
            >
              <span
                className={`block h-2 rounded-full transition-all motion-reduce:transition-none ${
                  i === index ? "w-6 bg-amethyst" : "w-2 bg-amethyst-200 group-hover:bg-amethyst-600"
                }`}
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

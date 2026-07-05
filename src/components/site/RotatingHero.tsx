"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Content } from "@/lib/queries";
import { Cover, hrefFor } from "./cards";
import { timeAgoAr } from "@/lib/format";

const ROTATE_MS = 6500;

/**
 * The homepage lead card, auto-rotating through the top stories. Slides
 * cross-fade every ~6.5s. Rotation pauses on hover/focus and is disabled for
 * users who prefer reduced motion; dots let the reader jump to any story.
 */
export function RotatingHero({ items }: { items: Content[] }) {
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
      className="relative overflow-hidden rounded-2xl border border-line"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="relative aspect-[16/10]">
        {items.map((c, i) => (
          <Link
            key={c.id}
            href={hrefFor(c)}
            aria-hidden={i !== index}
            tabIndex={i === index ? 0 : -1}
            className={`absolute inset-0 flex items-end transition-opacity duration-700 ease-in-out ${
              i === index ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            <Cover src={c.cover_image_url} alt="صورة رئيسية" className="absolute inset-0" />
            <span className="absolute right-3 top-3 rounded-md bg-teal px-2.5 py-1 text-[11px] font-semibold text-white">
              الأبرز
            </span>
            <div className="relative w-full bg-gradient-to-t from-ink/90 to-transparent p-4 pt-12 sm:p-6 sm:pt-16">
              <h2 className="m-0 text-lg font-bold leading-snug text-white sm:text-2xl">{c.title}</h2>
              <div className="mt-2 font-sans text-[11.5px] font-medium text-gold">
                {timeAgoAr(c.published_at)}
              </div>
            </div>
          </Link>
        ))}
      </div>

      {count > 1 ? (
        <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5">
          {items.map((c, i) => (
            <button
              key={c.id}
              type="button"
              aria-label={`الخبر رقم ${i + 1}`}
              aria-current={i === index}
              onClick={() => setIndex(i)}
              className={`h-2 rounded-full transition-all ${
                i === index ? "w-5 bg-white" : "w-2 bg-white/50 hover:bg-white/80"
              }`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

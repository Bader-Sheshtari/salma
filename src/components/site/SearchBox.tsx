"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const PLACEHOLDER = "ابحث في سلمى عن خبر، دراسة، طبيب، أو موضوع صحي...";

/**
 * Clean white internal-search box. Submits to /search?q=… (server-rendered
 * results) so it works without JS; `useRouter` just gives a snappier push.
 * `variant="hero"` is the larger homepage treatment; "compact" suits page tops.
 */
export function SearchBox({
  defaultValue = "",
  variant = "compact",
  autoFocus = false,
}: {
  defaultValue?: string;
  variant?: "hero" | "compact";
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState(defaultValue);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (query) router.push(`/search?q=${encodeURIComponent(query)}`);
  }

  const hero = variant === "hero";

  return (
    <form
      action="/search"
      onSubmit={submit}
      role="search"
      className={`flex gap-2 ${hero ? "" : "mx-auto max-w-2xl"}`}
    >
      <input
        name="q"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={PLACEHOLDER}
        aria-label="بحث"
        dir="rtl"
        autoFocus={autoFocus}
        className={`flex-1 rounded-xl border border-line bg-white text-ink shadow-sm outline-none placeholder:text-gray focus:border-teal ${
          hero ? "px-4 py-3.5 text-[15px]" : "px-3.5 py-2.5 text-sm"
        }`}
      />
      <button
        type="submit"
        className={`shrink-0 rounded-xl bg-teal font-bold text-white hover:opacity-90 ${
          hero ? "px-6 py-3.5 text-[15px]" : "px-5 py-2.5 text-sm"
        }`}
      >
        بحث
      </button>
    </form>
  );
}

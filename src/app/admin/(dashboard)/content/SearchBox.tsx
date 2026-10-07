"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cleanQ, contentHref } from "@/lib/content-search";

/**
 * Debounced (300ms, min 2 chars) server-side search box. State lives in the
 * URL: typing calls router.replace, the server component re-runs the RPC.
 *  - global: searches every status + category → /admin/content?status=all&q=…
 *  - scoped: keeps the current view (category / trash) and only swaps `q`.
 */
export default function SearchBox({
  mode,
  value,
  baseParams,
  placeholder,
}: {
  mode: "global" | "scoped";
  value: string;
  baseParams: Record<string, string>;
  placeholder: string;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [text, setText] = useState(value);
  const [prevValue, setPrevValue] = useState(value);
  const [lastPushed, setLastPushed] = useState(value);

  // Follow external URL changes (tab switch, «مسح») without clobbering what the
  // user is still typing after a debounced push.
  if (value !== prevValue) {
    setPrevValue(value);
    if (value !== lastPushed) {
      setText(value);
      setLastPushed(value);
    }
  }

  useEffect(() => {
    const raw = text.trim();
    const next = cleanQ(raw);
    if (raw.length > 0 && !next) return; // below min length → wait
    if (next === lastPushed) return;
    const t = setTimeout(() => {
      setLastPushed(next);
      const href =
        mode === "global"
          ? contentHref({ status: "all", q: next })
          : contentHref({ ...baseParams, q: next });
      startTransition(() => router.replace(href, { scroll: false }));
    }, 300);
    return () => clearTimeout(t);
  }, [text, lastPushed, mode, baseParams, router]);

  return (
    <div className="relative">
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full rounded-lg border border-gray/40 bg-white px-3.5 py-2.5 pe-20 text-sm outline-none focus:border-teal"
      />
      <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 font-sans text-[11px] text-gray">
        {busy ? "جارٍ البحث…" : ""}
      </span>
    </div>
  );
}

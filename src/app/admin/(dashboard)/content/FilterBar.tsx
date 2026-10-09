"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  REAL_STATUSES,
  SORT_LABEL_AR,
  STATUS_LABEL_AR,
  SYSTEM_AUTHOR,
  SYSTEM_AUTHOR_LABEL,
  contentHref,
  type ContentSort,
} from "@/lib/content-search";
import type { AdminProfileOption } from "@/lib/admin-queries";

const ctl =
  "rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] outline-none focus:border-teal";
const lbl = "flex items-center gap-1.5 text-[12.5px] text-gray";

/** Advanced filter keys (inside the تصفية panel). Sort lives outside it. */
const FILTER_KEYS = ["from", "to", "author", "reviewer", "publisher", "st", "cat"] as const;

/**
 * One row: الترتيب (always visible) + «تصفية ▾». The تصفية panel (collapsed by
 * default on every screen size) holds التاريخ (range) · الكاتب · المراجع ·
 * الناشر (+ الحالة inside الكل, + القسم in tabs without a category strip).
 * Reviewer and publisher are filters only, never table columns. The button
 * shows how many advanced filters are active (a date range counts once).
 */
export default function FilterBar({
  params,
  showStatus,
  categoryOptions,
  sortOptions,
  sort,
  profiles,
}: {
  params: Record<string, string>;
  showStatus: boolean;
  /** Non-null → render the القسم dropdown (pending/rejected/draft/trash). */
  categoryOptions: { slug: string; name_ar: string }[] | null;
  sortOptions: ContentSort[];
  sort: ContentSort;
  profiles: AdminProfileOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, startTransition] = useTransition();

  const owned = FILTER_KEYS.filter((k) => k !== "cat" || categoryOptions);
  const activeCount =
    (params.from || params.to ? 1 : 0) +
    owned.filter((k) => k !== "from" && k !== "to" && params[k]).length;

  function apply(patch: Record<string, string>) {
    const next = { ...params, ...patch };
    startTransition(() => router.replace(contentHref(next), { scroll: false }));
  }
  function reset() {
    const next = { ...params };
    for (const k of owned) delete next[k];
    startTransition(() => router.replace(contentHref(next), { scroll: false }));
  }

  return (
    <div className={`mb-3 ${busy ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        {sortOptions.length > 0 ? (
          <label className={lbl}>
            <span>الترتيب:</span>
            <select value={sort} onChange={(e) => apply({ sort: e.target.value })} className={ctl}>
              {sortOptions.map((s) => (
                <option key={s} value={s}>
                  {SORT_LABEL_AR[s]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold ${
            activeCount > 0 ? "border-teal bg-teal/5 text-teal" : "border-line bg-white text-ink"
          }`}
          aria-expanded={open}
          aria-controls="content-filter-panel"
        >
          تصفية{activeCount > 0 ? ` (${activeCount})` : ""} {open ? "▴" : "▾"}
        </button>
      </div>

      <div
        id="content-filter-panel"
        className={`${open ? "flex" : "hidden"} mt-2 flex-col gap-2 rounded-xl border border-line bg-white p-3 md:flex-row md:flex-wrap md:items-center md:gap-x-4`}
      >
        <div className={lbl}>
          <span>التاريخ:</span>
          <input
            type="date"
            value={params.from ?? ""}
            onChange={(e) => apply({ from: e.target.value })}
            className={ctl}
            aria-label="من تاريخ"
          />
          <span>—</span>
          <input
            type="date"
            value={params.to ?? ""}
            onChange={(e) => apply({ to: e.target.value })}
            className={ctl}
            aria-label="إلى تاريخ"
          />
        </div>

        <label className={lbl}>
          <span>الكاتب:</span>
          <select value={params.author ?? ""} onChange={(e) => apply({ author: e.target.value })} className={ctl}>
            <option value="">الكل</option>
            <option value={SYSTEM_AUTHOR}>{SYSTEM_AUTHOR_LABEL}</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className={lbl}>
          <span>المراجع:</span>
          <select value={params.reviewer ?? ""} onChange={(e) => apply({ reviewer: e.target.value })} className={ctl}>
            <option value="">الكل</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className={lbl}>
          <span>الناشر:</span>
          <select value={params.publisher ?? ""} onChange={(e) => apply({ publisher: e.target.value })} className={ctl}>
            <option value="">الكل</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        {categoryOptions ? (
          <label className={lbl}>
            <span>القسم:</span>
            <select value={params.cat ?? ""} onChange={(e) => apply({ cat: e.target.value })} className={ctl}>
              <option value="">كل الأقسام</option>
              {categoryOptions.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name_ar}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {showStatus ? (
          <label className={lbl}>
            <span>الحالة:</span>
            <select value={params.st ?? ""} onChange={(e) => apply({ st: e.target.value })} className={ctl}>
              <option value="">الكل</option>
              {REAL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL_AR[s]}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {activeCount > 0 ? (
          <button type="button" onClick={reset} className="text-[12.5px] font-semibold text-coral md:ms-auto">
            مسح التصفية
          </button>
        ) : null}
      </div>
    </div>
  );
}

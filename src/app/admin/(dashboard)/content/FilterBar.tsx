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

/** Keys this bar owns; any of them set = "filters active". */
const FILTER_KEYS = ["from", "to", "author", "reviewer", "publisher", "sort", "st", "cat"] as const;

/**
 * Filter bar: التاريخ (range) · الكاتب · المراجع · الناشر · الترتيب (+ الحالة
 * inside الكل, + القسم dropdown in tabs without a category strip). Reviewer and
 * publisher are filters only, never table columns. Collapses into «تصفية ▾»
 * below md.
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
  const activeCount = owned.filter((k) => params[k]).length;

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
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold md:hidden"
        aria-expanded={open}
      >
        تصفية {activeCount > 0 ? `(${activeCount})` : ""} ▾
      </button>

      <div
        className={`${open ? "flex" : "hidden"} mt-2 flex-col gap-2 rounded-xl border border-line bg-white p-3 md:mt-0 md:flex md:flex-row md:flex-wrap md:items-center md:border-0 md:bg-transparent md:p-0`}
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

        {activeCount > 0 ? (
          <button type="button" onClick={reset} className="text-[12.5px] font-semibold text-coral md:ms-auto">
            مسح التصفية
          </button>
        ) : null}
      </div>
    </div>
  );
}

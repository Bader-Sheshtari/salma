"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Content, Category } from "@/lib/queries";
import { timeAgoAr, formatDateTimeAr } from "@/lib/format";
import {
  setStatus,
  softDeleteContent,
  rejectContent,
  bulkSetStatus,
  bulkSoftDelete,
  setCategory,
  type BulkActionResult,
} from "../../actions";

const STATUS_LABEL: Record<string, string> = {
  published: "منشور",
  pending: "مراجعة",
  draft: "مسودّة",
  rejected: "مرفوض",
};

const NEEDS_REVIEW = "بحاجة مراجعة";

/** Today / Yesterday / absolute Arabic date for a timestamp, plus a sortable key. */
function dayInfo(iso: string): { key: number; label: string } {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const that = startOf(d);
  const diffDays = Math.round((startOf(new Date()) - that) / 86_400_000);
  const label =
    diffDays === 0
      ? "اليوم"
      : diffDays === 1
        ? "أمس"
        : new Intl.DateTimeFormat("ar-KW", {
            day: "numeric",
            month: "long",
            year: "numeric",
            numberingSystem: "latn",
          }).format(d);
  return { key: that, label };
}

type Group = { key: string; label: string; accent?: string; items: Content[] };

export default function ContentInbox({
  items,
  categories,
}: {
  items: Content[];
  categories: Category[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [catFilter, setCatFilter] = useState<string>(""); // "" = all
  const [groupBy, setGroupBy] = useState<"date" | "category">("date");
  const [report, setReport] = useState<BulkActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const catMap = useMemo(() => {
    const m = new Map<string, Category>();
    for (const c of categories) m.set(c.slug, c);
    return m;
  }, [categories]);

  const hasUncategorized = useMemo(
    () => items.some((c) => !c.category_slug),
    [items],
  );

  // Category filter first, then grouping.
  const filtered = useMemo(() => {
    if (!catFilter) return items;
    if (catFilter === "__none__") return items.filter((c) => !c.category_slug);
    return items.filter((c) => c.category_slug === catFilter);
  }, [items, catFilter]);

  const groups: Group[] = useMemo(() => {
    if (groupBy === "category") {
      const byCat = new Map<string, Content[]>();
      for (const c of filtered) {
        const k = c.category_slug ?? "__none__";
        (byCat.get(k) ?? byCat.set(k, []).get(k)!).push(c);
      }
      const order = (slug: string) =>
        slug === "__none__" ? Number.MAX_SAFE_INTEGER : catMap.get(slug)?.sort_order ?? 9_999;
      return [...byCat.entries()]
        .sort((a, b) => order(a[0]) - order(b[0]))
        .map(([slug, rows]) => ({
          key: slug,
          label: slug === "__none__" ? NEEDS_REVIEW : catMap.get(slug)?.name_ar ?? slug,
          accent: slug === "__none__" ? undefined : catMap.get(slug)?.accent,
          items: rows
            .slice()
            .sort((x, y) => +new Date(y.created_at) - +new Date(x.created_at)),
        }));
    }
    // Group by date (added date), newest day first, newest item first within a day.
    const byDay = new Map<number, Group>();
    for (const c of filtered) {
      const { key, label } = dayInfo(c.created_at);
      const g = byDay.get(key) ?? { key: String(key), label, items: [] };
      g.items.push(c);
      byDay.set(key, g);
    }
    return [...byDay.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, g]) => ({
        ...g,
        items: g.items
          .slice()
          .sort((x, y) => +new Date(y.created_at) - +new Date(x.created_at)),
      }));
  }, [filtered, groupBy, catMap]);

  const visibleIds = useMemo(() => filtered.map((c) => c.id), [filtered]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllVisible() {
    setSelected(new Set(visibleIds));
  }
  function clearSelection() {
    setSelected(new Set());
  }
  // Changing the category filter clears the selection so hidden items can never
  // be acted on — selection only ever means "currently visible + checked".
  function applyCatFilter(slug: string) {
    setCatFilter(slug);
    clearSelection();
  }

  function runBulk(kind: "publish" | "delete") {
    const ids = visibleIds.filter((id) => selected.has(id));
    const n = ids.length;
    if (n === 0) return;
    const ok =
      kind === "publish"
        ? window.confirm(`نشر ${n} مقالات مختارة؟`)
        : window.confirm(
            `حذف ${n} مقالات مختارة؟ قد لا يمكن التراجع عن هذا الإجراء.`,
          );
    if (!ok) return;
    setReport(null);
    startTransition(async () => {
      const res =
        kind === "publish"
          ? await bulkSetStatus(ids, "published")
          : await bulkSoftDelete(ids);
      setReport(res);
      clearSelection();
      router.refresh();
    });
  }

  function changeCategory(id: string, slug: string) {
    startTransition(async () => {
      const res = await setCategory(id, slug);
      if ("error" in res) window.alert(res.error);
      router.refresh();
    });
  }

  const selectedCount = visibleIds.filter((id) => selected.has(id)).length;

  return (
    <div>
      {/* Controls: category filter + group-by toggle */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="salma-scroll flex gap-2 overflow-x-auto">
          <button
            onClick={() => applyCatFilter("")}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px] font-semibold ${
              catFilter === "" ? "bg-teal text-white" : "border border-line bg-white text-gray"
            }`}
          >
            كل الأقسام
          </button>
          {categories.map((c) => (
            <button
              key={c.slug}
              onClick={() => applyCatFilter(c.slug)}
              className={`whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px] font-semibold ${
                catFilter === c.slug ? "bg-teal text-white" : "border border-line bg-white text-gray"
              }`}
            >
              {c.name_ar}
            </button>
          ))}
          {hasUncategorized ? (
            <button
              onClick={() => applyCatFilter("__none__")}
              className={`whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px] font-semibold ${
                catFilter === "__none__" ? "bg-coral text-white" : "border border-coral/50 bg-white text-coral"
              }`}
            >
              {NEEDS_REVIEW}
            </button>
          ) : null}
        </div>
        <div className="ms-auto flex items-center gap-1.5 text-[12.5px]">
          <span className="text-gray">تجميع حسب:</span>
          <button
            onClick={() => setGroupBy("date")}
            className={`rounded-lg px-2.5 py-1 font-semibold ${
              groupBy === "date" ? "bg-teal text-white" : "border border-line bg-white text-gray"
            }`}
          >
            التاريخ
          </button>
          <button
            onClick={() => setGroupBy("category")}
            className={`rounded-lg px-2.5 py-1 font-semibold ${
              groupBy === "category" ? "bg-teal text-white" : "border border-line bg-white text-gray"
            }`}
          >
            القسم
          </button>
        </div>
      </div>

      {/* Select-all row */}
      {filtered.length > 0 ? (
        <div className="mb-2 flex items-center gap-2 text-[12.5px] text-gray">
          <label className="flex cursor-pointer items-center gap-1.5 font-semibold">
            <input
              type="checkbox"
              className="size-4 accent-[var(--salma-teal)]"
              checked={allVisibleSelected}
              onChange={() => (allVisibleSelected ? clearSelection() : selectAllVisible())}
            />
            تحديد الكل ({filtered.length})
          </label>
          {selectedCount > 0 ? (
            <button onClick={clearSelection} className="text-coral font-semibold">
              إلغاء التحديد
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Bulk report */}
      {report ? (
        <div className="mb-3 rounded-xl border border-line bg-white p-3 text-[13px]">
          <div className="font-semibold">
            نجح: {report.succeeded} · تم تخطّيه: {report.skipped.length} · فشل: {report.failed.length}
          </div>
          {report.skipped.length > 0 ? (
            <div className="mt-1.5">
              <div className="text-[12px] font-semibold text-gray">تم تخطّيه:</div>
              <ul className="mt-0.5 list-disc space-y-0.5 ps-5 text-gray">
                {report.skipped.map((s) => (
                  <li key={s.id}>
                    {s.title} — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {report.failed.length > 0 ? (
            <div className="mt-1.5">
              <div className="text-[12px] font-semibold text-coral">فشل:</div>
              <ul className="mt-0.5 list-disc space-y-0.5 ps-5 text-coral">
                {report.failed.map((f) => (
                  <li key={f.id}>
                    {f.title} — {f.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <button onClick={() => setReport(null)} className="mt-2 text-[12px] text-gray underline">
            إخفاء
          </button>
        </div>
      ) : null}

      {/* List grouped by date/category */}
      <div className="overflow-hidden rounded-2xl border border-line bg-white">
        {filtered.length === 0 ? (
          <div className="p-6 text-[14px] text-gray">لا يوجد محتوى.</div>
        ) : (
          groups.map((g) => (
            <div key={g.key}>
              <div className="flex items-center gap-2 border-b border-line bg-cream/60 px-3.5 py-2">
                {g.accent ? (
                  <span className="size-2.5 rounded-full" style={{ background: g.accent }} />
                ) : null}
                <span className="text-[12.5px] font-bold text-ink">{g.label}</span>
                <span className="font-sans text-[11px] text-gray">({g.items.length})</span>
              </div>
              <ul className="divide-y divide-line">
                {g.items.map((c) => {
                  const isSel = selected.has(c.id);
                  const cat = c.category_slug ? catMap.get(c.category_slug) : undefined;
                  return (
                    <li
                      key={c.id}
                      className={`flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between ${
                        isSel ? "bg-teal/5" : ""
                      }`}
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-1 size-4 shrink-0 accent-[var(--salma-teal)]"
                          checked={isSel}
                          onChange={() => toggle(c.id)}
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[10px] font-semibold text-teal">
                              {c.type}
                            </span>
                            <span
                              className="rounded px-1.5 py-0.5 font-sans text-[10px] font-semibold text-white"
                              style={{
                                background:
                                  c.status === "published"
                                    ? "var(--salma-teal)"
                                    : c.status === "pending"
                                      ? "var(--salma-blue)"
                                      : c.status === "rejected"
                                        ? "var(--salma-coral)"
                                        : "var(--salma-gray)",
                              }}
                            >
                              {STATUS_LABEL[c.status] ?? c.status}
                            </span>
                            {c.origin === "ai" ? (
                              <span className="rounded border border-teal bg-teal/5 px-1.5 py-0.5 font-sans text-[10px] font-bold text-teal">
                                AI
                              </span>
                            ) : null}
                            {/* Category chip */}
                            {cat ? (
                              <span
                                className="rounded px-1.5 py-0.5 font-sans text-[10px] font-semibold text-white"
                                style={{ background: cat.accent }}
                              >
                                {cat.name_ar}
                              </span>
                            ) : (
                              <span className="rounded border border-coral/50 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-coral">
                                {NEEDS_REVIEW}
                              </span>
                            )}
                            <span className="truncate text-[14px] font-semibold">{c.title}</span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 font-sans text-[11px] text-gray">
                            <span>
                              أُضيف {formatDateTimeAr(c.created_at)} · آخر تحديث {timeAgoAr(c.updated_at)}
                            </span>
                            {/* Manual category override — admin can always change */}
                            <label className="flex items-center gap-1">
                              <span className="text-gray">القسم:</span>
                              <select
                                value={c.category_slug ?? ""}
                                disabled={pending}
                                onChange={(e) => changeCategory(c.id, e.target.value)}
                                className="rounded border border-line bg-white px-1.5 py-0.5 text-[11px]"
                              >
                                <option value="">— {NEEDS_REVIEW} —</option>
                                {categories.map((opt) => (
                                  <option key={opt.slug} value={opt.slug}>
                                    {opt.name_ar}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <Link
                          href={`/admin/content/${c.id}`}
                          className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold hover:bg-cream"
                        >
                          تحرير
                        </Link>
                        {c.status === "published" ? (
                          <form action={setStatus}>
                            <input type="hidden" name="id" value={c.id} />
                            <input type="hidden" name="status" value="draft" />
                            <button className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold">
                              إلغاء النشر
                            </button>
                          </form>
                        ) : c.status === "pending" ? (
                          <form action={setStatus}>
                            <input type="hidden" name="id" value={c.id} />
                            <input type="hidden" name="status" value="published" />
                            <button className="rounded-lg bg-teal px-3 py-1.5 text-[12.5px] font-semibold text-white">
                              نشر
                            </button>
                          </form>
                        ) : null}
                        {c.status === "pending" ? (
                          <form action={rejectContent}>
                            <input type="hidden" name="id" value={c.id} />
                            <button className="rounded-lg border border-coral/50 px-3 py-1.5 text-[12.5px] font-semibold text-coral hover:bg-cream">
                              رفض
                            </button>
                          </form>
                        ) : null}
                        <form action={softDeleteContent}>
                          <input type="hidden" name="id" value={c.id} />
                          <button className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold text-coral hover:bg-cream">
                            حذف
                          </button>
                        </form>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      {/* Sticky bulk-action toolbar */}
      {selectedCount > 0 ? (
        <div className="sticky bottom-3 z-10 mt-3 flex items-center justify-between gap-3 rounded-2xl border border-line bg-white p-3 shadow-lg">
          <span className="text-[13px] font-semibold">
            {selectedCount} مختار
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => runBulk("publish")}
              disabled={pending}
              className="rounded-lg bg-teal px-3.5 py-2 text-[12.5px] font-bold text-white disabled:opacity-50"
            >
              نشر المحدد
            </button>
            <button
              onClick={() => runBulk("delete")}
              disabled={pending}
              className="rounded-lg border border-coral/60 px-3.5 py-2 text-[12.5px] font-bold text-coral hover:bg-cream disabled:opacity-50"
            >
              حذف المحدد
            </button>
            <button
              onClick={clearSelection}
              disabled={pending}
              className="rounded-lg border border-line px-3.5 py-2 text-[12.5px] font-semibold disabled:opacity-50"
            >
              إلغاء التحديد
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

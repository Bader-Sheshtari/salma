"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  type RadarArticle,
  type RadarPriorityLevel,
  PRIORITY_LABEL,
  UNRANKED_LABEL,
  DUPLICATE_LABEL,
  langLabel,
} from "@/lib/radar";

type Cat = { slug: string; name_ar: string };

// Importance filter modes. "default" = editorial opportunities (very + important).
type ImportanceMode = "default" | "very_important" | "low" | "unranked" | "all";
// Duplicate filter modes. "opportunities" = new + possible (hides already-in-Salma).
type DupeMode = "opportunities" | "new" | "already" | "all";

const IMPORTANCE_FILTERS: { key: ImportanceMode; label: string }[] = [
  { key: "default", label: "مهم (افتراضي)" },
  { key: "very_important", label: "مهم جدًا" },
  { key: "low", label: "منخفض" },
  { key: "unranked", label: "غير مصنّف" },
  { key: "all", label: "الكل" },
];

const DUPE_FILTERS: { key: DupeMode; label: string }[] = [
  { key: "opportunities", label: "فرص (جديد + محتمل)" },
  { key: "new", label: "جديد" },
  { key: "already", label: "موجود في سلمى" },
  { key: "all", label: "الكل" },
];

function priorityClass(level: RadarPriorityLevel | null): string {
  if (level === "very_important") return "bg-red-50 text-red-700 border-red-200";
  if (level === "important") return "bg-amber-50 text-amber-700 border-amber-200";
  if (level === "low") return "bg-gray-50 text-gray-500 border-line";
  return "bg-cream text-gray border-line"; // unranked
}

function dateKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function dateGroupLabel(key: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (key === today) return "اليوم";
  if (key === yesterday) return "أمس";
  return new Date(key + "T00:00:00Z").toLocaleDateString("ar", {
    day: "numeric", month: "long", year: "numeric",
  });
}

function timeLabel(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
}

export default function RadarInbox({ items, categories }: { items: RadarArticle[]; categories: Cat[] }) {
  const [importance, setImportance] = useState<ImportanceMode>("default");
  const [dupe, setDupe] = useState<DupeMode>("opportunities");
  const [cat, setCat] = useState<string>("");

  const catName = useMemo(() => {
    const m = new Map(categories.map((c) => [c.slug, c.name_ar]));
    return (slug: string | null) => (slug ? m.get(slug) ?? slug : "—");
  }, [categories]);

  // Today's summary (by detection time — when Radar first observed the story).
  const today = new Date().toISOString().slice(0, 10);
  const summary = useMemo(() => {
    const t = items.filter((a) => dateKey(a.first_seen_at) === today);
    const s = { total: t.length, very: 0, important: 0, low: 0, unranked: 0, isNew: 0, already: 0, possible: 0 };
    for (const a of t) {
      if (a.priority_level === "very_important") s.very++;
      else if (a.priority_level === "important") s.important++;
      else if (a.priority_level === "low") s.low++;
      else s.unranked++;
      if (a.duplicate_status === "new") s.isNew++;
      else if (a.duplicate_status === "already_in_salma") s.already++;
      else if (a.duplicate_status === "possible_duplicate") s.possible++;
    }
    return s;
  }, [items, today]);

  const filtered = useMemo(() => {
    return items.filter((a) => {
      // Importance
      const lvl = a.priority_level;
      if (importance === "default" && !(lvl === "very_important" || lvl === "important")) return false;
      if (importance === "very_important" && lvl !== "very_important") return false;
      if (importance === "low" && lvl !== "low") return false;
      if (importance === "unranked" && lvl !== null) return false;
      // Duplicate status
      const d = a.duplicate_status;
      if (dupe === "opportunities" && !(d === "new" || d === "possible_duplicate")) return false;
      if (dupe === "new" && d !== "new") return false;
      if (dupe === "already" && d !== "already_in_salma") return false;
      // Category
      if (cat && a.expected_category_slug !== cat) return false;
      return true;
    });
  }, [items, importance, dupe, cat]);

  // Group filtered rows by detection date, newest date first, newest within.
  const groups = useMemo(() => {
    const map = new Map<string, RadarArticle[]>();
    for (const a of filtered) {
      const k = dateKey(a.first_seen_at);
      (map.get(k) ?? map.set(k, []).get(k)!).push(a);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered]);

  return (
    <div>
      {/* Summary bar */}
      <div className="mb-4 flex flex-wrap gap-2 text-[12.5px]">
        <SummaryCard label="اليوم" value={summary.total} strong />
        <SummaryCard label="🔴 مهم جدًا" value={summary.very} />
        <SummaryCard label="🟡 مهم" value={summary.important} />
        <SummaryCard label="⚪ منخفض" value={summary.low} />
        <SummaryCard label="جديد" value={summary.isNew} />
        <SummaryCard label="موجود في سلمى" value={summary.already} />
        {summary.unranked > 0 && <SummaryCard label="◻︎ غير مصنّف" value={summary.unranked} warn />}
      </div>

      {summary.unranked > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
          يوجد {summary.unranked} خبر غير مُصنّف بعد (التصنيف الآلي يُشغَّل لاحقًا). لعرضها اختر «غير مصنّف» أو «الكل».
        </div>
      )}

      {/* Filters */}
      <div className="mb-3 space-y-2">
        <FilterRow label="الأهمية">
          {IMPORTANCE_FILTERS.map((f) => (
            <Chip key={f.key} active={importance === f.key} onClick={() => setImportance(f.key)}>
              {f.label}
            </Chip>
          ))}
        </FilterRow>
        <FilterRow label="التكرار">
          {DUPE_FILTERS.map((f) => (
            <Chip key={f.key} active={dupe === f.key} onClick={() => setDupe(f.key)}>
              {f.label}
            </Chip>
          ))}
        </FilterRow>
        <FilterRow label="القسم">
          <Chip active={cat === ""} onClick={() => setCat("")}>الكل</Chip>
          {categories.map((c) => (
            <Chip key={c.slug} active={cat === c.slug} onClick={() => setCat(c.slug)}>
              {c.name_ar}
            </Chip>
          ))}
        </FilterRow>
      </div>

      <div className="mb-3 text-[12px] text-gray">{filtered.length} خبر معروض</div>

      {groups.length === 0 && (
        <div className="rounded-lg border border-line bg-white p-6 text-center text-[13px] text-gray">
          لا توجد أخبار مطابقة للفلاتر الحالية.
        </div>
      )}

      {groups.map(([key, rows]) => (
        <section key={key} className="mb-5">
          <h2 className="mb-2 text-[13px] font-bold text-gray">{dateGroupLabel(key)}</h2>
          <div className="space-y-2">
            {rows.map((a) => (
              <article key={a.id} className="rounded-xl border border-line bg-white p-3">
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-bold ${priorityClass(a.priority_level)}`}>
                    {a.priority_level ? PRIORITY_LABEL[a.priority_level] : UNRANKED_LABEL}
                    {a.priority_score !== null && <span className="opacity-60"> · {a.priority_score}</span>}
                  </span>
                  <span className="rounded-md border border-line bg-cream px-1.5 py-0.5 text-[11px] font-semibold text-teal">
                    {catName(a.expected_category_slug)}
                  </span>
                  {a.duplicate_status && a.duplicate_status !== "new" ? (
                    a.matched_content_id ? (
                      <Link
                        href={`/admin/content/${a.matched_content_id}`}
                        className="rounded-md border border-line px-1.5 py-0.5 text-[11px] font-semibold text-ink underline hover:bg-cream"
                      >
                        {DUPLICATE_LABEL[a.duplicate_status]} ↗
                      </Link>
                    ) : (
                      <span className="rounded-md border border-line px-1.5 py-0.5 text-[11px] font-semibold text-gray">
                        {DUPLICATE_LABEL[a.duplicate_status]}
                      </span>
                    )
                  ) : a.duplicate_status === "new" ? (
                    <span className="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                      جديد
                    </span>
                  ) : null}
                  <span className="rounded-md bg-ink px-1.5 py-0.5 font-sans text-[9px] font-bold tracking-wide text-white">
                    RADAR
                  </span>
                </div>

                <a
                  href={a.url ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-[14.5px] font-semibold leading-snug text-ink hover:text-teal"
                  dir="auto"
                >
                  {a.title ?? "—"}
                </a>

                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[11.5px] text-gray">
                  <span>{a.source_title ?? a.source_domain ?? "—"}</span>
                  {a.country && <span>· {a.country}</span>}
                  <span>· {langLabel(a.language)}</span>
                  {a.published_at && <span>· نُشر {timeLabel(a.published_at)}</span>}
                  <span>· رُصد {timeLabel(a.first_seen_at)}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SummaryCard({ label, value, strong, warn }: { label: string; value: number; strong?: boolean; warn?: boolean }) {
  return (
    <div
      className={`rounded-lg border px-3 py-1.5 ${
        warn ? "border-amber-200 bg-amber-50 text-amber-800" : "border-line bg-white text-ink"
      }`}
    >
      <span className={strong ? "font-bold" : "font-semibold"}>{label}: </span>
      <span className="font-bold">{value}</span>
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[12px] font-semibold text-gray">{label}</span>
      <div className="salma-scroll flex gap-1.5 overflow-x-auto">{children}</div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`whitespace-nowrap rounded-full px-3 py-1 text-[12.5px] font-semibold ${
        active ? "bg-teal text-white" : "border border-line bg-white text-gray hover:bg-cream"
      }`}
    >
      {children}
    </button>
  );
}

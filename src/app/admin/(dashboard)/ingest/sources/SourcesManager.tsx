"use client";

import { useActionState, useMemo, useState } from "react";
import {
  saveNewsSource,
  toggleNewsSource,
  deleteNewsSource,
  type SaveResult,
} from "../../../actions";
import type { NewsSource } from "@/lib/admin-queries";

const field =
  "w-full rounded-lg border border-gray/40 bg-white px-3 py-2 text-sm outline-none focus:border-teal";

const REGIONS: { value: string; label: string }[] = [
  { value: "kuwait", label: "الكويت" },
  { value: "gulf", label: "الخليج" },
  { value: "mena", label: "الشرق الأوسط" },
  { value: "world", label: "العالم" },
];

const TYPES: { value: string; label: string }[] = [
  { value: "official", label: "رسمي / حكومي" },
  { value: "research", label: "بحثي / علمي" },
  { value: "medical_institution", label: "مؤسسة طبية" },
  { value: "media", label: "إعلام" },
  { value: "reference", label: "مرجعي" },
];

const TIERS: { value: string; label: string }[] = [
  { value: "1", label: "المستوى 1 — أساسي وموثوق" },
  { value: "2", label: "المستوى 2 — اكتشاف وسياق" },
  { value: "3", label: "المستوى 3 — اكتشاف فقط" },
  { value: "blocked", label: "محظور" },
];

const REGION_LABEL = Object.fromEntries(REGIONS.map((r) => [r.value, r.label]));
const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.value, t.label]));

const TIER_BADGE: Record<string, string> = {
  "1": "bg-teal/10 text-teal",
  "2": "bg-amber-100 text-amber-800",
  "3": "bg-gray/15 text-gray",
  blocked: "bg-coral/15 text-coral",
};

function Checkbox({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[12.5px] text-ink">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="h-4 w-4 accent-teal" />
      {label}
    </label>
  );
}

/** Create/edit form. `source` present = edit, absent = create. */
function SourceForm({ source, onSaved }: { source?: NewsSource; onSaved?: () => void }) {
  const [state, formAction, pending] = useActionState<SaveResult, FormData>(
    async (prev, fd) => {
      const result = await saveNewsSource(prev, fd);
      if (result === null) onSaved?.();
      return result;
    },
    null,
  );

  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-2">
      {source ? <input type="hidden" name="id" value={source.id} /> : null}
      <label className="text-[12.5px] font-semibold text-ink">
        الاسم
        <input name="name" defaultValue={source?.name ?? ""} required className={`mt-1 ${field}`} />
      </label>
      <label className="text-[12.5px] font-semibold text-ink">
        النطاق
        <input
          name="domain"
          defaultValue={source?.domain ?? ""}
          placeholder="who.int"
          dir="ltr"
          required
          className={`mt-1 ${field}`}
        />
      </label>
      <label className="text-[12.5px] font-semibold text-ink">
        المنطقة
        <select name="region" defaultValue={source?.region ?? "world"} className={`mt-1 ${field}`}>
          {REGIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[12.5px] font-semibold text-ink">
        النوع
        <select name="source_type" defaultValue={source?.source_type ?? "official"} className={`mt-1 ${field}`}>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[12.5px] font-semibold text-ink">
        المستوى
        <select name="tier" defaultValue={source?.tier ?? "3"} className={`mt-1 ${field}`}>
          {TIERS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[12.5px] font-semibold text-ink">
        درجة الثقة (0–100)
        <input
          name="trust_score"
          type="number"
          min={0}
          max={100}
          defaultValue={source?.trust_score ?? 50}
          dir="ltr"
          className={`mt-1 ${field}`}
        />
      </label>
      <label className="text-[12.5px] font-semibold text-ink sm:col-span-2">
        رابط RSS (اختياري)
        <input
          name="feed_url"
          defaultValue={source?.feed_url ?? ""}
          placeholder="https://…/rss"
          dir="ltr"
          className={`mt-1 ${field}`}
        />
      </label>
      <label className="text-[12.5px] font-semibold text-ink sm:col-span-2">
        ملاحظات (اختياري)
        <textarea
          name="notes"
          defaultValue={source?.notes ?? ""}
          rows={2}
          className={`mt-1 ${field}`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
        <Checkbox name="discovery_enabled" label="مسموح للاكتشاف" defaultChecked={source?.discovery_enabled ?? true} />
        <Checkbox name="final_source_allowed" label="مسموح كمصدر نهائي" defaultChecked={source?.final_source_allowed ?? true} />
        <Checkbox name="active" label="مُفعّل" defaultChecked={source?.active ?? true} />
        <button
          disabled={pending}
          className="ms-auto rounded-lg bg-teal px-5 py-2 text-[13px] font-bold text-white disabled:opacity-60"
        >
          {pending ? "جارٍ الحفظ…" : source ? "حفظ" : "إضافة المصدر"}
        </button>
      </div>
      {state?.error ? <div className="text-[12.5px] text-coral sm:col-span-2">{state.error}</div> : null}
    </form>
  );
}

function DeleteSource({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState<SaveResult, FormData>(deleteNewsSource, null);
  return (
    <form action={formAction} className="mt-3 border-t border-line pt-3">
      <input type="hidden" name="id" value={id} />
      <button
        disabled={pending}
        className="text-[12px] font-semibold text-coral hover:underline disabled:opacity-60"
      >
        {pending ? "جارٍ الحذف…" : "حذف المصدر نهائياً"}
      </button>
      {state?.error ? <div className="mt-1.5 text-[12px] text-coral">{state.error}</div> : null}
    </form>
  );
}

function SourceRow({ source }: { source: NewsSource }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${TIER_BADGE[source.tier] ?? "bg-gray/15 text-gray"}`}>
          {source.tier === "blocked" ? "محظور" : `T${source.tier}`}
        </span>
        <span className="text-[13.5px] font-bold">{source.name}</span>
        <span dir="ltr" className="font-sans text-[12px] text-gray">
          {source.domain}
        </span>
        <span className="text-[11.5px] text-gray">
          · {REGION_LABEL[source.region] ?? source.region} · {TYPE_LABEL[source.source_type] ?? source.source_type} · ثقة{" "}
          {source.trust_score}
        </span>
        {!source.active ? (
          <span className="rounded-md bg-gray/15 px-2 py-0.5 text-[11px] text-gray">مُعطّل</span>
        ) : null}
        {!source.final_source_allowed ? (
          <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">اكتشاف فقط</span>
        ) : null}

        <div className="ms-auto flex items-center gap-1.5">
          <form action={toggleNewsSource}>
            <input type="hidden" name="id" value={source.id} />
            <input type="hidden" name="active" value={(!source.active).toString()} />
            <button className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-cream">
              {source.active ? "تعطيل" : "تفعيل"}
            </button>
          </form>
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-cream"
          >
            {open ? "إغلاق" : "تعديل"}
          </button>
        </div>
      </div>

      {open ? (
        <div className="mt-3 rounded-xl border border-line bg-cream/40 p-3.5">
          <SourceForm source={source} onSaved={() => setOpen(false)} />
          <DeleteSource id={source.id} />
        </div>
      ) : null}
    </li>
  );
}

export function SourcesManager({ sources }: { sources: NewsSource[] }) {
  const [showAdd, setShowAdd] = useState(false);
  const [q, setQ] = useState("");
  const [region, setRegion] = useState("");
  const [type, setType] = useState("");
  const [tier, setTier] = useState("");
  const [status, setStatus] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sources.filter((s) => {
      if (needle && !s.name.toLowerCase().includes(needle) && !s.domain.toLowerCase().includes(needle))
        return false;
      if (region && s.region !== region) return false;
      if (type && s.source_type !== type) return false;
      if (tier && s.tier !== tier) return false;
      if (status === "active" && !s.active) return false;
      if (status === "inactive" && s.active) return false;
      return true;
    });
  }, [sources, q, region, type, tier, status]);

  return (
    <div>
      <div className="mb-4 rounded-2xl border border-line bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[14px] font-bold">إضافة مصدر جديد</h2>
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-cream"
          >
            {showAdd ? "إخفاء" : "＋ مصدر"}
          </button>
        </div>
        {showAdd ? (
          <div className="mt-3">
            <SourceForm onSaved={() => setShowAdd(false)} />
          </div>
        ) : null}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ابحث بالاسم أو النطاق…"
          className={`${field} max-w-xs`}
        />
        <select value={region} onChange={(e) => setRegion(e.target.value)} className={`${field} w-auto`}>
          <option value="">كل المناطق</option>
          {REGIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} className={`${field} w-auto`}>
          <option value="">كل الأنواع</option>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <select value={tier} onChange={(e) => setTier(e.target.value)} className={`${field} w-auto`}>
          <option value="">كل المستويات</option>
          {TIERS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${field} w-auto`}>
          <option value="">الكل</option>
          <option value="active">المُفعّلة</option>
          <option value="inactive">المُعطّلة</option>
        </select>
        <span className="text-[12px] text-gray">{filtered.length} مصدر</span>
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-white">
        {filtered.length === 0 ? (
          <div className="p-6 text-[14px] text-gray">لا توجد مصادر مطابقة.</div>
        ) : (
          <ul className="divide-y divide-line">
            {filtered.map((s) => (
              <SourceRow key={s.id} source={s} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

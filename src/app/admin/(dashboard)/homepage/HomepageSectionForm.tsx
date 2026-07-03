"use client";

import { useActionState } from "react";
import { saveHomepageSection, type SaveResult } from "../../actions";
import type { HomepageSection } from "@/lib/admin-queries";

const field =
  "w-full rounded-lg border border-gray/40 px-3 py-2 text-sm outline-none focus:border-teal";
const label = "block text-[12px] font-semibold text-gray";

const STYLE_LABELS: Record<string, string> = {
  carousel: "شريط تمرير",
  grid: "شبكة",
  list: "قائمة",
  featured: "مميّز",
};

export function HomepageSectionForm({ section }: { section: HomepageSection }) {
  const [state, formAction, pending] = useActionState<SaveResult, FormData>(saveHomepageSection, null);
  const isTransfers = section.key === "feature:doctor_transfers";
  const isSocial = section.key === "feature:social";

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={section.id} />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          العنوان
          <input name="title_ar" defaultValue={section.title_ar} required className={`${field} mt-1`} />
        </label>
        <label className={label}>
          نمط العرض
          <select
            name="display_style"
            defaultValue={section.display_style}
            disabled={isTransfers}
            className={`${field} mt-1 disabled:opacity-60`}
          >
            {Object.entries(STYLE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid items-end gap-3 sm:grid-cols-[7rem_1fr_auto]">
        <label className={label}>
          عدد العناصر
          <input
            name="items_limit"
            type="number"
            min={1}
            max={24}
            defaultValue={section.items_limit}
            className={`${field} mt-1`}
          />
        </label>
        <label className={label}>
          لون مميّز (اختياري)
          <input
            name="accent"
            defaultValue={section.accent ?? ""}
            placeholder="#449785"
            dir="ltr"
            className={`${field} mt-1`}
          />
        </label>
        <label className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          <input type="checkbox" name="show_view_all" defaultChecked={section.show_view_all} className="h-4 w-4 accent-teal" />
          زر «عرض الكل»
        </label>
      </div>

      {isSocial ? (
        <div className="text-[12px] text-gold">لا تظهر مساحة التواصل على الموقع بعد — ستُفعّل في مرحلة لاحقة.</div>
      ) : null}
      {state?.error ? <div className="text-[12px] text-coral">{state.error}</div> : null}

      <button
        disabled={pending}
        className="self-start rounded-lg bg-teal px-5 py-2 text-[13px] font-bold text-white disabled:opacity-60"
      >
        {pending ? "جارٍ الحفظ…" : "حفظ"}
      </button>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { updateEditorialPolicy, type PolicyResult } from "../../../actions";
import type { EditorialPolicy } from "@/lib/admin-queries";

const REGIONS: { value: string; label: string }[] = [
  { value: "kuwait", label: "الكويت" },
  { value: "gulf", label: "دول الخليج" },
  { value: "mena", label: "الشرق الأوسط وشمال أفريقيا" },
  { value: "world", label: "العالم" },
];

function Field({
  name,
  label,
  hint,
  defaultValue,
}: {
  name: string;
  label: string;
  hint: string;
  defaultValue: string[];
}) {
  return (
    <label className="block text-[13px] font-semibold text-ink">
      {label}
      <span className="mt-0.5 block text-[11.5px] font-normal text-gray">{hint}</span>
      <textarea
        name={name}
        defaultValue={defaultValue.join("\n")}
        rows={Math.max(defaultValue.length + 1, 4)}
        className="mt-1.5 w-full rounded-lg border border-gray/40 px-3.5 py-2.5 text-sm leading-relaxed outline-none focus:border-teal"
      />
    </label>
  );
}

export function PolicyForm({ policy }: { policy: EditorialPolicy | null }) {
  const [state, formAction, pending] = useActionState<PolicyResult, FormData>(
    updateEditorialPolicy,
    null,
  );

  const regions = policy?.regions ?? ["kuwait", "gulf", "mena", "world"];

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-5 rounded-2xl border border-line bg-white p-4 sm:p-5">
      <fieldset>
        <legend className="text-[13px] font-semibold text-ink">المناطق المُفعّلة</legend>
        <p className="mb-2 text-[11.5px] text-gray">المناطق التي يبحث فيها الوكيل عن الأخبار.</p>
        <div className="flex flex-wrap gap-3">
          {REGIONS.map((r) => (
            <label key={r.value} className="flex items-center gap-1.5 text-[13px] text-ink">
              <input
                type="checkbox"
                name="regions"
                value={r.value}
                defaultChecked={regions.includes(r.value)}
                className="h-4 w-4 accent-teal"
              />
              {r.label}
            </label>
          ))}
        </div>
      </fieldset>

      <Field
        name="block_topics"
        label="المواضيع المحظورة (ما يجب تجنّبه)"
        hint="سطر لكل موضوع. يستبعد الوكيل أي خبر يتناولها."
        defaultValue={policy?.block_topics ?? []}
      />
      <Field
        name="priority_topics"
        label="المواضيع ذات الأولوية"
        hint="سطر لكل موضوع. يفضّلها الوكيل عند الاختيار."
        defaultValue={policy?.priority_topics ?? []}
      />
      <Field
        name="trusted_sources"
        label="المصادر الموثوقة"
        hint="سطر لكل مصدر (الاسم أو النطاق)."
        defaultValue={policy?.trusted_sources ?? []}
      />

      {state && "error" in state ? (
        <div className="text-[13px] text-coral">{state.error}</div>
      ) : null}
      {state && "saved" in state ? (
        <div className="rounded-lg bg-cream px-4 py-3 text-[13px] text-teal">تم حفظ السياسة.</div>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-teal px-6 py-2.5 text-sm font-bold text-white disabled:opacity-60"
      >
        {pending ? "جارٍ الحفظ…" : "حفظ السياسة"}
      </button>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { toggleHomepageSection, type ToggleResult } from "../../actions";
import type { HomepageSection } from "@/lib/admin-queries";

/**
 * The single, explicit control for a homepage section's public visibility.
 * Shows a status badge, a clear show/hide button, helper text explaining the
 * effect, and a success message after toggling.
 */
export function HomepageVisibilityToggle({ section }: { section: HomepageSection }) {
  const [state, formAction, pending] = useActionState<ToggleResult, FormData>(
    toggleHomepageSection,
    null,
  );
  const enabled = section.is_enabled;

  return (
    <div
      className={`mb-4 rounded-xl border p-3.5 ${
        enabled ? "border-teal/40 bg-teal/5" : "border-gold bg-cream"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12.5px] font-bold ${
            enabled ? "bg-teal text-white" : "bg-gray/15 text-gray"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${enabled ? "bg-white" : "bg-gray"}`} />
          {enabled ? "ظاهر في الصفحة الرئيسية" : "مخفي من الصفحة الرئيسية"}
        </span>

        <form action={formAction}>
          <input type="hidden" name="id" value={section.id} />
          <input type="hidden" name="next" value={enabled ? "false" : "true"} />
          <button
            disabled={pending}
            className={`rounded-lg px-4 py-2 text-[13px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60 ${
              enabled ? "bg-coral" : "bg-teal"
            }`}
          >
            {pending
              ? "جارٍ التحديث…"
              : enabled
                ? "إخفاء من الصفحة الرئيسية"
                : "إظهار في الصفحة الرئيسية"}
          </button>
        </form>
      </div>

      <p className="mt-2 text-[12px] text-gray">
        {enabled
          ? "عند الإيقاف سيبقى القسم موجودًا في النظام لكنه لن يظهر للزوار."
          : "عند التفعيل سيظهر هذا القسم في الصفحة الرئيسية."}
      </p>

      {state?.success ? (
        <p className="mt-2 rounded-lg bg-teal/10 px-3 py-1.5 text-[12.5px] font-semibold text-teal">
          {state.success}
        </p>
      ) : null}
      {state?.error ? (
        <p className="mt-2 text-[12.5px] font-semibold text-coral">{state.error}</p>
      ) : null}
    </div>
  );
}

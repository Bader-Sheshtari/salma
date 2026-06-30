"use client";

import Link from "next/link";
import { useActionState } from "react";
import { ingestNews, type IngestResult } from "../../actions";

export function IngestForm() {
  const [state, formAction, pending] = useActionState<IngestResult, FormData>(ingestNews, null);

  return (
    <div className="max-w-xl">
      <form action={formAction} className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4 sm:p-5">
        <p className="text-[13px] leading-relaxed text-gray">
          يبحث الوكيل في مصادر موثوقة عبر الإنترنت عن أحدث الأخبار الصحية (الكويت، الخليج، الشرق الأوسط،
          والعالم)، ثم يترجمها ويبسّطها ويصنّفها مع الإبقاء على رابط المصدر الأصلي. تُحفظ كلها بصيغة
          «بانتظار المراجعة» ولا تظهر للجمهور إلا بعد اعتمادك لها.
        </p>

        {state && "error" in state && state.error ? (
          <div className="text-[13px] text-coral">{state.error}</div>
        ) : null}
        {state && "kept" in state ? (
          <div className="rounded-lg bg-cream px-4 py-3 text-[13px] text-teal">
            تم جلب {state.found} خبراً: حُفِظ منها {state.kept}، استُبعد {state.filtered} بحسب السياسة،
            وتجاهل {state.duplicates} مكرّراً.{" "}
            {state.kept > 0 ? (
              <Link href="/admin/content?status=pending" className="font-bold underline">
                راجِعها الآن ←
              </Link>
            ) : null}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-lg bg-teal px-6 py-2.5 text-sm font-bold text-white disabled:opacity-60"
        >
          {pending ? "جارٍ جلب الأخبار…" : "جلب أحدث الأخبار الآن"}
        </button>
      </form>
    </div>
  );
}

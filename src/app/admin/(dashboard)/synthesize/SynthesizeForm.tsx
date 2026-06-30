"use client";

import Link from "next/link";
import { useActionState } from "react";
import { synthesizeUrl, type SynthResult } from "../../actions";

const field =
  "w-full rounded-lg border border-gray/40 px-3.5 py-2.5 text-sm outline-none focus:border-teal";

export function SynthesizeForm() {
  const [state, formAction, pending] = useActionState<SynthResult, FormData>(synthesizeUrl, null);

  return (
    <div className="max-w-xl">
      <form action={formAction} className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4 sm:p-5">
        <p className="text-[13px] leading-relaxed text-gray">
          الصق رابط مقال؛ يجلب النظام صفحته ويعيد صياغته كمقال عربي كامل مع الإبقاء على رابط المصدر
          الأصلي. يُحفظ بصيغة «بانتظار المراجعة» ولا يظهر للجمهور إلا بعد اعتمادك له.
        </p>

        <input
          name="url"
          type="url"
          dir="ltr"
          required
          placeholder="https://example.com/article"
          className={field}
        />

        {state && "error" in state && state.error ? (
          <div className="text-[13px] text-coral">{state.error}</div>
        ) : null}
        {state && "ok" in state && state.ok ? (
          <div className="rounded-lg bg-cream px-4 py-3 text-[13px] text-teal">
            تم إنشاء مسودة: «{state.title}».{" "}
            <Link href={`/admin/content/${state.id}`} className="font-bold underline">
              حرّرها وراجِعها الآن ←
            </Link>
          </div>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-lg bg-teal px-6 py-2.5 text-sm font-bold text-white disabled:opacity-60"
        >
          {pending ? "جارٍ المعالجة…" : "تحويل الرابط إلى مقال"}
        </button>
      </form>
    </div>
  );
}

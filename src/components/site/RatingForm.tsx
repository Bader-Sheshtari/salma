"use client";

import { useActionState, useState } from "react";
import { submitRating, type RatingResult } from "@/app/actions/ratings";

export function RatingForm({ doctorId }: { doctorId: string }) {
  const [state, formAction, pending] = useActionState<RatingResult | null, FormData>(
    submitRating,
    null,
  );
  const [stars, setStars] = useState(0);

  if (state?.ok) {
    return (
      <div className="rounded-2xl border border-line bg-cream px-4 py-3 text-[13px] text-teal">
        تم استلام تقييمك وسيظهر بعد مراجعته من المحرّر.
      </div>
    );
  }

  return (
    <form action={formAction} className="rounded-2xl border border-line p-4">
      <input type="hidden" name="doctor_id" value={doctorId} />
      <input type="hidden" name="stars" value={stars} />

      <div className="mb-2.5 flex items-center gap-1 text-2xl" dir="ltr">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setStars(n)}
            aria-label={`${n} نجوم`}
            className={n <= stars ? "text-amber-500" : "text-gray/40"}
          >
            ★
          </button>
        ))}
      </div>

      <input
        name="author_name"
        placeholder="اسمك"
        dir="rtl"
        required
        className="mb-2.5 w-full rounded-lg border border-gray/40 px-3.5 py-2.5 text-sm outline-none focus:border-teal"
      />
      <textarea
        name="body"
        placeholder="شاركنا تجربتك (اختياري)…"
        dir="rtl"
        rows={3}
        className="mb-1 w-full resize-y rounded-lg border border-gray/40 px-3.5 py-2.5 text-sm outline-none focus:border-teal"
      />
      {state && !state.ok ? <div className="mb-2 text-[12.5px] text-coral">{state.error}</div> : null}
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-gray">تُراجَع التقييمات قبل نشرها.</span>
        <button
          type="submit"
          disabled={pending || stars < 1}
          className="rounded-lg bg-teal px-5 py-2.5 text-[13px] font-bold text-white disabled:opacity-60"
        >
          {pending ? "جارٍ الإرسال…" : "أرسل التقييم"}
        </button>
      </div>
    </form>
  );
}

"use client";

import { useEffect } from "react";

/**
 * Admin error boundary: tells the editor WHAT failed (the current admin
 * screen) and that retrying is safe, without surfacing raw database or
 * provider errors. The digest correlates with server logs for diagnosis.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[salma-admin] screen error", error.digest ?? "");
  }, [error]);

  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <h1 className="text-xl font-bold">تعذّر تحميل هذه الشاشة</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-gray">
        حدث خطأ أثناء تحميل هذا القسم من لوحة الإدارة. لم يتأثر أي محتوى محفوظ — يمكنك إعادة
        المحاولة بأمان، وإذا استمرت المشكلة انتقل لقسم آخر ثم عد مجدداً.
      </p>
      <div className="mt-5 flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-teal px-5 py-2.5 text-sm font-bold text-white"
        >
          إعادة المحاولة
        </button>
      </div>
      {error.digest ? (
        <p className="mt-5 font-mono text-[10.5px] text-gray/60" dir="ltr">
          ref: {error.digest}
        </p>
      ) : null}
    </div>
  );
}

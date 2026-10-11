"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Public error boundary: a calm Arabic fallback for unexpected rendering/
 * server failures. Technical details stay server-side — the reader sees no
 * stack traces, database errors or provider messages. Next logs the real
 * error on the server; the client log below carries the redacted digest only.
 */
export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is a safe opaque reference for correlating server logs.
    console.error("[salma] page error", error.digest ?? "");
  }, [error]);

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]" dir="rtl">
      <main className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center sm:px-6">
        <h1 className="text-2xl font-bold">حدث خطأ غير متوقع</h1>
        <p className="mt-2 text-[14.5px] leading-relaxed text-gray">
          جرّب تحديث الصفحة، وإذا استمرت المشكلة يمكنك العودة إلى الصفحة الرئيسية.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-teal px-5 py-2.5 text-sm font-bold text-white"
          >
            تحديث الصفحة
          </button>
          <Link
            href="/"
            className="rounded-lg border border-line px-5 py-2.5 text-sm font-semibold text-ink hover:bg-cream"
          >
            العودة إلى الرئيسية
          </Link>
        </div>
        {error.digest ? (
          <p className="mt-6 font-mono text-[10.5px] text-gray/60" dir="ltr">
            ref: {error.digest}
          </p>
        ) : null}
      </main>
    </div>
  );
}

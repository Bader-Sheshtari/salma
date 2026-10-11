"use client";

/**
 * Last-resort boundary (root layout itself failed). Must render its own
 * <html>/<body>; kept dependency-free and inline-styled on purpose.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ar" dir="rtl">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#fff", color: "#2E2E2D" }}>
        <main style={{ maxWidth: 560, margin: "0 auto", padding: "96px 16px", textAlign: "center" }}>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>حدث خطأ غير متوقع</h1>
          <p style={{ marginTop: 8, fontSize: 14.5, color: "#6b6b6a", lineHeight: 1.8 }}>
            جرّب تحديث الصفحة، وإذا استمرت المشكلة يمكنك العودة إلى الصفحة الرئيسية.
          </p>
          <div style={{ marginTop: 24, display: "flex", gap: 12, justifyContent: "center" }}>
            <button
              type="button"
              onClick={reset}
              style={{ background: "#0F7B6C", color: "#fff", border: 0, borderRadius: 8, padding: "10px 20px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
            >
              تحديث الصفحة
            </button>
            {/* Deliberate plain <a>: when global-error renders, the app shell
                (and the Next router with it) may be broken — a hard
                navigation is the reliable escape hatch. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              style={{ border: "1px solid #e4ded4", borderRadius: 8, padding: "10px 20px", fontSize: 14, fontWeight: 600, color: "#2E2E2D", textDecoration: "none" }}
            >
              العودة إلى الرئيسية
            </a>
          </div>
          {error.digest ? (
            <p style={{ marginTop: 24, fontSize: 10.5, color: "#9a9a99", fontFamily: "monospace" }} dir="ltr">
              ref: {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}

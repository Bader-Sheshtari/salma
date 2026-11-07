"use client";

// «مقال من رابط عبر جمال» — universal Jamal action, URL entry point.
// One URL in → one PENDING draft out (existing targeted single-article path:
// hard limit 1, SSRF-safe fetch, dedupe, full validation, never publishes).
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { jamalFromUrl } from "@/app/admin/jamal-actions";
import JamalBadge from "./JamalBadge";

export default function JamalUrlCard() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      const res = await jamalFromUrl(trimmed);
      if ("ok" in res) {
        router.push(`/admin/content/${res.contentId}`);
        return;
      }
      setError(res.error);
    });
  }

  return (
    <div className="mb-6 max-w-2xl rounded-2xl border border-line bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[15px] font-bold">مقال من رابط مصدر</h2>
        <JamalBadge />
      </div>
      <p className="mb-3 font-sans text-[12.5px] text-gray">
        ألصق رابط خبر صحي وسيكتبه جمال بأسلوب سلمى المعتمد. تُحفظ النتيجة مسودة
        بانتظار المراجعة — لا يُنشر شيء تلقائياً.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="url"
          dir="ltr"
          value={url}
          disabled={pending}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder="https://example.com/health-news-article"
          className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2 font-sans text-[13px]"
        />
        <button
          type="button"
          disabled={pending || !url.trim()}
          onClick={submit}
          className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
        >
          {pending ? "جمال يكتب…" : "تحرير بواسطة جمال"}
        </button>
      </div>
      {pending ? (
        <p className="mt-2 font-sans text-[12px] text-gray">
          يجري جلب المصدر والكتابة والتحقق — قد يستغرق ذلك دقيقة أو دقيقتين.
        </p>
      ) : null}
      {error ? <p className="mt-2 font-sans text-[12.5px] font-semibold text-coral">{error}</p> : null}
    </div>
  );
}

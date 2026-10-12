"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createNewsletterIssue, curateNewsletterIssue } from "../../../newsletter-issue-actions";
import { RANGE_PRESETS } from "@/lib/newsletter-issues";

// Issue creation (brief §4): preset ranges with «آخر ٧ أيام» as the default,
// plus a custom range. Creating an issue immediately runs the curation engine
// and opens the editor on the proposed issue.
export default function CreateIssueForm() {
  const router = useRouter();
  const [preset, setPreset] = useState<string>("7d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  function submit() {
    setError(null);
    let start: Date;
    let end = new Date();
    if (preset === "custom") {
      if (!customStart || !customEnd) {
        setError("حدد بداية النطاق ونهايته.");
        return;
      }
      start = new Date(customStart + "T00:00:00");
      end = new Date(customEnd + "T23:59:59");
    } else {
      const days = RANGE_PRESETS.find((p) => p.key === preset)?.days ?? 7;
      start = new Date(Date.now() - days * 86400000);
    }
    setBusy(true);
    startTransition(async () => {
      const created = await createNewsletterIssue(start.toISOString(), end.toISOString());
      if ("error" in created) {
        setError(created.error);
        setBusy(false);
        return;
      }
      const issueId = created.id!;
      const curated = await curateNewsletterIssue(issueId);
      // Even on a curation hiccup the issue exists — open it either way.
      if ("error" in curated) setError(curated.error);
      router.push(`/admin/newsletter/issues/${issueId}`);
    });
  }

  return (
    <div className="rounded-xl border border-line bg-white p-3">
      <div className="mb-2 text-[13px] font-bold text-ink">إصدار جديد</div>
      <div className="flex flex-wrap items-center gap-2">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPreset(p.key)}
            className={`rounded-full px-3 py-1 text-[12.5px] font-semibold ${
              preset === p.key ? "bg-teal text-white" : "border border-line bg-white text-gray hover:bg-cream"
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPreset("custom")}
          className={`rounded-full px-3 py-1 text-[12.5px] font-semibold ${
            preset === "custom" ? "bg-teal text-white" : "border border-line bg-white text-gray hover:bg-cream"
          }`}
        >
          نطاق مخصص
        </button>
        {preset === "custom" && (
          <span className="flex items-center gap-1.5 text-[12px] text-gray">
            من
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="rounded-md border border-line px-2 py-1 text-[12.5px]"
            />
            إلى
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="rounded-md border border-line px-2 py-1 text-[12.5px]"
            />
          </span>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="ms-auto rounded-lg bg-teal px-4 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-50"
        >
          {busy ? "جارٍ تجهيز الاقتراح…" : "إنشاء واقتراح العدد"}
        </button>
      </div>
      {error && <div className="mt-2 text-[12px] font-semibold text-red-600">{error}</div>}
      {busy && (
        <div className="mt-2 text-[12px] text-gray">
          يجمع المحرك المرشحين ويوازن الأقسام ويكتب مسودات النصوص — ثوانٍ قليلة.
        </div>
      )}
    </div>
  );
}

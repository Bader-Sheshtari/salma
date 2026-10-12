import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { listNewsletterIssues } from "@/lib/admin-queries";
import { ISSUE_STATUS_AR } from "@/lib/newsletter-issues";
import { formatDateAr } from "@/lib/format";
import CreateIssueForm from "./CreateIssueForm";

export const dynamic = "force-dynamic";

// Newsletter Curation Engine V1 — issues list («إصدارات النشرة», brief §3).
// Staff-level: editors curate issues; subscriber PII stays admin-only.
export default async function NewsletterIssuesPage() {
  await requireStaff();
  const issues = await listNewsletterIssues();

  const statusClass = (s: string) =>
    s === "ready"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : s === "curated"
      ? "border-sky-200 bg-sky-50 text-sky-700"
      : s === "archived"
      ? "border-line bg-cream text-gray"
      : "border-amber-200 bg-amber-50 text-amber-700";

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h1 className="text-2xl font-bold">إصدارات النشرة</h1>
        <span className="rounded-md bg-ink px-2 py-0.5 font-sans text-[10px] font-bold tracking-wide text-white">
          CURATION
        </span>
      </div>
      <p className="mb-4 text-[13px] text-gray">
        تجهيز أعداد النشرة تحريرياً: اقتراح آلي متوازن ثم قرار المحرر النهائي. لا إرسال بريدي في هذه المرحلة.
        {" "}
        <Link href="/admin/newsletter" className="font-semibold text-teal underline">
          المشتركون والاستبيان ↗
        </Link>
      </p>

      <CreateIssueForm />

      <div className="mt-5 space-y-2">
        {issues.length === 0 && (
          <div className="rounded-lg border border-line bg-white p-6 text-center text-[13px] text-gray">
            لا توجد إصدارات بعد — أنشئ أول إصدار أعلاه.
          </div>
        )}
        {issues.map((issue) => (
          <Link
            key={issue.id}
            href={`/admin/newsletter/issues/${issue.id}`}
            className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white p-3 hover:bg-cream/50"
          >
            <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-bold ${statusClass(issue.status)}`}>
              {ISSUE_STATUS_AR[issue.status]}
            </span>
            <span className="text-[14px] font-bold text-ink">
              {issue.title ?? "إصدار بلا عنوان بعد"}
            </span>
            <span className="text-[12px] text-gray">
              {formatDateAr(issue.range_start)} → {formatDateAr(issue.range_end)}
            </span>
            {issue.curation_meta?.picks !== undefined && (
              <span className="ms-auto text-[12px] font-semibold text-gray">
                {issue.curation_meta.picks} عنصرًا مقترحًا
              </span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

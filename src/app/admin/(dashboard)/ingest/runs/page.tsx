import Link from "next/link";
import { listIngestionRuns, type IngestionRun, type RunArticle } from "@/lib/admin-queries";
import { timeAgoAr } from "@/lib/format";

export const dynamic = "force-dynamic";

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ar-KW", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} مللي ثانية`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} ثانية`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m} دقيقة${rem ? ` و${rem} ثانية` : ""}`;
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-lg bg-cream px-3 py-2 text-center">
      <div className={`text-lg font-bold ${accent ?? "text-ink"}`}>{value}</div>
      <div className="text-[11px] text-gray">{label}</div>
    </div>
  );
}

function RunCard({ run, articles }: { run: IngestionRun; articles: Record<string, RunArticle> }) {
  const ok = run.status === "success";
  const created = run.created_ids.map((id) => articles[id]).filter(Boolean) as RunArticle[];

  return (
    <article className="rounded-2xl border border-line bg-white p-4 sm:p-5">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[14px] font-bold text-ink">{fmtDateTime(run.created_at)}</div>
          <div className="text-[11.5px] text-gray">{timeAgoAr(run.created_at)}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-line px-2.5 py-1 text-[11px] font-semibold text-gray">
            {run.trigger === "cron" ? "مجدول" : "يدوي"}
          </span>
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-bold text-white ${
              ok ? "bg-teal" : "bg-coral"
            }`}
          >
            {ok ? "نجح" : "فشل"}
          </span>
        </div>
      </header>

      <div className="mb-3 grid grid-cols-4 gap-2">
        <Stat label="عُثر عليها" value={run.found} />
        <Stat label="محفوظة" value={run.kept} accent="text-teal" />
        <Stat label="مكررة" value={run.duplicates} />
        <Stat label="مستبعدة" value={run.filtered} accent="text-coral" />
      </div>

      <div className="mb-3 text-[12.5px] text-gray">
        المدة: <span className="font-semibold text-ink">{fmtDuration(run.duration_ms)}</span>
      </div>

      {run.sources.length > 0 ? (
        <div className="mb-3">
          <div className="mb-1.5 text-[11.5px] font-semibold text-gray">المصادر التي جرى فحصها</div>
          <div className="flex flex-wrap gap-1.5">
            {run.sources.map((s) => (
              <span
                key={s}
                className="rounded-md bg-sand px-2 py-0.5 font-sans text-[11px] text-ink"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {created.length > 0 ? (
        <div className="mb-3">
          <div className="mb-1.5 text-[11.5px] font-semibold text-gray">
            المقالات المُنشأة ({created.length})
          </div>
          <ul className="flex flex-col gap-1">
            {created.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/admin/content/${a.id}`}
                  className="text-[12.5px] font-semibold text-teal underline"
                >
                  {a.title}
                </Link>
                {a.status !== "pending" ? (
                  <span className="mr-1.5 text-[11px] text-gray">({a.status})</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {run.error ? (
        <div className="rounded-lg border border-coral/40 bg-coral/5 px-3 py-2 text-[12.5px] text-coral">
          <span className="font-bold">خطأ:</span> {run.error}
        </div>
      ) : null}
    </article>
  );
}

export default async function IngestRunsPage() {
  const { runs, articles } = await listIngestionRuns();

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="mb-1 text-2xl font-bold">سجلّ عمليات الجلب</h1>
          <p className="text-[13.5px] text-gray">
            تاريخ كل عملية جلب بالذكاء الاصطناعي ونتائجها لمراقبة عمل النظام ومعرفة أسباب أي إخفاق.
          </p>
        </div>
        <Link
          href="/admin/ingest"
          className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold text-ink hover:bg-cream"
        >
          ← العودة للجلب
        </Link>
      </div>

      {runs.length === 0 ? (
        <div className="rounded-2xl border border-line bg-white p-8 text-center text-[13.5px] text-gray">
          لا توجد عمليات جلب بعد. شغّل أول عملية من صفحة «جلب بالذكاء الاصطناعي».
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {runs.map((run) => (
            <RunCard key={run.id} run={run} articles={articles} />
          ))}
        </div>
      )}
    </div>
  );
}

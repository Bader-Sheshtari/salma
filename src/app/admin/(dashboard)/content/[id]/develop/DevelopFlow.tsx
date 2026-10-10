"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  cancelDevelopment,
  createDevelopedDraft,
  getDevelopmentState,
  startDevelopment,
} from "@/app/admin/develop-actions";
import {
  DEVELOP_DIRECTIONS,
  DEVELOP_ERROR_LABELS,
  DEVELOP_PHASE_LABELS,
  DEVELOP_STATUS_LABELS,
  type DevelopmentDirection,
  type DevelopmentJob,
  directionLabel,
} from "@/lib/develop-story";
import { formatDateTimeAr } from "@/lib/format";

/**
 * After the News / Develop Story — the whole editor flow on one screen:
 * direction → live research progress → research brief review → draft →
 * link into the normal pending review. The edge function owns job state;
 * this component only renders it and polls while a phase runs.
 */

const ACTIVE = new Set(["researching", "drafting"]);
const OPEN = new Set(["researching", "brief_ready", "drafting"]);

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-white p-5 ${className}`}>{children}</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-[13px] font-bold text-ink">{title}</div>
      {children}
    </div>
  );
}

function List({ items }: { items: string[] }) {
  if (!items.length) return <div className="text-[12.5px] text-gray">—</div>;
  return (
    <ul className="flex flex-col gap-1 text-[13px] leading-relaxed text-ink">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2">
          <span className="text-teal">•</span>
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

export function DevelopFlow({
  contentId,
  initialJob,
  initialHistory,
  initialResultTitle,
}: {
  contentId: string;
  initialJob: DevelopmentJob | null;
  initialHistory: DevelopmentJob[];
  initialResultTitle: string | null;
}) {
  const [job, setJob] = useState<DevelopmentJob | null>(initialJob);
  const [history, setHistory] = useState<DevelopmentJob[]>(initialHistory);
  const [resultTitle, setResultTitle] = useState<string | null>(initialResultTitle);
  const [direction, setDirection] = useState<DevelopmentDirection>("auto");
  const [note, setNote] = useState("");
  const [draftDirection, setDraftDirection] = useState<DevelopmentDirection | null>(null);
  const [confirmRepeat, setConfirmRepeat] = useState(false);
  const [startingNew, setStartingNew] = useState(false);
  const [pending, startTransition] = useTransition();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getDevelopmentState(contentId);
      setJob(s.job);
      setHistory(s.history);
      setResultTitle(s.resultTitle);
    } catch {
      // transient — next tick retries
    }
  }, [contentId]);

  // Poll while a phase is running (the proven admin latch/poll pattern).
  useEffect(() => {
    const active = job != null && ACTIVE.has(job.status);
    if (active && pollRef.current == null) {
      pollRef.current = setInterval(refresh, 4000);
    }
    if (!active && pollRef.current != null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current != null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [job, refresh]);

  const begin = () => {
    const repeated = [job, ...history].some(
      (j) => j && j.status === "draft_ready" && (j.draft_direction ?? j.direction) === direction && direction !== "auto",
    );
    if (repeated && !confirmRepeat) {
      setConfirmRepeat(true);
      return;
    }
    setConfirmRepeat(false);
    setStartingNew(false);
    startTransition(async () => {
      await startDevelopment(contentId, direction, note);
      await refresh();
    });
  };

  const makeDraft = (jobId: string) => {
    startTransition(async () => {
      await createDevelopedDraft(jobId, draftDirection, note);
      await refresh();
    });
  };

  const cancel = (jobId: string) => {
    startTransition(async () => {
      await cancelDevelopment(jobId);
      await refresh();
    });
  };

  const brief = job?.research_brief ?? null;
  const showStartForm = startingNew || job == null || job.status === "cancelled" ||
    (job.status === "failed" && !job.research_brief) || job.status === "draft_ready";
  const startFormOnly = job == null || job.status === "cancelled";

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Running phase ---- */}
      {job && ACTIVE.has(job.status) ? (
        <Card>
          <div className="flex items-center gap-3">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-teal border-t-transparent" />
            <div>
              <div className="text-[14px] font-bold">
                {DEVELOP_PHASE_LABELS[job.phase ?? ""] ?? DEVELOP_STATUS_LABELS[job.status]}
              </div>
              <div className="mt-0.5 text-[12px] text-gray">
                قد يستغرق هذا دقيقة أو دقيقتين — يمكنك مغادرة الصفحة والعودة لاحقاً.
              </div>
            </div>
          </div>
          {job.status === "researching" ? (
            <button
              type="button"
              onClick={() => cancel(job.id)}
              disabled={pending}
              className="mt-4 rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold text-gray hover:bg-cream"
            >
              إلغاء
            </button>
          ) : null}
        </Card>
      ) : null}

      {/* ---- Failed ---- */}
      {job && job.status === "failed" ? (
        <Card className="border-coral/40">
          <div className="text-[14px] font-bold text-coral">تعذر إكمال العملية</div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink">
            {DEVELOP_ERROR_LABELS[job.error_category ?? ""] ?? "حدث خطأ غير متوقع. أعد المحاولة."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {job.research_brief ? (
              <button
                type="button"
                onClick={() => makeDraft(job.id)}
                disabled={pending}
                className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white disabled:opacity-60"
              >
                إعادة محاولة إنشاء المسودة
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setStartingNew(true);
                if (!job.research_brief) cancel(job.id);
              }}
              disabled={pending}
              className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold text-ink hover:bg-cream"
            >
              بدء بحث جديد
            </button>
          </div>
        </Card>
      ) : null}

      {/* ---- Draft ready ---- */}
      {job && job.status === "draft_ready" && job.result_content_id ? (
        <Card className="border-teal/40 bg-teal/5">
          <div className="text-[14px] font-bold text-teal">اكتملت المسودة المعمّقة ✓</div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink">
            {resultTitle ? `«${resultTitle}»` : "المسودة الجديدة"} الآن{" "}
            <span className="font-semibold">بانتظار المراجعة</span> — لن تُنشر تلقائياً، وتمر عبر
            سير المراجعة والنشر المعتاد.
            {job.needs_human_review ? " (أشار الفحص التحريري إلى نقاط تحتاج انتباه المراجع.)" : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={`/admin/content/${job.result_content_id}`}
              className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white"
            >
              فتح المسودة للمراجعة
            </Link>
          </div>
        </Card>
      ) : null}

      {/* ---- Research brief review (§7) ---- */}
      {job && job.status === "brief_ready" && brief ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[15px] font-bold">موجز البحث</div>
            <span className="rounded-full bg-cream px-2.5 py-1 text-[11px] font-bold text-teal">
              جاهز للمراجعة
            </span>
          </div>
          <p className="mt-1 text-[12px] text-gray">
            أعدّته سلمى من المقال ومصادره المتاحة — راجعه ثم اختر اتجاه التطوير.
          </p>

          <Section title="ملخص القصة">
            <p className="text-[13.5px] leading-relaxed text-ink">{brief.story_summary}</p>
            {brief.new_vs_known ? (
              <p className="mt-1.5 text-[13px] leading-relaxed text-gray">{brief.new_vs_known}</p>
            ) : null}
          </Section>

          {(job.brief_sources ?? []).length > 0 ? (
            <Section title="المصادر">
              <ul className="flex flex-col gap-1 text-[12.5px]">
                {(job.brief_sources ?? []).map((s, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">
                      {s.role === "original_source"
                        ? "المصدر الأصلي"
                        : s.role === "editorial_primary"
                          ? "المصدر الأولي الموثوق"
                          : "مصدر إضافي"}
                      :
                    </span>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      dir="ltr"
                      className="text-teal underline underline-offset-2"
                    >
                      {s.label || s.domain}
                    </a>
                    {!s.fetched ? (
                      <span className="text-[11px] text-gray">(تعذّر الجلب الآلي)</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {brief.evidence_says ? (
            <Section title="ما تقوله الأدلة">
              <p className="text-[13px] leading-relaxed text-ink">{brief.evidence_says}</p>
            </Section>
          ) : null}

          {brief.key_numbers.length > 0 ? (
            <Section title="أهم الأرقام">
              <ul className="flex flex-col gap-1 text-[13px] text-ink">
                {brief.key_numbers.map((k, i) => (
                  <li key={i}>
                    <span className="font-sans font-bold text-teal">{k.value}</span>
                    <span className="text-gray"> — {k.context}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl bg-cream/60 p-3">
              <div className="mb-1.5 text-[13px] font-bold text-teal">ما نعرفه</div>
              <List items={brief.known} />
            </div>
            <div className="rounded-xl border border-line p-3">
              <div className="mb-1.5 text-[13px] font-bold text-gray">ما لا نعرفه</div>
              <List items={[...brief.unknown, ...brief.uncertain_claims.map((c) => `غير مؤكد: ${c}`)]} />
            </div>
          </div>

          <Section title="زوايا مقترحة لتطوير القصة">
            <div className="flex flex-col gap-2">
              {brief.suggested_angles.map((a) => (
                <button
                  key={a.direction + a.title}
                  type="button"
                  onClick={() => setDraftDirection(a.direction)}
                  className={`rounded-xl border p-3 text-start transition-colors ${
                    (draftDirection ?? brief.suggested_angles.find((x) => x.recommended)?.direction) ===
                      a.direction
                      ? "border-teal bg-teal/5"
                      : "border-line bg-white hover:border-teal/50"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2 text-[13px] font-bold text-ink">
                    {a.title}
                    <span className="rounded bg-cream px-1.5 py-0.5 text-[10.5px] font-semibold text-teal">
                      {directionLabel(a.direction)}
                    </span>
                    {a.recommended ? (
                      <span className="rounded bg-teal px-1.5 py-0.5 text-[10.5px] font-bold text-white">
                        موصى به
                      </span>
                    ) : null}
                  </div>
                  {a.rationale ? (
                    <p className="mt-1 text-[12.5px] leading-relaxed text-gray">{a.rationale}</p>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="mt-2.5">
              <label className="text-[12px] font-semibold text-gray">أو اختر اتجاهاً آخر:</label>
              <select
                dir="rtl"
                value={draftDirection ?? ""}
                onChange={(e) => setDraftDirection((e.target.value || null) as DevelopmentDirection | null)}
                className="mt-1 w-full max-w-xs rounded-lg border border-line bg-white px-3 py-2 text-[13px] outline-none focus:border-teal"
              >
                <option value="">— حسب الزاوية المحددة أعلاه —</option>
                {DEVELOP_DIRECTIONS.filter((d) => d.key !== "auto").map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          </Section>

          <Section title="ملاحظة للمحرر (اختياري)">
            <textarea
              dir="rtl"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder={job.editor_note ?? "مثال: ركز على تأثير الخبر على المرضى في الكويت"}
              className="w-full rounded-lg border border-line bg-white px-3 py-2 text-[13px] outline-none focus:border-teal"
            />
          </Section>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => makeDraft(job.id)}
              disabled={pending}
              className="rounded-lg bg-teal px-5 py-2.5 text-[13.5px] font-bold text-white disabled:opacity-60"
            >
              {pending ? "…" : "إنشاء مسودة معمقة"}
            </button>
            <button
              type="button"
              onClick={() => cancel(job.id)}
              disabled={pending}
              className="rounded-lg border border-line px-4 py-2.5 text-[13px] font-semibold text-gray hover:bg-cream"
            >
              إلغاء
            </button>
          </div>
        </Card>
      ) : null}

      {/* ---- Start form (§4) ---- */}
      {showStartForm ? (
        <Card>
          <div className="text-[15px] font-bold">
            {startFormOnly ? "كيف تريد تطوير هذه القصة؟" : "تطوير جديد"}
          </div>
          <p className="mt-1 text-[12px] text-gray">
            تبدأ سلمى بإعداد موجز بحث من المصادر والأدلة المتاحة، وتعرضه عليك قبل كتابة أي مسودة.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {DEVELOP_DIRECTIONS.map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => {
                  setDirection(d.key);
                  setConfirmRepeat(false);
                }}
                className={`rounded-xl border p-3 text-start transition-colors ${
                  direction === d.key ? "border-teal bg-teal/5" : "border-line bg-white hover:border-teal/50"
                }`}
              >
                <div className="text-[13px] font-bold text-ink">{d.label}</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-gray">{d.description}</div>
              </button>
            ))}
          </div>
          <div className="mt-3">
            <label className="text-[12px] font-semibold text-gray">ملاحظة للمحرر (اختياري)</label>
            <textarea
              dir="rtl"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="مثال: ابحث إن كانت هناك دراسة أصلية وراء هذا الادعاء"
              className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-[13px] outline-none focus:border-teal"
            />
          </div>
          {confirmRepeat ? (
            <p className="mt-2 text-[12.5px] font-semibold text-coral">
              سبق تطوير هذه القصة بهذا الاتجاه — اضغط «تأكيد البدء» إن كنت تريد مسودة جديدة فعلاً.
            </p>
          ) : null}
          <button
            type="button"
            onClick={begin}
            disabled={pending || (job != null && OPEN.has(job.status))}
            className="mt-3 rounded-lg bg-teal px-5 py-2.5 text-[13.5px] font-bold text-white disabled:opacity-60"
          >
            {pending ? "…" : confirmRepeat ? "تأكيد البدء" : "ابدأ البحث"}
          </button>
        </Card>
      ) : null}

      {/* ---- History ---- */}
      {history.length > 0 ? (
        <Card>
          <div className="mb-2 text-[13px] font-bold text-gray">تطويرات سابقة</div>
          <ul className="flex flex-col gap-1.5 text-[12.5px]">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2">
                <span className="font-sans text-[11px] text-gray">{formatDateTimeAr(h.created_at)}</span>
                <span className="text-ink">{directionLabel(h.draft_direction ?? h.direction)}</span>
                <span className="text-gray">— {DEVELOP_STATUS_LABELS[h.status] ?? h.status}</span>
                {h.result_content_id ? (
                  <Link
                    href={`/admin/content/${h.result_content_id}`}
                    className="font-semibold text-teal underline underline-offset-2"
                  >
                    فتح المسودة
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

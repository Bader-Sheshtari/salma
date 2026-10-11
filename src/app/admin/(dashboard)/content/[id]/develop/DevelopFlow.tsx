"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  cancelDevelopment,
  createDevelopedDraft,
  getDevelopmentEvidence,
  getDevelopmentState,
  startDevelopment,
} from "@/app/admin/develop-actions";
import {
  adviceForBrief,
  type BriefClaim,
  type BriefV2,
  DEVELOP_DIRECTIONS,
  DEVELOP_ERROR_LABELS,
  DEVELOP_PHASE_LABELS,
  DEVELOP_PHASE_LABELS_V2,
  DEVELOP_STATUS_LABELS,
  type DevelopmentDirection,
  type DevelopmentEvidence,
  type DevelopmentJob,
  type DevelopOrigin,
  directionLabel,
  EVIDENCE_CLASS_LABELS,
  isBriefV2,
  type ResearchBrief,
} from "@/lib/develop-story";
import { formatDateTimeAr } from "@/lib/format";

/**
 * After the News / Develop Story — the whole editor flow on one screen.
 * V2: article OR Radar-cluster origins; evidence-first briefs (ds2) with
 * provenance, timeline, what-changed and conflicts; adaptive research depth
 * (deep mode auto-activates for evidence-heavy stories — the «بحث معمّق»
 * switch is only an optional override). V1 (ds1) briefs still render.
 */

const ACTIVE = new Set(["researching", "drafting"]);
const OPEN = new Set(["researching", "brief_ready", "drafting"]);

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-white p-5 ${className}`}>{children}</div>;
}

function Section({ title, children, tone }: { title: string; children: React.ReactNode; tone?: "warn" }) {
  return (
    <div className="mt-4">
      <div className={`mb-1.5 text-[13px] font-bold ${tone === "warn" ? "text-coral" : "text-ink"}`}>{title}</div>
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

function Refs({ ids }: { ids: string[] }) {
  if (!ids.length) return null;
  return <span className="mr-1 font-sans text-[10px] text-teal/70" dir="ltr">[{ids.join(" ")}]</span>;
}

function Claims({ items }: { items: BriefClaim[] }) {
  if (!items.length) return <div className="text-[12.5px] text-gray">—</div>;
  return (
    <ul className="flex flex-col gap-1 text-[13px] leading-relaxed text-ink">
      {items.map((c, i) => (
        <li key={i} className="flex gap-2">
          <span className="text-teal">•</span>
          <span>
            {c.statement}
            <Refs ids={c.source_ids} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function EvidencePanel({ items }: { items: DevelopmentEvidence[] }) {
  const external = items.filter((e) => e.kind !== "salma_archive");
  const archive = items.filter((e) => e.kind === "salma_archive");
  const row = (e: DevelopmentEvidence) => (
    <li key={e.id} className="rounded-xl border border-line p-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-sans text-[10.5px] font-bold text-teal" dir="ltr">S{e.id}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold ${e.is_primary ? "bg-teal text-white" : "bg-cream text-teal"}`}>
          {e.kind === "salma_archive" ? "أرشيف سلمى" : (EVIDENCE_CLASS_LABELS[e.source_class ?? ""] ?? "مصدر")}
        </span>
        {e.published_date ? <span className="font-sans text-[10.5px] text-gray">{e.published_date}</span> : null}
        {!e.fetched ? <span className="text-[10.5px] text-gray">(بيانات وصفية)</span> : null}
      </div>
      <div className="mt-1 text-[12.5px] font-semibold leading-snug text-ink">
        {e.url ? (
          <a href={e.url} target="_blank" rel="noopener noreferrer" className="hover:text-teal">
            {e.title ?? e.publisher ?? e.url}
          </a>
        ) : (e.title ?? e.publisher ?? "—")}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 font-sans text-[10.5px] text-gray" dir="ltr">
        {e.publisher ? <span>{e.publisher}</span> : null}
        {e.pmid ? <span>PMID:{e.pmid}</span> : null}
        {e.doi ? <span>DOI:{e.doi}</span> : null}
        {e.nct_id ? <span>{e.nct_id}</span> : null}
      </div>
    </li>
  );
  return (
    <div>
      {external.length ? <ul className="flex flex-col gap-2">{external.map(row)}</ul> : null}
      {archive.length ? (
        <>
          <div className="mb-1.5 mt-3 text-[12px] font-bold text-gray">تغطية سلمى السابقة (سياق داخلي)</div>
          <ul className="flex flex-col gap-2">{archive.map(row)}</ul>
        </>
      ) : null}
    </div>
  );
}

function BriefV2View({ brief, evidence }: { brief: BriefV2; evidence: DevelopmentEvidence[] }) {
  const hasPrior = evidence.some((e) => e.kind === "salma_archive");
  const advice = adviceForBrief(brief, hasPrior);
  const [showSources, setShowSources] = useState(false);
  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
            advice.key === "new_article"
              ? "bg-teal text-white"
              : advice.key === "follow_up"
                ? "bg-cream text-teal"
                : "border border-line text-gray"
          }`}
        >
          {advice.label}
        </span>
      </div>

      <Section title="ملخص القصة">
        <p className="text-[13.5px] leading-relaxed text-ink">{brief.story_summary}</p>
        {brief.why_it_matters ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-gray">{brief.why_it_matters}</p>
        ) : null}
      </Section>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl bg-cream/60 p-3">
          <div className="mb-1.5 text-[13px] font-bold text-teal">الجديد الآن</div>
          <Claims items={brief.new_now} />
          {brief.changed.length ? (
            <>
              <div className="mb-1.5 mt-3 text-[12px] font-bold text-teal/80">ما الذي تغيّر</div>
              <Claims items={brief.changed} />
            </>
          ) : null}
        </div>
        <div className="rounded-xl border border-line p-3">
          <div className="mb-1.5 text-[13px] font-bold text-gray">ما كان معروفاً سابقاً</div>
          <Claims items={brief.previously_known} />
        </div>
      </div>

      {brief.timeline.length ? (
        <Section title="الخط الزمني">
          <ol className="relative mr-2 flex flex-col gap-2 border-r-2 border-line pr-4">
            {brief.timeline.map((t, i) => (
              <li key={i} className="text-[13px] leading-relaxed">
                <span className="font-sans text-[11px] font-bold text-teal" dir="ltr">{t.date}</span>
                <span className="mr-2">{t.event}</span>
                <Refs ids={t.source_ids} />
                {t.confidence !== "high" ? (
                  <span className="text-[10.5px] text-gray">({t.confidence === "medium" ? "ثقة متوسطة" : "ثقة منخفضة"})</span>
                ) : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {brief.scientific_evidence.length ? (
        <Section title="الأدلة العلمية">
          <ul className="flex flex-col gap-1.5 text-[13px] leading-relaxed">
            {brief.scientific_evidence.map((s, i) => (
              <li key={i}>
                <span className="rounded bg-cream px-1.5 py-0.5 text-[10.5px] font-bold text-teal">{s.study_type}</span>
                <span className="mr-2">{s.summary}</span>
                <Refs ids={s.source_ids} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {brief.regulatory_evidence.length ? (
        <Section title="الأدلة التنظيمية والرسمية">
          <ul className="flex flex-col gap-1.5 text-[13px] leading-relaxed">
            {brief.regulatory_evidence.map((s, i) => (
              <li key={i}>
                {s.summary}
                {s.status_verbatim ? (
                  <span className="mr-2 text-[11.5px] text-gray">(الحالة حرفياً: {s.status_verbatim})</span>
                ) : null}
                <Refs ids={s.source_ids} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {brief.key_numbers.length ? (
        <Section title="أهم الأرقام">
          <ul className="flex flex-col gap-1 text-[13px] text-ink">
            {brief.key_numbers.map((k, i) => (
              <li key={i}>
                <span className="font-sans font-bold text-teal">{k.value}</span>
                <span className="text-gray"> — {k.context}</span>
                <Refs ids={k.source_ids} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {brief.conflicts.length ? (
        <Section title="تعارض بين مصادر موثوقة" tone="warn">
          <div className="flex flex-col gap-2">
            {brief.conflicts.map((c, i) => (
              <div key={i} className="rounded-xl border border-coral/40 bg-coral/5 p-3 text-[13px]">
                <div className="font-bold">{c.topic}</div>
                <div className="mt-1">
                  <span className="font-semibold">الموقف الأول:</span> {c.position_a.statement}
                  <Refs ids={c.position_a.source_ids} />
                </div>
                <div className="mt-0.5">
                  <span className="font-semibold">الموقف الثاني:</span> {c.position_b.statement}
                  <Refs ids={c.position_b.source_ids} />
                </div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-line p-3">
          <div className="mb-1.5 text-[13px] font-bold text-gray">ما لا نعرفه</div>
          <List items={brief.unknown} />
        </div>
        <div className="rounded-xl border border-line p-3">
          <div className="mb-1.5 text-[13px] font-bold text-gray">أسئلة ما زالت بلا إجابة</div>
          <List items={brief.unanswered_questions} />
        </div>
      </div>

      {brief.evidence_gaps.length ? (
        <Section title="فجوات البحث">
          <List items={brief.evidence_gaps} />
        </Section>
      ) : null}

      <Section title={`المصادر (${evidence.length})`}>
        <button
          type="button"
          onClick={() => setShowSources((v) => !v)}
          className="rounded-lg border border-line px-3 py-1.5 text-[12px] font-semibold text-gray hover:bg-cream"
        >
          {showSources ? "إخفاء تفاصيل المصادر" : "عرض تفاصيل المصادر"}
        </button>
        {showSources ? <div className="mt-2.5"><EvidencePanel items={evidence} /></div> : null}
      </Section>
    </>
  );
}

function BriefV1View({ brief, sources }: { brief: ResearchBrief; sources: DevelopmentJob["brief_sources"] }) {
  return (
    <>
      <Section title="ملخص القصة">
        <p className="text-[13.5px] leading-relaxed text-ink">{brief.story_summary}</p>
        {brief.new_vs_known ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-gray">{brief.new_vs_known}</p>
        ) : null}
      </Section>
      {(sources ?? []).length > 0 ? (
        <Section title="المصادر">
          <ul className="flex flex-col gap-1 text-[12.5px]">
            {(sources ?? []).map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <a href={s.url} target="_blank" rel="noopener noreferrer" dir="ltr" className="text-teal underline underline-offset-2">
                  {s.label || s.domain}
                </a>
                {!s.fetched ? <span className="text-[11px] text-gray">(تعذّر الجلب الآلي)</span> : null}
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
    </>
  );
}

export function DevelopFlow({
  origin,
  initialJob,
  initialHistory,
  initialResultTitle,
}: {
  origin: DevelopOrigin;
  initialJob: DevelopmentJob | null;
  initialHistory: DevelopmentJob[];
  initialResultTitle: string | null;
}) {
  const [job, setJob] = useState<DevelopmentJob | null>(initialJob);
  const [history, setHistory] = useState<DevelopmentJob[]>(initialHistory);
  const [resultTitle, setResultTitle] = useState<string | null>(initialResultTitle);
  const [evidence, setEvidence] = useState<DevelopmentEvidence[]>([]);
  const [direction, setDirection] = useState<DevelopmentDirection>("auto");
  const [note, setNote] = useState("");
  const [deep, setDeep] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [draftDirection, setDraftDirection] = useState<DevelopmentDirection | null>(null);
  const [confirmRepeat, setConfirmRepeat] = useState(false);
  const [startingNew, setStartingNew] = useState(false);
  const [pending, startTransition] = useTransition();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getDevelopmentState(origin);
      setJob(s.job);
      setHistory(s.history);
      setResultTitle(s.resultTitle);
    } catch {
      // transient — next tick retries
    }
  }, [origin]);

  useEffect(() => {
    const active = job != null && ACTIVE.has(job.status);
    if (active && pollRef.current == null) pollRef.current = setInterval(refresh, 4000);
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

  // Load the evidence list once a brief exists.
  useEffect(() => {
    if (job && (job.status === "brief_ready" || job.status === "draft_ready") && job.research_prompt_version === "ds2") {
      getDevelopmentEvidence(job.id).then(setEvidence).catch(() => {});
    }
  }, [job?.id, job?.status, job?.research_prompt_version]); // eslint-disable-line react-hooks/exhaustive-deps

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
      await startDevelopment(origin, direction, note, deep);
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
                {DEVELOP_PHASE_LABELS_V2[job.phase ?? ""] ?? DEVELOP_PHASE_LABELS[job.phase ?? ""] ?? DEVELOP_STATUS_LABELS[job.status]}
              </div>
              <div className="mt-0.5 text-[12px] text-gray">
                {job.research_depth === "deep" ? "بحث معمّق — " : ""}
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

      {/* ---- Research brief review ---- */}
      {job && job.status === "brief_ready" && brief ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[15px] font-bold">موجز البحث</div>
            <div className="flex items-center gap-2">
              {job.research_depth === "deep" ? (
                <span className="rounded-full border border-teal/40 px-2.5 py-1 text-[11px] font-bold text-teal">
                  بحث معمّق
                </span>
              ) : null}
              <span className="rounded-full bg-cream px-2.5 py-1 text-[11px] font-bold text-teal">
                جاهز للمراجعة
              </span>
            </div>
          </div>
          <p className="mt-1 text-[12px] text-gray">
            أعدّته سلمى من المصادر والأدلة المتاحة — راجعه وافحص المصادر ثم اختر اتجاه التطوير.
          </p>

          {isBriefV2(brief) ? (
            <BriefV2View brief={brief} evidence={evidence} />
          ) : (
            <BriefV1View brief={brief as ResearchBrief} sources={job.brief_sources} />
          )}

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

      {/* ---- Start form ---- */}
      {showStartForm ? (
        <Card>
          <div className="text-[15px] font-bold">
            {startFormOnly ? "كيف تريد تطوير هذه القصة؟" : "تطوير جديد"}
          </div>
          <p className="mt-1 text-[12px] text-gray">
            تبدأ سلمى بإعداد موجز بحث من المصادر الموثوقة والأدلة المتاحة، وتعرضه عليك قبل كتابة أي
            مسودة. يتعمّق البحث تلقائياً في القصص العلمية والتنظيمية.
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
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-[11.5px] font-semibold text-gray underline underline-offset-2"
            >
              خيارات متقدمة
            </button>
            {showAdvanced ? (
              <label className="mt-1.5 flex items-center gap-2 text-[12.5px] text-ink">
                <input
                  type="checkbox"
                  checked={deep}
                  onChange={(e) => setDeep(e.target.checked)}
                  className="h-4 w-4 accent-[var(--salma-teal)]"
                />
                فرض «بحث معمّق» (يرفع حدود المصادر والأدبيات — يُفعَّل تلقائياً للقصص العلمية
                والتنظيمية حتى بدون هذا الخيار)
              </label>
            ) : null}
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

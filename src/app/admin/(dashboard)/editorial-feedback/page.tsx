import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  REJECT_REASONS,
  SAMPLE_LABEL_AR,
  sampleLabel,
  type EditMagnitude,
} from "@/lib/editorial-feedback";

export const dynamic = "force-dynamic";

/**
 * Editorial Feedback — READ-ONLY insight surface (V1, observational).
 *
 * Shows what the human editors actually decided (publish / reject / edit /
 * correct) against what ESL predicted. Every figure carries its sample size
 * and a deterministic label; nothing on this page feeds back into Radar
 * ranking, ESL scoring or the Writer.
 */

type OverviewRow = {
  content_id: string;
  title: string;
  status: string;
  created_at: string;
  esl_selected: boolean;
  lane: string | null;
  story_type: string | null;
  evidence_class: string | null;
  gcc: boolean | null;
  source_tier: number | null;
  chosen_source_domain: string | null;
  esc_status: string | null;
  esc_editorial_tier: number | null;
  esc_discovery_tier: number | null;
  usefulness: number | null;
  was_edited: boolean;
  title_edit_magnitude: EditMagnitude | null;
  body_edit_magnitude: EditMagnitude | null;
  ai_title: string | null;
  final_title: string | null;
  reject_reason: string | null;
  category_corrected: boolean;
  category_before: string | null;
  category_after: string | null;
  source_changed: boolean;
  source_before: string | null;
  source_after: string | null;
  image_changed: boolean;
  // Evidence Intelligence metadata (observational linkage only).
  ei_status: string | null;
  ei_strength: string | null;
  ei_peer_review: string | null;
  ei_claim_relationship: string | null;
};

type RateRow = { key: string; n: number; published: number; rate: number };

/** Acceptance rate per group among DECIDED items (published + rejected). */
function ratesBy(rows: OverviewRow[], keyOf: (r: OverviewRow) => string | null): RateRow[] {
  const map = new Map<string, { n: number; published: number }>();
  for (const r of rows) {
    if (r.status !== "published" && r.status !== "rejected") continue;
    const key = keyOf(r) ?? "—";
    const e = map.get(key) ?? { n: 0, published: 0 };
    e.n++;
    if (r.status === "published") e.published++;
    map.set(key, e);
  }
  return [...map.entries()]
    .map(([key, e]) => ({ key, n: e.n, published: e.published, rate: e.published / e.n }))
    .sort((a, b) => b.n - a.n);
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function SampleChip({ n }: { n: number }) {
  const label = sampleLabel(n);
  const tone =
    label === "meaningful_sample"
      ? "border-teal/50 text-teal"
      : label === "early_signal"
        ? "border-blue/50 text-blue"
        : "border-coral/50 text-coral";
  return (
    <span className={`rounded border px-1.5 py-0.5 font-sans text-[10px] font-semibold ${tone}`}>
      {SAMPLE_LABEL_AR[label]} · n={n}
    </span>
  );
}

function RateTable({ title, rows }: { title: string; rows: RateRow[] }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-4">
      <h2 className="mb-2 text-[15px] font-bold">{title}</h2>
      {rows.length === 0 ? (
        <div className="text-[13px] text-gray">لا توجد قرارات بعد.</div>
      ) : (
        <table className="w-full text-[13px]">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-line first:border-t-0">
                <td className="py-1.5 font-semibold">{r.key}</td>
                <td className="py-1.5 font-sans">{pct(r.rate)}</td>
                <td className="py-1.5 font-sans text-gray">
                  {r.published}/{r.n}
                </td>
                <td className="py-1.5 text-end">
                  <SampleChip n={r.n} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Deterministic, read-only observations — only when both sides have n ≥ 5. */
function buildObservations(rows: OverviewRow[]): string[] {
  const out: string[] = [];
  const say = (s: string) => out.push(s);

  const tierRates = ratesBy(rows, (r) =>
    r.source_tier == null ? null : r.source_tier >= 4 ? "منخفض (4–5)" : "قوي (1–3)",
  );
  const weak = tierRates.find((t) => t.key === "منخفض (4–5)");
  const strong = tierRates.find((t) => t.key === "قوي (1–3)");
  if (weak && strong && weak.n >= 5 && strong.n >= 5) {
    if (weak.rate < strong.rate - 0.1) {
      say(
        `قصص المصادر الضعيفة (فئة 4–5) تُقبل بنسبة أقل (${pct(weak.rate)} من ${weak.n}) مقارنة بالمصادر القوية (${pct(strong.rate)} من ${strong.n}).`,
      );
    } else {
      say(
        `لا يظهر فرق كبير في القبول بين المصادر القوية (${pct(strong.rate)} من ${strong.n}) والضعيفة (${pct(weak.rate)} من ${weak.n}) حتى الآن.`,
      );
    }
  }

  const escRates = ratesBy(rows, (r) =>
    r.esc_status == null ? null : r.esc_status === "upgraded" ? "تمت الترقية لمصدر أولي" : "بدون ترقية",
  );
  const up = escRates.find((t) => t.key === "تمت الترقية لمصدر أولي");
  const noUp = escRates.find((t) => t.key === "بدون ترقية");
  if (up && noUp && up.n >= 5 && noUp.n >= 5) {
    say(
      up.rate > noUp.rate + 0.1
        ? `القصص المُرقّاة لمصدر أولي تُقبل أكثر (${pct(up.rate)} من ${up.n}) من غير المُرقّاة (${pct(noUp.rate)} من ${noUp.n}).`
        : `لم يظهر بعد أثر واضح لترقية المصدر الأولي على القبول (${pct(up.rate)} من ${up.n} مقابل ${pct(noUp.rate)} من ${noUp.n}).`,
    );
  }

  const l5 = ratesBy(rows, (r) => r.lane).find((t) => t.key === "L5");
  if (l5 && l5.n >= 5) {
    say(`قصص «حياة صحية» (L5): نسبة قبول ${pct(l5.rate)} من ${l5.n} قرارات.`);
  }

  const publishedEdits = rows.filter((r) => r.status === "published");
  const heavy = publishedEdits.filter(
    (r) => r.body_edit_magnitude === "moderate" || r.body_edit_magnitude === "major",
  );
  if (publishedEdits.length >= 5 && heavy.length > 0) {
    say(
      `${heavy.length} من ${publishedEdits.length} مقالة منشورة احتاجت تحريراً متوسطاً أو كبيراً في النص.`,
    );
  }

  if (out.length === 0) {
    say("لا توجد بيانات كافية بعد لأي ملاحظة — تُجمع الإشارات من الآن فصاعداً مع كل قرار تحريري.");
  }
  return out;
}

const MAGNITUDE_AR: Record<string, string> = {
  none: "بدون تعديل",
  minor: "تعديل طفيف",
  moderate: "تعديل متوسط",
  major: "تعديل كبير",
};

// Evidence Intelligence facet labels (rows without a card group to null → excluded).
const EVIDENCE_STRENGTH_AR: Record<string, string> = {
  high: "قوي",
  moderate: "متوسط",
  limited: "محدود",
  very_limited: "محدود جدًا",
  unclear: "غير واضح",
};
const EVIDENCE_PEER_AR: Record<string, string> = {
  peer_reviewed: "محكّمة",
  preprint: "Preprint",
  conference_only: "مؤتمر فقط",
  institutional_guidance: "إرشادات مؤسسية",
  regulatory: "تنظيمية",
  unknown: "غير محدد",
};

export default async function EditorialFeedbackPage() {
  await requireAdmin();
  const svc = createAdminClient() as unknown as SupabaseClient;
  const { data } = await svc
    .from("editorial_feedback_overview")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(2000);
  const rows = (data ?? []) as OverviewRow[];

  const published = rows.filter((r) => r.status === "published").length;
  const rejected = rows.filter((r) => r.status === "rejected").length;
  const pending = rows.filter((r) => r.status === "pending").length;
  const decided = published + rejected;

  // Publish-time edit magnitude (absence of an event = never edited = none).
  const magDist = (pick: (r: OverviewRow) => EditMagnitude | null) => {
    const dist: Record<string, number> = { none: 0, minor: 0, moderate: 0, major: 0 };
    for (const r of rows) {
      if (r.status !== "published") continue;
      dist[pick(r) ?? "none"]++;
    }
    return dist;
  };
  const titleDist = magDist((r) => r.title_edit_magnitude);
  const bodyDist = magDist((r) => r.body_edit_magnitude);

  const reasonCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.status === "rejected") {
      const k = r.reject_reason ?? "__none__";
      reasonCounts.set(k, (reasonCounts.get(k) ?? 0) + 1);
    }
  }
  const reasonLabel = (code: string) =>
    code === "__none__"
      ? "بدون سبب محدد"
      : REJECT_REASONS.find((r) => r.code === code)?.label ?? code;

  const corrections = rows.filter((r) => r.category_corrected);
  const sourceChanges = rows.filter((r) => r.source_changed);
  const titleEdits = rows.filter((r) => r.title_edit_magnitude);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">التعلّم التحريري</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-gray">
          رصد قرارات المحررين الحقيقية على مقالات الذكاء الاصطناعي (نشر، رفض، تعديل، تصحيح)
          مربوطة بقرار طبقة الاختيار التحريري (ESL). هذه الصفحة للقراءة فقط —
          لا تُغيّر أي شيء في الترتيب أو الاختيار تلقائياً. القرارات التاريخية (نشر/انتظار)
          مشتقة من بيانات موجودة؛ أسباب الرفض ومقادير التعديل تُجمع من الآن فصاعداً.
        </p>
      </div>

      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "قرارات (نشر/رفض)", value: decided },
          { label: "منشور", value: published },
          { label: "مرفوض", value: rejected },
          { label: "بانتظار المراجعة", value: pending },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-line bg-white p-4">
            <div className="font-sans text-2xl font-bold text-teal">{s.value}</div>
            <div className="mt-0.5 text-[12px] text-gray">{s.label}</div>
          </div>
        ))}
      </div>

      {decided > 0 ? (
        <div className="rounded-2xl border border-line bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-bold">نسبة القبول الإجمالية:</span>
            <span className="font-sans text-[15px] font-bold text-teal">
              {pct(published / decided)}
            </span>
            <SampleChip n={decided} />
          </div>
        </div>
      ) : null}

      {/* Read-only observations */}
      <div className="rounded-2xl border border-line bg-white p-4">
        <h2 className="mb-2 text-[15px] font-bold">ملاحظات (للقراءة فقط)</h2>
        <ul className="list-disc space-y-1 ps-5 text-[13px] leading-relaxed">
          {buildObservations(rows).map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ul>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <RateTable title="القبول حسب المسار التحريري" rows={ratesBy(rows, (r) => r.lane)} />
        <RateTable title="القبول حسب نوع القصة" rows={ratesBy(rows, (r) => r.story_type)} />
        <RateTable
          title="القبول حسب فئة المصدر"
          rows={ratesBy(rows, (r) => (r.source_tier == null ? null : `فئة ${r.source_tier}`))}
        />
        <RateTable
          title="القبول حسب ترقية المصدر الأولي"
          rows={ratesBy(rows, (r) => r.esc_status)}
        />
        <RateTable
          title="القبول حسب صلة الخليج (GCC)"
          rows={ratesBy(rows, (r) => (r.gcc == null ? null : r.gcc ? "خليجي" : "غير خليجي"))}
        />
        <RateTable
          title="القبول: مرشّحات ESL مقابل غيرها"
          rows={ratesBy(rows, (r) => (r.esl_selected ? "عبر ESL" : "خارج ESL"))}
        />
        {/* Evidence Intelligence linkage — metadata only, nothing feeds back. */}
        <RateTable
          title="القبول حسب قوة الأدلة (Evidence)"
          rows={ratesBy(rows, (r) => EVIDENCE_STRENGTH_AR[r.ei_strength ?? ""] ?? null)}
        />
        <RateTable
          title="القبول حسب مراجعة الأقران"
          rows={ratesBy(rows, (r) => EVIDENCE_PEER_AR[r.ei_peer_review ?? ""] ?? null)}
        />
      </div>

      {/* Edit magnitudes at publish time */}
      <div className="grid gap-3 lg:grid-cols-2">
        {[
          { title: "تعديل العناوين قبل النشر", dist: titleDist },
          { title: "تعديل نص المقال قبل النشر", dist: bodyDist },
        ].map((sec) => (
          <div key={sec.title} className="rounded-2xl border border-line bg-white p-4">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-[15px] font-bold">{sec.title}</h2>
              <SampleChip n={published} />
            </div>
            <table className="w-full text-[13px]">
              <tbody>
                {(["none", "minor", "moderate", "major"] as const).map((m) => (
                  <tr key={m} className="border-t border-line first:border-t-0">
                    <td className="py-1.5 font-semibold">{MAGNITUDE_AR[m]}</td>
                    <td className="py-1.5 text-end font-sans text-gray">{sec.dist[m]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {/* Rejection reasons + corrections */}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl border border-line bg-white p-4">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-[15px] font-bold">أسباب الرفض الأكثر تكراراً</h2>
            <SampleChip n={rejected} />
          </div>
          {reasonCounts.size === 0 ? (
            <div className="text-[13px] text-gray">لا توجد حالات رفض مسجّلة بعد.</div>
          ) : (
            <table className="w-full text-[13px]">
              <tbody>
                {[...reasonCounts.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([code, n]) => (
                    <tr key={code} className="border-t border-line first:border-t-0">
                      <td className="py-1.5 font-semibold">{reasonLabel(code)}</td>
                      <td className="py-1.5 text-end font-sans text-gray">{n}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="rounded-2xl border border-line bg-white p-4">
          <h2 className="mb-2 text-[15px] font-bold">تصحيحات المحرر</h2>
          <ul className="space-y-1.5 text-[13px]">
            <li>
              تغيير القسم: <b className="font-sans">{corrections.length}</b>
              {corrections.length > 0 ? (
                <span className="text-gray">
                  {" "}
                  (آخرها: {corrections[0].category_before ?? "بدون"} ←{" "}
                  {corrections[0].category_after ?? "بدون"})
                </span>
              ) : null}
            </li>
            <li>
              تغيير المصدر: <b className="font-sans">{sourceChanges.length}</b>
            </li>
            <li>
              تعديل عنوان جوهري: <b className="font-sans">{titleEdits.length}</b>
            </li>
            <li>
              تغيير صورة الغلاف: <b className="font-sans">{rows.filter((r) => r.image_changed).length}</b>
            </li>
          </ul>
        </div>
      </div>

      <p className="text-[11.5px] leading-relaxed text-gray">
        ملاحظة منهجية: نسب القبول تُحسب من القرارات المحسومة فقط (منشور + مرفوض). مقادير التعديل
        تُقاس آلياً (وليس بنموذج لغوي) عند النشر مقارنةً بالنسخة الأصلية من الذكاء الاصطناعي —
        تغييرات علامات الترقيم والمسافات لا تُحتسب. أي مجموعة أقل من 5 عناصر تُعلَّم «عينة غير
        كافية» ولا يصح البناء عليها.
      </p>
    </div>
  );
}

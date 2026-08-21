import type { EvidenceIntelligenceRow } from "@/lib/admin-queries";

// Read-only Evidence Intelligence card for the Content editor (admin only,
// never reader-facing). Compact: a reviewer should grasp the evidence shape in
// seconds — type, peer review, subject, size, strength + its basis, and the one
// editorial caution. Unavailable/failed analyses render as a safe notice; they
// never block review or publishing.

const EVIDENCE_TYPE_AR: Record<string, string> = {
  systematic_review_meta_analysis: "مراجعة منهجية / تحليل تلوي (Meta-analysis)",
  randomized_controlled_trial: "تجربة معشاة منضبطة (RCT)",
  controlled_trial: "تجربة منضبطة",
  cohort: "دراسة أترابية رصدية (Cohort)",
  case_control: "دراسة حالات وشواهد (Case-control)",
  cross_sectional: "دراسة مقطعية",
  observational_other: "دراسة رصدية",
  case_series: "سلسلة حالات",
  preclinical_animal: "دراسة ما قبل سريرية (حيوانات)",
  laboratory_in_vitro: "دراسة مختبرية (In vitro)",
  modeling: "نمذجة / محاكاة",
  expert_guidance: "إرشادات خبراء / مؤسسية",
  regulatory_evidence: "دليل تنظيمي (جهة رقابية)",
  unknown: "غير محدد",
};

const PEER_REVIEW_AR: Record<string, string> = {
  peer_reviewed: "محكّمة (Peer-reviewed)",
  preprint: "مسودة بحثية (Preprint) — غير محكّمة بعد",
  conference_only: "مؤتمر فقط",
  institutional_guidance: "إرشادات مؤسسية",
  regulatory: "وثيقة تنظيمية",
  unknown: "غير محدد",
};

const SUBJECT_AR: Record<string, string> = {
  human_clinical: "بشري سريري",
  animal: "حيوانات (ما قبل سريري)",
  in_vitro: "مختبري (In vitro)",
  computational_modeling: "حاسوبي / نمذجة",
  mixed: "مختلط",
  not_applicable: "غير منطبق",
  unknown: "غير محدد",
};

const CLAIM_AR: Record<string, string> = {
  causal_supported: "علاقة سببية مدعومة",
  association_only: "ارتباط رصدي فقط — لا يثبت السببية",
  descriptive: "وصفي",
  mechanistic_preclinical: "آلية ما قبل سريرية — غير مثبتة في البشر",
  recommendation_guidance: "توصية / إرشاد",
  regulatory_fact: "واقعة تنظيمية",
  unknown: "غير محدد",
};

const INDEPENDENCE_AR: Record<string, string> = {
  independent: "دليل مستقل",
  company_only: "إعلان الشركة فقط — غير متحقق منه استقلاليًا",
  mixed: "مختلط",
  unknown: "غير محدد",
};

const STRENGTH_AR: Record<string, { label: string; color: string }> = {
  high: { label: "قوي", color: "var(--salma-teal)" },
  moderate: { label: "متوسط", color: "var(--salma-blue)" },
  limited: { label: "محدود", color: "#b7791f" },
  very_limited: { label: "محدود جدًا", color: "var(--salma-coral)" },
  unclear: { label: "غير واضح", color: "var(--salma-gray)" },
};

const TRISTATE_AR: Record<string, string> = { yes: "نعم", no: "لا", unknown: "غير محدد" };

type Card = {
  evidence_type?: string;
  peer_review_status?: string;
  subject_type?: string;
  population?: string | null;
  sample_size?: number | null;
  intervention?: string | null;
  comparator?: string | null;
  main_outcome?: string | null;
  claim_relationship?: string;
  evidence_strength?: string;
  strength_reasons?: string[];
  limitations?: string[];
  editorial_caution?: string | null;
  trial?: { phase: string | null; randomized: string; controlled: string; blinded: string } | null;
  review?: { included_studies: number | null; participants: number | null; consistency: string } | null;
  source_independence?: string;
  guidance_issuer?: string | null;
  regulatory_action?: string | null;
};

/** Provenance note: the card was derived from a fallback source because the
 *  identified editorial primary could not be fetched by the sanctioned
 *  extractor. Rendered on both complete and non-complete cards so the reviewer
 *  never assumes the analysis covered the inaccessible primary. */
function SourceProvenanceNote({ evidence }: { evidence: EvidenceIntelligenceRow }) {
  const s = evidence.evidence_source_status;
  if (s !== "discovery_source_fallback" && s !== "supporting_source_analyzed") return null;
  const analyzedLabel = s === "supporting_source_analyzed" ? "مصدر داعم" : "مصدر ثانوي (مصدر الاكتشاف)";
  return (
    <div className="mt-2 rounded-lg border border-line bg-cream px-3 py-2 text-[12px] leading-6 text-ink">
      <span className="font-semibold">مصدر التحليل:</span> {analyzedLabel}
      {evidence.analyzed_domain ? (
        <span dir="ltr" className="font-sans"> ({evidence.analyzed_domain})</span>
      ) : null}
      {evidence.editorial_primary_domain ? (
        <>
          {" — "}
          <span className="font-semibold">المصدر الأولي المحدد:</span>{" "}
          <span dir="ltr" className="font-sans">{evidence.editorial_primary_domain}</span>{" "}
          (تعذّر جلبه آليًا؛ البطاقة لا تعكس محتواه)
        </>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="text-[12.5px] leading-6 text-ink">
      <span className="font-semibold text-gray">{label}: </span>
      {value}
    </div>
  );
}

export function EvidencePanel({ evidence }: { evidence: EvidenceIntelligenceRow | null }) {
  if (!evidence) return null;

  const heading = (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <h2 className="text-[13.5px] font-bold text-ink">بطاقة الأدلة (Evidence)</h2>
      <span className="rounded-md bg-cream px-2 py-0.5 font-sans text-[10.5px] text-gray">
        تحليل آلي لمراجعة المحرر — لا يُعرض للقرّاء
      </span>
    </div>
  );

  if (evidence.analysis_status !== "complete" || !evidence.card) {
    const notice =
      evidence.analysis_status === "not_applicable"
        ? "تحليل الأدلة غير منطبق على هذا النوع من الأخبار."
        : evidence.analysis_status === "insufficient_source"
          ? "نص المصدر غير كافٍ لتحليل أدلة موثوق — راجع المصدر يدويًا."
          : "تعذّر تحليل الأدلة لهذه المادة — تبقى المراجعة البشرية والضوابط المعتادة سارية.";
    return (
      <div className="mb-5 max-w-2xl rounded-2xl border border-line bg-white p-4">
        {heading}
        <div className="text-[12.5px] text-gray">{notice}</div>
        <SourceProvenanceNote evidence={evidence} />
      </div>
    );
  }

  const card = evidence.card as Card;
  const strength = STRENGTH_AR[card.evidence_strength ?? "unclear"] ?? STRENGTH_AR.unclear;
  const trialBits: string[] = [];
  if (card.trial) {
    if (card.trial.phase) trialBits.push(`المرحلة ${card.trial.phase}`);
    if (card.trial.randomized !== "unknown") trialBits.push(`معشاة: ${TRISTATE_AR[card.trial.randomized]}`);
    if (card.trial.controlled !== "unknown") trialBits.push(`منضبطة: ${TRISTATE_AR[card.trial.controlled]}`);
    if (card.trial.blinded !== "unknown") trialBits.push(`معمّاة: ${TRISTATE_AR[card.trial.blinded]}`);
  }
  const reviewBits: string[] = [];
  if (card.review) {
    if (card.review.included_studies) reviewBits.push(`${card.review.included_studies} دراسة مشمولة`);
    if (card.review.participants) reviewBits.push(`≈${card.review.participants.toLocaleString("ar-EG")} مشارك`);
    if (card.review.consistency === "mixed") reviewBits.push("نتائج متباينة");
    if (card.review.consistency === "consistent") reviewBits.push("نتائج متسقة");
  }

  return (
    <div className="mb-5 max-w-2xl rounded-2xl border border-line bg-white p-4">
      {heading}

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-cream px-2 py-0.5 text-[11.5px] font-bold text-ink">
          {EVIDENCE_TYPE_AR[card.evidence_type ?? "unknown"] ?? card.evidence_type}
        </span>
        <span
          className="rounded-md px-2 py-0.5 text-[11px] font-bold text-white"
          style={{ background: strength.color }}
        >
          قوة الدليل: {strength.label}
        </span>
        {card.sample_size ? (
          <span className="rounded-md bg-cream px-2 py-0.5 font-sans text-[11px] text-ink" dir="ltr">
            n={card.sample_size.toLocaleString("en-US")}
          </span>
        ) : null}
      </div>

      <Row label="مراجعة الأقران" value={PEER_REVIEW_AR[card.peer_review_status ?? "unknown"]} />
      <Row label="نوع الأدلة" value={SUBJECT_AR[card.subject_type ?? "unknown"]} />
      <Row label="ما تدعمه النتيجة" value={CLAIM_AR[card.claim_relationship ?? "unknown"]} />
      {card.source_independence && card.source_independence !== "unknown" ? (
        <Row label="استقلالية المصدر" value={INDEPENDENCE_AR[card.source_independence]} />
      ) : null}
      {trialBits.length ? <Row label="التجربة" value={trialBits.join(" · ")} /> : null}
      {reviewBits.length ? <Row label="المراجعة المنهجية" value={reviewBits.join(" · ")} /> : null}
      <Row label="الفئة المدروسة" value={card.population} />
      <Row label="التدخل / التعرض" value={card.intervention} />
      <Row label="المقارنة" value={card.comparator} />
      <Row label="النتيجة الرئيسية" value={card.main_outcome} />
      <Row label="الجهة المصدرة" value={card.guidance_issuer} />
      <Row label="الإجراء التنظيمي" value={card.regulatory_action} />

      {card.strength_reasons?.length ? (
        <div className="mt-2 text-[12px] leading-6 text-gray">
          <span className="font-semibold">أساس التقييم:</span>{" "}
          {card.strength_reasons.join("؛ ")}
        </div>
      ) : null}

      {card.limitations?.length ? (
        <div className="mt-1 text-[12px] leading-6 text-gray">
          <span className="font-semibold">أبرز القيود:</span> {card.limitations.join("؛ ")}
        </div>
      ) : null}

      {card.editorial_caution ? (
        <div className="mt-2.5 rounded-lg border border-coral/40 bg-coral/5 px-3 py-2 text-[12.5px] font-semibold leading-6 text-ink">
          ⚠ {card.editorial_caution}
        </div>
      ) : null}

      <SourceProvenanceNote evidence={evidence} />

      {evidence.analyzed_url ? (
        <div className="mt-2 font-sans text-[10.5px] text-gray" dir="ltr">
          analyzed: {evidence.analyzed_domain ?? evidence.analyzed_url}
        </div>
      ) : null}
    </div>
  );
}

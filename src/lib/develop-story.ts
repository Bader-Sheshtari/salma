/**
 * After the News / Develop Story — shared admin-side catalog.
 *
 * Direction KEYS are the contract with supabase/functions/develop-story
 * (brief.ts DIRECTIONS) and the story_developments.direction DB CHECK —
 * change all three together.
 */

export type DevelopmentDirection =
  | "deeper_explainer"
  | "behind_the_news"
  | "evidence_analysis"
  | "context_background"
  | "reader_impact"
  | "follow_up"
  | "auto";

export const DEVELOP_DIRECTIONS: { key: DevelopmentDirection; label: string; description: string }[] = [
  { key: "deeper_explainer", label: "شرح أعمق للخبر", description: "ما الذي حدث فعلاً وكيف يفهمه القارئ فهماً حقيقياً." },
  { key: "behind_the_news", label: "ما وراء الخبر", description: "من أعلن ولماذا الآن، وما الذي لا يظهر في الصياغة الأصلية." },
  { key: "evidence_analysis", label: "تحليل الأدلة العلمية", description: "قوة الدليل، الارتباط مقابل السببية، وحدود الاستنتاج." },
  { key: "context_background", label: "السياق والخلفية", description: "ما سبق هذا الخبر وما الجديد فيه تحديداً." },
  { key: "reader_impact", label: "ماذا يعني هذا للقارئ؟", description: "من يتأثر عملياً وما الذي يتغيّر في حياته." },
  { key: "follow_up", label: "متابعة التطورات", description: "ما استجد وما المنتظر وما الذي نراقبه لاحقاً." },
  { key: "auto", label: "دع سلمى تقترح الاتجاه الأنسب", description: "يحلّل البحث القصة ويقترح أفضل زاوية للتطوير." },
];

export const directionLabel = (key: string | null): string =>
  DEVELOP_DIRECTIONS.find((d) => d.key === key)?.label ?? "—";

export const DEVELOP_PHASE_LABELS: Record<string, string> = {
  fetching_sources: "جاري جلب المصادر…",
  escalating: "جاري البحث عن المصدر الأولي…",
  analyzing_evidence: "جاري تحليل الأدلة…",
  building_brief: "جاري إعداد موجز البحث…",
  writing: "جاري إعداد المسودة…",
  saving: "جاري حفظ المسودة…",
};

export const DEVELOP_STATUS_LABELS: Record<string, string> = {
  researching: "جاري البحث",
  brief_ready: "موجز البحث جاهز للمراجعة",
  drafting: "جاري إعداد المسودة",
  draft_ready: "اكتملت المسودة",
  failed: "تعذر إكمال العملية",
  cancelled: "أُلغيت",
};

export const DEVELOP_ERROR_LABELS: Record<string, string> = {
  timeout: "توقفت العملية لفترة طويلة وتم إنهاؤها. يمكنك إعادة المحاولة.",
  research_model_failed: "تعذّر الوصول إلى نموذج البحث. أعد المحاولة بعد قليل.",
  research_error: "حدث خطأ أثناء البحث. أعد المحاولة.",
  brief_parse_failed: "أعاد النموذج موجزاً غير صالح. أعد المحاولة.",
  missing_brief: "موجز البحث غير متوفر — ابدأ البحث من جديد.",
  draft_rejected: "رُفضت المسودة في فحص الأمانة التحريرية — لم تُنشأ مادة غير موثوقة. يمكنك إعادة المحاولة أو تغيير الاتجاه.",
  draft_model_failed: "تعذّر الوصول إلى نموذج الكتابة. أعد المحاولة.",
  draft_error: "حدث خطأ أثناء إعداد المسودة. أعد المحاولة.",
  content_insert_failed: "اكتملت الكتابة لكن تعذّر حفظ المسودة. أعد المحاولة.",
  original_missing: "تعذّر العثور على المقال الأصلي.",
};

export type BriefAngle = {
  direction: Exclude<DevelopmentDirection, "auto">;
  title: string;
  rationale: string;
  recommended: boolean;
};

export type ResearchBrief = {
  story_summary: string;
  new_vs_known: string;
  evidence_says: string;
  key_numbers: { value: string; context: string }[];
  known: string[];
  unknown: string[];
  uncertain_claims: string[];
  suggested_angles: BriefAngle[];
};

export type BriefSource = {
  url: string;
  domain: string;
  role: "original_source" | "editorial_primary" | "supporting" | string;
  label: string;
  fetched: boolean;
  tier?: number | null;
};

export type DevelopmentJob = {
  id: string;
  original_content_id: string;
  requested_by: string | null;
  direction: string;
  draft_direction: string | null;
  editor_note: string | null;
  status: string;
  phase: string | null;
  error_category: string | null;
  error_message: string | null;
  research_brief: ResearchBrief | null;
  brief_sources: BriefSource[] | null;
  result_content_id: string | null;
  needs_human_review: boolean | null;
  editor_verdict: string | null;
  validation_warnings: string[] | null;
  cost: number;
  total_tokens: number;
  created_at: string;
  updated_at: string;
  research_completed_at: string | null;
  draft_completed_at: string | null;
};

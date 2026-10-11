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
  research_brief: ResearchBrief | BriefV2 | null;
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
  // V2 additions (null/undefined on V1 rows)
  research_prompt_version?: string | null;
  research_depth?: string | null;
  cluster_key?: string | null;
  thread_id?: string | null;
};

// ============================================================================
// Develop Story V2 — admin-side additions
// ============================================================================

export const DEVELOP_PHASE_LABELS_V2: Record<string, string> = {
  analyzing_context: "جاري مراجعة تغطية سلمى السابقة…",
  searching_literature: "جاري البحث في الأدبيات العلمية…",
  checking_trials: "جاري مراجعة سجل التجارب السريرية…",
};

export const EVIDENCE_CLASS_LABELS: Record<string, string> = {
  primary_study: "دراسة محكّمة",
  systematic_review: "مراجعة منهجية",
  trial_registry: "سجل تجارب سريرية",
  regulator: "جهة تنظيمية",
  public_health_agency: "هيئة صحة عامة",
  guideline_body: "جهة إرشادات طبية",
  gcc_ministry: "وزارة/هيئة صحية خليجية",
  institution: "مؤسسة طبية",
  wire: "وكالة أنباء",
  secondary_media: "مصدر إخباري",
  company_pr: "بيان شركة",
};

export type BriefClaim = { statement: string; source_ids: string[] };

export type BriefV2 = {
  story_summary: string;
  why_it_matters: string;
  previously_known: BriefClaim[];
  new_now: BriefClaim[];
  changed: BriefClaim[];
  timeline: { date: string; event: string; source_ids: string[]; confidence: string }[];
  scientific_evidence: { summary: string; source_ids: string[]; study_type: string }[];
  regulatory_evidence: { summary: string; source_ids: string[]; status_verbatim: string }[];
  key_numbers: { value: string; context: string; source_ids: string[] }[];
  conflicts: { topic: string; position_a: BriefClaim; position_b: BriefClaim }[];
  unknown: string[];
  unanswered_questions: string[];
  evidence_gaps: string[];
  suggested_angles: BriefAngle[];
};

export type DevelopmentEvidence = {
  id: number;
  kind: "web" | "pubmed" | "trial" | "regulator" | "salma_archive";
  url: string | null;
  title: string | null;
  publisher: string | null;
  published_date: string | null;
  source_class: string | null;
  tier: number | null;
  is_primary: boolean;
  doi: string | null;
  pmid: string | null;
  nct_id: string | null;
  fetched: boolean;
  confidence: string | null;
};

export const isBriefV2 = (b: unknown): b is BriefV2 =>
  Boolean(b && typeof b === "object" && "new_now" in (b as Record<string, unknown>));

/** Advisory chip: new article vs follow-up vs nothing new (never blocking). */
export function adviceForBrief(brief: BriefV2, hasPrior: boolean): { key: string; label: string } {
  if (brief.new_now.length === 0 && hasPrior) {
    return { key: "nothing_new", label: "لا جديد جوهرياً مقارنة بتغطية سلمى السابقة" };
  }
  if (!hasPrior || brief.new_now.length >= 3 || brief.changed.length >= 2) {
    return { key: "new_article", label: "تطور جوهري — يصلح لمادة جديدة" };
  }
  return { key: "follow_up", label: "الأنسب معالجته كمتابعة لتغطية سابقة" };
}

export type DevelopOrigin =
  | { type: "article"; id: string }
  | { type: "cluster"; key: string; title?: string | null };

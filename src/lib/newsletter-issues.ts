// Newsletter Curation Engine V1 — shared types + Arabic labels for issues.
//
// The vocabulary (section keys, reason badges, source types) is produced by
// the newsletter-curate edge function and stored in newsletter_items; these
// maps translate stored keys for display and degrade to the raw key for
// anything unknown.

export type NewsletterIssueStatus = "draft" | "curated" | "ready" | "archived";

export type NewsletterIssue = {
  id: string;
  title: string | null;
  intro_ar: string | null;
  status: NewsletterIssueStatus;
  range_start: string;
  range_end: string;
  section_titles: Record<string, string> | null;
  curation_meta: {
    curated_at?: string;
    candidates?: { articles: number; external: number; transfers: number; after_dedupe: number };
    picks?: number;
    empty_sections?: string[];
    copy_mode?: "llm" | "fallback";
    zero_result_search_terms?: string[];
    usage?: { calls: number; cost: number };
  } | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type NewsletterItem = {
  id: string;
  issue_id: string;
  item_type: "article" | "external" | "transfer";
  content_id: string | null;
  transfer_id: string | null;
  external_url: string | null;
  external_source_name: string | null;
  external_source_domain: string | null;
  external_author: string | null;
  external_published_at: string | null;
  external_source_type: string | null;
  verification_status: "verified" | "needs_check";
  /** V1.1 §5: located primary/official source (authority + verification basis) */
  primary_url: string | null;
  primary_source_name: string | null;
  section: string;
  position: number;
  newsletter_headline: string | null;
  teaser: string | null;
  short_analysis: string | null;
  why_ar: string | null;
  is_opinion: boolean;
  reasons: string[];
  score: number | null;
  score_parts: Record<string, number> | null;
  editor_state: "suggested" | "accepted" | "rejected" | "manual";
  created_at: string;
  updated_at: string;
};

export const ISSUE_STATUS_AR: Record<NewsletterIssueStatus, string> = {
  draft: "مسودة",
  curated: "مُقترح",
  ready: "جاهز",
  archived: "مؤرشف",
};

export const SECTION_ORDER = [
  "lead", "top_missed", "economy", "gcc", "research", "qol",
  "trend", "expert", "transfers", "quick",
] as const;

export const SECTION_LABELS_AR: Record<string, string> = {
  lead: "الخبر الأبرز",
  top_missed: "أهم ما فاتك",
  economy: "اقتصاد الصحة",
  gcc: "من الخليج",
  research: "البحث الذي يستحق الانتباه",
  qol: "جودة الحياة",
  trend: "ماذا يتحدث عنه العالم؟",
  expert: "مقال يستحق القراءة",
  transfers: "انتقالات",
  quick: "باختصار",
};

export const REASON_LABELS_AR: Record<string, string> = {
  official_source: "مصدر رسمي",
  primary_research: "دراسة أصلية",
  research: "بحث علمي",
  high_engagement: "مرتفع التفاعل",
  global_trend: "ترند عالمي موثوق",
  econ_important: "مهم اقتصادياً",
  gcc_strategic: "تطور مهم في الخليج",
  expert_article: "مقال خبير",
  qol: "جودة حياة",
  transfer: "انتقال طبيب",
  after_news: "ما بعد الخبر",
  search_demand: "مطلوب في البحث",
};

/**
 * V1.1 §12: only MEANINGFUL badges in the primary visual hierarchy, in this
 * priority order, capped by the card. Unknown/legacy keys are simply hidden.
 */
export const DISPLAY_REASONS: readonly string[] = [
  "official_source",
  "primary_research",
  "gcc_strategic",
  "econ_important",
  "global_trend",
  "high_engagement",
  "search_demand",
  "after_news",
];

export function displayReasons(reasons: string[], cap = 3): string[] {
  return DISPLAY_REASONS.filter((r) => reasons.includes(r)).slice(0, cap);
}

/** V1.1 §11: honest quality categories instead of false-precision percentages. */
export type ScoreBand = "strong" | "good" | "weak";

export function scoreBand(score: number | null): ScoreBand | null {
  if (score === null) return null;
  if (score >= 0.62) return "strong";
  if (score >= 0.48) return "good";
  return "weak";
}

export const BAND_LABEL_AR: Record<ScoreBand, string> = {
  strong: "قوي",
  good: "جيد",
  weak: "يحتاج مراجعة",
};

export const BAND_CLASS: Record<ScoreBand, string> = {
  strong: "border-emerald-200 bg-emerald-50 text-emerald-700",
  good: "border-sky-200 bg-sky-50 text-sky-700",
  weak: "border-amber-200 bg-amber-50 text-amber-700",
};

/** Editor-only pool (§10) — never rendered in the reader-facing issue. */
export const OPPORTUNITIES_SECTION = "opportunities";
export const OPPORTUNITIES_LABEL_AR = "فرص تحريرية — مواد تحتاج تحققاً أو تطويراً";
export const NO_LEAD_MESSAGE_AR = "لا يوجد خبر رئيسي قوي بما يكفي في هذه الفترة.";

export const SOURCE_TYPE_AR: Record<string, string> = {
  official: "جهة رسمية",
  research: "بحث علمي",
  institution: "مؤسسة",
  media: "صحافة",
  expert: "خبير",
  other: "أخرى",
};

export function sectionLabel(key: string, overrides?: Record<string, string> | null): string {
  return overrides?.[key] ?? SECTION_LABELS_AR[key] ?? key;
}

export function reasonLabel(key: string): string {
  return REASON_LABELS_AR[key] ?? key;
}

/** Range presets offered on issue creation (§4). */
export const RANGE_PRESETS = [
  { key: "today", label: "اليوم", days: 1 },
  { key: "3d", label: "آخر ٣ أيام", days: 3 },
  { key: "7d", label: "آخر ٧ أيام (افتراضي)", days: 7 },
] as const;

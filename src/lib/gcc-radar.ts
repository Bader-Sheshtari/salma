// GCC Radar V1 — shared types + Arabic labels for the admin UI.
//
// The vocabulary (topic/signal/org keys) is produced by the deterministic
// classifier in supabase/functions/radar-gcc/gccIntel.ts and stored in
// radar_gcc_intel; these maps only translate stored keys for display, so an
// unknown key degrades to showing the raw key, never breaking the page.

export type GccIntel = {
  radar_article_id: string;
  source_id: string | null;
  country_code: string;
  topics: string[];
  signals: string[];
  orgs: string[];
  authority_tier: number;
  strategic: boolean;
  strategic_reasons: string[];
  gcc_score: number;
  why_ar: string | null;
  created_at: string;
};

export type GccSource = {
  id: string;
  name: string;
  name_ar: string | null;
  domain: string;
  country_code: string;
  source_class: string;
  authority_tier: number;
  language: string;
  fetch_method: string;
  fetch_url: string;
  healthcare_only: boolean;
  active: boolean;
  notes: string | null;
  last_fetch_at: string | null;
  last_fetch_ok: boolean | null;
  last_error: string | null;
  last_item_at: string | null;
  consecutive_failures: number;
};

export type GccRun = {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  sources_attempted: number;
  sources_ok: number;
  returned_count: number;
  inserted_count: number;
  duplicate_count: number;
  filtered_count: number;
  backfill_skipped: number;
  per_source: { domain: string; ok: boolean; returned: number; inserted: number; error?: string }[] | null;
  error: string | null;
};

export const GCC_COUNTRY_AR: Record<string, string> = {
  KW: "الكويت",
  SA: "السعودية",
  AE: "الإمارات",
  QA: "قطر",
  BH: "البحرين",
  OM: "عُمان",
};

export const GCC_COUNTRY_FLAG: Record<string, string> = {
  KW: "🇰🇼", SA: "🇸🇦", AE: "🇦🇪", QA: "🇶🇦", BH: "🇧🇭", OM: "🇴🇲",
};

export const GCC_TOPIC_AR: Record<string, string> = {
  regulation: "تنظيم ورقابة",
  insurance: "التأمين الصحي",
  digital_health: "الصحة الرقمية",
  pharma: "الأدوية",
  medtech: "الأجهزة الطبية",
  hospitals: "المستشفيات والرعاية",
  investment: "استثمار واستحواذ",
  partnerships: "شراكات واتفاقيات",
  public_health: "الصحة العامة",
  workforce: "الكوادر الصحية",
  infrastructure: "بنية تحتية صحية",
  healthcare_finance: "تمويل القطاع الصحي",
};

export const GCC_SIGNAL_AR: Record<string, string> = {
  regulatory_approval: "اعتماد أو موافقة رسمية",
  recall_or_suspension: "سحب أو إيقاف",
  mandatory_directive: "تعميم أو قرار مُلزم",
  license_action: "إجراء ترخيص",
  tender_award: "مناقصة أو ترسية",
  acquisition: "استحواذ أو اندماج",
  funding_round: "جولة تمويل",
  facility_launch: "افتتاح أو إطلاق",
  expansion: "توسعة",
  partnership_agreement: "شراكة أو اتفاقية",
  penalty: "مخالفة أو غرامة",
  policy_report: "تقرير أو مؤشرات",
  official_statement: "تصريح رسمي",
};

export const GCC_CLASS_AR: Record<string, string> = {
  government: "جهة حكومية",
  regulator: "جهة تنظيمية",
  provider: "مزوّد رعاية",
  insurance: "تأمين صحي",
  digital_health: "صحة رقمية",
  pharma_medtech: "أدوية وأجهزة",
  investment: "استثمار",
  wire: "وكالة أنباء",
  media: "صحافة",
};

export function gccAuthorityLabel(tier: number): string {
  if (tier === 1) return "مصدر رسمي";
  if (tier === 2) return "وكالة / مؤسسة";
  if (tier === 3) return "صحافة موثوقة";
  return "ناقل / مجمِّع";
}

export function gccTopicLabel(key: string): string {
  return GCC_TOPIC_AR[key] ?? key;
}

export function gccSignalLabel(key: string): string {
  return GCC_SIGNAL_AR[key] ?? key;
}

// Fast News Radar — SHADOW MODE shared types, labels, and thresholds.
//
// Pure module (no server-only import) so both the server query layer and the
// client Radar Inbox component can use the types and label maps. Radar is an
// independent evaluation of shadow discoveries; nothing here writes to or
// couples with the Salma content pipeline.

export type RadarPriorityLevel = "very_important" | "important" | "low";
export type RadarDuplicateStatus = "new" | "already_in_salma" | "possible_duplicate";

/** A row of radar_shadow_articles plus the nullable ranking/dedupe fields.
 *  Any ranking field may be null → the row is UNRANKED (not yet evaluated). */
export type RadarArticle = {
  id: string;
  provider: string;
  provider_uri: string;
  event_uri: string | null;
  title: string | null;
  url: string | null;
  source_title: string | null;
  source_domain: string | null;
  language: string | null;
  country: string | null;
  published_at: string | null;
  provider_seen_at: string | null;
  first_seen_at: string;
  run_id: string | null;
  priority_score: number | null;
  priority_level: RadarPriorityLevel | null;
  expected_category_slug: string | null;
  duplicate_status: RadarDuplicateStatus | null;
  matched_content_id: string | null;
  ranked_at: string | null;
};

// --- Score → level thresholds (single tuning surface; easy to change later) --
// A hidden 0..100 internal score maps to the three user-facing levels.
export const RADAR_SCORE_VERY_IMPORTANT = 75; // >= 75 → very important
export const RADAR_SCORE_IMPORTANT = 50; // 50..74 → important; below → low

export function levelFromScore(score: number): RadarPriorityLevel {
  if (score >= RADAR_SCORE_VERY_IMPORTANT) return "very_important";
  if (score >= RADAR_SCORE_IMPORTANT) return "important";
  return "low";
}

// --- Arabic labels ----------------------------------------------------------
export const PRIORITY_LABEL: Record<RadarPriorityLevel, string> = {
  very_important: "🔴 مهم جدًا",
  important: "🟡 مهم",
  low: "⚪ منخفض الأهمية",
};

/** Label for an UNRANKED row (priority_level is null). */
export const UNRANKED_LABEL = "◻︎ غير مصنّف";

export const DUPLICATE_LABEL: Record<RadarDuplicateStatus, string> = {
  new: "جديد",
  already_in_salma: "موجود في سلمى",
  possible_duplicate: "محتمل أنه مكرر",
};

// ISO-639-3 → Arabic language name for the codes Event Registry returns.
export const LANG_LABEL: Record<string, string> = {
  eng: "الإنجليزية", ara: "العربية", zho: "الصينية", deu: "الألمانية",
  spa: "الإسبانية", fas: "الفارسية", ind: "الإندونيسية", pol: "البولندية",
  rus: "الروسية", ell: "اليونانية", por: "البرتغالية", tur: "التركية",
  ita: "الإيطالية", heb: "العبرية", est: "الإستونية", kor: "الكورية",
  fra: "الفرنسية", cat: "الكتالونية", srp: "الصربية", ron: "الرومانية",
  hrv: "الكرواتية", ukr: "الأوكرانية", hin: "الهندية", jpn: "اليابانية",
  vie: "الفيتنامية",
};

export function langLabel(code: string | null): string {
  if (!code) return "—";
  return LANG_LABEL[code] ?? code;
}

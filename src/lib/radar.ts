// Fast News Radar — SHADOW MODE shared types, labels, and thresholds.
//
// Pure module (no server-only import) so both the server query layer and the
// client Radar Inbox component can use the types and label maps. Radar is an
// independent evaluation of shadow discoveries; nothing here writes to or
// couples with the Salma content pipeline.

export type RadarPriorityLevel = "very_important" | "important" | "low";
export type RadarDuplicateStatus = "new" | "already_in_salma" | "possible_duplicate";
// One-click publish latch: null (never attempted), 'processing' (a publish job is
// running — blocks a second start), 'published' (linked to Content), or
// 'needs_review' (a prior attempt stopped safely at pending / failed — retryable).
// Persisted one-click publish state. `draft` means the preparation pipeline
// (تحرير في سلمى, or a direct publish that had no cover image) created a real
// Content row kept `pending` and linked via published_content_id, ready for human
// editing — terminal for the pipeline, never auto-restarted. `needs_review` means
// a Content row WAS created and is awaiting human review (published_content_id is
// set). `failed` means the pipeline stopped BEFORE any Content row was created
// (source retrieval failure, or Writer/Editor/Fidelity/validation rejection) —
// there is nothing in Content to review; the card shows an editorial-failure
// state. For a `draft` row, publish_error === 'needs_cover' flags a missing cover.
export type RadarPublishStatus = "processing" | "published" | "needs_review" | "failed" | "draft";

/** A row of radar_shadow_articles plus the nullable ranking/dedupe fields.
 *  Any ranking field may be null → the row is UNRANKED (not yet evaluated). */
export type RadarArticle = {
  id: string;
  provider: string;
  provider_uri: string;
  event_uri: string | null;
  title: string | null;
  // Faithful Arabic translation of the ORIGINAL headline (or the Arabic original
  // verbatim). Reading aid only — never Writer input. Null until translated.
  title_ar: string | null;
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
  // One-click publish state (see RadarPublishStatus). published_content_id is the
  // soft link to the created content row; publish_error carries the last failure.
  publish_status: RadarPublishStatus | null;
  published_content_id: string | null;
  publish_error: string | null;
  publish_authorized_at: string | null;
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

// --- Country → Arabic name + flag -------------------------------------------
// Event Registry stores the country as an English name (e.g. "United States").
// Map it to an Arabic name and a flag emoji for the Radar card. Unknown values
// are shown verbatim WITHOUT a flag (never invent a country/flag).
type CountryDisplay = { ar: string; flag: string };
const COUNTRY_LABEL: Record<string, CountryDisplay> = {
  "United States": { ar: "الولايات المتحدة", flag: "🇺🇸" },
  "United Kingdom": { ar: "المملكة المتحدة", flag: "🇬🇧" },
  "Spain": { ar: "إسبانيا", flag: "🇪🇸" },
  "India": { ar: "الهند", flag: "🇮🇳" },
  "Germany": { ar: "ألمانيا", flag: "🇩🇪" },
  "Egypt": { ar: "مصر", flag: "🇪🇬" },
  "Indonesia": { ar: "إندونيسيا", flag: "🇮🇩" },
  "Brazil": { ar: "البرازيل", flag: "🇧🇷" },
  "Poland": { ar: "بولندا", flag: "🇵🇱" },
  "Turkey": { ar: "تركيا", flag: "🇹🇷" },
  "Türkiye": { ar: "تركيا", flag: "🇹🇷" },
  "Argentina": { ar: "الأرجنتين", flag: "🇦🇷" },
  "Greece": { ar: "اليونان", flag: "🇬🇷" },
  "Russia": { ar: "روسيا", flag: "🇷🇺" },
  "Italy": { ar: "إيطاليا", flag: "🇮🇹" },
  "France": { ar: "فرنسا", flag: "🇫🇷" },
  "Serbia": { ar: "صربيا", flag: "🇷🇸" },
  "Pakistan": { ar: "باكستان", flag: "🇵🇰" },
  "Taiwan": { ar: "تايوان", flag: "🇹🇼" },
  "Ireland": { ar: "أيرلندا", flag: "🇮🇪" },
  "Gabon": { ar: "الغابون", flag: "🇬🇦" },
  "Portugal": { ar: "البرتغال", flag: "🇵🇹" },
  "Yemen": { ar: "اليمن", flag: "🇾🇪" },
  "Ukraine": { ar: "أوكرانيا", flag: "🇺🇦" },
  "Cuba": { ar: "كوبا", flag: "🇨🇺" },
  "Croatia": { ar: "كرواتيا", flag: "🇭🇷" },
  "Morocco": { ar: "المغرب", flag: "🇲🇦" },
  "Algeria": { ar: "الجزائر", flag: "🇩🇿" },
  "Philippines": { ar: "الفلبين", flag: "🇵🇭" },
  "Romania": { ar: "رومانيا", flag: "🇷🇴" },
  "Slovenia": { ar: "سلوفينيا", flag: "🇸🇮" },
  "Colombia": { ar: "كولومبيا", flag: "🇨🇴" },
  "Venezuela": { ar: "فنزويلا", flag: "🇻🇪" },
  "South Korea": { ar: "كوريا الجنوبية", flag: "🇰🇷" },
  "North Korea": { ar: "كوريا الشمالية", flag: "🇰🇵" },
  "Iran": { ar: "إيران", flag: "🇮🇷" },
  "Belgium": { ar: "بلجيكا", flag: "🇧🇪" },
  "Malawi": { ar: "مالاوي", flag: "🇲🇼" },
  "Austria": { ar: "النمسا", flag: "🇦🇹" },
  "Bosnia and Herzegovina": { ar: "البوسنة والهرسك", flag: "🇧🇦" },
  "Norway": { ar: "النرويج", flag: "🇳🇴" },
  "Vietnam": { ar: "فيتنام", flag: "🇻🇳" },
  "Kuwait": { ar: "الكويت", flag: "🇰🇼" },
  "Saudi Arabia": { ar: "السعودية", flag: "🇸🇦" },
  "United Arab Emirates": { ar: "الإمارات", flag: "🇦🇪" },
  "Qatar": { ar: "قطر", flag: "🇶🇦" },
  "Bahrain": { ar: "البحرين", flag: "🇧🇭" },
  "Oman": { ar: "عُمان", flag: "🇴🇲" },
  "Jordan": { ar: "الأردن", flag: "🇯🇴" },
  "Lebanon": { ar: "لبنان", flag: "🇱🇧" },
  "Syria": { ar: "سوريا", flag: "🇸🇾" },
  "Iraq": { ar: "العراق", flag: "🇮🇶" },
  "Palestine": { ar: "فلسطين", flag: "🇵🇸" },
  "Sudan": { ar: "السودان", flag: "🇸🇩" },
  "Tunisia": { ar: "تونس", flag: "🇹🇳" },
  "Libya": { ar: "ليبيا", flag: "🇱🇾" },
  "China": { ar: "الصين", flag: "🇨🇳" },
  "Japan": { ar: "اليابان", flag: "🇯🇵" },
  "Canada": { ar: "كندا", flag: "🇨🇦" },
  "Australia": { ar: "أستراليا", flag: "🇦🇺" },
  "Netherlands": { ar: "هولندا", flag: "🇳🇱" },
  "Switzerland": { ar: "سويسرا", flag: "🇨🇭" },
  "Sweden": { ar: "السويد", flag: "🇸🇪" },
  "Denmark": { ar: "الدنمارك", flag: "🇩🇰" },
  "Finland": { ar: "فنلندا", flag: "🇫🇮" },
  "Mexico": { ar: "المكسيك", flag: "🇲🇽" },
  "Chile": { ar: "تشيلي", flag: "🇨🇱" },
  "Israel": { ar: "إسرائيل", flag: "🇮🇱" },
  "Nigeria": { ar: "نيجيريا", flag: "🇳🇬" },
  "South Africa": { ar: "جنوب أفريقيا", flag: "🇿🇦" },
  "Kenya": { ar: "كينيا", flag: "🇰🇪" },
  "Ethiopia": { ar: "إثيوبيا", flag: "🇪🇹" },
  "Thailand": { ar: "تايلاند", flag: "🇹🇭" },
  "Malaysia": { ar: "ماليزيا", flag: "🇲🇾" },
  "Singapore": { ar: "سنغافورة", flag: "🇸🇬" },
  "Bangladesh": { ar: "بنغلاديش", flag: "🇧🇩" },
  "Sri Lanka": { ar: "سريلانكا", flag: "🇱🇰" },
  "New Zealand": { ar: "نيوزيلندا", flag: "🇳🇿" },
  "Hungary": { ar: "المجر", flag: "🇭🇺" },
  "Czechia": { ar: "التشيك", flag: "🇨🇿" },
  "Czech Republic": { ar: "التشيك", flag: "🇨🇿" },
  "Slovakia": { ar: "سلوفاكيا", flag: "🇸🇰" },
  "Bulgaria": { ar: "بلغاريا", flag: "🇧🇬" },
  "Belarus": { ar: "بيلاروسيا", flag: "🇧🇾" },
};

/** Country display for the Radar card: Arabic name + flag when known, else the
 *  original value with no flag. Returns null when country is missing. */
export function countryDisplay(country: string | null): { label: string; flag: string | null } | null {
  const c = (country ?? "").trim();
  if (!c) return null;
  const known = COUNTRY_LABEL[c];
  if (known) return { label: known.ar, flag: known.flag };
  return { label: c, flag: null };
}

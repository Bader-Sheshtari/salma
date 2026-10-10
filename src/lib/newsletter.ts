/**
 * Newsletter + optional audience survey — single source of truth for the
 * option catalogs, consent version, and signup sources.
 *
 * Survey answers are stored in the database as option KEYS (text / text[]),
 * deliberately without DB-level CHECKs on the multi-select lists: to add,
 * remove, or reword an option later, edit this file only — no migration.
 * The server action validates submissions against these catalogs.
 */

/** Bump when the consent wording near the signup form materially changes. */
export const NEWSLETTER_CONSENT_VERSION = "2026-10-10.v1";

/** Where a subscription originated. Extend here when new placements ship. */
export const SIGNUP_SOURCES = ["homepage", "article", "newsletter_page", "category"] as const;
export type SignupSource = (typeof SIGNUP_SOURCES)[number];

export type Option = { key: string; label: string };

/** هل أنت طبيب أو تعمل في القطاع الصحي؟ (single choice) */
export const PROFESSION_OPTIONS: Option[] = [
  { key: "doctor", label: "طبيب" },
  { key: "health_sector", label: "أعمل في قطاع صحي آخر" },
  { key: "not_health", label: "لا" },
  { key: "prefer_not_say", label: "أفضل عدم الإجابة" },
];

/** ليش تهتم بالمحتوى الصحي والطبي؟ (multi) */
export const REASON_OPTIONS: Option[] = [
  { key: "self_family_health", label: "لمتابعة صحتي وصحة أسرتي" },
  { key: "work_speciality", label: "بحكم عملي أو تخصصي" },
  { key: "research_updates", label: "لمتابعة الأبحاث والمستجدات الطبية" },
  { key: "health_sector_watch", label: "لمتابعة القطاع الصحي" },
  { key: "general_knowledge", label: "للاطلاع والمعرفة العامة" },
  { key: "other", label: "سبب آخر" },
];

/** ما المواضيع التي تهمك أكثر؟ (multi) */
export const TOPIC_OPTIONS: Option[] = [
  { key: "public_health", label: "الصحة العامة" },
  { key: "womens_health", label: "صحة المرأة" },
  { key: "child_health", label: "صحة الطفل" },
  { key: "mental_health", label: "الصحة النفسية" },
  { key: "nutrition_lifestyle", label: "التغذية ونمط الحياة" },
  { key: "chronic_diseases", label: "الأمراض المزمنة" },
  { key: "pharma", label: "الأدوية والصيدلة" },
  { key: "research_studies", label: "الأبحاث العلمية والدراسات الطبية" },
  { key: "doctor_transfers", label: "انتقالات الأطباء" },
  { key: "doctors_hospitals", label: "أخبار الأطباء والمستشفيات" },
  { key: "health_sector", label: "القطاع الصحي" },
  { key: "kuwait_health", label: "أخبار الصحة في الكويت" },
  { key: "gcc_health", label: "أخبار الصحة في الخليج" },
  { key: "dawi_news", label: "أخبار داوي" },
];

/** أي نوع من المحتوى تفضله؟ (multi) */
export const CONTENT_OPTIONS: Option[] = [
  { key: "quick_news", label: "خبر سريع ومختصر" },
  { key: "behind_the_news", label: "شرح ما وراء الخبر" },
  { key: "research", label: "أبحاث ودراسات" },
  { key: "health_tips", label: "نصائح ومعلومات صحية" },
  { key: "doctors_hospitals", label: "أخبار الأطباء والمستشفيات" },
  { key: "digest", label: "ملخص لأهم الأخبار" },
];

/** كم مرة تفضل أن توصلك النشرة؟ (single choice — informational only for now) */
export const FREQUENCY_OPTIONS: Option[] = [
  { key: "daily", label: "يومياً" },
  { key: "weekly", label: "أسبوعياً" },
  { key: "top_news_only", label: "أهم الأخبار فقط" },
  { key: "undecided", label: "لم أحدد بعد" },
];

/** Stored nationality value when the subscriber declines to answer. */
export const PREFER_NOT_SAY = "prefer_not_say";

/**
 * ISO 3166-1 alpha-2 codes. Arabic display names come from
 * Intl.DisplayNames("ar", { type: "region" }) so no name list is maintained
 * here. GCC countries are pinned to the top of selectors (Kuwait first) but
 * every country remains selectable.
 */
export const GCC_CODES = ["KW", "SA", "AE", "QA", "BH", "OM"] as const;

export const COUNTRY_CODES: string[] = [
  "AD","AE","AF","AG","AI","AL","AM","AO","AR","AS","AT","AU","AW","AX","AZ",
  "BA","BB","BD","BE","BF","BG","BH","BI","BJ","BM","BN","BO","BR","BS","BT","BW","BY","BZ",
  "CA","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CU","CV","CW","CY","CZ",
  "DE","DJ","DK","DM","DO","DZ","EC","EE","EG","ER","ES","ET","FI","FJ","FK","FM","FO","FR",
  "GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GT","GU","GW","GY",
  "HK","HN","HR","HT","HU","ID","IE","IL","IM","IN","IQ","IR","IS","IT","JE","JM","JO","JP",
  "KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ","LA","LB","LC","LI","LK","LR","LS",
  "LT","LU","LV","LY","MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ",
  "MR","MS","MT","MU","MV","MW","MX","MY","MZ","NA","NC","NE","NG","NI","NL","NO","NP","NR",
  "NU","NZ","OM","PA","PE","PF","PG","PH","PK","PL","PM","PR","PS","PT","PW","PY","QA","RE",
  "RO","RS","RU","RW","SA","SB","SC","SD","SE","SG","SI","SK","SL","SM","SN","SO","SR","SS",
  "ST","SV","SX","SY","SZ","TC","TD","TG","TH","TJ","TL","TM","TN","TO","TR","TT","TV","TW",
  "TZ","UA","UG","US","UY","UZ","VA","VC","VE","VG","VI","VN","VU","WF","WS","YE","ZA","ZM","ZW",
];

const optionKeys = (opts: Option[]) => new Set(opts.map((o) => o.key));
const REASON_KEYS = optionKeys(REASON_OPTIONS);
const TOPIC_KEYS = optionKeys(TOPIC_OPTIONS);
const CONTENT_KEYS = optionKeys(CONTENT_OPTIONS);
const PROFESSION_KEYS = optionKeys(PROFESSION_OPTIONS);
const FREQUENCY_KEYS = optionKeys(FREQUENCY_OPTIONS);
const COUNTRY_SET = new Set(COUNTRY_CODES);

/** Keep only known option keys (drops anything a tampered client sends). */
export function filterMulti(values: string[], catalog: "reasons" | "topics" | "content"): string[] {
  const keys = catalog === "reasons" ? REASON_KEYS : catalog === "topics" ? TOPIC_KEYS : CONTENT_KEYS;
  return [...new Set(values)].filter((v) => keys.has(v));
}

export function validProfession(v: string): boolean {
  return PROFESSION_KEYS.has(v);
}
export function validFrequency(v: string): boolean {
  return FREQUENCY_KEYS.has(v);
}
export function validCountry(v: string): boolean {
  return COUNTRY_SET.has(v);
}
export function validNationality(v: string): boolean {
  return v === PREFER_NOT_SAY || COUNTRY_SET.has(v);
}
export function validSource(v: string): v is SignupSource {
  return (SIGNUP_SOURCES as readonly string[]).includes(v);
}

export const labelOf = (opts: Option[], key: string | null): string =>
  (key && opts.find((o) => o.key === key)?.label) || "—";

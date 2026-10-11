/**
 * Reader Analytics V1 — shared event vocabulary + traffic-source
 * classification. Client-safe (no secrets, no server imports).
 *
 * Privacy design (see also the /api/track route and the privacy policy):
 * events are anonymous; the only client-side state is a random per-tab
 * session id in sessionStorage used to deduplicate refreshes. No cookies,
 * no IPs, no identity, no fingerprinting, nothing cross-session.
 */

export const READER_EVENTS = ["view", "engaged", "completed"] as const;
export type ReaderEvent = (typeof READER_EVENTS)[number];

export const TRAFFIC_SOURCES = [
  "direct",
  "search_engine",
  "instagram",
  "whatsapp",
  "x",
  "facebook",
  "telegram",
  "internal",
  "other",
] as const;
export type TrafficSource = (typeof TRAFFIC_SOURCES)[number];

export const INTERNAL_SOURCES = ["homepage", "category", "search", "related", "other"] as const;
export type InternalSource = (typeof INTERNAL_SOURCES)[number];

const SEARCH_ENGINES = /(^|\.)google\.|(^|\.)bing\.com|duckduckgo\.com|search\.yahoo\.|yandex\./;

/**
 * Classify a pageview's origin from document.referrer + utm_source.
 * External referrers keep only their HOSTNAME (never a path); internal
 * referrers map to the Salma surface the reader came from — which is how we
 * measure whether Search→Article and Related→Article actually work.
 */
export function classifyTraffic(
  referrer: string,
  ownHost: string,
  utmSource: string | null,
): { source: TrafficSource; internal: InternalSource | null; referrerDomain: string | null } {
  const utm = (utmSource ?? "").trim().toLowerCase();
  if (utm) {
    const mapped: TrafficSource | null =
      utm.includes("instagram") ? "instagram"
      : utm.includes("whatsapp") ? "whatsapp"
      : utm === "x" || utm.includes("twitter") ? "x"
      : utm.includes("facebook") || utm === "fb" ? "facebook"
      : utm.includes("telegram") ? "telegram"
      : null;
    if (mapped) return { source: mapped, internal: null, referrerDomain: null };
  }

  if (!referrer) return { source: "direct", internal: null, referrerDomain: null };
  let host = "";
  let path = "";
  try {
    const u = new URL(referrer);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return { source: "direct", internal: null, referrerDomain: null };
  }

  if (host === ownHost.toLowerCase()) {
    const internal: InternalSource =
      path === "/" ? "homepage"
      : path.startsWith("/category") ? "category"
      : path.startsWith("/search") ? "search"
      : path.startsWith("/article") || path.startsWith("/video") ? "related"
      : "other";
    return { source: "internal", internal, referrerDomain: null };
  }

  const source: TrafficSource =
    SEARCH_ENGINES.test(host) ? "search_engine"
    : host.includes("instagram.") ? "instagram"
    : host.includes("whatsapp.") || host === "wa.me" ? "whatsapp"
    : host === "t.co" || host.includes("twitter.") || host === "x.com" ? "x"
    : host.includes("facebook.") || host === "fb.me" || host === "m.facebook.com" ? "facebook"
    : host === "t.me" || host.includes("telegram.") ? "telegram"
    : "other";
  return { source, internal: null, referrerDomain: host.slice(0, 100) };
}

export const SOURCE_LABELS_AR: Record<string, string> = {
  direct: "مباشر",
  search_engine: "محركات البحث",
  instagram: "إنستغرام",
  whatsapp: "واتساب",
  x: "إكس (تويتر)",
  facebook: "فيسبوك",
  telegram: "تيليغرام",
  internal: "تنقّل داخل سلمى",
  other: "إحالات أخرى",
};

export const INTERNAL_LABELS_AR: Record<string, string> = {
  homepage: "الصفحة الرئيسية ← مقال",
  category: "صفحة قسم ← مقال",
  search: "البحث ← مقال",
  related: "مقالات ذات صلة ← مقال",
  other: "صفحات أخرى ← مقال",
};

/** Map an in-app pathname to the internal discovery source it represents. */
export function classifyInternalPath(path: string): InternalSource {
  if (path === "/") return "homepage";
  if (path.startsWith("/category")) return "category";
  if (path.startsWith("/search")) return "search";
  if (path.startsWith("/article") || path.startsWith("/video")) return "related";
  return "other";
}

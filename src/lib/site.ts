/** Canonical site origin, used for metadata, canonical URLs, OG tags, sitemap. */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
).replace(/\/+$/, "");

export const SITE_NAME = "سلمى";

/** Resolve a path against the canonical origin. */
export function absoluteUrl(path = "/"): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

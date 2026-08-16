// Radar one-click publish — Event Registry EXACT-ARTICLE source fallback.
//
// Purpose: when the direct SSRF-hardened extraction of the ORIGINAL publisher
// page fails (e.g. CNN returns 403 to a neutral server fetch), an ADMIN-
// authorized Radar publish may recover the body of the SAME article via Event
// Registry, which is used ONLY as a technical discovery/fetch provider. Event
// Registry NEVER becomes the editorial source — the original publisher (e.g.
// "CNN International") is preserved by the caller (see index.ts / registry.ts).
//
// This module is pure: the ER HTTP POST is injected (ErPost) so it is testable
// with fixtures and never opens a socket on its own. It returns the SAME
// SourceFetchResult shape as fetchSourceText, so the unchanged grounded
// Writer v27 → Editorial Director → Fidelity pipeline consumes it identically.
//
// Two exact-article methods, tried in order (see fetchErArticleSource):
//   1. eventregistry_stored  — /api/v1/article/getArticles by the stored
//      articleUri (provider_uri). IDENTITY: the returned article uri must equal
//      the stored provider_uri AND its host must match the stored URL host, so
//      ER can never substitute a different publisher or a topic-similar story.
//   2. eventregistry_extract — /api/v1/analytics/extractArticleInfo of the EXACT
//      original URL. IDENTITY is the URL itself (ER extracts that one page); we
//      only accept a body it actually returned for that URL.
// A total failure returns a discrete reason and NO text (the caller then does
// NOT call the Writer and does NOT publish — a headline/summary is never used).

import {
  extractEssentialEntities,
  MAX_TEXT_CHARS,
  MIN_TEXT_CHARS,
  type SourceFetchResult,
  type SourceText,
} from "./fetchSourceText.ts";

// An injected Event Registry POST. Mirrors radar-shadow's erPost: JSON body with
// the apiKey folded in by the adapter (never passed through this pure module).
export type ErPost = (
  path: string,
  body: Record<string, unknown>,
) => Promise<{ status: number; ok: boolean; json: unknown }>;

// Retrieval-method labels recorded on the audit row (ingestion_decisions
// .source_extraction_method, free text) so the technical fetch method is
// observable WITHOUT any schema change and WITHOUT surfacing ER to the reader.
const ER_STORED_METHOD = "eventregistry_stored" as const;
const ER_EXTRACT_METHOD = "eventregistry_extract" as const;

type ErArticle = {
  uri?: unknown;
  url?: unknown;
  title?: unknown;
  body?: unknown;
  date?: unknown;
  dateTime?: unknown;
};

function countWords(text: string): number {
  return (text ?? "").trim().split(/\s+/).filter((tok) => /[\p{L}\p{N}]/u.test(tok)).length;
}

/** Host (lowercased, www-stripped) + path-normalized href for identity checks. */
function normUrl(u: string | null | undefined): { host: string } | null {
  if (!u) return null;
  try {
    const url = new URL(String(u));
    return { host: url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "") };
  } catch {
    return null;
  }
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** Wrap a recovered body into the SourceText the grounded writer consumes. The
 *  body is clipped to MAX_TEXT_CHARS and mustPreserve is deterministically
 *  extracted from the body EXACTLY as the direct path does (same validator). */
function buildSourceText(args: {
  title: string;
  text: string;
  url: string;
  method: typeof ER_STORED_METHOD | typeof ER_EXTRACT_METHOD;
  publishedDate: string | null;
  sourceName: string | null;
}): SourceText {
  const clipped = args.text.length > MAX_TEXT_CHARS ? args.text.slice(0, MAX_TEXT_CHARS) : args.text;
  return {
    ok: true,
    title: args.title ?? "",
    text: clipped,
    method: args.method,
    publishedDate: args.publishedDate ?? null,
    charCount: clipped.length,
    wordCount: countWords(clipped),
    finalUrl: args.url,
    mustPreserve: extractEssentialEntities(clipped, { sourceName: args.sourceName }),
  };
}

/** Pick the ER article matching providerUri from either observed response shape:
 *  { articles: { results: [...] } } (getArticles) or { [uri]: { info } }. */
function pickErArticle(json: unknown, providerUri: string): ErArticle | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;

  const results = (j.articles as { results?: unknown[] } | undefined)?.results;
  if (Array.isArray(results)) {
    const match = results.find(
      (r) => r && typeof r === "object" && String((r as ErArticle).uri) === providerUri,
    );
    if (match) return match as ErArticle;
    if (results.length === 1 && results[0] && typeof results[0] === "object") {
      return results[0] as ErArticle;
    }
    return null;
  }

  const byUri = j[providerUri] as { info?: unknown } | undefined;
  if (byUri?.info && typeof byUri.info === "object") return byUri.info as ErArticle;
  return null;
}

/** Attempt 2 — stored ER body for the EXACT SAME article (by provider_uri). */
export async function fetchErStoredArticle(args: {
  erPost: ErPost;
  providerUri: string;
  url: string;
  sourceName: string | null;
}): Promise<SourceFetchResult> {
  let json: unknown;
  try {
    const res = await args.erPost("/api/v1/article/getArticles", {
      articleUri: args.providerUri,
      resultType: "articles",
      includeArticleBody: true,
      articleBodyLen: -1,
    });
    if (!res.ok) return { ok: false, reason: "source_text_unavailable" };
    json = res.json;
  } catch {
    return { ok: false, reason: "source_text_unavailable" };
  }

  const article = pickErArticle(json, args.providerUri);
  if (!article) return { ok: false, reason: "source_text_unavailable" };

  // IDENTITY gate 1: it must be the exact stored article, never a substitute.
  if (String(article.uri ?? "") !== args.providerUri) {
    return { ok: false, reason: "source_text_unavailable" };
  }
  // IDENTITY gate 2: same publisher host as the stored URL (guards against ER
  // ever returning a different outlet's copy under the same uri).
  const want = normUrl(args.url);
  const got = normUrl(typeof article.url === "string" ? article.url : null);
  if (!want || !got || want.host !== got.host) {
    return { ok: false, reason: "source_domain_mismatch" };
  }

  const body = String(article.body ?? "").trim();
  if (body.length < MIN_TEXT_CHARS) return { ok: false, reason: "source_content_too_short" };

  return buildSourceText({
    title: firstString(article.title) ?? "",
    text: body,
    url: args.url,
    method: ER_STORED_METHOD,
    publishedDate: firstString(article.dateTime, article.date),
    sourceName: args.sourceName,
  });
}

/** Attempt 3 — ER extraction of the EXACT original URL (identity IS the URL). */
export async function fetchErExtractedArticle(args: {
  erPost: ErPost;
  url: string;
  sourceName: string | null;
}): Promise<SourceFetchResult> {
  let json: unknown;
  try {
    const res = await args.erPost("/api/v1/analytics/extractArticleInfo", { url: args.url });
    if (!res.ok) return { ok: false, reason: "source_text_unavailable" };
    json = res.json;
  } catch {
    return { ok: false, reason: "source_text_unavailable" };
  }

  if (!json || typeof json !== "object") return { ok: false, reason: "source_text_unavailable" };
  const info = json as Record<string, unknown>;
  const body = String(info.body ?? "").trim();
  if (body.length < MIN_TEXT_CHARS) return { ok: false, reason: "source_content_too_short" };

  return buildSourceText({
    title: firstString(info.title) ?? "",
    text: body,
    url: args.url,
    method: ER_EXTRACT_METHOD,
    publishedDate: firstString(info.datetime, info.date),
    sourceName: args.sourceName,
  });
}

/**
 * Exact-article ER fallback: try the stored article body first (strongest
 * identity — by provider_uri), then ER extraction of the exact URL. Returns the
 * first success as a SourceText, or the last discrete failure reason. NEVER
 * searches for, or substitutes, a different/similar article.
 */
export async function fetchErArticleSource(args: {
  erPost: ErPost;
  providerUri: string | null;
  url: string;
  sourceName: string | null;
}): Promise<SourceFetchResult> {
  if (args.providerUri) {
    const stored = await fetchErStoredArticle({
      erPost: args.erPost,
      providerUri: args.providerUri,
      url: args.url,
      sourceName: args.sourceName,
    });
    if (stored.ok) return stored;
  }
  return fetchErExtractedArticle({
    erPost: args.erPost,
    url: args.url,
    sourceName: args.sourceName,
  });
}

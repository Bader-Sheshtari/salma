"use server";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/** One generated cover candidate + the editorial concept it was built from
 *  (used for the editor's session gallery and regeneration avoid-history). */
export type ImageCandidate = { url: string; conceptSummary: string; mode: "fast" | "premium" };

/** Non-binding editorial hint: which cover is strongest/most truthful —
 *  the preserved original image, a real official asset from an authoritative
 *  source tied to the story, or an AI-generated editorial illustration. */
export type AssetDecision = "original_source" | "official_asset" | "generate";
export type AssetRecommendation = { decision: AssetDecision; reason: string };

export type GenerateImageResult =
  | { ok: true; urls: string[]; candidates: ImageCandidate[]; recommendation: AssetRecommendation }
  | { error: string };

// User-friendly Arabic messages for each backend `reason`. Distinguishes wait /
// daily-allowance / temporary-service / image-failure categories, and never
// leaks API/provider internals or secrets.
const IMAGE_ERROR_MESSAGES: Record<string, string> = {
  no_title: "أدخل عنوان الخبر أولاً لتُبنى الصورة عليه.",
  connect: "تعذّر الاتصال بخدمة توليد الصور مؤقتاً. حاول مرة أخرى.",
  openrouter: "تعذّر توليد الصورة من الخدمة حالياً. حاول مرة أخرى بعد قليل.",
  no_image: "لم تُرجِع الخدمة صورة. حاول مرة أخرى.",
  bad_format: "صيغة الصورة المُولّدة غير مدعومة.",
  upload: "تعذّر حفظ الصورة المُولّدة. حاول مرة أخرى.",
  bad_request: "طلب غير صالح.",
  bad_quality: "وضع التوليد غير صالح.",
  bad_count: "عدد الصور غير صالح.",
  too_large: "حجم الطلب كبير جداً.",
  // Rate limits / quotas — surfaced clearly instead of a generic connection error.
  rate_limited: "يرجى الانتظار قليلاً قبل توليد صورة أخرى.",
  rate_user_minute: "يرجى الانتظار قليلاً قبل توليد صورة أخرى.",
  rate_user_daily: "بلغت حدّك اليومي من توليد الصور. جرّب مجدداً بعد فترة.",
  rate_global_daily: "بلغ النظام الحد اليومي لتوليد الصور. حاول لاحقاً.",
  rate_premium_global_daily: "بلغ النظام الحد اليومي لصور «الجودة العالية». حاول لاحقاً أو استخدم «التوليد السريع».",
  reservation_failed: "تعذّر التحقق من حدود الاستخدام مؤقتاً. حاول مرة أخرى.",
};

/** Map a backend reason to a friendly Arabic message. Unknown/absent → a safe
 *  temporary-service message. */
function imageErrorMessage(reason: string | undefined | null): string {
  const r = String(reason ?? "").trim();
  return IMAGE_ERROR_MESSAGES[r] ?? "تعذّر توليد الصورة مؤقتاً. حاول مرة أخرى.";
}

/** supabase-js surfaces a non-2xx Edge response (e.g. 429 rate limit, 503) as an
 *  invoke `error` with the original Response in `.context` and `data === null`,
 *  so the detailed `{ reason }` body is otherwise lost. Read it back so the
 *  editor sees the REAL cause (wait / daily limit / service) — not a generic
 *  "connection failed". Best-effort; falls back to a temporary-service message. */
async function reasonFromInvokeError(error: unknown): Promise<string | undefined> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx && typeof (ctx as Response).json === "function") {
    try {
      const body = (await (ctx as Response).json()) as { reason?: unknown } | null;
      if (body && typeof body.reason === "string") return body.reason;
    } catch {
      // response not JSON / already consumed → fall through
    }
  }
  return undefined;
}

/**
 * Proxy to the `generate-image` Edge Function: given the article's
 * title/excerpt/summary/category it asks OpenRouter for a few editorial cover
 * options (visually different from each other), uploads each to the public
 * `media` bucket, and returns their URLs. Calling it again simply produces a
 * fresh set (the "generate another set" flow).
 *
 * The OpenRouter key lives ONLY as a Supabase function secret (same one used by
 * synthesize-url / ingest), so image generation runs inside Supabase, not in
 * this Next.js process — no duplicate key to keep in sync.
 */
export async function generateCoverImage(input: {
  title: string;
  originalTitle?: string;
  excerpt?: string;
  summary?: string;
  body?: string;
  category?: string;
  sourceName?: string;
  country?: string;
  quality?: "fast" | "premium";
  count?: number;
  // Concept summaries already generated this editor session — the planner steers
  // each new request toward a materially different visual direction.
  avoidConcepts?: string[];
  // Whether the article has a preserved ORIGINAL source image, so the planner may
  // recommend using it when it is the stronger, more credible cover.
  hasSourceImage?: boolean;
}): Promise<GenerateImageResult> {
  await requireAdmin();

  const title = (input.title || "").trim();
  if (title.length < 4) return { error: "أدخل عنوان الخبر أولاً لتُبنى الصورة عليه." };

  const quality: "fast" | "premium" = input.quality === "premium" ? "premium" : "fast";
  // Default to exactly 1 image for BOTH modes; callers may opt into 2–3.
  const requested = Number(input.count);
  const count = Number.isInteger(requested) ? Math.min(3, Math.max(1, requested)) : 1;

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: "انتهت الجلسة. سجّل الدخول مرة أخرى." };

  // Body truncated to keep the payload bounded; the Edge Function truncates
  // again and drives an editorial visual-planning step from this context.
  const { data, error } = await supabase.functions.invoke("generate-image", {
    body: {
      title,
      original_title: (input.originalTitle ?? "").trim().slice(0, 300),
      excerpt: input.excerpt ?? "",
      summary: input.summary ?? "",
      body: (input.body ?? "").trim().slice(0, 6000),
      category: input.category ?? "",
      source_name: (input.sourceName ?? "").trim().slice(0, 160),
      country: (input.country ?? "").trim().slice(0, 120),
      quality,
      count,
      avoid_concepts: Array.isArray(input.avoidConcepts)
        ? input.avoidConcepts.map((s) => String(s ?? "").trim().slice(0, 120)).filter(Boolean).slice(0, 12)
        : [],
      has_source_image: input.hasSourceImage === true,
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  if (error) {
    // A non-2xx edge response (rate limit / quota / service) arrives here with
    // the body in error.context — recover the real reason instead of a generic
    // "connection failed" so the editor sees e.g. the daily-limit message.
    const reason = await reasonFromInvokeError(error);
    return { error: imageErrorMessage(reason) };
  }
  if (!data) {
    return { error: "تعذّر الاتصال بخدمة توليد الصور مؤقتاً. حاول مرة أخرى." };
  }
  if (data.ok === false) {
    return { error: imageErrorMessage(typeof data.reason === "string" ? data.reason : undefined) };
  }

  const urls: string[] = Array.isArray(data.urls)
    ? data.urls.filter((u: unknown): u is string => typeof u === "string" && u.length > 0)
    : typeof data.url === "string"
      ? [data.url]
      : [];
  if (urls.length === 0) return { error: "لم تُرجِع الخدمة صوراً. حاول مرة أخرى." };

  // Prefer the concept-annotated candidates; fall back to bare urls for an older
  // Edge Function response shape.
  const rawCandidates: unknown[] = Array.isArray(data.candidates) ? data.candidates : [];
  const candidates: ImageCandidate[] = rawCandidates
    .map((c): ImageCandidate | null => {
      const o = (c ?? {}) as Record<string, unknown>;
      const url = typeof o.url === "string" ? o.url : "";
      if (!url) return null;
      return {
        url,
        conceptSummary: typeof o.concept_summary === "string" ? o.concept_summary : "",
        mode: o.mode === "premium" ? "premium" : "fast",
      };
    })
    .filter((c): c is ImageCandidate => c !== null);
  const finalCandidates = candidates.length > 0
    ? candidates
    : urls.map((url) => ({ url, conceptSummary: "", mode: quality }));

  const rawRec = (data.recommendation ?? {}) as Record<string, unknown>;
  const decision: AssetDecision =
    rawRec.decision === "original_source" || rawRec.decision === "official_asset"
      ? rawRec.decision
      : "generate";
  const recommendation: AssetRecommendation = {
    decision,
    reason: typeof rawRec.reason === "string" ? rawRec.reason : "",
  };

  return { ok: true, urls, candidates: finalCandidates, recommendation };
}

// --- Official-asset retrieval from already-known authoritative article URLs ---

/** One image found on a page ALREADY linked to the article (its source_url /
 *  content_sources). This is a SOURCE-page image — NOT necessarily the entity's
 *  official website — so it is typed/labeled neutrally. Retrieval ≠ selection. */
export type OfficialAsset = {
  imageUrl: string;
  sourceUrl: string;
  sourceName: string;
  assetType: "source_image" | "source_logo";
  attribution: string;
};

export type OfficialAssetsResult = { ok: true; assets: OfficialAsset[] } | { error: string };

/**
 * Inspect the authoritative pages ALREADY linked to this article (its source
 * URLs / content_sources — passed in by the trusted editor, never open-web
 * discovery) and return their declared official images as selectable cover
 * candidates. The SSRF-safe fetch + extraction runs inside the ingest-news Edge
 * Function (reusing its hardening). Best-effort: on any failure it returns an
 * empty list so the editor never breaks.
 */
export async function fetchOfficialAssets(input: {
  urls: { url: string; label?: string }[];
}): Promise<OfficialAssetsResult> {
  await requireAdmin();

  const seen = new Set<string>();
  const urls = (Array.isArray(input.urls) ? input.urls : [])
    .map((u) => ({ url: String(u?.url ?? "").trim(), label: String(u?.label ?? "").trim() }))
    .filter((u) => /^https?:\/\//i.test(u.url) && !seen.has(u.url) && seen.add(u.url))
    .slice(0, 8);
  if (urls.length === 0) return { ok: true, assets: [] };

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: "انتهت الجلسة. سجّل الدخول مرة أخرى." };

  const { data, error } = await supabase.functions.invoke("ingest-news", {
    body: { op: "source_assets", urls },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error || !data || data.ok === false) return { error: "تعذّر جلب الصور الرسمية من المصادر." };

  const raw: unknown[] = Array.isArray(data.assets) ? data.assets : [];
  const assets: OfficialAsset[] = raw
    .map((a): OfficialAsset | null => {
      const o = (a ?? {}) as Record<string, unknown>;
      const imageUrl = typeof o.imageUrl === "string" ? o.imageUrl : "";
      if (!imageUrl) return null;
      return {
        imageUrl,
        sourceUrl: typeof o.sourceUrl === "string" ? o.sourceUrl : "",
        sourceName: typeof o.sourceName === "string" ? o.sourceName : "",
        assetType: o.assetType === "source_logo" ? "source_logo" : "source_image",
        attribution: typeof o.attribution === "string" ? o.attribution : "",
      };
    })
    .filter((a): a is OfficialAsset => a !== null);
  return { ok: true, assets };
}

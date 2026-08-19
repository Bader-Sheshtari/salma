"use server";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/** One generated cover candidate + the editorial concept it was built from
 *  (used for the editor's session gallery and regeneration avoid-history). */
export type ImageCandidate = { url: string; conceptSummary: string; mode: "fast" | "premium" };

/** Non-binding editorial hint: the planner judged the ORIGINAL source image the
 *  stronger cover for this real-world-anchored story (only when one exists). */
export type SourceImageRecommendation = { preferSourceImage: boolean; reason: string };

export type GenerateImageResult =
  | { ok: true; urls: string[]; candidates: ImageCandidate[]; recommendation: SourceImageRecommendation }
  | { error: string };

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

  if (error || !data) {
    return { error: "تعذّر الاتصال بخدمة توليد الصور. حاول مرة أخرى." };
  }
  if (data.ok === false) {
    const reasons: Record<string, string> = {
      no_title: "أدخل عنوان الخبر أولاً لتُبنى الصورة عليه.",
      connect: "تعذّر الاتصال بخدمة توليد الصور.",
      openrouter: `تعذّر توليد الصور (${data.status ?? ""}). تأكد من نموذج الصور ومن رصيد OpenRouter.`,
      no_image: "لم تُرجِع الخدمة صوراً. حاول مرة أخرى أو جرّب نموذجاً آخر.",
      bad_format: "صيغة الصورة المُولّدة غير مدعومة.",
      upload: "تعذّر حفظ الصور المُولّدة.",
      bad_request: "طلب غير صالح.",
      bad_quality: "وضع التوليد غير صالح.",
      bad_count: "عدد الصور غير صالح.",
      too_large: "حجم الطلب كبير جداً.",
      rate_limited: "تجاوزت الحد المسموح من التوليد مؤقتاً. انتظر قليلاً ثم حاول مجدداً.",
      rate_user_minute: "أرسلت طلبات كثيرة بسرعة. انتظر دقيقة ثم حاول مجدداً.",
      rate_user_daily: "بلغت حدّك اليومي من توليد الصور. حاول لاحقاً.",
      rate_global_daily: "بلغ النظام الحد اليومي لتوليد الصور. حاول لاحقاً.",
      rate_premium_global_daily: "بلغ النظام الحد اليومي لصور «الجودة العالية». حاول لاحقاً أو استخدم الوضع السريع.",
      reservation_failed: "تعذّر التحقق من حدود الاستخدام مؤقتاً. حاول مرة أخرى.",
    };
    return { error: reasons[String(data.reason)] ?? "تعذّر توليد الصور. حاول مرة أخرى." };
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
  const recommendation: SourceImageRecommendation = {
    preferSourceImage: rawRec.prefer_source_image === true,
    reason: typeof rawRec.reason === "string" ? rawRec.reason : "",
  };

  return { ok: true, urls, candidates: finalCandidates, recommendation };
}

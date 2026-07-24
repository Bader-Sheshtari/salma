"use server";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type GenerateImageResult = { ok: true; urls: string[] } | { error: string };

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
  excerpt?: string;
  summary?: string;
  category?: string;
  quality?: "fast" | "premium";
  count?: number;
}): Promise<GenerateImageResult> {
  await requireAdmin();

  const title = (input.title || "").trim();
  if (title.length < 4) return { error: "أدخل عنوان الخبر أولاً لتُبنى الصورة عليه." };

  const quality = input.quality === "premium" ? "premium" : "fast";
  // Default to exactly 1 image for BOTH modes; callers may opt into 2–3.
  const requested = Number(input.count);
  const count = Number.isInteger(requested) ? Math.min(3, Math.max(1, requested)) : 1;

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: "انتهت الجلسة. سجّل الدخول مرة أخرى." };

  const { data, error } = await supabase.functions.invoke("generate-image", {
    body: {
      title,
      excerpt: input.excerpt ?? "",
      summary: input.summary ?? "",
      category: input.category ?? "",
      quality,
      count,
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

  const urls = Array.isArray(data.urls)
    ? data.urls.filter((u: unknown): u is string => typeof u === "string" && u.length > 0)
    : typeof data.url === "string"
      ? [data.url]
      : [];
  if (urls.length === 0) return { error: "لم تُرجِع الخدمة صوراً. حاول مرة أخرى." };
  return { ok: true, urls };
}

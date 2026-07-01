"use server";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type GenerateImageResult = { ok: true; url: string } | { error: string };

/**
 * Proxy to the `generate-image` Edge Function: given the article's
 * title/excerpt/category it asks OpenRouter for an editorial cover image,
 * uploads it to the public `media` bucket, and returns its URL. Calling it again
 * simply produces a fresh image (the "generate another" flow).
 *
 * The OpenRouter key lives ONLY as a Supabase function secret (same one used by
 * synthesize-url / ingest), so image generation runs inside Supabase, not in
 * this Next.js process — no duplicate key to keep in sync.
 */
export async function generateCoverImage(input: {
  title: string;
  excerpt?: string;
  category?: string;
}): Promise<GenerateImageResult> {
  await requireAdmin();

  const title = (input.title || "").trim();
  if (title.length < 4) return { error: "أدخل عنوان الخبر أولاً لتُبنى الصورة عليه." };

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: "انتهت الجلسة. سجّل الدخول مرة أخرى." };

  const { data, error } = await supabase.functions.invoke("generate-image", {
    body: { title, excerpt: input.excerpt ?? "", category: input.category ?? "" },
    headers: { Authorization: `Bearer ${token}` },
  });

  if (error || !data) {
    return { error: "تعذّر الاتصال بخدمة توليد الصور. حاول مرة أخرى." };
  }
  if (data.ok === false) {
    const reasons: Record<string, string> = {
      no_title: "أدخل عنوان الخبر أولاً لتُبنى الصورة عليه.",
      connect: "تعذّر الاتصال بخدمة توليد الصور.",
      openrouter: `تعذّر توليد الصورة (${data.status ?? ""}). تأكد من نموذج الصور ومن رصيد OpenRouter.`,
      no_image: "لم تُرجِع الخدمة صورة. حاول مرة أخرى أو جرّب نموذجاً آخر.",
      bad_format: "صيغة الصورة المُولّدة غير مدعومة.",
      upload: "تعذّر حفظ الصورة المُولّدة.",
    };
    return { error: reasons[String(data.reason)] ?? "تعذّر توليد الصورة. حاول مرة أخرى." };
  }

  return { ok: true, url: String(data.url) };
}

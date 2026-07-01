"use server";

import { createClient } from "@/lib/supabase/server";

export type NewsletterResult = { ok: true } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function subscribeNewsletter(
  _prev: NewsletterResult | null,
  formData: FormData,
): Promise<NewsletterResult> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();

  if (!EMAIL_RE.test(email)) return { ok: false, error: "الرجاء إدخال بريد إلكتروني صحيح." };

  const supabase = await createClient();
  // `newsletter_subscribers` isn't in the generated types yet, so scope a loose cast to this call.
  // RLS allows the anonymous insert.
  const db = supabase as unknown as {
    from: (t: string) => {
      insert: (v: unknown) => Promise<{ error: { code?: string } | null }>;
    };
  };
  const { error } = await db.from("newsletter_subscribers").insert({ email });

  // A unique index on lower(email) means a repeat sign-up is already subscribed — treat as success.
  if (error && error.code !== "23505") {
    return { ok: false, error: "تعذّر إتمام الاشتراك، حاول لاحقاً." };
  }
  return { ok: true };
}

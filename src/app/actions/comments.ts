"use server";

import { createClient } from "@/lib/supabase/server";
import type { TablesInsert } from "@/lib/supabase/database.types";
import { publicRateLimited } from "@/lib/public-throttle";

export type CommentResult = { ok: true } | { ok: false; error: string };

export async function submitComment(
  _prev: CommentResult | null,
  formData: FormData,
): Promise<CommentResult> {
  // Honeypot: invisible to humans, filled by naive bots — pretend success.
  if (String(formData.get("website") ?? "").trim() !== "") return { ok: true };

  const contentId = String(formData.get("content_id") ?? "").trim();
  const authorName = String(formData.get("author_name") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();

  if (!contentId) return { ok: false, error: "محتوى غير صالح." };
  if (authorName.length < 2) return { ok: false, error: "الرجاء إدخال اسمك." };
  if (body.length < 3) return { ok: false, error: "التعليق قصير جداً." };
  if (body.length > 2000) return { ok: false, error: "التعليق طويل جداً." };

  if (await publicRateLimited("comment")) {
    return { ok: false, error: "محاولات كثيرة خلال وقت قصير — حاول لاحقاً." };
  }

  const supabase = await createClient();
  const row: TablesInsert<"comments"> = {
    content_id: contentId,
    author_name: authorName,
    body,
  };
  // RLS allows anonymous insert; a DB trigger forces status to 'pending'
  // so the comment is held for admin moderation before appearing publicly.
  // Cast works around an @supabase/ssr 0.5.2 insert-overload type quirk.
  const { error } = await supabase.from("comments").insert(row as unknown as never);

  if (error) return { ok: false, error: "تعذّر إرسال التعليق، حاول لاحقاً." };
  return { ok: true };
}

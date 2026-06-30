"use server";

import { createClient } from "@/lib/supabase/server";
import type { TablesInsert } from "@/lib/supabase/database.types";

export type RatingResult = { ok: true } | { ok: false; error: string };

/**
 * Submit a doctor rating. RLS allows anonymous insert for an existing,
 * non-deleted doctor; a DB trigger forces status to 'pending' so it is held
 * for admin moderation before counting toward the average.
 */
export async function submitRating(
  _prev: RatingResult | null,
  formData: FormData,
): Promise<RatingResult> {
  const doctorId = String(formData.get("doctor_id") ?? "").trim();
  const authorName = String(formData.get("author_name") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const stars = Number(formData.get("stars"));

  if (!doctorId) return { ok: false, error: "طبيب غير صالح." };
  if (!Number.isInteger(stars) || stars < 1 || stars > 5)
    return { ok: false, error: "اختر تقييماً من 1 إلى 5 نجوم." };
  if (authorName.length < 2) return { ok: false, error: "الرجاء إدخال اسمك." };
  if (body.length > 2000) return { ok: false, error: "النص طويل جداً." };

  const supabase = await createClient();
  const row: TablesInsert<"doctor_ratings"> = {
    doctor_id: doctorId,
    author_name: authorName,
    body: body || null,
    stars,
  };
  const { error } = await supabase.from("doctor_ratings").insert(row as unknown as never);

  if (error) return { ok: false, error: "تعذّر إرسال التقييم، حاول لاحقاً." };
  return { ok: true };
}

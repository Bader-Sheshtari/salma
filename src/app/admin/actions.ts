"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import type { TablesInsert, TablesUpdate } from "@/lib/supabase/database.types";

function slugify(input: string): string {
  return input
    .trim()
    .replace(/[\u064B-\u065F\u0610-\u061A]/g, "") // strip Arabic diacritics
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .toLowerCase();
}

export type SaveResult = { error: string } | null;

/** Create or update a content item plus its sources. */
export async function saveContent(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  await requireAdmin();
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  if (title.length < 4) return { error: "العنوان قصير جداً." };

  const type = String(formData.get("type") ?? "news");
  const status = String(formData.get("status") ?? "draft");
  const category_slug = String(formData.get("category_slug") ?? "") || null;
  const excerpt = String(formData.get("excerpt") ?? "").trim() || null;
  const body = String(formData.get("body") ?? "").trim() || null;
  const cover_image_url = String(formData.get("cover_image_url") ?? "").trim() || null;
  const cover_credit_name = String(formData.get("cover_credit_name") ?? "").trim() || null;
  const cover_credit_url = String(formData.get("cover_credit_url") ?? "").trim() || null;
  const source_name = String(formData.get("source_name") ?? "").trim() || null;
  const source_url = String(formData.get("source_url") ?? "").trim() || null;
  const video_url = String(formData.get("video_url") ?? "").trim() || null;
  const video_duration = String(formData.get("video_duration") ?? "").trim() || null;
  const readRaw = String(formData.get("read_minutes") ?? "").trim();
  const read_minutes = readRaw ? Number(readRaw) : null;
  const is_breaking = formData.get("is_breaking") === "on";
  const is_featured = formData.get("is_featured") === "on";

  const slug = String(formData.get("slug") ?? "").trim() || slugify(title);
  const published_at = status === "published" ? new Date().toISOString() : null;

  const payload = {
    title,
    slug,
    type,
    status,
    category_slug,
    excerpt,
    body,
    cover_image_url,
    cover_credit_name,
    cover_credit_url,
    source_name,
    source_url,
    video_url,
    video_duration,
    read_minutes: Number.isFinite(read_minutes as number) ? read_minutes : null,
    is_breaking,
    is_featured,
    ...(published_at ? { published_at } : {}),
  } satisfies Partial<TablesInsert<"content">>;

  let contentId = id;

  if (id) {
    const { error } = await supabase
      .from("content")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update(payload as unknown as never)
      .eq("id", id);
    if (error) return { error: "تعذّر حفظ التعديلات." };
  } else {
    const { data, error } = await supabase
      .from("content")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .insert(payload as unknown as never)
      .select("id")
      .single();
    if (error || !data) return { error: "تعذّر إنشاء المحتوى (تأكد أن الرابط فريد)." };
    contentId = (data as { id: string }).id;
  }

  // Replace sources: parallel arrays source_label[] / source_url[].
  const labels = formData.getAll("source_label").map((v) => String(v).trim());
  const urls = formData.getAll("source_url").map((v) => String(v).trim());
  const rows: TablesInsert<"content_sources">[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i]) rows.push({ content_id: contentId, label: labels[i], url: urls[i] || null });
  }
  await supabase.from("content_sources").delete().eq("content_id", contentId);
  if (rows.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase.from("content_sources").insert(rows as unknown as never);
  }

  // Replace media gallery: submitted as a JSON array in `media_json`.
  const mediaRows: TablesInsert<"content_media">[] = [];
  try {
    const parsed = JSON.parse(String(formData.get("media_json") ?? "[]"));
    if (Array.isArray(parsed)) {
      parsed.forEach((m, i) => {
        const url = String(m?.url ?? "").trim();
        if (!url) return;
        mediaRows.push({
          content_id: contentId,
          type: m?.type === "video" ? "video" : "image",
          url,
          storage_path: m?.storage_path ? String(m.storage_path) : null,
          caption: String(m?.caption ?? "").trim() || null,
          credit_name: String(m?.credit_name ?? "").trim() || null,
          credit_url: String(m?.credit_url ?? "").trim() || null,
          sort_order: i,
        });
      });
    }
  } catch {
    // ignore malformed payload — treat as no media
  }
  await supabase.from("content_media").delete().eq("content_id", contentId);
  if (mediaRows.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase.from("content_media").insert(mediaRows as unknown as never);
  }

  revalidatePath("/admin/content");
  revalidatePath("/");
  redirect("/admin/content");
}

export async function setStatus(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  const status = String(formData.get("status"));
  const patch =
    status === "published"
      ? { status, published_at: new Date().toISOString() }
      : { status };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase.from("content").update(patch as unknown as never).eq("id", id);
  revalidatePath("/admin/content");
  revalidatePath("/");
}

export async function softDeleteContent(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  await supabase
    .from("content")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ deleted_at: new Date().toISOString() } as unknown as never)
    .eq("id", id);
  revalidatePath("/admin/content");
  revalidatePath("/");
}

export type IngestResult =
  | { error: string }
  | { found: number; kept: number; filtered: number; duplicates: number }
  | null;

/**
 * Trigger the news-ingestion agent, which runs entirely inside Supabase as the
 * `ingest-news` Edge Function: it live-searches trusted sources, translates and
 * curates into Arabic, and stores real, sourced items as `pending` content
 * (origin = 'ai') for an admin to review. The AI never authors facts.
 *
 * This server action is a thin proxy — it forwards the admin's session JWT so
 * the function can authorize the caller, then returns the run stats.
 */
export async function ingestNews(_prev: IngestResult, _formData: FormData): Promise<IngestResult> {
  await requireAdmin();
  const supabase = await createClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: "انتهت الجلسة. سجّل الدخول مرة أخرى." };

  const { data, error } = await supabase.functions.invoke("ingest-news", {
    body: {},
    headers: { Authorization: `Bearer ${token}` },
  });

  if (error || !data || data.ok === false) {
    return { error: "تعذّر تشغيل وكيل الأخبار. تأكد من مفتاح OpenRouter وإعدادات السياسة التحريرية." };
  }

  revalidatePath("/admin/content");
  return {
    found: Number(data.found) || 0,
    kept: Number(data.kept) || 0,
    filtered: Number(data.filtered) || 0,
    duplicates: Number(data.duplicates) || 0,
  };
}

const VALID_REGIONS = ["kuwait", "gulf", "mena", "world"];

/** Split a textarea value into a clean, de-duplicated list (one item per line). */
function linesToList(value: string): string[] {
  const seen = new Set<string>();
  for (const raw of value.split("\n")) {
    const t = raw.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

export type PolicyResult = { error: string } | { saved: true } | null;

/** Update the single editorial-policy row that drives the ingestion agent. */
export async function updateEditorialPolicy(
  _prev: PolicyResult,
  formData: FormData,
): Promise<PolicyResult> {
  await requireAdmin();
  const supabase = await createClient();

  const regions = formData
    .getAll("regions")
    .map((r) => String(r))
    .filter((r) => VALID_REGIONS.includes(r));
  if (regions.length === 0) return { error: "اختر منطقة واحدة على الأقل." };

  const patch = {
    block_topics: linesToList(String(formData.get("block_topics") ?? "")),
    priority_topics: linesToList(String(formData.get("priority_topics") ?? "")),
    trusted_sources: linesToList(String(formData.get("trusted_sources") ?? "")),
    regions,
    updated_at: new Date().toISOString(),
  } satisfies TablesUpdate<"editorial_policy">;

  const { data: existing } = await supabase
    .from("editorial_policy")
    .select("id")
    .limit(1)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("editorial_policy")
      .update(patch as unknown as never)
      .eq("id", (existing as { id: string }).id);
    if (error) return { error: "تعذّر حفظ السياسة." };
  } else {
    const { error } = await supabase
      .from("editorial_policy")
      .insert(patch as unknown as never);
    if (error) return { error: "تعذّر إنشاء السياسة." };
  }

  revalidatePath("/admin/ingest/policy");
  return { saved: true };
}

export async function moderateComment(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  const action = String(formData.get("action"));
  if (action === "delete") {
    await supabase.from("comments").delete().eq("id", id);
  } else {
    const status = action === "approve" ? "approved" : "rejected";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase.from("comments").update({ status } as unknown as never).eq("id", id);
  }
  revalidatePath("/admin/comments");
}

// ============ DEPARTMENTS ============

export async function saveDepartment(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  await requireAdmin();
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "").trim();
  const name_ar = String(formData.get("name_ar") ?? "").trim();
  if (name_ar.length < 2) return { error: "اسم القسم قصير جداً." };
  const slug = String(formData.get("slug") ?? "").trim() || slugify(name_ar);
  const sortRaw = String(formData.get("sort_order") ?? "").trim();
  const sort_order = sortRaw ? Number(sortRaw) || 0 : 0;

  const payload = { name_ar, slug, sort_order } satisfies Partial<TablesInsert<"departments">>;

  if (id) {
    const { error } = await supabase
      .from("departments")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update(payload as unknown as never)
      .eq("id", id);
    if (error) return { error: "تعذّر حفظ القسم." };
  } else {
    const { error } = await supabase
      .from("departments")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .insert(payload as unknown as never);
    if (error) return { error: "تعذّر إنشاء القسم (تأكد أن الرابط فريد)." };
  }

  revalidatePath("/admin/departments");
  revalidatePath("/doctors");
  return null;
}

export async function deleteDepartment(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  await supabase.from("departments").delete().eq("id", id);
  revalidatePath("/admin/departments");
  revalidatePath("/doctors");
}

// ============ DOCTORS ============

export async function saveDoctor(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  await requireAdmin();
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "").trim();
  const name_ar = String(formData.get("name_ar") ?? "").trim();
  if (name_ar.length < 3) return { error: "اسم الطبيب قصير جداً." };

  const department_id = String(formData.get("department_id") ?? "").trim() || null;
  const title_ar = String(formData.get("title_ar") ?? "").trim() || null;
  const hospital = String(formData.get("hospital") ?? "").trim() || null;
  const photo_url = String(formData.get("photo_url") ?? "").trim() || null;
  const bio = String(formData.get("bio") ?? "").trim() || null;
  const slug = String(formData.get("slug") ?? "").trim() || slugify(name_ar);

  const payload = {
    name_ar,
    slug,
    department_id,
    title_ar,
    hospital,
    photo_url,
    bio,
  } satisfies Partial<TablesInsert<"doctors">>;

  if (id) {
    const { error } = await supabase
      .from("doctors")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update(payload as unknown as never)
      .eq("id", id);
    if (error) return { error: "تعذّر حفظ التعديلات." };
  } else {
    const { error } = await supabase
      .from("doctors")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .insert(payload as unknown as never);
    if (error) return { error: "تعذّر إنشاء الطبيب (تأكد أن الرابط فريد)." };
  }

  revalidatePath("/admin/doctors");
  revalidatePath("/doctors");
  redirect("/admin/doctors");
}

export async function softDeleteDoctor(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  await supabase
    .from("doctors")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ deleted_at: new Date().toISOString() } as unknown as never)
    .eq("id", id);
  revalidatePath("/admin/doctors");
  revalidatePath("/doctors");
}

export async function moderateRating(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  const action = String(formData.get("action"));
  if (action === "delete") {
    await supabase.from("doctor_ratings").delete().eq("id", id);
  } else {
    const status = action === "approve" ? "approved" : "rejected";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase.from("doctor_ratings").update({ status } as unknown as never).eq("id", id);
  }
  revalidatePath("/admin/doctors/ratings");
  revalidatePath("/doctors");
}

// ============ DOCTOR TRANSFERS (انتقال الأطباء) ============

export async function saveTransfer(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  await requireAdmin();
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "").trim();
  const doctor_name = String(formData.get("doctor_name") ?? "").trim();
  if (doctor_name.length < 3) return { error: "اسم الطبيب قصير جداً." };

  const department_id = String(formData.get("department_id") ?? "").trim() || null;
  const from_hospital = String(formData.get("from_hospital") ?? "").trim() || null;
  const to_hospital = String(formData.get("to_hospital") ?? "").trim() || null;
  const transfer_date = String(formData.get("transfer_date") ?? "").trim() || null;
  const note = String(formData.get("note") ?? "").trim() || null;
  const status = String(formData.get("status") ?? "published");

  const payload = {
    doctor_name,
    department_id,
    from_hospital,
    to_hospital,
    transfer_date,
    note,
    status,
  } satisfies Partial<TablesInsert<"doctor_transfers">>;

  if (id) {
    const { error } = await supabase
      .from("doctor_transfers")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update(payload as unknown as never)
      .eq("id", id);
    if (error) return { error: "تعذّر حفظ التعديلات." };
  } else {
    const { error } = await supabase
      .from("doctor_transfers")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .insert(payload as unknown as never);
    if (error) return { error: "تعذّر إنشاء الانتقال." };
  }

  revalidatePath("/admin/transfers");
  revalidatePath("/transfers");
  redirect("/admin/transfers");
}

export async function softDeleteTransfer(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  await supabase
    .from("doctor_transfers")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ deleted_at: new Date().toISOString() } as unknown as never)
    .eq("id", id);
  revalidatePath("/admin/transfers");
  revalidatePath("/transfers");
}

// ============ URL → AI SYNTHESIS ============

export type SynthResult = { error: string } | { ok: true; id: string; title: string } | null;

/**
 * Proxy to the `synthesize-url` Edge Function: the admin pastes an article URL;
 * the function fetches the page, writes an Arabic draft, keeps the source as a
 * reference, and stores it as `pending` content for review. Mirrors ingestNews:
 * the OpenRouter key lives only as a Supabase function secret, so synthesis must
 * run inside Supabase, not in this Next.js process.
 */
export async function synthesizeUrl(_prev: SynthResult, formData: FormData): Promise<SynthResult> {
  await requireAdmin();
  const url = String(formData.get("url") ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return { error: "أدخل رابطاً صحيحاً يبدأ بـ http(s)." };

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: "انتهت الجلسة. سجّل الدخول مرة أخرى." };

  const { data, error } = await supabase.functions.invoke("synthesize-url", {
    body: { url },
    headers: { Authorization: `Bearer ${token}` },
  });

  if (error || !data) {
    return { error: "تعذّر الاتصال بخدمة المعالجة. حاول مرة أخرى." };
  }
  if (data.ok === false) {
    const reasons: Record<string, string> = {
      no_text: "تعذّر قراءة نص المقال من هذا الرابط. قد يكون الموقع محمياً أو يعرض محتواه عبر JavaScript؛ جرّب رابطاً آخر أو أضف المقال يدوياً.",
      synthesis: "تعذّرت صياغة المقال. حاول مرة أخرى بعد قليل.",
    };
    return { error: reasons[String(data.reason)] ?? "تعذّرت معالجة الرابط. تأكد من صحته وإعدادات OpenRouter." };
  }

  revalidatePath("/admin/content");
  return { ok: true, id: String(data.id), title: String(data.title ?? "") };
}

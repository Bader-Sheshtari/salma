"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, isManagerRole, type Profile } from "@/lib/auth";
import { slugify, ensureUniqueSlug } from "@/lib/slug";
import type { TablesInsert, TablesUpdate } from "@/lib/supabase/database.types";

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

  const specialty = String(formData.get("specialty") ?? "").trim() || null;
  const doctor_photo_url = String(formData.get("doctor_photo_url") ?? "").trim() || null;
  const from_hospital = String(formData.get("from_hospital") ?? "").trim() || null;
  const to_hospital = String(formData.get("to_hospital") ?? "").trim() || null;
  const transfer_date = String(formData.get("transfer_date") ?? "").trim() || null;
  const summary = String(formData.get("summary") ?? "").trim() || null;
  const body = String(formData.get("body") ?? "").trim() || null;
  const source_name = String(formData.get("source_name") ?? "").trim() || null;
  const source_url = String(formData.get("source_url") ?? "").trim() || null;
  const status = String(formData.get("status") ?? "published");

  // Published rows need a stable slug + timestamp; drafts/pending leave slug null
  // (partial unique index ignores nulls) and only get a published_at when set.
  const slug =
    status === "published"
      ? await ensureUniqueSlug("doctor_transfers", slugify(doctor_name), id || undefined)
      : null;

  const publishedRaw = String(formData.get("published_at") ?? "").trim();
  const published_at = publishedRaw
    ? new Date(publishedRaw).toISOString()
    : status === "published"
      ? new Date().toISOString()
      : null;

  const payload = {
    doctor_name,
    specialty,
    doctor_photo_url,
    from_hospital,
    to_hospital,
    transfer_date,
    summary,
    body,
    source_name,
    source_url,
    status,
    published_at,
    ...(slug ? { slug } : {}),
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
  revalidatePath("/");
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

// ============ HOMEPAGE SECTIONS ============

const DISPLAY_STYLES = ["carousel", "grid", "list", "featured"];

/** Update the editable fields of a single homepage section. Kind/key/category
 * are immutable (seeded), so they are not accepted here. */
export async function saveHomepageSection(_prev: SaveResult, formData: FormData): Promise<SaveResult> {
  await requireAdmin();
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { error: "قسم غير معروف." };

  const title_ar = String(formData.get("title_ar") ?? "").trim();
  if (title_ar.length < 2) return { error: "عنوان القسم قصير جداً." };

  const styleRaw = String(formData.get("display_style") ?? "carousel");
  const display_style = DISPLAY_STYLES.includes(styleRaw) ? styleRaw : "carousel";
  const limitRaw = Number(String(formData.get("items_limit") ?? "6"));
  const items_limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 24) : 6;
  const is_enabled = formData.get("is_enabled") === "on";
  const show_view_all = formData.get("show_view_all") === "on";
  const accent = String(formData.get("accent") ?? "").trim() || null;

  const payload = {
    title_ar,
    display_style,
    items_limit,
    is_enabled,
    show_view_all,
    accent,
  } satisfies Partial<TablesUpdate<"homepage_sections">>;

  const { error } = await supabase
    .from("homepage_sections")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update(payload as unknown as never)
    .eq("id", id);
  if (error) return { error: "تعذّر حفظ القسم." };

  revalidatePath("/admin/homepage");
  revalidatePath("/");
  return null;
}

/** Swap a section's sort_order with its neighbour to move it up or down. */
export async function moveHomepageSection(formData: FormData) {
  await requireAdmin();
  const supabase = await createClient();
  const id = String(formData.get("id"));
  const dir = String(formData.get("dir"));

  const { data } = await supabase
    .from("homepage_sections")
    .select("id, sort_order")
    .order("sort_order", { ascending: true });
  const rows = (data as { id: string; sort_order: number }[]) ?? [];
  const i = rows.findIndex((r) => r.id === id);
  if (i === -1) return;
  const j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= rows.length) return;

  const a = rows[i];
  const b = rows[j];
  await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase.from("homepage_sections").update({ sort_order: b.sort_order } as unknown as never).eq("id", a.id),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase.from("homepage_sections").update({ sort_order: a.sort_order } as unknown as never).eq("id", b.id),
  ]);

  revalidatePath("/admin/homepage");
  revalidatePath("/");
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

/* ─────────────────────────  ADMIN USERS & PERMISSIONS  ───────────────────────── */

export type AdminUserResult = { error: string } | { ok: string } | null;

/** Roles a manager may hand out through the UI (never "owner"). */
const ASSIGNABLE_ROLES = ["admin", "super_admin"] as const;

/**
 * Whether `actor` may act on `target` (suspend / delete / change role / reset
 * password). Self is excluded (use the self-service password form) and the owner
 * account is always protected. Owners manage admins and super admins; super
 * admins manage only plain admins. Mirrors the spec's role hierarchy — and is the
 * authoritative check, since the service-role client bypasses RLS and triggers.
 */
function canManage(actor: Profile, target: { id: string; role: string }): boolean {
  if (target.id === actor.id) return false;
  if (target.role === "owner") return false;
  if (actor.role === "owner") return true;
  if (actor.role === "super_admin") return target.role === "admin";
  return false;
}

/** Create a new admin account (auth user + elevated profile) with a temp password. */
export async function createAdmin(
  _prev: AdminUserResult,
  formData: FormData,
): Promise<AdminUserResult> {
  const actor = await requireAdmin();
  if (!isManagerRole(actor.role)) return { error: "لا تملك صلاحية إضافة مدراء." };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const full_name = String(formData.get("full_name") ?? "").trim() || null;
  const role = String(formData.get("role") ?? "admin");

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "أدخل بريداً إلكترونياً صحيحاً." };
  if (password.length < 8) return { error: "كلمة المرور المؤقتة يجب ألا تقل عن 8 أحرف." };
  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) return { error: "دور غير صالح." };
  if (role === "super_admin" && actor.role !== "owner")
    return { error: "فقط المالك يمكنه تعيين مشرف أعلى." };

  const admin = createAdminClient();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: full_name ? { full_name } : undefined,
  });
  if (createErr || !created?.user) {
    if (/registered|already|exists/i.test(createErr?.message ?? ""))
      return { error: "هذا البريد مسجّل بالفعل." };
    return { error: "تعذّر إنشاء الحساب." };
  }

  // handle_new_user already inserted a profile (role=user); elevate it.
  const { error: updErr } = await admin
    .from("profiles")
    .update({ role, full_name, created_by: actor.id } as never)
    .eq("id", created.user.id);
  if (updErr) {
    await admin.auth.admin.deleteUser(created.user.id); // roll back the orphan
    return { error: "تعذّر ضبط صلاحية الحساب." };
  }

  revalidatePath("/admin/users");
  return { ok: "تم إنشاء الحساب بنجاح." };
}

/** Change a target admin's role (admin ⇄ super_admin). */
export async function setAdminRole(formData: FormData) {
  const actor = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) return;
  if (role === "super_admin" && actor.role !== "owner") return;

  const admin = createAdminClient();
  const { data } = await admin.from("profiles").select("id, role").eq("id", id).maybeSingle();
  const target = data as { id: string; role: string } | null;
  if (!target || !canManage(actor, target)) return;

  await admin.from("profiles").update({ role } as never).eq("id", id);
  revalidatePath("/admin/users");
}

/** Suspend or re-activate a target admin. */
export async function toggleAdminDisabled(formData: FormData) {
  const actor = await requireAdmin();
  const id = String(formData.get("id") ?? "");

  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id, role, disabled")
    .eq("id", id)
    .maybeSingle();
  const target = data as { id: string; role: string; disabled: boolean } | null;
  if (!target || !canManage(actor, target)) return;

  await admin.from("profiles").update({ disabled: !target.disabled } as never).eq("id", id);
  revalidatePath("/admin/users");
}

/** Permanently delete a target admin (cascades the profile via the auth FK). */
export async function deleteAdmin(formData: FormData) {
  const actor = await requireAdmin();
  const id = String(formData.get("id") ?? "");

  const admin = createAdminClient();
  const { data } = await admin.from("profiles").select("id, role").eq("id", id).maybeSingle();
  const target = data as { id: string; role: string } | null;
  if (!target || !canManage(actor, target)) return;

  await admin.auth.admin.deleteUser(id);
  revalidatePath("/admin/users");
}

/** Set a new temporary password for a target admin. */
export async function resetAdminPassword(
  _prev: AdminUserResult,
  formData: FormData,
): Promise<AdminUserResult> {
  const actor = await requireAdmin();
  if (!isManagerRole(actor.role)) return { error: "لا تملك صلاحية." };
  const id = String(formData.get("id") ?? "");
  const password = String(formData.get("password") ?? "");
  if (password.length < 8) return { error: "كلمة المرور يجب ألا تقل عن 8 أحرف." };

  const admin = createAdminClient();
  const { data } = await admin.from("profiles").select("id, role").eq("id", id).maybeSingle();
  const target = data as { id: string; role: string } | null;
  if (!target || !canManage(actor, target)) return { error: "لا تملك صلاحية على هذا الحساب." };

  const { error } = await admin.auth.admin.updateUserById(id, { password });
  if (error) return { error: "تعذّر تغيير كلمة المرور." };
  return { ok: "تم تحديث كلمة المرور." };
}

/** Any signed-in admin may change their own password. */
export async function changeOwnPassword(
  _prev: AdminUserResult,
  formData: FormData,
): Promise<AdminUserResult> {
  await requireAdmin();
  const password = String(formData.get("password") ?? "");
  if (password.length < 8) return { error: "كلمة المرور يجب ألا تقل عن 8 أحرف." };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: "تعذّر تغيير كلمة المرور." };
  return { ok: "تم تغيير كلمة مرورك بنجاح." };
}

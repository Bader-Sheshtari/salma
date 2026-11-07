"use server";

// Universal Jamal editorial action («تحرير بواسطة جمال») — the ONE shared
// server-action module every admin entry point uses (owner approval
// 2026-11-07). All writing goes through the EXISTING ingest-news Jamal mode
// (j1.0-c2 + Atlas + full validation stack); nothing here builds a second
// pipeline. Three actions:
//   jamalFromUrl        — new PENDING article from a source URL.
//   jamalRewriteProposal— propose a rewrite of an existing article (no write).
//   acceptJamalRewrite  — editor's explicit acceptance applies the proposal
//                         (DB lifecycle triggers version the original) and
//                         links the jamal_runs row (badge appears only then).
// Radar items reuse the hardened radar pipeline action (radar-actions.ts),
// which now requests writer_mode "jamal" for preparation.
//
// Permissions: every action requires staff (editor and above). The edge
// function independently restricts editor-tier JWTs to the Jamal slice and
// never lets them publish. Manual requests never touch the ESL daily cap
// (the cap lives inside the ESL function only).

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const GENERIC_ERROR = "تعذّر تنفيذ طلب جمال. حاول مرة أخرى.";

export type JamalFromUrlResult =
  | { ok: true; contentId: string }
  | { error: string; duplicateOf?: string };

/** New PENDING article: Jamal writes from the given source URL through the
 *  existing targeted single-article path (hard limit 1, URL-scoped
 *  authorization, SSRF-safe fetch, dedupe, validation, prepare-only). */
export async function jamalFromUrl(rawUrl: string, categorySlug?: string | null): Promise<JamalFromUrlResult> {
  await requireStaff();
  const url = String(rawUrl ?? "").trim();
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "الرابط يجب أن يبدأ بـ http أو https." };
  } catch {
    return { error: "الرابط غير صالح." };
  }

  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return { error: "انتهت الجلسة. سجّل الدخول مرة أخرى." };

  const { data, error } = await supabase.functions.invoke("ingest-news", {
    body: {
      writer_mode: "jamal",
      pilot_limit: 1,
      pilot_source_url: url,
      // URL-scoped authorization for exactly this URL (existing mechanism —
      // grants a single SSRF-guarded fetch, no registry trust, no publish).
      radar_authorized_source: true,
      radar_publish_mode: "prepare",
      radar_category_slug: categorySlug ?? null,
    },
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (error || !data) return { error: GENERIC_ERROR };

  const pilot = (data as { pilot?: { created_content_id?: string | null; rejection_reason?: string | null } }).pilot ?? null;
  if (pilot?.created_content_id) {
    revalidatePath("/admin/content");
    return { ok: true, contentId: pilot.created_content_id };
  }
  const reason = pilot?.rejection_reason ?? (data as { error?: string }).error ?? null;
  if (reason === "duplicate_existing_content") {
    return { error: "هذا الخبر موجود بالفعل في سلمى — لم يُنشأ مقال مكرر." };
  }
  if (reason === "pilot_source_url_not_registered" || reason === "pilot_source_url_invalid") {
    return { error: "تعذّر اعتماد هذا الرابط كمصدر." };
  }
  if (reason && reason.startsWith("source_")) {
    return { error: "تعذّر جلب نص المصدر من الرابط (حجب آلي أو محتوى غير قابل للاستخراج)." };
  }
  if (reason) return { error: `رفضت ضوابط التحقق المسودة (${reason}). لم يُحفظ شيء.` };
  return { error: GENERIC_ERROR };
}

export type JamalProposal = {
  title: string;
  excerpt: string;
  body: string;
  read_minutes: number | null;
  review_notes: string[];
};

export type JamalRewriteResult =
  | { ok: true; proposal: JamalProposal; needsHumanReview: boolean; grounding: "source_refetch" | "stored_body"; jamalRunId: string | null; baseVersion: number }
  | { error: string; reviewNotes?: string[] };

/** Propose a Jamal rewrite of an existing article. Read-only: the article is
 *  untouched until acceptJamalRewrite. */
export async function jamalRewriteProposal(contentId: string): Promise<JamalRewriteResult> {
  await requireStaff();
  const id = String(contentId ?? "").trim();
  if (!id) return { error: "معرّف غير صالح." };

  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return { error: "انتهت الجلسة. سجّل الدخول مرة أخرى." };

  const { data, error } = await supabase.functions.invoke("ingest-news", {
    body: { op: "jamal_rewrite", content_id: id },
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (error || !data) return { error: GENERIC_ERROR };

  const d = data as {
    ok?: boolean;
    proposal?: JamalProposal;
    needs_human_review?: boolean;
    grounding?: "source_refetch" | "stored_body";
    jamal_run_id?: string | null;
    base_version?: number;
    rejection?: string;
    review_notes?: string[];
    error?: string;
  };
  if (d.ok && d.proposal) {
    return {
      ok: true,
      proposal: d.proposal,
      needsHumanReview: d.needs_human_review === true,
      grounding: d.grounding ?? "stored_body",
      jamalRunId: d.jamal_run_id ?? null,
      baseVersion: typeof d.base_version === "number" ? d.base_version : 0,
    };
  }
  if (d.error === "rewrite_rejected") {
    return {
      error: `رفضت ضوابط التحقق إعادة الصياغة (${d.rejection ?? "validation_failed"}). لم يتغير المقال.`,
      reviewNotes: d.review_notes,
    };
  }
  return { error: GENERIC_ERROR };
}

export type AcceptRewriteResult = { ok: true } | { error: string };

/** Apply an accepted Jamal rewrite. The update runs under the editor's own
 *  session (RLS + the DB lifecycle triggers snapshot the previous text into
 *  content_versions, exactly like any manual edit), guarded by optimistic
 *  concurrency on the version the proposal was generated against. Only after
 *  the update succeeds is the jamal_runs row linked (service role), which is
 *  what makes the «تحرير جمال» badge appear. */
export async function acceptJamalRewrite(input: {
  contentId: string;
  proposal: JamalProposal;
  jamalRunId: string | null;
  baseVersion: number;
}): Promise<AcceptRewriteResult> {
  await requireStaff();
  const id = String(input.contentId ?? "").trim();
  const title = String(input.proposal?.title ?? "").trim();
  const body = String(input.proposal?.body ?? "").trim();
  const excerpt = String(input.proposal?.excerpt ?? "").trim();
  if (!id || title.length < 4 || !body) return { error: "اقتراح غير صالح." };

  const supabase = await createClient();
  // Untyped client for the dynamic patch shape (same precedent as
  // admin-queries' search_content / jamal_runs access).
  const client = supabase as unknown as SupabaseClient;
  const patch: Record<string, unknown> = { title, excerpt: excerpt || null, body };
  if (input.proposal.read_minutes) patch.read_minutes = input.proposal.read_minutes;
  let q = client
    .from("content")
    .update(patch)
    .eq("id", id)
    .is("deleted_at", null);
  // Optimistic concurrency: refuse to clobber edits made after the proposal.
  if (input.baseVersion > 0) q = q.eq("version", input.baseVersion);
  const { data: updated, error } = await q.select("id");
  if (error) return { error: "تعذّر حفظ الصياغة المقترحة." };
  if (!updated || updated.length === 0) {
    return { error: "تغيّر المقال بعد توليد الاقتراح — أعد توليد الصياغة ثم راجعها من جديد." };
  }

  // Link provenance → badge. Only an existing PROPOSAL row (content_id IS
  // NULL) can be claimed, and only for this article.
  if (input.jamalRunId) {
    const svc = createAdminClient() as unknown as SupabaseClient;
    await svc
      .from("jamal_runs")
      .update({ content_id: id })
      .eq("id", input.jamalRunId)
      .is("content_id", null);
  }

  revalidatePath("/admin/content");
  revalidatePath(`/admin/content/${id}`);
  return { ok: true };
}

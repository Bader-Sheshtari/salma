"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Newsletter Curation Engine V1 — server actions (staff-level: §34).
 *
 * The curation run itself (candidate gathering + deterministic selection +
 * one batched LLM copy pass) lives in the newsletter-curate edge function;
 * everything else here is plain issue/item editing under RLS. No sending,
 * no delivery (§35).
 */

const GENERIC = "تعذّر تنفيذ العملية — حاول مرة أخرى.";

type ActionResult = { ok: true; id?: string } | { error: string };

const VALID_SECTIONS = new Set([
  "lead", "top_missed", "economy", "gcc", "research", "qol",
  "trend", "expert", "transfers", "quick",
  // V1.1: editor-only pool («فرص تحريرية») — moving an item OUT of it into a
  // real section is the manual override the verification gate allows (§4).
  "opportunities",
]);

function issuePaths(id?: string): string[] {
  return id
    ? ["/admin/newsletter/issues", `/admin/newsletter/issues/${id}`]
    : ["/admin/newsletter/issues"];
}

async function staffClient(): Promise<SupabaseClient> {
  const supabase = await createClient();
  return supabase as unknown as SupabaseClient;
}

// --- Issue lifecycle ---------------------------------------------------------

export async function createNewsletterIssue(
  rangeStartIso: string,
  rangeEndIso: string,
): Promise<ActionResult> {
  const profile = await requireStaff();
  const start = new Date(rangeStartIso);
  const end = new Date(rangeEndIso);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    return { error: "نطاق التاريخ غير صالح." };
  }
  const client = await staffClient();
  const { data, error } = await client
    .from("newsletter_issues")
    .insert({
      status: "draft",
      range_start: start.toISOString(),
      range_end: end.toISOString(),
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error || !data) return { error: GENERIC };
  revalidatePath("/admin/newsletter/issues");
  return { ok: true, id: data.id as string };
}

/** Runs (or re-runs) the curation engine. Editor decisions survive re-runs. */
export async function curateNewsletterIssue(issueId: string): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: GENERIC };
  try {
    const { data, error } = await supabase.functions.invoke("newsletter-curate", {
      body: { op: "curate", issue_id: issueId },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error || !data || (data as { ok?: boolean }).ok === false) return { error: GENERIC };
  } catch {
    return { error: "تأخّر التجهيز أكثر من المعتاد — حدّث الصفحة بعد قليل." };
  }
  for (const p of issuePaths(issueId)) revalidatePath(p);
  return { ok: true, id: issueId };
}

export async function setIssueStatus(
  issueId: string,
  status: "draft" | "curated" | "ready" | "archived",
): Promise<ActionResult> {
  await requireStaff();
  const client = await staffClient();
  const { error } = await client
    .from("newsletter_issues").update({ status }).eq("id", issueId);
  if (error) return { error: GENERIC };
  for (const p of issuePaths(issueId)) revalidatePath(p);
  return { ok: true };
}

export async function saveIssueMeta(
  issueId: string,
  meta: { title?: string; intro_ar?: string; section_titles?: Record<string, string> },
): Promise<ActionResult> {
  await requireStaff();
  const update: Record<string, unknown> = {};
  if (meta.title !== undefined) update.title = meta.title.trim().slice(0, 180) || null;
  if (meta.intro_ar !== undefined) update.intro_ar = meta.intro_ar.trim().slice(0, 2000) || null;
  if (meta.section_titles !== undefined) {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta.section_titles)) {
      if (VALID_SECTIONS.has(k) && v.trim()) clean[k] = v.trim().slice(0, 120);
    }
    update.section_titles = Object.keys(clean).length ? clean : null;
  }
  if (Object.keys(update).length === 0) return { ok: true };
  const client = await staffClient();
  const { error } = await client.from("newsletter_issues").update(update).eq("id", issueId);
  if (error) return { error: GENERIC };
  for (const p of issuePaths(issueId)) revalidatePath(p);
  return { ok: true };
}

export async function deleteNewsletterIssue(issueId: string): Promise<ActionResult> {
  await requireStaff();
  const client = await staffClient();
  const { error } = await client.from("newsletter_issues").delete().eq("id", issueId);
  if (error) return { error: GENERIC };
  revalidatePath("/admin/newsletter/issues");
  return { ok: true };
}

// --- Item editing ------------------------------------------------------------

export async function setItemState(
  itemId: string,
  issueId: string,
  state: "accepted" | "rejected" | "suggested",
): Promise<ActionResult> {
  await requireStaff();
  const client = await staffClient();
  const { error } = await client
    .from("newsletter_items").update({ editor_state: state }).eq("id", itemId);
  if (error) return { error: GENERIC };
  for (const p of issuePaths(issueId)) revalidatePath(p);
  return { ok: true };
}

export async function saveItemCopy(
  itemId: string,
  issueId: string,
  copy: { headline?: string; teaser?: string; analysis?: string; why?: string },
): Promise<ActionResult> {
  await requireStaff();
  const update: Record<string, unknown> = {};
  if (copy.headline !== undefined) update.newsletter_headline = copy.headline.trim().slice(0, 200) || null;
  if (copy.teaser !== undefined) update.teaser = copy.teaser.trim().slice(0, 1500) || null;
  if (copy.analysis !== undefined) update.short_analysis = copy.analysis.trim().slice(0, 700) || null;
  if (copy.why !== undefined) update.why_ar = copy.why.trim().slice(0, 300) || null;
  if (Object.keys(update).length === 0) return { ok: true };
  const client = await staffClient();
  const { error } = await client.from("newsletter_items").update(update).eq("id", itemId);
  if (error) return { error: GENERIC };
  for (const p of issuePaths(issueId)) revalidatePath(p);
  return { ok: true };
}

export async function moveItem(
  itemId: string,
  issueId: string,
  target: { section?: string; direction?: "up" | "down" },
): Promise<ActionResult> {
  await requireStaff();
  const client = await staffClient();
  if (target.section) {
    if (!VALID_SECTIONS.has(target.section)) return { error: GENERIC };
    // Append at the end of the target section.
    const { data: maxRow } = await client
      .from("newsletter_items")
      .select("position")
      .eq("issue_id", issueId)
      .eq("section", target.section)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    const pos = ((maxRow as { position: number } | null)?.position ?? -1) + 1;
    const { error } = await client
      .from("newsletter_items")
      .update({ section: target.section, position: pos })
      .eq("id", itemId);
    if (error) return { error: GENERIC };
  } else if (target.direction) {
    const { data: me } = await client
      .from("newsletter_items")
      .select("id,section,position")
      .eq("id", itemId)
      .maybeSingle();
    if (!me) return { error: GENERIC };
    const row = me as { id: string; section: string; position: number };
    const { data: neighbor } = await client
      .from("newsletter_items")
      .select("id,position")
      .eq("issue_id", issueId)
      .eq("section", row.section)
      .filter("position", target.direction === "up" ? "lt" : "gt", row.position)
      .order("position", { ascending: target.direction === "down" })
      .limit(1)
      .maybeSingle();
    const n = neighbor as { id: string; position: number } | null;
    if (!n) return { ok: true }; // already at the edge
    // Swap positions.
    const { error: e1 } = await client
      .from("newsletter_items").update({ position: n.position }).eq("id", row.id);
    const { error: e2 } = await client
      .from("newsletter_items").update({ position: row.position }).eq("id", n.id);
    if (e1 || e2) return { error: GENERIC };
  }
  for (const p of issuePaths(issueId)) revalidatePath(p);
  return { ok: true };
}

export async function deleteItem(itemId: string, issueId: string): Promise<ActionResult> {
  await requireStaff();
  const client = await staffClient();
  const { error } = await client.from("newsletter_items").delete().eq("id", itemId);
  if (error) return { error: GENERIC };
  for (const p of issuePaths(issueId)) revalidatePath(p);
  return { ok: true };
}

/** Manually add a published Salma article by slug or id (§25). */
export async function addArticleItem(
  issueId: string,
  slugOrId: string,
  section: string,
): Promise<ActionResult> {
  await requireStaff();
  if (!VALID_SECTIONS.has(section)) return { error: GENERIC };
  const needle = slugOrId.trim();
  if (!needle) return { error: "أدخل رابط المقال أو معرّفه." };
  // Accept a full public URL, a slug, or a UUID.
  const slug = needle.includes("/article/")
    ? needle.split("/article/")[1]?.split(/[?#]/)[0] ?? needle
    : needle;
  const admin = createAdminClient() as unknown as SupabaseClient;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(needle);
  const { data: content } = await admin
    .from("content")
    .select("id,title,status")
    .is("deleted_at", null)
    .eq(isUuid ? "id" : "slug", isUuid ? needle : decodeURIComponent(slug))
    .maybeSingle();
  const row = content as { id: string; title: string; status: string } | null;
  if (!row) return { error: "لم يتم العثور على المقال." };
  if (row.status !== "published") return { error: "المقال غير منشور — النشرة تضم المنشور فقط." };
  const client = await staffClient();
  const { data: maxRow } = await client
    .from("newsletter_items")
    .select("position")
    .eq("issue_id", issueId).eq("section", section)
    .order("position", { ascending: false }).limit(1).maybeSingle();
  const pos = ((maxRow as { position: number } | null)?.position ?? -1) + 1;
  const { error } = await client.from("newsletter_items").insert({
    issue_id: issueId,
    item_type: "article",
    content_id: row.id,
    section,
    position: pos,
    newsletter_headline: row.title,
    verification_status: "verified",
    editor_state: "manual",
  });
  if (error) return { error: GENERIC };
  for (const p of issuePaths(issueId)) revalidatePath(p);
  return { ok: true };
}

/** Manually add an external newsletter-only item (§14, §25). */
export async function addExternalItem(
  issueId: string,
  input: {
    url: string;
    headline: string;
    sourceName?: string;
    author?: string;
    section: string;
    sourceType?: string;
  },
): Promise<ActionResult> {
  await requireStaff();
  if (!VALID_SECTIONS.has(input.section)) return { error: GENERIC };
  let url: URL;
  try {
    url = new URL(input.url.trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error("bad protocol");
  } catch {
    return { error: "رابط المصدر غير صالح." };
  }
  const headline = input.headline.trim().slice(0, 200);
  if (!headline) return { error: "أدخل عنوان العنصر." };
  const sourceType = ["official", "research", "institution", "media", "expert", "other"]
    .includes(input.sourceType ?? "") ? input.sourceType : "other";
  const client = await staffClient();
  const { data: maxRow } = await client
    .from("newsletter_items")
    .select("position")
    .eq("issue_id", issueId).eq("section", input.section)
    .order("position", { ascending: false }).limit(1).maybeSingle();
  const pos = ((maxRow as { position: number } | null)?.position ?? -1) + 1;
  const { error } = await client.from("newsletter_items").insert({
    issue_id: issueId,
    item_type: "external",
    external_url: url.href,
    external_source_name: input.sourceName?.trim().slice(0, 120) || url.hostname.replace(/^www\./, ""),
    external_source_domain: url.hostname.replace(/^www\./, ""),
    external_author: input.author?.trim().slice(0, 120) || null,
    external_source_type: sourceType,
    is_opinion: sourceType === "expert",
    section: input.section,
    position: pos,
    newsletter_headline: headline,
    verification_status: "needs_check", // manual externals start unverified
    editor_state: "manual",
  });
  if (error) return { error: GENERIC };
  for (const p of issuePaths(issueId)) revalidatePath(p);
  return { ok: true };
}

/** Mark a manually-added external item as source-verified (§14). */
export async function setItemVerification(
  itemId: string,
  issueId: string,
  status: "verified" | "needs_check",
): Promise<ActionResult> {
  await requireStaff();
  const client = await staffClient();
  const { error } = await client
    .from("newsletter_items").update({ verification_status: status }).eq("id", itemId);
  if (error) return { error: GENERIC };
  for (const p of issuePaths(issueId)) revalidatePath(p);
  return { ok: true };
}

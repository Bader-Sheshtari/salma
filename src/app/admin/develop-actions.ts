"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { DevelopmentDirection, DevelopmentJob } from "@/lib/develop-story";

/**
 * After the News / Develop Story — server actions.
 *
 * Staff-level (editor and above): Develop Story is a content-authority
 * feature, mirroring the content actions, NOT the admin-only synthesize path.
 * All writes happen inside the develop-story edge function (service role,
 * after its own staff check); it owns every terminal state write, so a
 * terminated server action can never orphan a job — the UI polls
 * getDevelopmentState and reads whatever the function wrote.
 */

const GENERIC = "تعذّر تنفيذ العملية — حاول مرة أخرى.";
// A researching/drafting row untouched this long is a dead run (matches the
// edge function's own healing threshold).
const STALE_RUN_MS = 12 * 60 * 1000;

type ActionResult = { ok: true; jobId: string | null; status?: string } | { error: string };

async function invokeDevelop(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return null;
  try {
    const { data, error } = await supabase.functions.invoke("develop-story", {
      body,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) return null;
    return (data ?? null) as Record<string, unknown> | null;
  } catch {
    // The invoke may time out while the edge function keeps running; the
    // caller's polling picks the terminal state up from the job row.
    return null;
  }
}

export async function startDevelopment(
  contentId: string,
  direction: DevelopmentDirection,
  editorNote: string,
): Promise<ActionResult> {
  await requireStaff();
  if (!contentId) return { error: GENERIC };
  const data = await invokeDevelop({
    op: "start",
    content_id: contentId,
    direction,
    editor_note: editorNote.trim().slice(0, 500),
  });
  if (!data) return { ok: true, jobId: null }; // keep polling — the function owns the state
  if (data.ok === false) return { error: GENERIC };
  return { ok: true, jobId: (data.job_id as string) ?? null, status: data.status as string };
}

export async function createDevelopedDraft(
  jobId: string,
  direction: DevelopmentDirection | null,
  editorNote: string,
): Promise<ActionResult> {
  await requireStaff();
  if (!jobId) return { error: GENERIC };
  const data = await invokeDevelop({
    op: "draft",
    job_id: jobId,
    ...(direction ? { direction } : {}),
    editor_note: editorNote.trim().slice(0, 500),
  });
  revalidatePath("/admin/content");
  if (!data) return { ok: true, jobId }; // polling resolves the outcome
  if (data.ok === false && !data.status) return { error: GENERIC };
  return { ok: true, jobId, status: data.status as string };
}

export async function cancelDevelopment(jobId: string): Promise<ActionResult> {
  await requireStaff();
  if (!jobId) return { error: GENERIC };
  await invokeDevelop({ op: "cancel", job_id: jobId });
  return { ok: true, jobId };
}

/**
 * Poll the latest development state for an article. Reads through RLS (staff
 * select policy); heals stale running rows first via the service client so a
 * dead run fails visibly instead of spinning forever.
 */
export async function getDevelopmentState(contentId: string): Promise<{
  job: DevelopmentJob | null;
  history: DevelopmentJob[];
  resultTitle: string | null;
}> {
  await requireStaff();
  const stale = new Date(Date.now() - STALE_RUN_MS).toISOString();
  try {
    await createAdminClient()
      .from("story_developments")
      .update({ status: "failed", phase: null, error_category: "timeout", error_message: "stale run healed" })
      .eq("original_content_id", contentId)
      .in("status", ["researching", "drafting"])
      .lt("updated_at", stale);
  } catch {
    // healing is best-effort
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("story_developments")
    .select(
      "id,original_content_id,requested_by,direction,draft_direction,editor_note,status,phase,error_category,error_message,research_brief,brief_sources,result_content_id,needs_human_review,editor_verdict,validation_warnings,cost,total_tokens,created_at,updated_at,research_completed_at,draft_completed_at",
    )
    .eq("original_content_id", contentId)
    .order("created_at", { ascending: false })
    .limit(10);
  const jobs = (data ?? []) as unknown as DevelopmentJob[];
  const job = jobs[0] ?? null;

  let resultTitle: string | null = null;
  if (job?.result_content_id) {
    const { data: result } = await supabase
      .from("content")
      .select("title")
      .eq("id", job.result_content_id)
      .maybeSingle();
    resultTitle = (result as { title: string } | null)?.title ?? null;
  }
  return { job, history: jobs.slice(1), resultTitle };
}

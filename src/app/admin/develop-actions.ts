"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  DevelopmentDirection,
  DevelopmentEvidence,
  DevelopmentJob,
  DevelopOrigin,
} from "@/lib/develop-story";

/**
 * After the News / Develop Story — server actions (V2: article OR Radar
 * cluster origins, adaptive depth with an optional deep override, evidence
 * provenance reads).
 *
 * Staff-level (editor and above). All writes happen inside the develop-story
 * edge function (service role, after its own staff check); it owns every
 * terminal state write, so a terminated server action can never orphan a job
 * — the UI polls getDevelopmentState and reads whatever the function wrote.
 */

const GENERIC = "تعذّر تنفيذ العملية — حاول مرة أخرى.";
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
  origin: DevelopOrigin,
  direction: DevelopmentDirection,
  editorNote: string,
  deepOverride = false,
): Promise<ActionResult> {
  await requireStaff();
  const data = await invokeDevelop({
    op: "start",
    ...(origin.type === "article" ? { content_id: origin.id } : { cluster_key: origin.key }),
    direction,
    editor_note: editorNote.trim().slice(0, 500),
    ...(deepOverride ? { depth: "deep" } : {}),
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
  if (!data) return { ok: true, jobId };
  if (data.ok === false && !data.status) return { error: GENERIC };
  return { ok: true, jobId, status: data.status as string };
}

export async function cancelDevelopment(jobId: string): Promise<ActionResult> {
  await requireStaff();
  if (!jobId) return { error: GENERIC };
  await invokeDevelop({ op: "cancel", job_id: jobId });
  return { ok: true, jobId };
}

const JOB_COLUMNS =
  "id,original_content_id,cluster_key,requested_by,direction,draft_direction,editor_note,status,phase,error_category,error_message,research_brief,brief_sources,result_content_id,needs_human_review,editor_verdict,validation_warnings,cost,total_tokens,created_at,updated_at,research_completed_at,draft_completed_at,research_prompt_version,research_depth,thread_id";

/**
 * Poll the latest development state for an origin (article or cluster).
 * Reads through RLS (staff select policy); heals stale running rows first via
 * the service client so a dead run fails visibly instead of spinning forever.
 */
export async function getDevelopmentState(origin: DevelopOrigin): Promise<{
  job: DevelopmentJob | null;
  history: DevelopmentJob[];
  resultTitle: string | null;
}> {
  await requireStaff();
  const stale = new Date(Date.now() - STALE_RUN_MS).toISOString();
  try {
    type Chain = { eq: (c: string, v: string) => Chain } & PromiseLike<unknown>;
    const heal = createAdminClient()
      .from("story_developments")
      .update({ status: "failed", phase: null, error_category: "timeout", error_message: "stale run healed" })
      .in("status", ["researching", "drafting"])
      .lt("updated_at", stale) as unknown as Chain;
    await (origin.type === "article"
      ? heal.eq("original_content_id", origin.id)
      : heal.eq("cluster_key", origin.key));
  } catch {
    // healing is best-effort
  }

  const supabase = await createClient();
  type SelChain = { eq: (c: string, v: string) => PromiseLike<{ data: unknown }> };
  const q = supabase
    .from("story_developments")
    .select(JOB_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(10) as unknown as SelChain;
  const { data } = await (origin.type === "article"
    ? q.eq("original_content_id", origin.id)
    : q.eq("cluster_key", origin.key));
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

/** The persisted evidence items for a job (RLS: staff read). */
export async function getDevelopmentEvidence(jobId: string): Promise<DevelopmentEvidence[]> {
  await requireStaff();
  if (!jobId) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("development_evidence")
    .select("id,kind,url,title,publisher,published_date,source_class,tier,is_primary,doi,pmid,nct_id,fetched,confidence")
    .eq("development_id", jobId)
    .order("id");
  return (data ?? []) as unknown as DevelopmentEvidence[];
}

// AFTER THE NEWS / DEVELOP STORY — V1 (edge orchestrator).
//
// A human-triggered, two-phase editorial workflow on top of the SAME pipeline
// modules ingest-news uses (nothing re-implemented):
//
//   op:"start"  — research phase. Fetches the original article's source,
//                 reuses Primary Source Escalation + Evidence Intelligence,
//                 builds a Research Brief (one structured LLM call) and stops
//                 at status 'brief_ready' for the editor.
//   op:"draft"  — after the editor confirms a direction: the shared
//                 writer → Editorial Director → fidelity chain (writeArticle)
//                 produces a NEW content row with status 'pending'. It NEVER
//                 auto-publishes and NEVER touches the original article.
//   op:"cancel" — marks an open job cancelled.
//
// Failure discipline (lesson of the silent Radar outage): every phase writes
// its terminal state (brief_ready / draft_ready / failed + category) BEFORE
// returning, so an abandoned HTTP caller can never orphan a job as "running";
// stale running rows are healed to failed by op:"start" and the admin poller.
// An empty/invalid model result is always 'failed', never success.
//
// Auth: a signed-in STAFF JWT (editor and above — Develop Story is a
// content-authority feature), or the project's service-role key (system
// caller: operational testing/automation; its holder already has full DB
// access). The anon key alone is always rejected.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  chatEvidence,
  chatJson,
  denoRawFetch,
  denoResolveDns,
  EDITOR_MODEL,
  EVIDENCE_MODEL,
  evidenceDbDeps,
  type LlmUsage,
  newUsage,
  resolveAnalysisSource,
  runEscalation,
  WRITER_CONFIG,
  writeArticle,
} from "../ingest-news/pipeline.ts";
import { fetchSourceText, type SourceText } from "../ingest-news/fetchSourceText.ts";
import {
  selectProfile,
  validateArticle,
  WRITER_PROMPT_VERSION,
  type WritingProfile,
} from "../ingest-news/salmaWriter.ts";
import { EDITOR_PROMPT_VERSION } from "../ingest-news/salmaEditor.ts";
import { analyzeEvidence, type EvidenceCard } from "../ingest-news/evidenceIntelligence.ts";
import { domainOf } from "../ingest-news/sourceEscalation.ts";
import {
  BRIEF_PROMPT_VERSION,
  BRIEF_RESPONSE_FORMAT,
  buildBriefMessages,
  buildDevelopmentInstructions,
  DEVELOP_EDITOR_OVERLAY,
  type DevelopmentDirection,
  DIRECTIONS,
  isDirection,
  parseBriefOutput,
  renderBriefOrientation,
  type ResearchBrief,
} from "./brief.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Statuses the workflow may develop FROM (never drafts/rejected/trash).
const DEVELOPABLE_STATUSES = ["published", "pending", "unpublished"];
// A researching/drafting row untouched this long is a dead run → failed.
const STALE_RUN_MS = 12 * 60 * 1000;

// Bounded material sizes (chars) for the brief/grounding corpus.
const MAX_ARTICLE_CHARS = 12_000;
const MAX_ORIGINAL_SOURCE_CHARS = 8_000;
const MAX_PRIMARY_SOURCE_CHARS = 10_000;

type Actor = { kind: "staff"; id: string } | { kind: "service"; id: null };

async function authorize(req: Request, admin: SupabaseClient): Promise<Actor | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt === ANON_KEY) return null;
  if (jwt === SERVICE_KEY) return { kind: "service", id: null };

  const authClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) {
    // Service-role caller whose key string differs from the injected env
    // (legacy JWT vs rotated representation): verify by CAPABILITY — only a
    // service key is authorized on the GoTrue admin API. Anon keys and user
    // JWTs get a 401/403 error here.
    try {
      const probe = createClient(SUPABASE_URL, jwt, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (!error) return { kind: "service", id: null };
    } catch {
      // not a service key — fall through to the rejection below
    }
    return null;
  }
  const { data: profile } = await admin
    .from("profiles")
    .select("role,disabled")
    .eq("id", user.id)
    .maybeSingle();
  if (
    profile &&
    ["editor", "admin", "super_admin", "owner"].includes(profile.role) &&
    !profile.disabled
  ) {
    return { kind: "staff", id: user.id };
  }
  return null;
}

function slugify(input: string): string {
  return (
    input
      .trim()
      .replace(/[ً-ٟؐ-ؚ]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .toLowerCase() || "story"
  );
}

const trunc = (s: string | null | undefined, n: number): string => (s ?? "").slice(0, n);

/** Map the deterministic writing profile onto an escalation story type. */
function storyTypeForProfile(profile: WritingProfile): string {
  switch (profile) {
    case "research_study":
      return "scientific_study";
    case "safety_alert":
      return "product_safety_or_recall";
    case "regulation_or_service":
      return "regulatory_decision";
    default:
      return "general";
  }
}

type ContentRow = {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  body: string | null;
  status: string;
  category_slug: string | null;
  source_name: string | null;
  source_url: string | null;
  original_title: string | null;
  original_url: string | null;
  source_lang: string | null;
  published_at: string | null;
  cover_image_url: string | null;
  cover_credit_name: string | null;
  cover_credit_url: string | null;
  source_image_url: string | null;
  deleted_at: string | null;
};

type JobPatch = Record<string, unknown>;

async function patchJob(admin: SupabaseClient, id: string, patch: JobPatch, expectStatus?: string[]) {
  let q = admin.from("story_developments").update(patch).eq("id", id);
  if (expectStatus && expectStatus.length) q = q.in("status", expectStatus);
  await q;
}

async function addJobUsage(admin: SupabaseClient, id: string, usage: LlmUsage) {
  const { data } = await admin
    .from("story_developments")
    .select("openrouter_calls,prompt_tokens,completion_tokens,total_tokens,cost")
    .eq("id", id)
    .maybeSingle();
  if (!data) return;
  await admin.from("story_developments").update({
    openrouter_calls: (data.openrouter_calls ?? 0) + usage.calls,
    prompt_tokens: (data.prompt_tokens ?? 0) + usage.prompt_tokens,
    completion_tokens: (data.completion_tokens ?? 0) + usage.completion_tokens,
    total_tokens: (data.total_tokens ?? 0) + usage.total_tokens,
    cost: Number(data.cost ?? 0) + usage.cost,
  }).eq("id", id);
}

// ---- Phase 1: research ------------------------------------------------------

async function runResearch(admin: SupabaseClient, jobId: string, original: ContentRow, direction: DevelopmentDirection, editorNote: string | null): Promise<void> {
  const usage = newUsage();
  const started = Date.now();
  const fail = async (category: string, message: string) => {
    await patchJob(admin, jobId, {
      status: "failed",
      phase: null,
      error_category: category,
      error_message: message.slice(0, 500),
      research_duration_ms: Date.now() - started,
    }, ["researching"]);
    await addJobUsage(admin, jobId, usage);
  };

  try {
    const articleBody = trunc(original.body, MAX_ARTICLE_CHARS);
    const sourceUrl = original.original_url || original.source_url || null;

    // 1. Fetch the original external source (best-effort; the Salma article
    //    itself is already human-reviewed material).
    await patchJob(admin, jobId, { phase: "fetching_sources" }, ["researching"]);
    let originalSource: SourceText | null = null;
    if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
      const f = await fetchSourceText({
        url: sourceUrl,
        registeredDomain: domainOf(sourceUrl),
        sourceName: original.source_name,
        rawFetch: denoRawFetch,
        resolveDns: denoResolveDns,
      }).catch(() => null);
      if (f && f.ok) originalSource = f;
    }

    // 2. Primary Source Escalation (shared infrastructure + its cluster cache;
    //    develop jobs use the dev:<content_id> namespace).
    await patchJob(admin, jobId, { phase: "escalating" }, ["researching"]);
    const routingText = [original.title, original.excerpt ?? "", articleBody, originalSource?.text ?? ""].join("\n");
    const profile = selectProfile({ sourceText: routingText });
    const clusterKey = `dev:${original.id}`;
    let escalation = null;
    let primarySource: SourceText | null = null;
    let primaryUrl: string | null = null;
    if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
      escalation = await runEscalation(admin, {
        clusterKey,
        storyType: storyTypeForProfile(profile),
        discoveryUrl: sourceUrl,
        discoveryDomain: domainOf(sourceUrl),
        title: original.original_title ?? original.title,
        titleAr: original.title,
      });
      const editorialUrl = escalation.selected_editorial_source?.url;
      if (
        escalation.status === "upgraded" && editorialUrl && /^https?:\/\//i.test(editorialUrl) &&
        editorialUrl !== sourceUrl
      ) {
        const resolved = await resolveAnalysisSource(escalation, sourceUrl);
        primaryUrl = escalation.selected_editorial_source.url;
        if (resolved.url !== sourceUrl) {
          const pf = await fetchSourceText({
            url: resolved.url,
            registeredDomain: domainOf(resolved.url),
            sourceName: null,
            rawFetch: denoRawFetch,
            resolveDns: denoResolveDns,
          }).catch(() => null);
          if (pf && pf.ok) primarySource = pf;
        }
      }
    }

    // 3. Evidence Intelligence: reuse the card already linked to this article
    //    when one exists (ESL promotions); otherwise run the bounded analysis
    //    over the strongest fetched text (cached under dev:<id>).
    await patchJob(admin, jobId, { phase: "analyzing_evidence" }, ["researching"]);
    let card: EvidenceCard | null = null;
    const { data: existingCard } = await admin
      .from("radar_evidence_intelligence")
      .select("card,analysis_status")
      .eq("content_id", original.id)
      .maybeSingle();
    if (existingCard?.analysis_status === "complete" && existingCard.card) {
      card = existingCard.card as EvidenceCard;
    } else {
      const analysisText = primarySource ?? originalSource;
      if (analysisText) {
        const outcome = await analyzeEvidence(
          {
            clusterKey,
            storyType: storyTypeForProfile(profile),
            sourceUrl: analysisText.finalUrl,
            sourceDomain: domainOf(analysisText.finalUrl),
            sourceTitle: analysisText.title || null,
            sourceText: analysisText.text,
            sourceKind: primarySource ? "primary" : "discovery_fallback",
            editorialPrimaryUrl: primaryUrl,
          },
          { ...evidenceDbDeps(admin), chat: (m) => chatEvidence(m, { usage }) },
        ).catch(() => null);
        if (outcome?.status === "complete" && outcome.card) card = outcome.card;
      }
    }

    // 4. Prior Salma coverage for context (same category, recent, published).
    const { data: related } = await admin
      .from("content")
      .select("title,published_at")
      .eq("status", "published")
      .is("deleted_at", null)
      .neq("id", original.id)
      .eq("category_slug", original.category_slug ?? "")
      .order("published_at", { ascending: false })
      .limit(8);

    // 5. ONE structured brief call.
    await patchJob(admin, jobId, { phase: "building_brief" }, ["researching"]);
    const messages = buildBriefMessages({
      original: {
        title: original.title,
        excerpt: original.excerpt,
        body: articleBody,
        categorySlug: original.category_slug,
        publishedAt: original.published_at,
        sourceName: original.source_name,
        sourceUrl,
      },
      originalSourceText: trunc(originalSource?.text, MAX_ORIGINAL_SOURCE_CHARS),
      primarySourceText: trunc(primarySource?.text, MAX_PRIMARY_SOURCE_CHARS),
      primarySourceUrl: primarySource ? primarySource.finalUrl : primaryUrl,
      evidenceCardJson: card ? JSON.stringify(card) : null,
      relatedItems: (related ?? []).map((r) => ({ title: r.title, publishedAt: r.published_at })),
      requestedDirection: direction,
      editorNote,
    });
    const res = await chatJson(messages, {
      model: EVIDENCE_MODEL,
      // Reasoning-capable models count internal thinking toward the cap and
      // the Arabic brief JSON is token-dense; 10000 avoids the truncated-
      // completion failures observed at 6000 (same lesson as chatEvidence).
      maxTokens: 10_000,
      temperature: 0,
      responseFormat: BRIEF_RESPONSE_FORMAT,
      timeoutMs: 120_000,
      usage,
    });
    if (!res.ok) {
      await fail("research_model_failed", res.reason);
      return;
    }
    const parsed = parseBriefOutput(res.content);
    if (!parsed.ok) {
      await fail("brief_parse_failed", parsed.error);
      return;
    }

    // 6. Grounding corpus for the draft phase: the Salma article (verified,
    //    human-reviewed) + every successfully FETCHED external text. Stored so
    //    a draft retry grounds against exactly this material.
    const corpusParts = [
      `مقال سلمى المنشور:\n${original.title}\n${original.excerpt ?? ""}\n${articleBody}`,
      originalSource
        ? `نص المصدر الأصلي (${originalSource.finalUrl}):\n${originalSource.title}\n${trunc(originalSource.text, MAX_ORIGINAL_SOURCE_CHARS)}`
        : "",
      primarySource
        ? `نص المصدر الأولي (${primarySource.finalUrl}):\n${primarySource.title}\n${trunc(primarySource.text, MAX_PRIMARY_SOURCE_CHARS)}`
        : "",
    ].filter(Boolean);
    const mustPreserve = [
      ...new Set([...(originalSource?.mustPreserve ?? []), ...(primarySource?.mustPreserve ?? [])]),
    ].slice(0, 24);
    const briefSources = [
      sourceUrl
        ? {
          url: sourceUrl,
          domain: domainOf(sourceUrl),
          role: "original_source",
          label: original.source_name || domainOf(sourceUrl),
          fetched: Boolean(originalSource),
        }
        : null,
      primaryUrl
        ? {
          url: primaryUrl,
          domain: domainOf(primaryUrl),
          role: "editorial_primary",
          label: domainOf(primaryUrl),
          fetched: Boolean(primarySource),
          tier: escalation?.selected_editorial_source?.tier ?? null,
        }
        : null,
      escalation?.supporting_url
        ? { url: escalation.supporting_url, domain: domainOf(escalation.supporting_url), role: "supporting", label: domainOf(escalation.supporting_url), fetched: false }
        : null,
    ].filter(Boolean);

    await patchJob(admin, jobId, {
      status: "brief_ready",
      phase: null,
      research_brief: parsed.brief,
      brief_sources: briefSources,
      evidence_cluster_key: card ? clusterKey : null,
      escalation: escalation
        ? { status: escalation.status, method: escalation.method, editorial: escalation.selected_editorial_source, supporting_url: escalation.supporting_url, upgrade_reason: escalation.upgrade_reason }
        : null,
      draft_inputs: {
        corpus: corpusParts.join("\n\n"),
        must_preserve: mustPreserve,
        source_name: primarySource ? domainOf(primarySource.finalUrl) : (original.source_name || (sourceUrl ? domainOf(sourceUrl) : "سلمى")),
        source_url: primarySource?.finalUrl ?? sourceUrl,
        profile,
      },
      research_model: EVIDENCE_MODEL,
      research_prompt_version: BRIEF_PROMPT_VERSION,
      research_duration_ms: Date.now() - started,
      research_completed_at: new Date().toISOString(),
    }, ["researching"]);
    await addJobUsage(admin, jobId, usage);
  } catch (e) {
    await fail("research_error", e instanceof Error ? e.message : String(e));
  }
}

// ---- Phase 2: draft -----------------------------------------------------------

async function runDraft(admin: SupabaseClient, jobId: string, original: ContentRow, direction: Exclude<DevelopmentDirection, "auto">, editorNote: string | null): Promise<{ contentId: string } | { error: string }> {
  const usage = newUsage();
  const started = Date.now();
  const fail = async (category: string, message: string) => {
    await patchJob(admin, jobId, {
      status: "failed",
      phase: null,
      error_category: category,
      error_message: message.slice(0, 500),
      draft_duration_ms: Date.now() - started,
    }, ["drafting"]);
    await addJobUsage(admin, jobId, usage);
  };

  try {
    const { data: job } = await admin
      .from("story_developments")
      .select("research_brief,draft_inputs")
      .eq("id", jobId)
      .maybeSingle();
    const brief = (job?.research_brief ?? null) as ResearchBrief | null;
    const inputs = (job?.draft_inputs ?? null) as
      | { corpus: string; must_preserve: string[]; source_name: string | null; source_url: string | null; profile: WritingProfile }
      | null;
    if (!brief || !inputs?.corpus) {
      await fail("missing_brief", "research brief unavailable");
      return { error: "missing_brief" };
    }

    await patchJob(admin, jobId, { phase: "writing" }, ["drafting"]);
    // The grounding corpus is already assembled plain text — "main" is the
    // closest ExtractionMethod and the field is audit-only downstream.
    const verified: SourceText = {
      ok: true,
      title: original.title,
      text: inputs.corpus,
      method: "main",
      publishedDate: null,
      charCount: inputs.corpus.length,
      wordCount: inputs.corpus.split(/\s+/).filter(Boolean).length,
      finalUrl: inputs.source_url || `https://salma.health/article/${original.slug}`,
      mustPreserve: inputs.must_preserve ?? [],
    };

    let card: EvidenceCard | null = null;
    const { data: cardRow } = await admin
      .from("radar_evidence_intelligence")
      .select("card,analysis_status")
      .or(`content_id.eq.${original.id},cluster_key.eq.dev:${original.id}`)
      .eq("analysis_status", "complete")
      .limit(1)
      .maybeSingle();
    if (cardRow?.card) card = cardRow.card as EvidenceCard;

    const outcome = await writeArticle({
      verified,
      // The research brief rides in the UNVERIFIED-orientation slot: fenced
      // off from factual grounding exactly like discovery leads.
      discovery: { originalTitle: "", excerpt: "", body: renderBriefOrientation(brief) },
      sourceName: inputs.source_name,
      registeredDomain: inputs.source_url ? domainOf(inputs.source_url) : null,
      citationTitles: [],
      sourceLang: null,
      evidence: card,
      profile: inputs.profile,
      extraInstructions: buildDevelopmentInstructions({ direction, editorNote }),
      editorExtraInstructions: DEVELOP_EDITOR_OVERLAY,
      // Develop Story always writes on the premium route (flagship quality,
      // tiny volume). EVIDENCE_MODEL (claude-sonnet tier, not overridden by
      // the pilot-era writer env vars) is pinned for BOTH routes so no env
      // combination can silently downgrade the develop writer.
      config: {
        defaultModel: EVIDENCE_MODEL,
        sensitiveModel: EVIDENCE_MODEL,
        fallbackModel: WRITER_CONFIG.fallbackModel,
      },
      writerMaxTokens: 6000,
      usage,
    });

    if (!outcome.ok) {
      await patchJob(admin, jobId, {
        editorial_audit: outcome.editorial ?? null,
        fidelity_audit: outcome.fidelity ?? null,
        writer_model: WRITER_CONFIG.sensitiveModel,
        writer_prompt_version: WRITER_PROMPT_VERSION,
        editor_model: EDITOR_MODEL,
        editor_prompt_version: EDITOR_PROMPT_VERSION,
        writing_profile: inputs.profile,
      }, ["drafting"]);
      await fail("draft_rejected", outcome.rejection);
      return { error: outcome.rejection };
    }

    // Persisted validation snapshot (§17): warnings for THIS final draft.
    const finalValidation = validateArticle({
      article: { ...outcome.article, profile: inputs.profile },
      source: { sourceText: inputs.corpus, mustPreserve: inputs.must_preserve, sourceLang: null },
    });

    await patchJob(admin, jobId, { phase: "saving" }, ["drafting"]);
    const slug = `${slugify(outcome.article.title)}-${Math.random().toString(36).slice(2, 7)}`;
    const { data: inserted, error: insErr } = await admin
      .from("content")
      .insert({
        type: "article",
        status: "pending",
        origin: "ai",
        title: outcome.article.title,
        slug,
        excerpt: outcome.article.excerpt,
        ai_summary: outcome.article.summary ?? null,
        body: outcome.article.body,
        read_minutes: outcome.readMinutes,
        category_slug: original.category_slug,
        source_name: inputs.source_name,
        source_url: inputs.source_url,
        original_title: original.original_title ?? original.title,
        original_url: inputs.source_url,
        cover_image_url: original.cover_image_url,
        cover_credit_name: original.cover_credit_name,
        cover_credit_url: original.cover_credit_url,
        source_image_url: original.source_image_url,
        developed_from_content_id: original.id,
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      await fail("content_insert_failed", insErr?.message ?? "insert failed");
      return { error: "content_insert_failed" };
    }

    // Research provenance rows (visible in the admin sources list).
    const { data: jobRow } = await admin
      .from("story_developments")
      .select("brief_sources")
      .eq("id", jobId)
      .maybeSingle();
    const provenance = (Array.isArray(jobRow?.brief_sources) ? jobRow!.brief_sources : []) as
      { url: string; role: string; label: string }[];
    const labels: Record<string, string> = {
      original_source: "مصدر الخبر الأصلي",
      editorial_primary: "المصدر الأولي",
      supporting: "سياق مستقل",
    };
    const sourceRows = provenance
      .filter((s) => s.url)
      .map((s) => ({ content_id: inserted.id, label: `${labels[s.role] ?? "مصدر"}: ${s.label}`, url: s.url }));
    if (sourceRows.length) await admin.from("content_sources").insert(sourceRows);

    await patchJob(admin, jobId, {
      status: "draft_ready",
      phase: null,
      error_category: null,
      error_message: null,
      result_content_id: inserted.id,
      draft_direction: direction,
      writing_profile: inputs.profile,
      writer_model: outcome.audit.writer_model_used ?? WRITER_CONFIG.sensitiveModel,
      writer_prompt_version: WRITER_PROMPT_VERSION,
      editor_model: EDITOR_MODEL,
      editor_prompt_version: EDITOR_PROMPT_VERSION,
      editor_verdict: (outcome.editorial as { final_editorial_verdict?: string } | null)?.final_editorial_verdict ?? null,
      editorial_audit: outcome.editorial ?? null,
      fidelity_audit: outcome.fidelity ?? null,
      validation_warnings: finalValidation.warnings,
      needs_human_review: outcome.needsHumanReview,
      draft_duration_ms: Date.now() - started,
      draft_completed_at: new Date().toISOString(),
    }, ["drafting"]);
    await addJobUsage(admin, jobId, usage);
    return { contentId: inserted.id };
  } catch (e) {
    await fail("draft_error", e instanceof Error ? e.message : String(e));
    return { error: "draft_error" };
  }
}

// ---- HTTP handler --------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const actor = await authorize(req, admin);
  if (!actor) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const op = String(body.op ?? "");

  if (op === "cancel") {
    const jobId = String(body.job_id ?? "");
    if (!jobId) return Response.json({ ok: false, error: "job_id required" }, { status: 400 });
    await admin
      .from("story_developments")
      .update({ status: "cancelled", phase: null })
      .eq("id", jobId)
      .in("status", ["researching", "brief_ready", "drafting", "failed"]);
    return Response.json({ ok: true });
  }

  if (op === "start") {
    const contentId = String(body.content_id ?? "");
    const direction = body.direction;
    const editorNote = String(body.editor_note ?? "").trim().slice(0, 500) || null;
    if (!contentId || !isDirection(direction)) {
      return Response.json({ ok: false, error: "content_id and valid direction required" }, { status: 400 });
    }

    const { data: original } = await admin
      .from("content")
      .select(
        "id,title,slug,excerpt,body,status,category_slug,source_name,source_url,original_title,original_url,source_lang,published_at,cover_image_url,cover_credit_name,cover_credit_url,source_image_url,deleted_at",
      )
      .eq("id", contentId)
      .maybeSingle();
    if (!original || original.deleted_at || !DEVELOPABLE_STATUSES.includes(original.status)) {
      return Response.json({ ok: false, error: "article not developable" }, { status: 422 });
    }
    if (!original.body || original.body.trim().length < 80) {
      return Response.json({ ok: false, error: "article body too short" }, { status: 422 });
    }

    // Heal a dead run so it never blocks the editor forever.
    await admin
      .from("story_developments")
      .update({ status: "failed", phase: null, error_category: "timeout", error_message: "stale run healed" })
      .eq("original_content_id", contentId)
      .in("status", ["researching", "drafting"])
      .lt("updated_at", new Date(Date.now() - STALE_RUN_MS).toISOString());

    const { data: job, error: insErr } = await admin
      .from("story_developments")
      .insert({
        original_content_id: contentId,
        requested_by: actor.id,
        direction,
        editor_note: editorNote,
        status: "researching",
        phase: "fetching_sources",
      })
      .select("id")
      .single();
    if (insErr || !job) {
      // Unique active-job index: an open development already exists (double
      // click / second tab) — return it instead of erroring (§ graceful).
      if (insErr?.code === "23505") {
        const { data: active } = await admin
          .from("story_developments")
          .select("id,status")
          .eq("original_content_id", contentId)
          .in("status", ["researching", "brief_ready", "drafting"])
          .maybeSingle();
        return Response.json({ ok: true, job_id: active?.id ?? null, existing: true });
      }
      return Response.json({ ok: false, error: "could not create job" }, { status: 500 });
    }

    // Research runs INSIDE this request; the terminal state is written before
    // we return (and also survives an abandoned caller — see fail()).
    await runResearch(admin, job.id, original as ContentRow, direction, editorNote);
    const { data: done } = await admin
      .from("story_developments")
      .select("status,error_category")
      .eq("id", job.id)
      .maybeSingle();
    return Response.json({ ok: true, job_id: job.id, status: done?.status ?? "failed" });
  }

  if (op === "draft") {
    const jobId = String(body.job_id ?? "");
    const rawDirection = body.direction;
    const editorNote = String(body.editor_note ?? "").trim().slice(0, 500) || null;
    if (!jobId) return Response.json({ ok: false, error: "job_id required" }, { status: 400 });

    const { data: job } = await admin
      .from("story_developments")
      .select("id,original_content_id,status,direction,editor_note,research_brief")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) return Response.json({ ok: false, error: "job not found" }, { status: 404 });
    // brief_ready → draft; failed-with-brief → retry draft.
    if (!(job.status === "brief_ready" || (job.status === "failed" && job.research_brief))) {
      return Response.json({ ok: false, error: `job not draftable (${job.status})` }, { status: 409 });
    }

    // Resolve the concrete direction: editor's pick → requested → brief's
    // recommended angle → deeper_explainer.
    let direction = isDirection(rawDirection) && rawDirection !== "auto" ? rawDirection : null;
    if (!direction && isDirection(job.direction) && job.direction !== "auto") direction = job.direction;
    if (!direction) {
      const angles = ((job.research_brief ?? {}) as ResearchBrief).suggested_angles ?? [];
      const rec = angles.find((a) => a.recommended) ?? angles[0];
      direction = rec && rec.direction in DIRECTIONS ? rec.direction : "deeper_explainer";
    }

    const { data: locked } = await admin
      .from("story_developments")
      .update({ status: "drafting", phase: "writing", draft_direction: direction, ...(editorNote ? { editor_note: editorNote } : {}) })
      .eq("id", jobId)
      .in("status", ["brief_ready", "failed"])
      .select("id")
      .maybeSingle();
    if (!locked) return Response.json({ ok: false, error: "job already drafting" }, { status: 409 });

    const { data: original } = await admin
      .from("content")
      .select(
        "id,title,slug,excerpt,body,status,category_slug,source_name,source_url,original_title,original_url,source_lang,published_at,cover_image_url,cover_credit_name,cover_credit_url,source_image_url,deleted_at",
      )
      .eq("id", job.original_content_id)
      .maybeSingle();
    if (!original) {
      await patchJob(admin, jobId, { status: "failed", phase: null, error_category: "original_missing", error_message: "original article missing" }, ["drafting"]);
      return Response.json({ ok: false, error: "original missing" }, { status: 422 });
    }

    const r = await runDraft(admin, jobId, original as ContentRow, direction, editorNote ?? (job.editor_note as string | null));
    const { data: done } = await admin
      .from("story_developments")
      .select("status,result_content_id,error_category,error_message")
      .eq("id", jobId)
      .maybeSingle();
    return Response.json({
      ok: "contentId" in r,
      job_id: jobId,
      status: done?.status ?? "failed",
      content_id: done?.result_content_id ?? null,
      error: "error" in r ? r.error : null,
    });
  }

  return Response.json({ ok: false, error: "unknown op" }, { status: 400 });
});

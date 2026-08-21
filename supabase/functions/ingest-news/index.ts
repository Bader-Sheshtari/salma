// Salma news-ingestion agent — runs entirely inside Supabase (Deno).
//
// Auth (verify_jwt is disabled; this function does its own checks):
//   - Cron path: pg_cron -> run_news_ingestion() sends header
//     `x-ingest-secret` matching the INGEST_SECRET function secret.
//   - Manual path: the admin UI invokes this function with the admin's
//     session JWT in the Authorization header; we verify role = 'admin'.
//
// Required function secrets: OPENROUTER_API_KEY, INGEST_SECRET.
// Optional: OPENROUTER_MODEL. SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  blockedDomains,
  buildRegistryIndex,
  type Candidate,
  type DecisionReason,
  discoveryDomains,
  DRAFT_STATUS,
  failsPrGate,
  hostFromUrl,
  isRejectionReason,
  matchSource,
  pickFinalSource,
  type RegistrySource,
  type RejectionReason,
  registryUsable,
  resolveAuthorizedTargetedSource,
} from "./registry.ts";
import { clusterStories, pickBestIndex, type StoryText, storyDuplicate } from "./dedupe.ts";
import { finalizeRun, selectRollbackTargets } from "./runFinalize.ts";
import {
  buildWritingInstructions,
  causationAsserted,
  parseWriterOutput,
  readingTimeMinutes,
  selectProfile,
  validateArticle,
  WRITER_PROMPT_VERSION,
} from "./salmaWriter.ts";
import {
  assertWriterConfig,
  evaluateWriterCompletion,
  isForbiddenWriterModel,
  orchestrateWriter,
  processRepresentativesWithLimit,
  resolvePilotGate,
  type WriterHttpResult,
  type WriterMode,
  type WriterModelConfig,
  type WriterValidation,
} from "./writerRouter.ts";
import {
  buildEditorInstructions,
  buildFactPacket,
  type EditorArticle,
  EDITOR_PROMPT_VERSION,
  EDITOR_RESPONSE_FORMAT,
  type EditorCallResult,
  type EditorialAudit,
  renderEditorPacket,
  runEditorPass,
} from "./salmaEditor.ts";
import {
  fetchSourceText,
  groundedWrite,
  isBlockedHostname,
  NEUTRAL_USER_AGENT,
  type RawResponse,
  type SourceFetchResult,
  type SourceText,
  validateResolvedAddresses,
} from "./fetchSourceText.ts";
import { type ErPost, fetchErArticleSource } from "./erSourceFallback.ts";
import {
  escalate,
  domainOf as escDomainOf,
  roleTier as escRoleTier,
  type EscalationInput,
  type EscalationResult,
  type RegistryEntry as EscRegistryEntry,
  type StoryType as EscStoryType,
} from "./sourceEscalation.ts";
import {
  type FidelityArticle,
  type FidelityRepairAudit,
  type FidelityValidation,
  finalizeWriterDraft,
} from "./fidelityRepair.ts";
import {
  analyzeEvidence,
  associationGuardApplies,
  type EvidenceCard,
  type EvidenceInput,
  type EvidenceOutcome,
  type EvidenceSourceKind,
  type EvidenceSourceStatus,
  type EvidenceStatus,
  EVIDENCE_PROMPT_VERSION,
  EVIDENCE_RESPONSE_FORMAT,
  renderEvidenceGuidanceBlock,
} from "./evidenceIntelligence.ts";

// Evidence Intelligence analysis model. Medical/evidence interpretation needs a
// capable model (accuracy > minimal token cost) — default to the same tier as
// the sensitive writer route. Bounded to ≤ the ESL daily cap of stories/day,
// one call each, cached per canonical cluster.
const EVIDENCE_MODEL = Deno.env.get("EVIDENCE_MODEL") || "anthropic/claude-sonnet-5";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = Deno.env.get("OPENROUTER_MODEL") || "openai/gpt-oss-20b:free";
// Bumped when the editorial prompt/decision schema changes; recorded per decision.
const PROMPT_VERSION = "e1.1";

// E1.3C writer-model routing. Kept SEPARATE from OPENROUTER_MODEL (which still
// controls the discovery/editorial-selection call). Safe defaults match the
// approved E1.3B pilot routing; each can be overridden by its own env var.
// google/gemini-3-flash-preview must never be configured here (assertWriterConfig
// enforces this at run start).
const WRITER_CONFIG: WriterModelConfig = {
  defaultModel: Deno.env.get("OPENROUTER_WRITER_DEFAULT_MODEL") || "openai/gpt-5.4-mini",
  sensitiveModel: Deno.env.get("OPENROUTER_WRITER_SENSITIVE_MODEL") || "anthropic/claude-sonnet-5",
  fallbackModel: Deno.env.get("OPENROUTER_WRITER_FALLBACK_MODEL") || "openai/gpt-4o-mini",
};

// E1.4A editorial-director model. Configured INDEPENDENTLY of the writer route
// (its own env var) so the editor model can be tuned without touching writer
// routing. It runs once on every validated writer draft; there is no fallback
// and no retry. google/gemini-3-flash-preview must never be configured here
// (assertEditorConfig enforces this at run start, same rule as the writer).
const EDITOR_MODEL = Deno.env.get("OPENROUTER_EDITOR_MODEL") || "openai/gpt-5.4-mini";

function assertEditorConfig(model: string): void {
  if (!model || !model.trim()) throw new Error("editor model is not configured");
  if (isForbiddenWriterModel(model)) {
    throw new Error(`forbidden editor model configured: ${model}`);
  }
}

// Fallback set, used only if the categories table can't be read. The live list
// is fetched from the DB per run so admin-created categories work too.
const FALLBACK_CATEGORIES = [
  "kuwait",
  "gulf",
  "world",
  "health-economy",
  "lifestyle",
  "investigations",
];

async function fetchCategorySlugs(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from("categories").select("slug").order("sort_order");
  const slugs = (data as { slug: string }[] | null)?.map((c) => c.slug) ?? [];
  return slugs.length > 0 ? slugs : FALLBACK_CATEGORIES;
}

// Loads the active source registry fresh at the start of every run. Never
// throws: returns `ok: false` when the query itself failed, so the caller can
// fail safe (abort the run, create no drafts) instead of silently weakening
// source verification.
async function loadRegistry(
  db: SupabaseClient,
): Promise<{ sources: RegistrySource[]; index: Map<string, RegistrySource>; ok: boolean }> {
  try {
    const { data, error } = await db
      .from("news_sources")
      .select(
        "name,domain,region,source_type,tier,trust_score,discovery_enabled,final_source_allowed,active",
      )
      .eq("active", true);
    if (error || !data) return { sources: [], index: new Map(), ok: false };
    const sources = data as RegistrySource[];
    return { sources, index: buildRegistryIndex(sources), ok: true };
  } catch {
    return { sources: [], index: new Map(), ok: false };
  }
}

// Thrown when the source registry cannot be loaded/verified. Surfaced to the
// admin as a clear operational error; the run creates no drafts.
class RegistryUnavailableError extends Error {
  constructor() {
    super("source registry unavailable — ingestion aborted, no drafts created");
    this.name = "RegistryUnavailableError";
  }
}

const REGION_LABELS: Record<string, string> = {
  kuwait: "الكويت",
  gulf: "دول الخليج (السعودية، الإمارات، قطر، البحرين، عُمان)",
  mena: "الشرق الأوسط وشمال أفريقيا",
  world: "العالم",
};

type Citation = { url: string; title: string };
type WebChatResult = { content: string; citations: Citation[] };

type Policy = {
  block_topics: string[];
  priority_topics: string[];
  trusted_sources: string[];
  regions: string[];
};

type RunStats = { found: number; kept: number; filtered: number; duplicates: number };

// E1.3E single-article pilot report. Operational-only: it carries NO extracted
// source text, API keys, tokens, or request headers — just the counts an
// operator needs to confirm the first controlled pilot processed exactly one
// candidate. Returned to the manual caller only AFTER the mandatory audit has
// persisted (runIngestion throws otherwise, so a reported pilot is always audited).
type PilotReport = {
  writer_mode: "pilot";
  pilot_limit: number;
  candidates_considered: number;
  source_fetches_attempted: number;
  writer_calls_attempted: number;
  fallback_calls_attempted: number;
  // Writer JSON-recovery observability: total writer model calls for the pilot
  // draft and whether the second call was the strict-JSON reparse recovery.
  writer_attempts: number;
  writer_second_attempt: "none" | "json_recovery";
  pending_articles_created: number;
  rejection_reason: string | null;
  created_content_id: string | null;
  // E1.4A: the editorial-director audit for the single draft that reached the
  // editor stage (null until then). Observability-only — surfaced in the HTTP
  // pilot report, NOT persisted to ingestion_decisions (no migration).
  editorial: EditorialAudit | null;
  editor_prompt_version: string | null;
  // Post-editor source-fidelity stage audit (original error, repair attempt,
  // repair outcome, final validation, needs_human_review). Observability-only.
  fidelity: FidelityRepairAudit | null;
  // True when the pilot draft became pending WITH an unresolved omission warning.
  needs_human_review: boolean;
  // True when the targeted source was resolved via the URL-scoped human-authorized
  // Radar bypass (synthetic transient source) rather than a registered news_source.
  authorized_source_bypass: boolean;
};

type Draft = {
  title: string;
  excerpt: string;
  body: string;
  category_slug: string | null;
  read_minutes: number;
  relevance_score: number;
  original_title: string;
  source_url: string;
  // E1.1 editorial-selection fields (model-supplied, then code-verified).
  primary_source_url: string;
  secondary_source_urls: string[];
  published_date: string | null;
  editorial_value_score: number;
  institutional_pr_score: number;
  rejection_reason: RejectionReason | null;
};

// One audit row per candidate story considered in a run.
type Decision = {
  title: string;
  source_domain: string | null;
  source_url: string | null;
  source_tier: string | null;
  source_trust_score: number | null;
  editorial_value_score: number | null;
  institutional_pr_score: number | null;
  accepted: boolean;
  rejection_reason: string | null;
  // E1.2 semantic-dedup audit metadata (all nullable; only set on duplicates).
  duplicate_of_content_id: string | null;
  similarity_score: number | null;
  dedupe_method: string | null;
  matched_title: string | null;
  selected_final_domain: string | null;
  // E1.3C writer-routing audit (all nullable; only set once a candidate reaches
  // the writing stage). Requires the additive columns from migration
  // 20260804120000_ingestion_decisions_writer_audit.sql.
  writing_profile: string | null;
  writer_primary_model: string | null;
  writer_model_used: string | null;
  writer_fallback_used: boolean | null;
  writer_prompt_version: string | null;
  writer_validation_reason: string | null;
  // E1.3D verified-source extraction audit (all nullable; only set on a pilot
  // candidate that reached the source-text stage). Requires the additive columns
  // from migration 20260805120000_ingestion_decisions_source_extraction.sql.
  source_extraction_method: string | null;
  source_char_count: number | null;
  source_word_count: number | null;
};

// Optional dedup audit fields attached to a decision (E1.2).
type DedupeMeta = {
  duplicate_of_content_id?: string | null;
  similarity_score?: number | null;
  dedupe_method?: string | null;
  matched_title?: string | null;
  selected_final_domain?: string | null;
};

// Optional writer-routing audit fields attached to a decision (E1.3C/D).
type WriterAudit = {
  writing_profile?: string | null;
  writer_primary_model?: string | null;
  writer_model_used?: string | null;
  writer_fallback_used?: boolean | null;
  writer_prompt_version?: string | null;
  writer_validation_reason?: string | null;
  source_extraction_method?: string | null;
  source_char_count?: number | null;
  source_word_count?: number | null;
};

// ---- OpenRouter web-search client ---------------------------------------

async function chatWeb(
  messages: { role: string; content: string }[],
  options: { temperature?: number; maxTokens?: number; maxResults?: number; model?: string } = {},
): Promise<WebChatResult> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://salma.health",
      "X-Title": "Salma",
    },
    body: JSON.stringify({
      model: options.model ?? DEFAULT_MODEL,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2048,
      plugins: [{ id: "web", max_results: options.maxResults ?? 6 }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenRouter web request failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message ?? {};
  const annotations = Array.isArray(message.annotations) ? message.annotations : [];
  const citations: Citation[] = [];
  for (const a of annotations) {
    const c = a?.url_citation;
    if (c?.url) citations.push({ url: String(c.url), title: String(c.title ?? "") });
  }
  return { content: message.content ?? "", citations };
}

// ---- OpenRouter writer client (E1.3C) -----------------------------------
//
// A SEPARATE, tool-free call: no web plugin, no search, temperature 0.2. It
// only rewrites the already-verified facts it is handed. Returns a structured
// result so the router can tell a technical failure (fallback-eligible) from a
// hard config error (not).
async function chatWriter(
  model: string,
  messages: { role: string; content: string }[],
): Promise<WriterHttpResult> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://salma.health",
        "X-Title": "Salma",
      },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 2000 }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return { ok: false, httpStatus: res.status };
    const data = await res.json().catch(() => null);
    // Inspect the completion metadata (finish_reason + content shape) BEFORE
    // parsing: a truncated/filtered/tool_calls completion or a non-string
    // content shape is a completed-but-invalid response (reject, no fallback);
    // an empty completion stays a technical failure (fallback-eligible).
    const evald = evaluateWriterCompletion(data?.choices?.[0]);
    if (evald.ok) return { ok: true, content: evald.content };
    if (evald.kind === "completed_invalid") {
      return { ok: false, completedInvalid: true, reason: evald.reason };
    }
    return { ok: false, httpStatus: res.status, emptyOrMalformed: true };
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    return { ok: false, httpStatus: 0, timedOut, networkError: !timedOut };
  }
}

// ---- Editorial-director model client (E1.4A) ----------------------------
//
// One OpenRouter call for the single editorial-rewrite attempt. Mirrors
// chatWriter's transport but returns the editor's own result shape: any
// transport/HTTP/empty failure is a plain reason string (the editor never
// falls back or retries — a failed call simply keeps the writer draft). It
// sends ONLY the neutral headers; never a Supabase secret or the API key in
// the body. A slightly higher token budget covers the edited body plus the
// short issues_found/changes_made control lists.
async function chatEditor(
  model: string,
  messages: { role: string; content: string }[],
): Promise<EditorCallResult> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) return { ok: false, reason: "editor_api_key_missing" };
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://salma.health",
        "X-Title": "Salma",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: 2200,
        response_format: EDITOR_RESPONSE_FORMAT,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return { ok: false, reason: `editor_http_${res.status}` };
    const data = await res.json().catch(() => null);
    const evald = evaluateWriterCompletion(data?.choices?.[0]);
    if (evald.ok) return { ok: true, content: evald.content };
    return {
      ok: false,
      reason: evald.kind === "completed_invalid" ? `editor_completed_invalid:${evald.reason}` : "editor_empty_completion",
    };
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    return { ok: false, reason: timedOut ? "editor_timeout" : "editor_network_error" };
  }
}

// ---- Evidence Intelligence model client -----------------------------------
//
// The ONE structured evidence-extraction call. Tool-free (no web plugin — the
// stage interprets the already-fetched source text only), temperature 0, strict
// json_schema output. Any transport/HTTP/empty failure is a plain reason string;
// the orchestrator records analysis_failed and the story proceeds unchanged.
async function chatEvidence(
  messages: { role: string; content: string }[],
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) return { ok: false, reason: "evidence_api_key_missing" };
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://salma.health",
        "X-Title": "Salma",
      },
      body: JSON.stringify({
        model: EVIDENCE_MODEL,
        messages,
        temperature: 0,
        // Arabic free-text fields are token-dense and reasoning-capable models
        // count internal thinking toward the cap; 8000 keeps the call bounded
        // (≤ daily cap of calls) while avoiding the truncated-completion
        // failures observed at 1800/4000 on longer sources.
        max_tokens: 8000,
        response_format: EVIDENCE_RESPONSE_FORMAT,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { ok: false, reason: `evidence_http_${res.status}` };
    const data = await res.json().catch(() => null);
    const evald = evaluateWriterCompletion(data?.choices?.[0]);
    if (evald.ok) return { ok: true, content: evald.content };
    return {
      ok: false,
      reason: evald.kind === "completed_invalid" ? `evidence_completed_invalid:${evald.reason}` : "evidence_empty_completion",
    };
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    return { ok: false, reason: timedOut ? "evidence_timeout" : "evidence_network_error" };
  }
}

// ---- Hardened source-fetch adapter (E1.3D) ------------------------------
//
// The real network primitive handed to fetchSourceText. It performs ONE request
// with redirect:"manual" (fetchSourceText validates every hop itself), a hard
// per-request timeout, and exposes the body as a chunk stream so the module can
// enforce its byte cap while downloading. It sends ONLY the neutral headers the
// module supplies — never Authorization / Cookie / apikey / any Supabase or
// OpenRouter secret. A timeout surfaces as a DOMException("TimeoutError") which
// fetchSourceText maps to source_fetch_timeout; any other throw → source_fetch_failed.
async function* streamChunks(
  stream: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader already released (e.g. after an early break) — ignore.
    }
  }
}

async function denoRawFetch(
  url: string,
  init: { headers: Record<string, string>; timeoutMs: number; maxBytes: number },
): Promise<RawResponse> {
  const res = await fetch(url, {
    method: "GET",
    headers: init.headers,
    redirect: "manual",
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  return {
    status: res.status,
    headers: res.headers,
    body: streamChunks(res.body),
  };
}

// ---- Hardened DNS resolver (E1.3E SSRF layer) ---------------------------
//
// The real DNS primitive handed to fetchSourceText. It resolves BOTH A (IPv4)
// and AAAA (IPv6) records via Deno.resolveDns and returns the concatenated
// numeric addresses so fetchSourceText can refuse any private/reserved/metadata
// address BEFORE a socket is opened, on the initial URL and on every redirect
// hop. Each record type is queried independently: a host with only A records
// (NotFound for AAAA, and vice-versa) still resolves, but a host that resolves
// to NOTHING yields [] → fetchSourceText fails closed (source_dns_resolution_failed).
//
// DNS-rebinding caveat (intentional, documented): Deno's fetch performs its own
// resolution and cannot be pinned to the IP validated here, so this is
// conservative pre-flight defense-in-depth, not a full guarantee against a
// TTL=0 rebinding attacker.
async function denoResolveDns(hostname: string): Promise<string[]> {
  const out: string[] = [];
  for (const recordType of ["A", "AAAA"] as const) {
    try {
      const addrs = await Deno.resolveDns(hostname, recordType);
      out.push(...addrs);
    } catch {
      // NotFound / no record of this type is normal (e.g. IPv4-only host has no
      // AAAA). A genuinely unresolvable host returns [] from BOTH and is failed
      // closed by validateResolvedAddresses; we never treat a lookup error as
      // "resolved to nothing = safe".
    }
  }
  return out;
}

// ---- Event Registry POST (Radar exact-article fallback only) -------------
//
// A FIXED trusted host we own the request to (never operator-supplied), so the
// SSRF host-validation that guards fetchSourceText does not apply: Event
// Registry itself fetches the target and returns the stored/extracted body. The
// apiKey is folded in here and never passed to the pure erSourceFallback module.
// Used ONLY on the admin-authorized Radar publish path (see runIngestion).
const ER_HOST = "https://eventregistry.org";
// ER performs its own remote extraction, so allow more headroom than the direct
// single-page fetch while staying bounded.
const ER_FETCH_TIMEOUT_MS = 15000;
function denoErPost(apiKey: string): ErPost {
  return async (path, body) => {
    const res = await fetch(ER_HOST + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, apiKey }),
      signal: AbortSignal.timeout(ER_FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Leave json null; the caller treats an unparseable body as unavailable.
    }
    return { status: res.status, ok: res.ok, json };
  };
}

// Render the Arabic user message the writer works from. It draws a HARD line
// between two kinds of material:
//   - VERIFIED facts: only the cited source headline(s) and the registry source
//     name actually returned/verified by the pipeline. These are the sole facts
//     the writer may state, and they are exactly what the validator grounds
//     against (see writeArticle).
//   - UNVERIFIED discovery leads: the discovery model's generated draft
//     (title/summary/body). These are provided ONLY as orientation and MUST NOT
//     be stated as fact unless the same detail is present in the verified facts.
// This separation is what stops a fabricated number/quote/claim that exists only
// in the discovery draft from being written as if it were sourced.
function renderWriterPacket(input: {
  verifiedFactText: string;
  citationTitles: string[];
  discovery: { originalTitle: string; excerpt: string; body: string };
  sourceName: string | null;
  // Evidence Intelligence wording constraints (restrictions only — never facts).
  evidenceGuidance?: string | null;
}): string {
  const lines = [
    `المصدر المُتحقَّق منه: ${input.sourceName || "—"}`,
    ``,
    `الحقائق المُتحقَّق منها (هذه هي المادة الوحيدة المسموح بذكرها؛ لا تُضِف رقماً أو تاريخاً أو اسماً أو اقتباساً أو ادّعاءً غير وارد هنا):`,
    input.verifiedFactText || "—",
  ];
  // Evidence-derived wording constraints, BEFORE the unverified leads so they
  // read as binding rules on the verified material. They restrict phrasing only
  // and are never a source of facts or numbers.
  if (input.evidenceGuidance) {
    lines.push(``, input.evidenceGuidance);
  }
  const extraTitles = input.citationTitles.filter(Boolean);
  if (extraTitles.length) {
    lines.push(``, `عناوين المصادر المرجعية (مُتحقَّق منها):`, ...extraTitles.map((t) => `- ${t}`));
  }
  // Unverified discovery leads: explicitly fenced off as NON-factual context.
  const discoveryLeads = [input.discovery.originalTitle, input.discovery.excerpt, input.discovery.body]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join("\n");
  if (discoveryLeads) {
    lines.push(
      ``,
      `سياق استكشافي غير مُتحقَّق منه (للتوجيه فقط — لا تعتمده كحقيقة، ولا تنقل منه أي رقم أو تاريخ أو اقتباس أو ادّعاء ما لم يرد في الحقائق المُتحقَّق منها أعلاه):`,
      discoveryLeads,
    );
  }
  return lines.join("\n");
}

// Formatting-only directive for the single writer JSON-recovery call. Appended
// AFTER the same system+user packet; it changes no facts and adds no editorial
// rule — it only re-instructs strict conformance to the existing writer schema
// when the first response was unparseable JSON.
const WRITER_JSON_RECOVERY_MESSAGE = {
  role: "system",
  content:
    "تنبيه تنسيقي فقط: كانت استجابتك السابقة غير قابلة للتحليل كـ JSON. أعِد إخراج نفس المقال ككائن JSON واحد صالح فقط، دون أي نص تمهيدي أو تعليق أو أسيجة برمجية (```) أو أي نص قبل القوس { أو بعده }. استخدم الحقول التالية فقط وكلها قيم نصية: \"title\" و\"excerpt\" و\"body\" (و\"summary\" اختياري). لا تُغيّر الحقائق أو المحتوى؛ الإصلاح مقصور على التنسيق ليصبح JSON صالحًا.",
} as const;

// ---- Constrained source-fidelity repair (editorial-policy alignment) -----
//
// A SINGLE post-editor call that fixes ONLY the listed source-fidelity issues
// using ONLY the extracted source. It never adds a new fact/number/quote/claim/
// cause/recommendation/advice; it may delete the unsupported addition, replace it
// with the correct source value, or rewrite the sentence without the detail. It
// returns the same strict writer JSON schema so parseWriterOutput can read it.

/** Human-readable Arabic instruction for one deterministic fidelity issue code. */
function fidelityIssueInstruction(code: string): string {
  const [kind, detail] = code.split(/:(.+)/);
  switch (kind) {
    case "unsupported_number":
      return `الرقم أو التاريخ «${detail ?? ""}» غير وارد في نص المصدر. احذفه، أو استبدله بالقيمة الصحيحة كما وردت حرفيًا في المصدر، أو أعِد صياغة الجملة دون هذا الرقم.`;
    case "unsupported_claim":
      return `الادّعاء المتعلق بـ«${detail ?? ""}» (فعالية أو موافقة أو نتيجة) غير مدعوم بنص المصدر. احذفه أو خفّف الصياغة لتطابق ما ورد في المصدر فقط، دون إضافة أي حكم جديد.`;
    case "invented_quotation":
      return "يوجد اقتباس مباشر بين علامتَي تنصيص غير وارد حرفيًا في نص المصدر. احذف الاقتباس أو أعِد صياغته بأسلوب غير مباشر دون علامات تنصيص، دون اختلاق أي كلام منسوب.";
    case "missing_official_action":
      return "أشار المصدر إلى إجراء رسمي (سحب أو تحذير أو إيقاف أو ما شابه) لم يُذكر في المقال. أضِف هذا الإجراء فقط إذا ورد صراحةً في نص المصدر، بصياغة مطابقة للمصدر.";
    case "missing_unaffected_batch_statement":
      return "ذكر المصدر أن دفعات أو منتجات أخرى غير متأثرة. أضِف هذا التوضيح فقط إذا ورد صراحةً في نص المصدر.";
    default:
      return `أصلح المشكلة «${code}» بالاعتماد على نص المصدر فقط دون إضافة أي معلومة جديدة.`;
  }
}

/** Build the two-message packet for the single constrained fidelity-repair call. */
function buildFidelityRepairMessages(input: {
  verifiedFactText: string;
  sourceName: string | null;
  draft: FidelityArticle;
  issues: string[];
}): { role: string; content: string }[] {
  const instructions = input.issues.map((c, i) => `${i + 1}. ${fidelityIssueInstruction(c)}`).join("\n");
  const system =
    "أنت محرّر تدقيق أمانة المصدر في «سلمى». مهمتك الوحيدة: إصلاح مخالفات الأمانة المُدرَجة أدناه بالاعتماد الحصري على نص المصدر المُرفق. " +
    "لا تُضِف أي حقيقة أو رقم أو تاريخ أو اقتباس أو ادّعاء أو سبب أو توصية أو نصيحة طبية غير واردة حرفيًا في نص المصدر. " +
    "لكل مخالفة اختر أحد الحلول: حذف الإضافة غير المدعومة، أو استبدالها بالقيمة الصحيحة من المصدر، أو إعادة صياغة الجملة دون التفصيلة غير المدعومة. " +
    "لا تُغيّر أي معلومة صحيحة أخرى، وحافظ على الأسلوب العربي المتقن. " +
    "عقد الإخراج الإلزامي (يجب أن يطابق المُحلِّل تمامًا): أعِد المقال كاملًا ككائن JSON واحد صالح فقط. " +
    "ضمِّن الحقول النصية الثلاثة كلها في كل مرة: \"title\" و\"excerpt\" و\"body\"، وانسخ أي حقل لم تُعدّله كما هو حرفيًا من المسودة (لا تحذف أي حقل ولا تتركه فارغًا). " +
    "\"summary\" اختياري فقط؛ إذا أدرجته فليكن نصًا. لا تُضِف أي مفتاح آخر إطلاقًا، ولا تُعِد كائن تعديل جزئيًا أو مخططًا بديلًا أو قائمة تغييرات. " +
    "كل القيم نصوص فقط. لا تُحِط الإخراج بأسيجة برمجية (```) ولا تكتب أي تعليق أو نص قبل القوس { أو بعده }.";
  const user = [
    input.sourceName ? `المصدر المُتحقَّق منه: ${input.sourceName}` : "",
    "— نص المصدر المُتحقَّق منه (الحقيقة الوحيدة المسموح الاعتماد عليها) —",
    input.verifiedFactText,
    "",
    "— المسودة الحالية —",
    `العنوان: ${input.draft.title}`,
    `المقتطف: ${input.draft.excerpt}`,
    input.draft.summary ? `الملخّص: ${input.draft.summary}` : "",
    `النص: ${input.draft.body}`,
    "",
    "— مخالفات الأمانة الواجب إصلاحها (وهي فقط) —",
    instructions,
  ]
    .filter((s) => s !== "")
    .join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

type WriterOutcome =
  | {
    ok: true;
    article: { title: string; excerpt: string; body: string; summary?: string };
    readMinutes: number;
    audit: WriterAudit;
    // E1.4A editorial-director audit for the single edit attempt on this draft.
    // Carried SEPARATELY from WriterAudit so the ingestion_decisions insert stays
    // unchanged (no migration); surfaced only in the pilot HTTP report.
    editorial: EditorialAudit;
    // Post-editor source-fidelity stage audit (original error, repair attempt,
    // repair outcome, final validation, needs_human_review). Observability-only.
    fidelity: FidelityRepairAudit | null;
    // True when the draft was allowed to become pending despite an unresolved
    // omission (missing_official_action / missing_unaffected_batch_statement).
    needsHumanReview: boolean;
    // Writer JSON-recovery observability (surfaced in the pilot report only).
    writerAttempts: number;
    writerSecondAttempt: "none" | "json_recovery";
  }
  | {
    ok: false;
    rejection: string;
    audit: WriterAudit;
    // Present when the rejection happened at the post-editor fidelity stage
    // (the editorial pass ran first); null when the writer stage failed early.
    editorial: EditorialAudit | null;
    fidelity: FidelityRepairAudit | null;
    writerAttempts: number;
    writerSecondAttempt: "none" | "json_recovery";
  };

// Select the profile, route to the approved model (with technical-failure
// fallback), and validate the output. The FINAL stored title/excerpt/body/
// read_minutes all come from this validated writer output — never the raw
// discovery draft. A parse/validation failure returns ok:false so NO pending
// draft is created (the reason is recorded on the audit row).
async function writeArticle(input: {
  // VERIFIED source material (E1.3D): the plain text extracted from the ONE
  // final, registered, final_source_allowed source page. This — plus the
  // registered source name/domain and the selected URL — is the SOLE factual
  // grounding the validator allows.
  verified: SourceText;
  // UNVERIFIED discovery-model output. Used only as orientation for the writer
  // and as a routing signal — NEVER as factual grounding.
  discovery: { originalTitle: string; body: string; excerpt: string };
  // Registered source label + domain (verified from the registry).
  sourceName: string | null;
  registeredDomain: string | null;
  // Verified: the titles the web plugin actually returned as url_citations.
  citationTitles: string[];
  // Source language (ISO code) for locale-aware numeric grounding — supplied for
  // the Radar path (from the trusted radar row); null for generic Discovery,
  // where the numeric validator falls back to the English convention.
  sourceLang?: string | null;
  // Validated Evidence Card for this cluster (ESL promotions only; null when
  // analysis was skipped/failed/unavailable). Supplies wording CONSTRAINTS to
  // the writer packet and strengthens the association→causation guard. It is
  // never a source of facts — grounding stays the verified source text alone.
  evidence?: EvidenceCard | null;
}): Promise<WriterOutcome> {
  const originalTitle = input.discovery.originalTitle ?? "";

  // GROUNDING material — verified ONLY, built from the extracted source page:
  // its title, its body, reliable publication metadata, the registered source
  // name/domain, and the selected URL. The validator compares the writer's
  // output against exactly this text. Neither the discovery draft nor the
  // provider citation titles are grounding: they are model/aggregator-supplied
  // and must not let a fabricated number/quote/claim pass validation.
  const verifiedFactText = [
    input.verified.title,
    input.verified.text,
    input.verified.publishedDate ? `تاريخ النشر: ${input.verified.publishedDate}` : "",
    input.sourceName ? `المصدر: ${input.sourceName}` : "",
    input.registeredDomain ? `النطاق: ${input.registeredDomain}` : "",
    input.verified.finalUrl,
  ]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join("\n");

  // Essential entities that must survive into the article (blocking for a safety
  // alert). Deterministically extracted from the VERIFIED source text only —
  // never model-generated (see fetchSourceText.extractEssentialEntities).
  const mustPreserve = input.verified.mustPreserve;

  // ROUTING signal — may use the broader discovery text AND the verified source
  // title. Routing errs toward the sensitive model (see selectProfile /
  // sensitiveProfileHint); reading the unverified leads here only ever makes
  // routing MORE cautious, never less, and never affects what counts as a fact.
  const routingText = [
    originalTitle,
    input.discovery.excerpt,
    input.discovery.body,
    input.verified.title,
    ...input.citationTitles,
  ]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join("\n");
  const profile = selectProfile({ sourceText: routingText });

  const messages = [
    { role: "system", content: buildWritingInstructions(profile) },
    {
      role: "user",
      content: renderWriterPacket({
        verifiedFactText,
        citationTitles: input.citationTitles,
        discovery: input.discovery,
        sourceName: input.sourceName,
        evidenceGuidance: renderEvidenceGuidanceBlock(input.evidence) || null,
      }),
    },
  ];

  // Build the full source-fidelity validation once; reused by the writer-stage
  // structural gate, the Editorial Director's re-validation, and the post-editor
  // fidelity stage — always over the SAME verified source text.
  const validateFidelity = (a: { title: string; excerpt: string; body: string }): FidelityValidation => {
    const v = validateArticle({
      // The writer output no longer echoes a profile field (strict 3-field
      // schema); use the deterministic routing profile computed above.
      article: { title: a.title, excerpt: a.excerpt, body: a.body, profile },
      source: {
        sourceText: verifiedFactText,
        originalTitle,
        brand: input.sourceName ?? null,
        mustPreserve,
        // Locale-aware numeric grounding: interpret the source's separators with
        // its own language (null → English convention). Draft is always Arabic.
        sourceLang: input.sourceLang ?? null,
      },
    });
    const errors = [...v.errors];
    // Evidence-strengthened association→causation guard: when the validated
    // Evidence Card says the underlying evidence is association-only, an asserted
    // causal claim in the draft is a fidelity breach REGARDLESS of the writing
    // profile's own marker heuristics — unless the source itself asserts
    // causation (then the existing source-grounding rules already govern it).
    // Same blocking code and semantics as the existing research_study check.
    if (
      associationGuardApplies(input.evidence) &&
      !errors.includes("association_as_causation") &&
      causationAsserted([a.title, a.excerpt, a.body].join("\n")) &&
      !causationAsserted(verifiedFactText)
    ) {
      errors.push("association_as_causation");
    }
    return { ok: errors.length === 0, errors, cleanTitle: v.cleanTitle, readMinutes: v.readMinutes };
  };

  // Writer-stage gate: parse + STRUCTURAL (malformed_output) only. Source-fidelity
  // breaches are NO LONGER blocked here — the Editorial Director runs first and a
  // single constrained fidelity repair may fix them (editorial-policy alignment).
  // parseWriterOutput still drives the strict-JSON recovery via writer_output_
  // invalid_json, and malformed_output:* remains a hard writer-stage rejection.
  const validate = (content: string): WriterValidation => {
    const parsed = parseWriterOutput(content);
    if (!parsed.ok) return { ok: false, reason: parsed.error };
    const v = validateFidelity(parsed.article);
    const structural = v.errors.filter((e) => e.startsWith("malformed_output"));
    if (structural.length) return { ok: false, reason: structural[0] };
    return {
      ok: true,
      article: {
        title: v.cleanTitle,
        excerpt: parsed.article.excerpt,
        body: parsed.article.body,
        // Optional "باختصار" quick summary, only when the writer supplied one.
        ...(parsed.article.summary ? { summary: parsed.article.summary } : {}),
      },
      readMinutes: v.readMinutes,
    };
  };

  const r = await orchestrateWriter({
    profile,
    config: WRITER_CONFIG,
    // On the one strict-JSON recovery, resend the SAME system+user packet with an
    // appended formatting-only directive; the base writer prompt is untouched.
    call: (model, opts) =>
      chatWriter(
        model,
        opts?.strictJsonRecovery ? [...messages, WRITER_JSON_RECOVERY_MESSAGE] : messages,
      ),
    validate,
  });

  const audit: WriterAudit = {
    writing_profile: r.profile,
    writer_primary_model: r.primaryModel,
    writer_model_used: r.modelUsed,
    writer_fallback_used: r.usedFallback,
    writer_prompt_version: WRITER_PROMPT_VERSION,
    writer_validation_reason: r.validationReason,
    // Verified-source extraction provenance (E1.3D): how the source body was
    // recovered and its size. Recorded on every pilot decision that reached the
    // writer, alongside the routing/model audit above.
    source_extraction_method: input.verified.method,
    source_char_count: input.verified.charCount,
    source_word_count: input.verified.wordCount,
  };
  if (!(r.ok && r.article)) {
    return {
      ok: false,
      rejection: r.rejection ?? "writer_failed",
      audit,
      editorial: null,
      fidelity: null,
      writerAttempts: r.writerAttempts,
      writerSecondAttempt: r.secondAttemptType,
    };
  }
  const writerArticle = r.article;

  // Editorial-policy alignment: the Editorial Director runs FIRST — BEFORE any
  // source-fidelity rejection — so it can improve the headline/lead/compression/
  // Arabic style/attribution and remove unnecessary additions on every writer
  // draft (even one that still carries a fidelity breach). The editor keeps an
  // edit only when it re-passes the SAME source-fidelity validation and preserves
  // the required actions / essential entities / risk; otherwise it retains the
  // writer draft. THEN the post-editor fidelity stage validates, attempts exactly
  // ONE constrained repair when eligible, and re-validates (see fidelityRepair.ts).
  const writerReadMinutes = r.readMinutes ?? readingTimeMinutes(writerArticle.body);
  const packet = buildFactPacket({ profile, sourceText: verifiedFactText, mustPreserve });
  const revalidate = (a: EditorArticle) => {
    const v = validateFidelity({ title: a.title, excerpt: a.excerpt, body: a.body });
    return v.ok
      ? ({ ok: true, readMinutes: v.readMinutes, cleanTitle: v.cleanTitle } as const)
      : ({ ok: false, reason: v.errors[0] ?? "validation_failed" } as const);
  };
  const writerDraft: EditorArticle = {
    title: writerArticle.title,
    excerpt: writerArticle.excerpt,
    summary: writerArticle.summary ?? "",
    body: writerArticle.body,
  };

  const { editorial, fidelity } = await finalizeWriterDraft<EditorialAudit>({
    runEditor: async () => {
      const editorPass = await runEditorPass({
        profile,
        model: EDITOR_MODEL,
        original: { article: writerDraft, readMinutes: writerReadMinutes },
        packet,
        call: (model, opts) =>
          chatEditor(model, [
            {
              role: "system",
              content: buildEditorInstructions(profile, {
                strictJsonRecovery: opts?.strictRecovery,
                repairIssues: opts?.repair?.issues,
              }),
            },
            {
              role: "user",
              // Editorial repair works from the FIRST edited draft; every other
              // call (normal + formatting recovery) works from the writer draft.
              content: renderEditorPacket({ packet, draft: opts?.repair?.draft ?? writerDraft }),
            },
          ]),
        revalidate,
        verificationOnly: packet.verificationOnly,
      });
      // The editor's chosen draft (an accepted edit, else the writer draft) is the
      // single draft the fidelity stage validates and may repair.
      const chosen: FidelityArticle = {
        title: editorPass.article.title,
        excerpt: editorPass.article.excerpt,
        summary: editorPass.article.summary ?? "",
        body: editorPass.article.body,
      };
      return { article: chosen, readMinutes: editorPass.readMinutes, audit: editorPass.audit };
    },
    validate: (a) => validateFidelity({ title: a.title, excerpt: a.excerpt, body: a.body }),
    // Exactly ONE constrained repair via the existing editor model (non-Gemini,
    // asserted at run start). No loop, no fallback expansion.
    repair: async (issues, draft) => {
      const res = await chatEditor(
        EDITOR_MODEL,
        buildFidelityRepairMessages({ verifiedFactText, sourceName: input.sourceName ?? null, draft, issues }),
      );
      if (!res.ok) return { ok: false, reason: res.reason };
      const parsed = parseWriterOutput(res.content);
      if (!parsed.ok) return { ok: false, reason: parsed.error };
      return {
        ok: true,
        article: {
          title: parsed.article.title,
          excerpt: parsed.article.excerpt,
          summary: parsed.article.summary ?? draft.summary,
          body: parsed.article.body,
        },
      };
    },
  });

  // A hard-blocking breach, or a repairable breach still present after the single
  // repair, rejects: NO pending draft is created (the reason is audited).
  if (fidelity.decision === "reject") {
    return {
      ok: false,
      rejection: fidelity.rejectionReason ?? "validation_failed",
      audit,
      editorial,
      fidelity: fidelity.audit,
      writerAttempts: r.writerAttempts,
      writerSecondAttempt: r.secondAttemptType,
    };
  }

  // clean OR needs_human_review → a PENDING draft (auto-publish stays disabled).
  // The stored title is the brand-stripped clean title, matching the writer path.
  const finalArticle = {
    title: fidelity.cleanTitle || fidelity.article.title,
    excerpt: fidelity.article.excerpt,
    body: fidelity.article.body,
    ...(fidelity.article.summary ? { summary: fidelity.article.summary } : {}),
  };
  return {
    ok: true,
    article: finalArticle,
    readMinutes: fidelity.readMinutes,
    audit,
    editorial,
    fidelity: fidelity.audit,
    needsHumanReview: fidelity.decision === "needs_human_review",
    writerAttempts: r.writerAttempts,
    writerSecondAttempt: r.secondAttemptType,
  };
}

// ---- Helpers ------------------------------------------------------------

function dedupeKeyFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return null;
  }
}

// Fetches the real article page and extracts its OpenGraph/Twitter cover
// image. Returns null on any failure so ingestion never blocks on images.
// ---- Official-asset retrieval (bounded, SSRF-safe) ----------------------
//
// For the Content editor's «صورة من المصدر الرسمي» path: given URLs ALREADY
// linked to an article (its source_url / content_sources — never open-web
// discovery), inspect each authoritative page and surface its author-declared
// hero/brand image (og:image / twitter:image / og:logo) as a selectable cover
// candidate. Reuses the SAME SSRF hardening as source extraction (blocked-host
// list + DNS resolution check) — no duplicated security logic, no crawling.

// NOTE: a URL linked to an article (content_sources / source_url) is a
// SOURCE page (often a news outlet like CNN/Reuters), NOT necessarily the
// entity's official website. We therefore do NOT claim officialness: assets are
// typed neutrally as a source-page image or a source-page logo, and attribution
// names the source page they came from.
type OfficialAsset = {
  imageUrl: string;
  sourceUrl: string;
  sourceName: string;
  assetType: "source_image" | "source_logo";
  attribution: string;
};

/** Conservative reject of obviously-unsuitable images (favicons, sprites,
 *  tracking pixels, tiny icons, vector icons, data URIs). We only ever read
 *  author-declared meta images to begin with, so this is a belt-and-suspenders. */
function isUsableAssetImage(u: string): boolean {
  const low = u.toLowerCase();
  if (low.startsWith("data:")) return false;
  if (/\.svg(\?|#|$)/.test(low)) return false;
  if (/\.ico(\?|#|$)/.test(low)) return false;
  if (/favicon|sprite|spacer|tracking|beacon|1x1|pixel\.|\/pixel/.test(low)) return false;
  if (/(^|[^0-9])(16x16|24x24|32x32|48x48)([^0-9]|$)/.test(low)) return false;
  return true;
}

/** Fetch ONE already-known authoritative page and return its declared official
 *  image(s). SSRF-safe: http(s) only, blocked-host check, and a DNS-resolution
 *  classification that must be "safe" before any fetch. Best-effort — any
 *  failure (blocked, unreachable, no image) yields []. */
async function fetchOfficialAssetsFrom(
  url: string,
  label: string,
  resolveDns: (h: string) => Promise<string[]>,
): Promise<OfficialAsset[]> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return [];
  if (isBlockedHostname(u.hostname)) return [];
  const cls = await validateResolvedAddresses(u.hostname, resolveDns).catch(() => "unsafe" as const);
  if (cls !== "safe") return [];

  let html: string;
  try {
    const res = await fetch(u.href, {
      headers: { "User-Agent": NEUTRAL_USER_AGENT },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!res.ok) return [];
    if (!/text\/html|application\/xhtml/i.test(res.headers.get("content-type") ?? "")) return [];
    html = (await res.text()).slice(0, 200000);
  } catch {
    return [];
  }

  const name = label || u.hostname.replace(/^www\./, "");
  const grab = (re: RegExp): string | undefined => html.match(re)?.[1];
  const out: OfficialAsset[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined, assetType: OfficialAsset["assetType"]) => {
    if (!raw) return;
    let abs: string;
    try {
      abs = new URL(raw.trim(), u.href).href;
    } catch {
      return;
    }
    if (seen.has(abs) || !isUsableAssetImage(abs)) return;
    seen.add(abs);
    out.push({ imageUrl: abs, sourceUrl: u.href, sourceName: name, assetType, attribution: name });
  };

  // Hero image (page-author declared) — preferred.
  push(
    grab(/<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i) ??
      grab(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      grab(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i),
    "source_image",
  );
  push(grab(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i), "source_image");
  // A declared logo on the source page — supporting fallback only.
  push(grab(/<meta[^>]+property=["']og:logo["'][^>]+content=["']([^"']+)["']/i), "source_logo");
  return out;
}

/** Extract official assets from a bounded set of already-known authoritative
 *  URLs. Deduped by image URL; capped. Never throws into the request path. */
async function extractOfficialAssets(
  items: { url: string; label: string }[],
  resolveDns: (h: string) => Promise<string[]>,
): Promise<OfficialAsset[]> {
  const seenUrls = new Set<string>();
  const targets = items
    .filter((it) => it.url && !seenUrls.has(it.url) && seenUrls.add(it.url))
    .slice(0, 8);
  const results = await Promise.all(
    targets.map((t) => fetchOfficialAssetsFrom(t.url, t.label, resolveDns).catch(() => [])),
  );
  const out: OfficialAsset[] = [];
  const seenImg = new Set<string>();
  for (const arr of results) {
    for (const a of arr) {
      if (seenImg.has(a.imageUrl)) continue;
      seenImg.add(a.imageUrl);
      out.push(a);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

// ---- Primary Source Escalation (bounded, ≤ selected/day) ------------------

/** Trim a possibly-unknown value to a non-empty string, else null. */
function asTrimmedTop(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

/** Load news_sources into the escalation registry shape (domain → type/tier). */
async function loadEscalationRegistry(admin: SupabaseClient): Promise<Map<string, EscRegistryEntry>> {
  const map = new Map<string, EscRegistryEntry>();
  const { data } = await admin.from("news_sources").select("domain,source_type,tier,active").eq("active", true);
  for (const r of (data ?? []) as { domain: string; source_type: string; tier: string }[]) {
    const d = escDomainOf(r.domain);
    if (d) map.set(d, { domain: d, source_type: String(r.source_type), tier: String(r.tier) });
  }
  return map;
}

// Strong-source domains worth surfacing as a cited primary (STEP B link filter).
const ESCALATION_LINK_HINTS = [
  "fda.gov", "ema.europa.eu", "who.int", "cdc.gov", "nih.gov", "mhra.gov.uk",
  "sfda.gov.sa", "nature.com", "nejm.org", "thelancet.com", "jamanetwork.com",
  "bmj.com", "science.org", "doi.org", "ncbi.nlm.nih.gov", "reuters.com",
  "apnews.com", "mayoclinic.org", "health.harvard.edu", "cochrane.org",
];

/** SSRF-safe: fetch the discovery article and return outbound links pointing to
 *  known strong-source domains (STEP B). Mirrors the hardened asset fetch. */
async function fetchOutboundLinks(url: string): Promise<string[]> {
  let u: URL;
  try { u = new URL(url); } catch { return []; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return [];
  if (isBlockedHostname(u.hostname)) return [];
  const cls = await validateResolvedAddresses(u.hostname, denoResolveDns).catch(() => "unsafe" as const);
  if (cls !== "safe") return [];
  let html: string;
  try {
    const res = await fetch(u.href, {
      headers: { "User-Agent": NEUTRAL_USER_AGENT },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!res.ok) return [];
    if (!/text\/html|application\/xhtml/i.test(res.headers.get("content-type") ?? "")) return [];
    html = (await res.text()).slice(0, 300000);
  } catch { return []; }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
    let abs: string;
    try { abs = new URL(m[1].trim(), u.href).href; } catch { continue; }
    const host = escDomainOf(abs);
    if (host === escDomainOf(u.href)) continue; // outbound only
    if (!ESCALATION_LINK_HINTS.some((h) => host === h || host.endsWith("." + h))) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= 15) break;
  }
  return out;
}

// Escalation search runs on a capable, plugin-supporting model (NOT the free
// discovery default, which may not execute the web plugin). Overridable.
const ESCALATION_MODEL = Deno.env.get("ESL_ESCALATION_MODEL") || "openai/gpt-4o-mini";

/** ONE bounded web search for the development → citations (url + title). */
async function escalationWebSearch(query: string): Promise<{ url: string; title: string }[]> {
  const r = await chatWeb(
    [
      { role: "system", content: "You find the single strongest AUTHORITATIVE primary source (regulator, peer-reviewed journal, health institution, or major news wire) for a specific health development. Return citations only; do not write prose." },
      { role: "user", content: `Find the most authoritative original/primary source URLs for this exact development: ${query}` },
    ],
    { maxResults: 6, temperature: 0, model: ESCALATION_MODEL },
  );
  return r.citations.map((c) => ({ url: c.url, title: c.title }));
}

/**
 * Run escalation for one selected ESL cluster, with a per-cluster CACHE so the
 * same development is never re-searched. Never throws (returns escalation_failed
 * on error so promotion stays safe). Persists the audit row.
 */
async function runEscalation(
  admin: SupabaseClient,
  facts: { clusterKey: string; storyType: string; discoveryUrl: string; discoveryDomain: string; title: string | null; titleAr: string | null },
): Promise<EscalationResult> {
  // Cache hit → reuse (no fetch, no search).
  const { data: cached } = await admin
    .from("radar_source_escalation")
    .select("status,method,discovery_url,discovery_domain,discovery_role,discovery_tier,editorial_url,editorial_domain,editorial_role,editorial_tier,supporting_url,upgrade_reason")
    .eq("cluster_key", facts.clusterKey)
    .maybeSingle();
  if (cached) {
    return {
      status: cached.status as EscalationResult["status"],
      method: (cached.method ?? "none") as EscalationResult["method"],
      discovery_source: { url: cached.discovery_url ?? facts.discoveryUrl, domain: cached.discovery_domain ?? facts.discoveryDomain, role: (cached.discovery_role ?? "secondary_media") as EscalationResult["discovery_source"]["role"], tier: cached.discovery_tier ?? 5 },
      selected_editorial_source: { url: cached.editorial_url ?? facts.discoveryUrl, domain: cached.editorial_domain ?? facts.discoveryDomain, role: (cached.editorial_role ?? "secondary_media") as EscalationResult["selected_editorial_source"]["role"], tier: cached.editorial_tier ?? 5 },
      supporting_url: cached.supporting_url ?? null,
      upgrade_reason: cached.upgrade_reason ?? "cached",
    };
  }

  const registry = await loadEscalationRegistry(admin);
  const input: EscalationInput = {
    discoveryUrl: facts.discoveryUrl,
    discoveryDomain: facts.discoveryDomain,
    title: facts.title,
    titleAr: facts.titleAr,
    storyType: (facts.storyType || "general") as EscStoryType,
  };
  let result: EscalationResult;
  try {
    result = await escalate(input, { registry, fetchOutboundLinks, webSearch: escalationWebSearch });
  } catch {
    const disc = { url: facts.discoveryUrl, domain: facts.discoveryDomain, role: "secondary_media" as const, tier: 5 };
    result = { status: "escalation_failed", method: "none", discovery_source: disc, selected_editorial_source: disc, supporting_url: null, upgrade_reason: "escalation error — discovery preserved" };
  }

  // Persist audit / cache (best-effort; never blocks promotion).
  try {
    await admin.from("radar_source_escalation").upsert({
      cluster_key: facts.clusterKey,
      story_type: facts.storyType,
      status: result.status,
      method: result.method,
      discovery_url: result.discovery_source.url,
      discovery_domain: result.discovery_source.domain,
      discovery_role: result.discovery_source.role,
      discovery_tier: result.discovery_source.tier,
      editorial_url: result.selected_editorial_source.url,
      editorial_domain: result.selected_editorial_source.domain,
      editorial_role: result.selected_editorial_source.role,
      editorial_tier: result.selected_editorial_source.tier,
      supporting_url: result.supporting_url,
      upgrade_reason: result.upgrade_reason,
      updated_at: new Date().toISOString(),
    }, { onConflict: "cluster_key" });
  } catch { /* audit best-effort */ }
  return result;
}

// ---- Evidence Intelligence (bounded, ≤ selected/day) ----------------------

/** The source Evidence Intelligence (and the Writer) can actually work from.
 *  Escalation may pick a primary the sanctioned extractor cannot fetch (e.g. a
 *  hard bot-block); this resolves, with at most two bounded probe fetches, the
 *  strongest FETCHABLE source in the order primary → validated supporting →
 *  discovery — while preserving the identified primary for provenance. */
type ResolvedEvidenceSource = {
  kind: EvidenceSourceKind;
  url: string;                // the source the Writer/analysis will fetch
  primaryUrl: string | null;  // identified primary when it is NOT `url`
};

async function resolveAnalysisSource(
  esc: EscalationResult,
  discoveryUrl: string,
): Promise<ResolvedEvidenceSource> {
  const primary = esc.selected_editorial_source.url;
  const probe = async (url: string): Promise<boolean> => {
    try {
      const r = await fetchSourceText({
        url,
        registeredDomain: escDomainOf(url),
        sourceName: null,
        rawFetch: denoRawFetch,
        resolveDns: denoResolveDns,
      });
      return r.ok;
    } catch {
      return false;
    }
  };
  if (await probe(primary)) return { kind: "primary", url: primary, primaryUrl: null };
  const supporting = esc.supporting_url;
  if (supporting && /^https?:\/\//i.test(supporting) && await probe(supporting)) {
    return { kind: "supporting", url: supporting, primaryUrl: primary };
  }
  return { kind: "discovery_fallback", url: discoveryUrl, primaryUrl: primary };
}

/** Real DB deps for analyzeEvidence: per-cluster cache + audit row in the
 *  radar_evidence_intelligence sidecar. Rows are keyed by canonical cluster so
 *  the same development is analyzed exactly once. */
function evidenceDbDeps(admin: SupabaseClient): {
  cacheGet: (clusterKey: string) => Promise<{ status: EvidenceStatus; card: EvidenceCard | null; sourceStatus?: EvidenceSourceStatus | null } | null>;
  cachePut: (o: { status: EvidenceStatus; card: EvidenceCard | null; reason: string | null; sourceStatus: EvidenceSourceStatus }, input: EvidenceInput) => Promise<void>;
} {
  return {
    cacheGet: async (clusterKey) => {
      const { data } = await admin
        .from("radar_evidence_intelligence")
        .select("analysis_status,card,evidence_source_status")
        .eq("cluster_key", clusterKey)
        .maybeSingle();
      if (!data) return null;
      return {
        status: data.analysis_status as EvidenceStatus,
        card: (data.card ?? null) as EvidenceCard | null,
        sourceStatus: (data.evidence_source_status ?? null) as EvidenceSourceStatus | null,
      };
    },
    cachePut: async (o, input) => {
      // Heuristic role/tier of the analyzed domain (registry-independent — the
      // audit column is informational, mirroring the escalation heuristics).
      const rt = escRoleTier(input.sourceDomain, new Map());
      await admin.from("radar_evidence_intelligence").upsert({
        cluster_key: input.clusterKey,
        story_type: input.storyType,
        analyzed_url: input.sourceUrl,
        analyzed_domain: input.sourceDomain,
        analysis_status: o.status,
        evidence_source_status: o.sourceStatus,
        evidence_source_role: rt.role,
        evidence_source_tier: rt.tier,
        editorial_primary_url: input.editorialPrimaryUrl ?? null,
        editorial_primary_domain: input.editorialPrimaryUrl ? escDomainOf(input.editorialPrimaryUrl) : null,
        applicability: o.card?.applicability ?? null,
        evidence_type: o.card?.evidence_type ?? null,
        peer_review_status: o.card?.peer_review_status ?? null,
        subject_type: o.card?.subject_type ?? null,
        claim_relationship: o.card?.claim_relationship ?? null,
        evidence_strength: o.card?.evidence_strength ?? null,
        source_independence: o.card?.source_independence ?? null,
        sample_size: o.card?.sample_size ?? null,
        card: o.card,
        reason: o.reason,
        model: EVIDENCE_MODEL,
        prompt_version: EVIDENCE_PROMPT_VERSION,
        updated_at: new Date().toISOString(),
      }, { onConflict: "cluster_key" });
    },
  };
}

/** Analyzer handed into runIngestion for an ESL promotion. It receives the SAME
 *  verified source text the Writer is grounded in (single fetch — Evidence
 *  Intelligence interprets exactly what the Writer sees). Never throws; a null/
 *  failed outcome leaves the pipeline exactly as before this feature. */
function makeEvidenceAnalyzer(
  admin: SupabaseClient,
  ctx: { clusterKey: string; storyType: string; sourceKind: EvidenceSourceKind; editorialPrimaryUrl: string | null },
): (verified: SourceText) => Promise<EvidenceOutcome | null> {
  return async (verified) => {
    try {
      const outcome = await analyzeEvidence(
        {
          clusterKey: ctx.clusterKey,
          storyType: ctx.storyType,
          sourceUrl: verified.finalUrl,
          sourceDomain: escDomainOf(verified.finalUrl),
          sourceTitle: verified.title || null,
          sourceText: verified.text,
          sourceKind: ctx.sourceKind,
          editorialPrimaryUrl: ctx.editorialPrimaryUrl,
        },
        { ...evidenceDbDeps(admin), chat: chatEvidence },
      );
      return outcome;
    } catch {
      return null; // evidence must never block the editorial pipeline
    }
  };
}

async function fetchCoverImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SalmaBot/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200000);
    const patterns = [
      /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) {
        try {
          return new URL(m[1].trim(), url).href;
        } catch {
          continue;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function slugify(input: string): string {
  return (
    input
      .trim()
      .replace(/[\u064B-\u065F\u0610-\u061A]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .toLowerCase() || "news"
  );
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in response");
  return JSON.parse(text.slice(start, end + 1));
}

function buildSystem(policy: Policy, validCategories: string[]): string {
  const block = policy.block_topics.length
    ? policy.block_topics.map((t) => `- ${t}`).join("\n")
    : "- (لا قيود إضافية)";
  const priority = policy.priority_topics.length
    ? policy.priority_topics.map((t) => `- ${t}`).join("\n")
    : "- (لا أولويات محددة)";

  return `أنت محرّر صحي في منصة "سلمى" الإخبارية الكويتية. تتلقى نتائج بحث حقيقية من الإنترنت (مع روابطها) وتحوّلها إلى مسودّات أخبار صحية بالعربية الفصحى.

قواعد صارمة:
- استخدم فقط المعلومات الموجودة في نتائج البحث المرفقة. لا تختلق أي حقائق أو أرقام أو أسماء.
- لا تختلق روابط. انسخ رابط المصدر (source_url) حرفياً من نتائج البحث التي اعتمدت عليها لكل خبر.
- ترجم وبسّط المحتوى لقارئ عام في الكويت والخليج مع الحفاظ على الدقة.
- استبعِد تماماً أي خبر يتناول المواضيع التالية (سياسة "ما يجب تجنّبه"):
${block}
- أعطِ الأولوية للمواضيع التالية:
${priority}
- صنّف كل خبر في قسم واحد رئيسي (category_slug) من: ${validCategories.join(", ")}.
  حدّد أولاً الطبيعة التحريرية الجوهرية للخبر، ثم طبّق هذا الترتيب في الأسبقية:
  1) dawi-news: فقط إذا كان الخبر تحديداً عن "داوي" (منتجاتها، شراكاتها، إطلاقاتها، إعلاناتها، مبادراتها، أو تطوّرات الشركة). مجرّد أن يكون الخبر منشوراً أو مصدره داوي لا يجعله dawi-news.
  2) investigations: فقط للأخبار الاستقصائية فعلاً، القائمة على الأدلة، أو تقارير المساءلة/الكشف. لا تستخدمه لمجرّد أنّ المقال طويل.
  3) health-economy: إذا كان جوهر الخبر اقتصاد/أعمال القطاع الصحي (استحواذات، اندماجات، استثمارات، تمويل، أسواق صحية، أعمال الأدوية/التقنية الحيوية، أعمال المستشفيات، اقتصاد التأمين، نتائج مالية، استراتيجية شركة، شراكات تجارية كبرى). هذا القسم يتقدّم على الجغرافيا حين تكون الطبيعة الاقتصادية/التجارية هي محور الخبر — مثال: صفقة استحواذ دوائية أميركية تُصنّف health-economy لا world.
  4) lifestyle: للصحة الشخصية العملية، والعافية، والوقاية، والتغذية، والرياضة، والنوم، وصحة الحياة اليومية، والمواضيع الموجّهة للقارئ.
  5) الأقسام الجغرافية: للأخبار الطبية/الصحة العامة/الصحية الاعتيادية التي لا تنتمي أساساً لأحد الأقسام الموضوعية أعلاه — محورها الكويت → kuwait؛ محورها دولة خليجية أخرى أو شأن خليجي عام → gulf؛ دولية/خارج الخليج → world.
  قواعد حاسمة: ذكرٌ عابر للكويت لا يجعل الخبر kuwait، وذكرٌ عابر لدولة خليجية لا يجعله gulf. حدّد ما يدور حوله الخبر أساساً بالاعتماد على العنوان والموجز والنص المتاح والمصدر والجهات والشركات والجغرافيا، لا على مطابقة كلمات مفتاحية سطحية. اختر قسماً رئيسياً واحداً فقط.
  إذا كانت الثقة منخفضة فعلاً، اترك category_slug فارغاً (null) بدل التخمين؛ سيراجعه المحرّر البشري يدوياً.
- relevance_score: رقم 0-100 يقيس مدى أهمية الخبر لقارئ صحي في الكويت/الخليج.

التقييم التحريري (مهم — ثقة المصدر لا تعني القيمة التحريرية):
- editorial_value_score: رقم 0-100 يقيس القيمة الخبرية الحقيقية للقارئ (تطوّر ملموس ذو أثر عام).
- institutional_pr_score: رقم 0-100 يقيس مدى كون الخبر مجرّد دعاية مؤسسية أو مراسم بلا مضمون.
- عادةً ارفض (institutional_pr مرتفع، editorial_value منخفض): المشاركة في مؤتمرات، رعاية فعاليات، الزيارات والاستقبالات الرسمية، اجتماعات التعاون العامة، الجوائز والتهاني والبروتوكول، الافتتاحات دون معلومات خدمية، مذكرات التفاهم دون مخرجات، التصريحات حول المسؤولين، عبارات الالتزام العامة.
- لكن لا ترفض بناءً على الكلمات المفتاحية وحدها: تحقّق أولاً من وجود تطوّر ملموس يهمّ الجمهور (لائحة أو قرار تنظيمي، تحذير أو سحب دواء، إطلاق خدمة مع تفاصيل الوصول، تغيير يمسّ المرضى أو الأهلية أو التكلفة أو السعة أو أوقات الانتظار، بيانات صحة عامة جديدة، نتيجة سريرية أو بحثية، نتيجة قابلة للقياس، مواعيد أو أماكن أو حجز أو شروط أهلية مفيدة).
- إذا وُجدت معلومة مفيدة داخل بيان دعائي: استخرج المضمون الجوهري واحذف العبارات المراسمية، ولا ترفض الخبر.
- يجب أن يجيب كل خبر مقبول عن: ما الذي تغيّر، من المتأثّر، لماذا يهمّ الآن، ما الحقيقة أو الإجراء المفيد.
- decision: "accept" أو "reject". عند الرفض، اضبط rejection_reason بأحد القيم التالية فقط: ceremonial_or_promotional, no_concrete_public_impact, generic_institutional_announcement, memorandum_without_deliverables, official_activity_without_news_value, weak_or_unverified_source, stronger_primary_source_required.
- المصادر: primary_source_url هو الرابط الأصلي الأقوى (جهة تنظيمية أو وزارة أو جامعة أو مستشفى أو دورية علمية) وليس مجمِّع أخبار ضعيف. secondary_source_urls روابط داعمة إضافية. published_date تاريخ النشر الأصلي إن توفّر (YYYY-MM-DD) وإلا اتركه فارغاً. لا تختلق التواريخ أو الروابط.

أعد النتيجة بصيغة JSON فقط دون أي نص إضافي.`;
}

function buildPrompt(
  regionLabel: string,
  count: number,
  preferDomains: string[],
  avoidDomains: string[],
): string {
  const prefer = preferDomains.length
    ? `\nفضّل المصادر الأساسية الموثوقة من هذه النطاقات (الأقوى أولاً): ${preferDomains.join(", ")}.`
    : "";
  const avoid = avoidDomains.length
    ? `\nتجنّب تماماً هذه النطاقات المحظورة: ${avoidDomains.join(", ")}.`
    : "";
  return `ابحث عن أحدث الأخبار الصحية الموثوقة المتعلقة بـ: ${regionLabel}.${prefer}${avoid}
أنشئ حتى ${count} مسودّات خبر اعتماداً على نتائج البحث الحقيقية فقط.
فضّل الدراسة الأصلية أو الجهة التنظيمية أو الوزارة أو الجامعة أو المستشفى كمصدر نهائي بدلاً من مجمِّع أخبار ضعيف.
أعد كائن JSON بالشكل التالي حصراً:
{"items":[{"title":"العنوان بالعربية","excerpt":"موجز قصير","body":"النص المبسّط","category_slug":"world","read_minutes":3,"relevance_score":70,"original_title":"العنوان الأصلي بلغته","source_url":"https://...","primary_source_url":"https://...","secondary_source_urls":["https://..."],"published_date":"2026-01-01","editorial_value_score":70,"institutional_pr_score":20,"decision":"accept","rejection_reason":null}]}`;
}

function sanitize(items: unknown, validCategories: string[]): Draft[] {
  if (!Array.isArray(items)) return [];
  const fallbackCat = validCategories.includes("world") ? "world" : validCategories[0] ?? "world";
  const out: Draft[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const title = String(o.title ?? "").trim();
    const source_url = String(o.source_url ?? "").trim();
    if (title.length < 4 || !source_url) continue;
    const secondary = Array.isArray(o.secondary_source_urls)
      ? o.secondary_source_urls.map((u) => String(u).trim()).filter(Boolean)
      : [];
    const publishedRaw = String(o.published_date ?? "").trim();
    const reasonRaw = o.rejection_reason;
    out.push({
      title,
      excerpt: String(o.excerpt ?? "").trim(),
      body: String(o.body ?? "").trim(),
      // Empty/omitted → null (genuinely low confidence; admin classifies it in
      // the inbox). A non-empty but INVALID slug is still coerced to the
      // fallback so we never write a dangling category_slug that fails the FK.
      category_slug: String(o.category_slug ?? "").trim() === ""
        ? null
        : validCategories.includes(String(o.category_slug))
          ? String(o.category_slug)
          : fallbackCat,
      read_minutes: Number(o.read_minutes) || 3,
      relevance_score: Math.min(Math.max(Number(o.relevance_score) || 0, 0), 100),
      original_title: String(o.original_title ?? "").trim(),
      source_url,
      primary_source_url: String(o.primary_source_url ?? "").trim() || source_url,
      secondary_source_urls: secondary,
      published_date: publishedRaw || null,
      editorial_value_score: Math.min(Math.max(Number(o.editorial_value_score) || 0, 0), 100),
      institutional_pr_score: Math.min(Math.max(Number(o.institutional_pr_score) || 0, 0), 100),
      rejection_reason:
        String(o.decision ?? "").toLowerCase() === "reject" && isRejectionReason(reasonRaw)
          ? reasonRaw
          : null,
    });
  }
  return out;
}

function citationIndex(citations: Citation[]): Map<string, Citation> {
  const map = new Map<string, Citation>();
  for (const c of citations) {
    const key = dedupeKeyFromUrl(c.url);
    if (key) map.set(key, c);
  }
  return map;
}

// ---- Core run -----------------------------------------------------------

async function runIngestion(
  db: SupabaseClient,
  opts: {
    trigger?: "manual" | "cron";
    perRegion?: number;
    writerMode?: WriterMode;
    pilotLimit?: number | null;
    // E1.3F targeted single-article pilot: an operator-supplied source URL,
    // honored ONLY in pilot mode. Its hostname must match an active, registered,
    // final_source_allowed source (verified below against the loaded registry);
    // ignored entirely in legacy mode.
    targetedSourceUrl?: string | null;
    // Radar one-click publish: the EXACT admin-authorized article URL permitted
    // to bypass the news_sources registry (URL-scoped human authorization). Only
    // set by the entrypoint for an authenticated manual trigger; when it equals
    // targetedSourceUrl the pilot may fetch that one URL via a transient synthetic
    // source. Cron/legacy runs never receive it, so they can never bypass.
    radarAuthorizedUrl?: string | null;
    // Radar exact-article source fallback identifiers (from the TRUSTED radar row,
    // never free text). Honored ONLY when radarAuthorizedUrl is set. provider must
    // be "eventregistry"; providerUri is the stored ER article uri used for the
    // exact-article stored-body recovery; sourceTitle is the ORIGINAL publisher
    // name (e.g. "CNN International") preserved as the editorial source.
    radarErProvider?: string | null;
    radarErProviderUri?: string | null;
    radarSourceTitle?: string | null;
    // Source language (ISO code) from the TRUSTED radar row, honored ONLY with a
    // valid radarAuthorizedUrl. Feeds locale-aware numeric grounding so a European
    // source's period-thousands / comma-decimals are read correctly. Cron/legacy
    // never set it → the validator uses the English-convention default.
    radarSourceLang?: string | null;
    // Evidence Intelligence analyzer for an ESL promotion (bounded: ≤ the daily
    // cap of stories, cached per canonical cluster). Runs over the SAME verified
    // source text the Writer is grounded in, ONLY for the exact authorized URL.
    // Null/absent (all non-ESL paths) → the pipeline is byte-for-byte unchanged.
    evidenceAnalyzer?: ((verified: SourceText) => Promise<EvidenceOutcome | null>) | null;
  } = {},
): Promise<RunStats & { pilot?: PilotReport }> {
  const trigger = opts.trigger ?? "manual";
  const perRegion = Math.min(Math.max(opts.perRegion ?? 3, 1), 5);
  // Controlled-pilot gate: "legacy" (the unchanged pre-pilot path the scheduled
  // cron uses) inserts the discovery draft directly — no source fetch, no Salma
  // writer. "pilot" runs the E1.3C/D verified-source writer. Defaults to legacy
  // so any caller that does not explicitly (and authorizedly) opt in is legacy.
  const writerMode: WriterMode = opts.writerMode ?? "legacy";
  // E1.3E single-article cap. In pilot mode the run processes at most this many
  // candidates that REACH the source-fetch stage (the entrypoint only ever lets
  // pilotLimit=1 through). null in legacy mode → no cap, unchanged behavior.
  const pilotLimit: number | null = writerMode === "pilot" ? (opts.pilotLimit ?? 1) : null;
  // E1.3F: the targeted-pilot URL is honored ONLY in pilot mode; legacy/cron
  // runs ignore it so the scheduled path can never be steered to an arbitrary URL.
  const targetedSourceUrl: string | null = writerMode === "pilot" ? (opts.targetedSourceUrl ?? null) : null;
  // Honored ONLY in pilot mode; the entrypoint additionally restricts it to an
  // authenticated manual trigger. Never consulted in legacy/cron runs.
  const radarAuthorizedUrl: string | null = writerMode === "pilot" ? (opts.radarAuthorizedUrl ?? null) : null;
  // Radar exact-article ER fallback, built ONCE. Available ONLY when: pilot mode,
  // a URL-scoped Radar authorization exists, the provider is Event Registry, and
  // the ER key is configured. null in every other path → the direct fetch is the
  // sole source (unchanged behavior). This closure NEVER searches ER; it recovers
  // only the body of the exact authorized article (by provider_uri, then by URL).
  const erApiKey = Deno.env.get("EVENTREGISTRY_API_KEY") ?? "";
  const radarSourceTitle = radarAuthorizedUrl ? (opts.radarSourceTitle ?? null) : null;
  const radarErFetch: ((url: string, sourceName: string | null) => Promise<SourceFetchResult>) | null =
    radarAuthorizedUrl && erApiKey && opts.radarErProvider === "eventregistry"
      ? (url, sourceName) =>
        fetchErArticleSource({
          erPost: denoErPost(erApiKey),
          providerUri: opts.radarErProviderUri ?? null,
          url,
          sourceName,
        })
      : null;
  // Live pilot counters, mutated as the single candidate is processed; assembled
  // into the returned PilotReport after finalize. null in legacy mode.
  const pilot: PilotReport | null = writerMode === "pilot"
    ? {
      writer_mode: "pilot",
      pilot_limit: pilotLimit ?? 1,
      candidates_considered: 0,
      source_fetches_attempted: 0,
      writer_calls_attempted: 0,
      fallback_calls_attempted: 0,
      writer_attempts: 1,
      writer_second_attempt: "none",
      pending_articles_created: 0,
      rejection_reason: null,
      created_content_id: null,
      editorial: null,
      editor_prompt_version: null,
      fidelity: null,
      needs_human_review: false,
      authorized_source_bypass: false,
    }
    : null;

  // Fail fast on a misconfigured writer route (empty or forbidden model) before
  // any discovery/model call — never silently route to the wrong model. The
  // editorial-director model is asserted on the same rule (independent config).
  assertWriterConfig(WRITER_CONFIG);
  assertEditorConfig(EDITOR_MODEL);

  const { data: policy } = await db
    .from("editorial_policy")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (!policy) throw new Error("no editorial policy configured");

  const validCategories = await fetchCategorySlugs(db);
  const regions: string[] = policy.regions?.length ? policy.regions : ["world"];
  const stats: RunStats = { found: 0, kept: 0, filtered: 0, duplicates: 0 };

  const startedAt = Date.now();
  // Pre-generated so decisions can FK the run row.
  const runId = crypto.randomUUID();

  // Load the source registry fresh each run. FAIL SAFE: if it cannot be loaded
  // or verified we record a `registry_unavailable` run, create NO drafts, leave
  // existing published content untouched, and surface an operational error —
  // we never silently fall back to accepting unverified citations.
  const registry = await loadRegistry(db);
  if (!registryUsable(registry.ok, registry.sources.length)) {
    await db.from("ingestion_runs").insert({
      id: runId,
      trigger,
      status: "error",
      error: "registry_unavailable",
      found: 0,
      kept: 0,
      filtered: 0,
      duplicates: 0,
      duration_ms: Date.now() - startedAt,
      sources: [],
      created_ids: [],
    });
    throw new RegistryUnavailableError();
  }
  const preferDomains = discoveryDomains(registry.sources);
  const avoidDomains = blockedDomains(registry.sources);

  const sourcesChecked = new Set<string>();
  const createdIds: string[] = [];
  const decisions: Decision[] = [];

  // Records the outcome of a single candidate story for the audit log. The
  // `chosen` candidate (when accepted) determines the domain/tier/trust logged;
  // `meta` carries optional E1.2 semantic-dedup audit fields.
  const logDecision = (
    draft: Draft,
    chosen: Candidate | null,
    accepted: boolean,
    reason: DecisionReason | string | null,
    meta: DedupeMeta = {},
    writer: WriterAudit = {},
  ): void => {
    const url = chosen?.url ?? draft.primary_source_url ?? draft.source_url;
    decisions.push({
      title: draft.title,
      source_domain: url ? hostFromUrl(url) : null,
      source_url: url || null,
      source_tier: chosen?.source?.tier ?? null,
      source_trust_score: chosen?.source?.trust_score ?? null,
      editorial_value_score: draft.editorial_value_score,
      institutional_pr_score: draft.institutional_pr_score,
      accepted,
      rejection_reason: reason,
      duplicate_of_content_id: meta.duplicate_of_content_id ?? null,
      similarity_score: meta.similarity_score ?? null,
      dedupe_method: meta.dedupe_method ?? null,
      matched_title: meta.matched_title ?? null,
      selected_final_domain: meta.selected_final_domain ?? null,
      writing_profile: writer.writing_profile ?? null,
      writer_primary_model: writer.writer_primary_model ?? null,
      writer_model_used: writer.writer_model_used ?? null,
      writer_fallback_used: writer.writer_fallback_used ?? null,
      writer_prompt_version: writer.writer_prompt_version ?? null,
      writer_validation_reason: writer.writer_validation_reason ?? null,
      source_extraction_method: writer.source_extraction_method ?? null,
      source_char_count: writer.source_char_count ?? null,
      source_word_count: writer.source_word_count ?? null,
    });
  };

  // A candidate that survived editorial + source selection and is ready to be
  // considered for insertion. Carries its citation-verified candidate set so
  // secondary sources can be preserved when it wins a duplicate cluster.
  type PendingItem = {
    draft: Draft;
    chosen: Candidate;
    candidates: Candidate[];
    citation: Citation;
    key: string;
  };

  const storyTextOf = (draft: Draft): StoryText => ({
    title: draft.title,
    originalTitle: draft.original_title,
    excerpt: draft.excerpt,
  });

  // E1.3F — build the synthetic, discovery-less draft for a targeted pilot. It
  // carries NO editorial text or scores from any caller: title/excerpt/body/
  // original_title stay EMPTY so nothing manually supplied is ever treated as a
  // fact (the writer is grounded solely in the fetched source text), and the
  // editorial/PR scores are 0 because no model classified this story. The only
  // operator input is the URL (as the source pointer); the category is derived
  // conservatively from registry metadata (the matched source's region), falling
  // back to "world". Used only when resolveTargetedSource accepted the URL.
  const buildTargetedDraft = (url: string, source: RegistrySource | null): Draft => {
    const region = source?.region ?? "";
    const category_slug = validCategories.includes(region)
      ? region
      : validCategories.includes("world")
      ? "world"
      : validCategories[0];
    return {
      title: "",
      excerpt: "",
      body: "",
      category_slug,
      read_minutes: 0,
      relevance_score: 0,
      original_title: "",
      source_url: url,
      primary_source_url: url,
      secondary_source_urls: [],
      published_date: null,
      editorial_value_score: 0,
      institutional_pr_score: 0,
      rejection_reason: null,
    };
  };

  // Phase 1 (pure): run the editorial gate + source selection for one draft.
  // Rejections are logged/counted immediately; survivors become PendingItems.
  // No DB writes here so the whole run can be clustered before any insert.
  const evaluateDraft = (
    draft: Draft,
    citations: Map<string, Citation>,
  ): PendingItem | null => {
    stats.found++;

    // The model already judged this a promotional/ceremonial non-story.
    if (draft.rejection_reason) {
      logDecision(draft, null, false, draft.rejection_reason);
      stats.filtered++;
      return null;
    }

    // Deterministic backstop over the model: a high-PR / low-editorial release
    // is rejected even if the model tried to keep it.
    if (failsPrGate(draft.editorial_value_score, draft.institutional_pr_score)) {
      logDecision(draft, null, false, "ceremonial_or_promotional");
      stats.filtered++;
      return null;
    }

    // Build the candidate set from every URL the model attached, keeping only
    // those that match a real citation the plugin returned (anti-fabrication).
    const candidateUrls = [
      draft.primary_source_url,
      draft.source_url,
      ...draft.secondary_source_urls,
    ];
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const url of candidateUrls) {
      const k = dedupeKeyFromUrl(url);
      const citation = k ? citations.get(k) : undefined;
      if (!k || !citation || seen.has(k)) continue;
      seen.add(k);
      candidates.push({ url: citation.url, source: matchSource(hostFromUrl(citation.url), registry.index) });
    }

    // Rank sources: drop blocked, prefer Tier 1 primary over weak aggregators.
    // Registry is guaranteed usable here (the run aborts earlier otherwise).
    const pick = pickFinalSource(candidates, true);
    if (!pick.chosen) {
      logDecision(draft, null, false, pick.reason);
      stats.filtered++;
      return null;
    }
    const chosen = pick.chosen;
    const key = dedupeKeyFromUrl(chosen.url)!;
    const citation = citations.get(key)!;
    return { draft, chosen, candidates, citation, key };
  };

  // Insert one representative draft as a pending editorial draft. `supporting`
  // holds extra candidate URLs (its own secondaries plus the final URLs of the
  // same-run duplicates it represents) preserved as context sources — never
  // merged into the body. Safe to run concurrently: the unique dedupe_key index
  // turns any residual same-key race into a counted duplicate.
  const insertRepresentative = async (
    item: PendingItem,
    supporting: Candidate[],
    written: { article: { title: string; excerpt: string; body: string; summary?: string }; readMinutes: number; audit: WriterAudit },
    meta: DedupeMeta = {},
  ): Promise<string | null> => {
    const { draft, chosen, citation, key } = item;
    const finalUrl = chosen.url;
    const sourceName =
      chosen.source?.name || citation.title || new URL(citation.url).host.replace(/^www\./, "");
    const coverImage = await fetchCoverImage(citation.url);

    // FINAL stored article is the validated writer output, NOT the raw
    // discovery draft. read_minutes is recomputed from the final Arabic body.
    const article = written.article;
    const slug = `${slugify(article.title)}-${Math.random().toString(36).slice(2, 7)}`;
    const payload = {
      title: article.title,
      slug,
      type: "news",
      status: DRAFT_STATUS,
      origin: "ai",
      category_slug: draft.category_slug,
      excerpt: article.excerpt || null,
      ai_summary: article.summary || null,
      body: article.body || null,
      read_minutes: written.readMinutes,
      relevance_score: draft.relevance_score,
      original_title: draft.original_title || null,
      original_url: citation.url,
      source_name: sourceName,
      source_url: finalUrl,
      cover_image_url: coverImage,
      // The ORIGINAL publisher image, persisted independently of the cover so it
      // stays selectable as «الصورة الأصلية» even after an AI/upload replaces the
      // cover. Never modified by later cover changes.
      source_image_url: coverImage,
      cover_credit_name: coverImage ? sourceName : null,
      cover_credit_url: coverImage ? citation.url : null,
      dedupe_key: key,
    };
    const { data, error } = await db
      .from("content")
      .insert(payload)
      .select("id")
      .single();
    if (error || !data) {
      // 23505 = unique_violation: another concurrent item won the same key.
      if ((error as { code?: string } | null)?.code === "23505") {
        logDecision(draft, chosen, false, "duplicate_url", meta, written.audit);
        stats.duplicates++;
      } else {
        logDecision(draft, chosen, false, null, meta, written.audit);
        stats.filtered++;
      }
      return null;
    }

    const contentId = (data as { id: string }).id;
    // Primary source first, then any distinct supporting citations for context.
    const sourceRows = [{ content_id: contentId, label: sourceName, url: finalUrl }];
    const sourceSeen = new Set<string>([finalUrl]);
    for (const c of [...item.candidates, ...supporting]) {
      if (sourceSeen.has(c.url)) continue;
      sourceSeen.add(c.url);
      sourceRows.push({
        content_id: contentId,
        label: c.source?.name || new URL(c.url).host.replace(/^www\./, ""),
        url: c.url,
      });
    }
    await db.from("content_sources").insert(sourceRows);
    logDecision(draft, chosen, true, null, meta, written.audit);
    createdIds.push(contentId);
    stats.kept++;
    return contentId;
  };

  // Fetch + evaluate each region concurrently (network-bound), returning the
  // survivors. Clustering across the whole run happens after all regions gather.
  const gatherRegion = async (region: string): Promise<PendingItem[]> => {
    const regionLabel = REGION_LABELS[region] ?? region;
    let result: WebChatResult;
    try {
      result = await chatWeb(
        [
          { role: "system", content: buildSystem(policy as Policy, validCategories) },
          { role: "user", content: buildPrompt(regionLabel, perRegion, preferDomains, avoidDomains) },
        ],
        { temperature: 0.3, maxTokens: 2600, maxResults: 8 },
      );
    } catch {
      return [];
    }

    for (const c of result.citations) {
      try {
        sourcesChecked.add(new URL(c.url).host.replace(/^www\./, ""));
      } catch {
        // skip unparseable citation URLs
      }
    }

    const citations = citationIndex(result.citations);
    let parsed: { items?: unknown };
    try {
      parsed = extractJson(result.content) as { items?: unknown };
    } catch {
      return [];
    }

    const pending: PendingItem[] = [];
    for (const draft of sanitize(parsed.items, validCategories)) {
      const item = evaluateDraft(draft, citations);
      if (item) pending.push(item);
    }
    return pending;
  };

  // Recent news content for the semantic existing-content comparison. Scope is
  // deliberately ORIGIN-AGNOSTIC: published, pending, and draft news items are
  // all included (regardless of origin) so the agent cannot recreate a story an
  // editor already wrote by hand. Non-news types and soft-deleted rows are
  // excluded. A bounded 14-day lookback + row cap keeps this a small, indexed
  // scan; older stories are still protected from exact-URL repeats by the
  // per-item dedupe_key point lookup below.
  type RecentContent = { id: string; title: string; original_title: string | null };
  const loadRecentContent = async (): Promise<RecentContent[]> => {
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    try {
      const { data } = await db
        .from("content")
        .select("id,title,original_title")
        .eq("type", "news")
        .is("deleted_at", null)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(500);
      return (data as RecentContent[] | null) ?? [];
    } catch {
      return [];
    }
  };

  // Phase 3: for a cluster representative, reject if it repeats stored content —
  // first by exact dedupe_key (any age), then by semantic title match against
  // the recent window — otherwise insert it as a pending draft.
  const commitRepresentative = async (
    item: PendingItem,
    supporting: Candidate[],
    recent: RecentContent[],
  ): Promise<{ reachedFetchStage: boolean; result: string | null }> => {
    const { draft, chosen, key } = item;

    // Exact URL repeat (indexed point lookup, not time-bounded).
    const { data: existing } = await db
      .from("content")
      .select("id")
      .eq("dedupe_key", key)
      .maybeSingle();
    if (existing) {
      const existingId = (existing as { id: string }).id;
      logDecision(draft, chosen, false, "duplicate_existing_content", {
        duplicate_of_content_id: existingId,
        dedupe_method: "exact_url",
        selected_final_domain: hostFromUrl(chosen.url),
      });
      stats.duplicates++;
      return { reachedFetchStage: false, result: existingId };
    }

    // Semantic repeat against recent stored content (origin-agnostic).
    const text = storyTextOf(draft);
    for (const r of recent) {
      const verdict = storyDuplicate(text, { title: r.title, originalTitle: r.original_title });
      if (verdict.duplicate) {
        logDecision(draft, chosen, false, "duplicate_semantic_existing", {
          duplicate_of_content_id: r.id,
          similarity_score: verdict.score,
          dedupe_method: verdict.method,
          matched_title: r.title,
          selected_final_domain: hostFromUrl(chosen.url),
        });
        stats.duplicates++;
        return { reachedFetchStage: false, result: r.id };
      }
    }

    // Legacy path (pilot gate): the scheduled cron and any non-pilot caller keep
    // the exact pre-pilot behavior — insert the discovery draft as the pending
    // AI draft, with NO source fetch and NO Salma writer call. The stored
    // status/origin/type are identical to the pilot path (pending / ai / news);
    // only the body provenance differs. The writer audit stays empty so the
    // legacy cron audit trail is unchanged.
    if (writerMode === "legacy") {
      const legacyWritten = {
        article: { title: draft.title, excerpt: draft.excerpt, body: draft.body },
        readMinutes: draft.read_minutes,
        audit: {} as WriterAudit,
      };
      const legacyId = await insertRepresentative(item, supporting, legacyWritten);
      return { reachedFetchStage: false, result: legacyId };
    }

    // Source-text stage (E1.3D, pilot only): the story has passed editorial +
    // source selection, same-run representative selection, and BOTH existing-content
    // dedup checks. Only now — for the ONE final, registered, final_source_allowed
    // URL — do we fetch and extract the real source page. pickFinalSource(_, true)
    // guarantees chosen.source is a registered final source with a domain; the
    // fetch is SSRF-validated against exactly that domain (see fetchSourceText).
    const registeredDomain = chosen.source?.domain ?? null;
    if (!registeredDomain) {
      // Defensive: a final source without a domain cannot be safely fetched.
      // This is BEFORE the fetch stage, so it does NOT consume the single pilot
      // slot — the bounded loop moves on to the next representative.
      logDecision(draft, chosen, false, "source_text_unavailable");
      stats.filtered++;
      return { reachedFetchStage: false, result: null };
    }

    // FETCH STAGE reached (E1.3E): from here this candidate consumes the single
    // pilot slot even if extraction/writing then fails. Counted before the fetch
    // is attempted so the bounded loop stops after exactly one fetch-stage try.
    if (pilot) pilot.source_fetches_attempted += 1;

    // Writer stage (E1.3C/D): groundedWrite fetches+extracts the verified source
    // text and ONLY THEN calls the writer — exactly once, and never on a
    // fetch/extraction failure. A source-fetch failure creates NO pending draft
    // and NO paid writer call; the discrete source_* reason is recorded on the
    // audit row. The writer/validator are grounded in the extracted source text,
    // never the discovery draft (see writeArticle). A parse/validation failure is
    // likewise a rejection that creates no draft (fallback never runs after a
    // factual validation failure — see orchestrateWriter).
    const grounded = await groundedWrite<WriterOutcome>({
      fetchSource: async () => {
        // Attempt 1 — direct extraction of the ORIGINAL publisher page, with ALL
        // SSRF/DNS/redirect/domain protections intact. This is the ONLY path for
        // every non-Radar candidate and the preferred path for Radar too.
        const direct = await fetchSourceText({
          url: chosen.url,
          registeredDomain,
          sourceName: chosen.source?.name ?? null,
          rawFetch: denoRawFetch,
          // E1.3E: per-hop DNS-resolution SSRF check (see denoResolveDns). A
          // DNS/security failure returns a discrete source_* reason → no writer
          // call, no pending draft, and a rejection audit row (below).
          resolveDns: denoResolveDns,
        });
        if (direct.ok) return direct;
        // Attempt 2 & 3 — admin-authorized Radar exact-article ER fallback, ONLY
        // for the exact authorized URL (chosen.url === radarAuthorizedUrl). ER is
        // a technical fetch provider: it recovers the SAME article's body (by
        // provider_uri, then by exact URL) — never a different/similar story, and
        // never becomes the editorial source. On ER failure we keep the DIRECT
        // failure reason so the audit/UX reflects the original-source outcome.
        if (radarErFetch && chosen.url === radarAuthorizedUrl) {
          const recovered = await radarErFetch(chosen.url, chosen.source?.name ?? null);
          if (recovered.ok) return recovered;
        }
        return direct;
      },
      write: async (verified) => {
        // Evidence Intelligence (ESL promotions only, same scope as the other
        // radar-authorized extras): ONE bounded, cached analysis of the SAME
        // verified source text the Writer sees. Never blocks — a failed or
        // unavailable analysis simply passes no evidence context.
        let evidence: EvidenceOutcome | null = null;
        if (opts.evidenceAnalyzer && chosen.url === radarAuthorizedUrl) {
          evidence = await opts.evidenceAnalyzer(verified);
        }
        return writeArticle({
          verified,
          discovery: {
            originalTitle: draft.original_title,
            body: draft.body,
            excerpt: draft.excerpt,
          },
          sourceName: chosen.source?.name ?? item.citation.title ?? null,
          registeredDomain,
          citationTitles: [item.citation.title].filter((t): t is string => !!t),
          // Locale-aware numeric grounding: the trusted radar-row language, used
          // ONLY for the exact admin-authorized URL (same scope as the ER
          // fallback). Every other candidate passes null → English convention.
          sourceLang: chosen.url === radarAuthorizedUrl ? (opts.radarSourceLang ?? null) : null,
          evidence: evidence?.status === "complete" ? evidence.card : null,
        });
      },
    });
    if (!grounded.ok) {
      // Source fetch/extraction (incl. DNS-security) failed: no writer call, no
      // pending draft. The discrete source_* reason is the pilot's rejection.
      logDecision(draft, chosen, false, grounded.reason);
      stats.filtered++;
      if (pilot) pilot.rejection_reason = grounded.reason;
      return { reachedFetchStage: true, result: null };
    }

    // The writer WAS called (groundedWrite only calls write() on a successful
    // fetch): count exactly one primary writer call, plus one fallback call iff
    // the primary suffered a qualifying technical failure (writer_fallback_used).
    const written = grounded.value;
    if (pilot) {
      pilot.writer_calls_attempted += 1;
      if (written.audit.writer_fallback_used) pilot.fallback_calls_attempted += 1;
      // Surface the writer attempt count + second-attempt type (json_recovery
      // when the one strict-JSON reparse retry fired). Observability only.
      pilot.writer_attempts = written.writerAttempts;
      pilot.writer_second_attempt = written.writerSecondAttempt;
      // The editor + fidelity stages run inside writeArticle on every draft that
      // reached the writer, so surface their audits on BOTH outcomes (a
      // fidelity-stage rejection still ran the editor first — editorial-policy
      // ordering — and carries a fidelity audit).
      if (written.editorial) {
        pilot.editorial = written.editorial;
        pilot.editor_prompt_version = EDITOR_PROMPT_VERSION;
      }
      pilot.fidelity = written.fidelity;
      if (written.ok) pilot.needs_human_review = written.needsHumanReview;
    }
    if (!written.ok) {
      logDecision(draft, chosen, false, written.rejection, {
        selected_final_domain: hostFromUrl(chosen.url),
      }, written.audit);
      stats.filtered++;
      if (pilot) pilot.rejection_reason = written.rejection;
      return { reachedFetchStage: true, result: null };
    }

    const insertedId = await insertRepresentative(item, supporting, written, {
      selected_final_domain: hostFromUrl(chosen.url),
    });
    if (pilot && !insertedId) pilot.rejection_reason = "pending_insert_failed";
    return { reachedFetchStage: true, result: insertedId };
  };

  // Persist the per-candidate audit trail. The run row already exists (created
  // as 'running' below) so the run_id FK always resolves. This is MANDATORY:
  // the returned result reports failure (the supabase client returns { error }
  // rather than throwing) so the caller can refuse to mark the run successful.
  const persistDecisions = async (): Promise<{ ok: boolean; error?: string }> => {
    if (decisions.length === 0) return { ok: true };
    const rows = decisions.map((d) => ({
      ...d,
      run_id: runId,
      model: DEFAULT_MODEL,
      prompt_version: PROMPT_VERSION,
    }));
    try {
      const { error } = await db.from("ingestion_decisions").insert(rows);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // Best-effort rollback used only when the mandatory audit write fails. Deletes
  // exactly the pending AI drafts THIS run created (guarded by selectRollbackTargets
  // — never previously-existing or since-published content); content_sources rows
  // cascade-delete via their `on delete cascade` FK.
  const rollbackCreatedContent = async (): Promise<{ ok: boolean; error?: string }> => {
    if (createdIds.length === 0) return { ok: true };
    try {
      const { data, error: selErr } = await db
        .from("content")
        .select("id,origin,status")
        .in("id", createdIds);
      if (selErr) return { ok: false, error: selErr.message };
      const targets = selectRollbackTargets(
        (data as { id: string; origin: string | null; status: string | null }[] | null) ?? [],
        createdIds,
        DRAFT_STATUS,
      );
      if (targets.length === 0) return { ok: true };
      const { error: delErr } = await db.from("content").delete().in("id", targets);
      if (delErr) return { ok: false, error: delErr.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // Run lifecycle: create the run row up front as 'running' so decisions can
  // reference it and so a crash mid-run leaves a visibly-unfinished row (never
  // a misleading 'success'). It is UPDATEd to a terminal state on completion.
  await db.from("ingestion_runs").insert({
    id: runId,
    trigger,
    status: "running",
    found: 0,
    kept: 0,
    filtered: 0,
    duplicates: 0,
    sources: [],
    created_ids: [],
  });

  type Plan = { rep: PendingItem; members: PendingItem[]; supporting: Candidate[] };

  let phaseError: unknown = null;
  try {
    let plans: Plan[];

    if (targetedSourceUrl) {
      // TARGETED single-article pilot (E1.3F): skip discovery ENTIRELY (no web
      // discovery model call, no clustering) and build exactly ONE representative
      // from the operator-supplied URL — but ONLY when its hostname matches an
      // active, registered, final_source_allowed source. The URL is the sole
      // operator input; no manually-supplied title/body/excerpt/entity/category
      // is trusted (buildTargetedDraft leaves them empty), so the fetched page
      // must supply every fact. An unregistered/blocked/context-only URL is a
      // hard rejection here: no fetch, no writer call, no insert.
      sourcesChecked.add(hostFromUrl(targetedSourceUrl));
      // URL-scoped human-authorized bypass: when the entrypoint marked this exact
      // URL as admin-authorized (radarAuthorizedUrl === targetedSourceUrl), an
      // unregistered host resolves to a TRANSIENT synthetic source scoped to that
      // one URL. Otherwise this is identical to resolveTargetedSource (registry
      // required). SSRF/redirect/DNS protections are unchanged — fetchSourceText
      // still validates every hop against the resolved host.
      const resolved = resolveAuthorizedTargetedSource(
        targetedSourceUrl,
        registry.index,
        radarAuthorizedUrl,
      );
      const key = dedupeKeyFromUrl(targetedSourceUrl);
      if (!resolved.ok || !key) {
        const reason = resolved.ok ? "pilot_source_url_invalid" : resolved.reason;
        logDecision(
          buildTargetedDraft(targetedSourceUrl, null),
          { url: targetedSourceUrl, source: null },
          false,
          reason,
          { selected_final_domain: hostFromUrl(targetedSourceUrl) },
        );
        stats.filtered++;
        if (pilot) pilot.rejection_reason = reason;
        plans = [];
      } else {
        if (pilot) pilot.authorized_source_bypass = resolved.authorized;
        // Preserve the ORIGINAL publisher identity: the URL-scoped synthetic
        // Radar source defaults its name to the bare host (e.g. "edition.cnn.com").
        // When the trusted radar row carries the publisher title (e.g. "CNN
        // International"), use it as the editorial source name so the stored
        // content and its content_sources show the publisher, never the host and
        // never Event Registry. Applied ONLY to the transient authorized source
        // (never a registered news_source, which already has its proper name).
        if (resolved.authorized && resolved.source && radarSourceTitle) {
          resolved.source.name = radarSourceTitle;
        }
        const draft = buildTargetedDraft(targetedSourceUrl, resolved.source);
        const chosen: Candidate = { url: targetedSourceUrl, source: resolved.source };
        const rep: PendingItem = {
          draft,
          chosen,
          candidates: [chosen],
          citation: { url: targetedSourceUrl, title: "" },
          key,
        };
        plans = [{ rep, members: [], supporting: [] }];
      }
    } else {
      // Phase 1: gather every editorial+source survivor across all regions.
      const pendings = (await Promise.all(regions.map(gatherRegion))).flat();

      // Phase 2: cluster same-run duplicates. Each high-confidence cluster yields
      // ONE representative (strongest eligible source); the rest are logged as
      // same-run semantic duplicates and their final URLs preserved as supporting
      // sources on the winner — never as separate drafts.
      //
      // Source ranking deliberately excludes any per-item published_date: the only
      // dates available here come from model output and are unverified, so they
      // must never influence which source wins. tier/trust/final-eligibility/
      // primary-status decide (see betterSource).
      const clusters = clusterStories(pendings, (p) => storyTextOf(p.draft));
      plans = clusters.map((cluster) => {
        const bestIdx = pickBestIndex(cluster.map((p) => ({ source: p.chosen.source })));
        const rep = cluster[bestIdx];
        const members = cluster.filter((_, i) => i !== bestIdx);
        const supporting = members.map((m) => m.chosen);
        return { rep, members, supporting };
      });
    }

    // Phase 3: reject representatives that repeat recent stored content, then
    // insert the rest as pending drafts. The winner is committed FIRST so its
    // canonical content id (whether freshly inserted or the row it matched) can
    // be linked from every same-run duplicate's audit record.
    const recent = await loadRecentContent();
    // Phase-3 processing is bounded for the pilot: processRepresentativesWithLimit
    // stops STARTING new representatives once `pilotLimit` of them have reached the
    // source-fetch stage (limit=1 for the first pilot). In legacy mode the limit is
    // null → every representative is processed, unchanged. A representative rejected
    // BEFORE the fetch stage (a duplicate, or a final source without a domain) does
    // not consume the slot, so the loop keeps looking for the one real pilot candidate.
    const loopResult = await processRepresentativesWithLimit({
      representatives: plans,
      limit: pilotLimit,
      commit: async ({ rep, members, supporting }) => {
        const outcome = await commitRepresentative(rep, supporting, recent);
        for (const dup of members) {
          const verdict = storyDuplicate(storyTextOf(dup.draft), storyTextOf(rep.draft));
          logDecision(dup.draft, dup.chosen, false, "duplicate_semantic_same_run", {
            duplicate_of_content_id: outcome.result,
            similarity_score: verdict.score,
            dedupe_method: verdict.method ?? "semantic_title",
            matched_title: rep.draft.title,
            selected_final_domain: hostFromUrl(rep.chosen.url),
          });
          stats.duplicates++;
        }
        return outcome;
      },
      // Pilot only: representatives after the single slot are deliberately not
      // processed. Record them (and their cluster members) honestly so the audit
      // shows they were deferred by the single-article cap, not silently dropped.
      onSkipped: ({ rep, members }) => {
        logDecision(rep.draft, rep.chosen, false, "pilot_single_article_limit", {
          selected_final_domain: hostFromUrl(rep.chosen.url),
        });
        stats.filtered++;
        for (const dup of members) {
          logDecision(dup.draft, dup.chosen, false, "pilot_single_article_limit");
          stats.filtered++;
        }
      },
    });

    if (pilot) {
      pilot.candidates_considered = loopResult.processed;
      pilot.pending_articles_created = createdIds.length;
      pilot.created_content_id = createdIds[0] ?? null;
    }

  } catch (e) {
    phaseError = e;
  }

  // Finalize: the audit trail is mandatory. finalizeRun always attempts to persist
  // the decisions and decides the terminal state — a failed audit on an otherwise
  // successful run becomes an error (after rolling back this run's created drafts),
  // never a misleading success.
  const final = await finalizeRun({
    phaseError,
    createdIds,
    persist: persistDecisions,
    cleanupCreated: rollbackCreatedContent,
  });
  // E1.3F: mark a targeted pilot at the run level with the registered domain it
  // targeted (never the full URL, never any secret or extracted body). The key
  // is included ONLY for a targeted run, so legacy/cron/ordinary-pilot runs never
  // reference the additive `pilot_source_domain` column (migration-ordering safe:
  // the column must exist before the first targeted pilot, but non-targeted runs
  // are unaffected whether or not it has been applied).
  const runUpdate: Record<string, unknown> = {
    status: final.status,
    error: final.status === "error" ? final.error : null,
    ...stats,
    duration_ms: Date.now() - startedAt,
    sources: [...sourcesChecked],
    created_ids: final.createdIds,
  };
  if (targetedSourceUrl) runUpdate.pilot_source_domain = hostFromUrl(targetedSourceUrl);
  await db.from("ingestion_runs").update(runUpdate).eq("id", runId);

  // Return an error to the caller: re-throw the original phase failure, or raise
  // the mandatory-audit failure so the run is never treated as successful.
  if (phaseError != null) throw phaseError;
  if (final.throwMessage) throw new Error(final.throwMessage);
  // Reaching here means finalizeRun persisted the mandatory audit (it throws
  // otherwise), so the pilot report below is only ever returned for an audited run.
  return pilot ? { ...stats, pilot } : stats;
}

// ---- Auth + HTTP entrypoint --------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const INGEST_SECRET = Deno.env.get("INGEST_SECRET");

/** Returns the run trigger if authorized, otherwise null. */
async function authorize(
  req: Request,
  admin: SupabaseClient,
): Promise<"cron" | "manual" | null> {
  // Cron path: shared secret header set by run_news_ingestion().
  const provided = req.headers.get("x-ingest-secret");
  if (INGEST_SECRET && provided && provided === INGEST_SECRET) return "cron";

  // Manual path: a signed-in admin's session JWT.
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt === ANON_KEY) return null;

  const authClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) return null;

  const { data: profile } = await admin
    .from("profiles")
    .select("role,disabled")
    .eq("id", user.id)
    .maybeSingle();
  if (
    profile &&
    ["admin", "super_admin", "owner"].includes(profile.role) &&
    !profile.disabled
  )
    return "manual";
  return null;
}

// --- Radar one-click publish: terminal-state ownership ----------------------
//
// For a Radar-authorized one-click publish, THIS Edge Function owns the final
// radar_shadow_articles state transition — it must be written BEFORE the HTTP
// response returns, using the service-role client already created below. This
// closes the failure mode where the Next.js server action was terminated after
// the invoke returned 200, orphaning the row in 'processing'. The server action
// now only latches 'processing' and reads back the terminal state we write.
//
// Two modes, selected by radar_publish_mode:
//   "publish" (default) — the direct one-click path (نشر مباشر).
//   "prepare"           — the editorial preparation path (تحرير في سلمى): create
//                         the Content as `pending`, DON'T publish, leave the Radar
//                         row 'draft' linked to it so a human edits then publishes.
//
// Terminal outcomes:
//   (a) published      — publish mode, content clean AND has a cover image →
//                        flip pending→published.
//   (b) draft          — prepare mode (any content), OR publish mode when the
//                        clean article has NO cover image (graceful fallback to
//                        editorial review — NOT a failure). needs_cover marks the
//                        missing-cover case for the UI.
//   (c) needs_review   — publish mode, a real Content row exists but is not clean
//                        (or was no longer 'pending' at publish time).
//   (d) failed         — the pipeline stopped BEFORE any Content row (source
//                        retrieval / Writer / Editor / Fidelity / validation).
// A duplicate/existing-content match never reaches here: the server action
// blocks it before invoking, so no run is started and no Content is created.
type RadarPublishOutcome =
  | { status: "published"; content_id: string }
  | { status: "draft"; content_id: string; needs_cover: boolean }
  | { status: "needs_review"; content_id: string; reason: string | null }
  | { status: "failed"; reason: string | null };

/** True when the created Content row already carries a non-empty cover image. */
async function contentHasCover(admin: SupabaseClient, contentId: string): Promise<boolean> {
  const { data } = await admin
    .from("content")
    .select("cover_image_url")
    .eq("id", contentId)
    .maybeSingle();
  const url = (data as { cover_image_url?: string | null } | null)?.cover_image_url ?? null;
  return !!(url && String(url).trim());
}

// Write a terminal radar state, but ONLY for the row still owned by this
// authorized run (publish_status = 'processing'). Scoping to 'processing'
// guarantees the Edge Function finalizes exactly the row the server action
// latched for THIS invocation and never mutates an unrelated radar row.
async function setRadarTerminal(
  admin: SupabaseClient,
  radarId: string,
  patch: { publish_status: string; published_content_id: string | null; publish_error: string | null },
): Promise<void> {
  await admin
    .from("radar_shadow_articles")
    .update(patch)
    .eq("id", radarId)
    .eq("publish_status", "processing");
}

/** Validate a category slug against the live categories table; null if unknown. */
async function resolveRadarCategory(admin: SupabaseClient, slug: string | null): Promise<string | null> {
  const s = String(slug ?? "").trim();
  if (!s) return null;
  const { data } = await admin.from("categories").select("slug").eq("slug", s).maybeSingle();
  return data ? s : null;
}

/**
 * Finalize the Radar row for an authorized one-click publish from the pilot
 * outcome, writing the terminal state before the HTTP response returns. This is
 * the SAME terminal decision the server action used to own — moved here so the
 * write survives server-action termination. It changes no editorial safeguard;
 * it only persists the pipeline's already-decided outcome.
 */
async function finalizeRadarPublish(
  admin: SupabaseClient,
  radarId: string,
  pilot: PilotReport | null,
  categorySlugInput: string | null,
  mode: "publish" | "prepare",
): Promise<RadarPublishOutcome> {
  const contentId = pilot?.created_content_id ?? null;

  // (d) No Content row → the pipeline stopped before creation. Retryable failed.
  if (!contentId) {
    const reason = pilot?.rejection_reason ?? "no_content_created";
    await setRadarTerminal(admin, radarId, {
      publish_status: "failed",
      published_content_id: null,
      publish_error: reason,
    });
    return { status: "failed", reason };
  }

  // (b-prepare) Editorial preparation: the pipeline produced a real Content row.
  //     Leave it `pending` and mark the Radar row 'draft' linked to it — never
  //     publish here. `needs_cover` marks a missing cover image for the UI.
  if (mode === "prepare") {
    const needsCover = !(await contentHasCover(admin, contentId));
    await setRadarTerminal(admin, radarId, {
      publish_status: "draft",
      published_content_id: contentId,
      publish_error: needsCover ? "needs_cover" : null,
    });
    return { status: "draft", content_id: contentId, needs_cover: needsCover };
  }

  // (c) Direct publish, content exists but not clean → leave it pending for human
  //     review, and record needs_review WITH the content id (card links to Content).
  const clean = pilot?.needs_human_review === false && pilot?.fidelity?.decision === "clean";
  if (!clean) {
    const reason = pilot?.rejection_reason ?? "needs_human_review";
    await setRadarTerminal(admin, radarId, {
      publish_status: "needs_review",
      published_content_id: contentId,
      publish_error: reason,
    });
    return { status: "needs_review", content_id: contentId, reason };
  }

  // (b-cover) Direct publish of a clean article WITHOUT a cover image → do NOT
  //     publish an image-less article. Fall back to editorial review: keep the
  //     Content `pending`, mark the Radar row 'draft' + needs_cover. This is a
  //     graceful fallback, never a failure — the human adds a cover then publishes.
  if (!(await contentHasCover(admin, contentId))) {
    await setRadarTerminal(admin, radarId, {
      publish_status: "draft",
      published_content_id: contentId,
      publish_error: "needs_cover",
    });
    return { status: "draft", content_id: contentId, needs_cover: true };
  }

  // (a) Clean AND has a cover → apply the optional category, then flip
  //     pending→published. Only a 'pending' row is ever published (mirrors
  //     setStatus); a non-pending row is linked and left for review.
  const categorySlug = await resolveRadarCategory(admin, categorySlugInput);
  const publishPatch: Record<string, unknown> = {
    status: "published",
    published_at: new Date().toISOString(),
  };
  if (categorySlug) publishPatch.category_slug = categorySlug;

  const { data: published } = await admin
    .from("content")
    .update(publishPatch)
    .eq("id", contentId)
    .eq("status", "pending")
    .is("deleted_at", null)
    .select("id");

  if (!published || published.length === 0) {
    await setRadarTerminal(admin, radarId, {
      publish_status: "needs_review",
      published_content_id: contentId,
      publish_error: "content_not_pending",
    });
    return { status: "needs_review", content_id: contentId, reason: "content_not_pending" };
  }

  await setRadarTerminal(admin, radarId, {
    publish_status: "published",
    published_content_id: contentId,
    publish_error: null,
  });
  return { status: "published", content_id: contentId };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const trigger = await authorize(req, admin);
  if (!trigger) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Controlled-pilot gate (E1.3E). Only an AUTHORIZED caller (verified above via
  // the ingest secret or an admin JWT) that EXPLICITLY sends writer_mode:"pilot"
  // AND an explicit pilot_limit of exactly 1 runs the verified-source Salma
  // writer; everything else — including the scheduled cron, which sends no body —
  // stays on the unchanged legacy path. A pilot request with a missing/other/>1
  // pilot_limit is REJECTED (HTTP 400) and performs NO ingestion, rather than
  // silently clamping. Resolving with authorized=true is sound because an
  // unauthorized request already returned 401 above and can never reach here.
  // This does NOT read or change OPENROUTER_MODEL or any writer-model secret.
  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  // Bounded official-asset retrieval op (Content editor «صورة من المصدر الرسمي»).
  // Admin-only (never cron), read-only, and scoped to URLs the caller already has
  // for the article (its source/content_sources). Reuses the SSRF-safe fetch and
  // returns declared official images; never runs the ingestion pipeline. Any
  // failure yields an empty list — it must never break the editor.
  if ((body as { op?: unknown })?.op === "source_assets") {
    if (trigger !== "manual") {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const rawUrls = Array.isArray((body as { urls?: unknown }).urls) ? (body as { urls: unknown[] }).urls : [];
    const items = rawUrls
      .map((x) => {
        const o = (x ?? {}) as Record<string, unknown>;
        return { url: String(o.url ?? "").trim().slice(0, 2000), label: String(o.label ?? "").trim().slice(0, 160) };
      })
      .filter((it) => it.url)
      .slice(0, 8);
    const assets = await extractOfficialAssets(items, denoResolveDns).catch(() => []);
    return Response.json({ ok: true, assets });
  }

  // Primary Source Escalation — DRY RUN (op:"escalate_source"). Runs the bounded
  // escalation ladder for ONE selected cluster and returns/caches the result
  // WITHOUT creating any Content. This is the safe way to validate escalation on
  // real selected clusters. Read-only; authorized caller only (already gated above).
  if ((body as { op?: unknown })?.op === "escalate_source") {
    const b = body as Record<string, unknown>;
    const discoveryUrl = asTrimmedTop(b.discovery_url);
    const clusterKey = asTrimmedTop(b.cluster_key);
    if (!discoveryUrl || !clusterKey) {
      return Response.json({ ok: false, error: "cluster_key and discovery_url required" }, { status: 400 });
    }
    const result = await runEscalation(admin, {
      clusterKey,
      storyType: asTrimmedTop(b.story_type) ?? "general",
      discoveryUrl,
      discoveryDomain: asTrimmedTop(b.discovery_domain) ?? escDomainOf(discoveryUrl),
      title: asTrimmedTop(b.title),
      titleAr: asTrimmedTop(b.title_ar),
    });
    return Response.json({ ok: true, escalation: result });
  }

  // Evidence Intelligence — DRY RUN (op:"analyze_evidence"). Fetches ONE source
  // page (same hardened SSRF-safe path the pipeline uses), runs the bounded
  // structured evidence analysis and returns the card WITHOUT creating any
  // Content. persist:true additionally writes the per-cluster cache/audit row
  // (so a validated real cluster is not re-analyzed at promotion time).
  // Authorized caller only (already gated above).
  if ((body as { op?: unknown })?.op === "analyze_evidence") {
    const b = body as Record<string, unknown>;
    const url = asTrimmedTop(b.url);
    const clusterKey = asTrimmedTop(b.cluster_key);
    if (!url || !clusterKey) {
      return Response.json({ ok: false, error: "cluster_key and url required" }, { status: 400 });
    }
    const persist = b.persist === true;
    const storyType = asTrimmedTop(b.story_type) ?? "general";

    // use_escalation:true mirrors the LIVE promotion path: run/reuse the cached
    // escalation for this cluster (url = the discovery URL), then resolve the
    // strongest FETCHABLE source (primary → supporting → discovery) exactly as
    // a real promotion would, recording the fallback provenance.
    let resolved: ResolvedEvidenceSource = { kind: "primary", url, primaryUrl: null };
    if (b.use_escalation === true) {
      const esc = await runEscalation(admin, {
        clusterKey,
        storyType,
        discoveryUrl: url,
        discoveryDomain: escDomainOf(url),
        title: asTrimmedTop(b.title),
        titleAr: asTrimmedTop(b.title_ar),
      });
      if (esc.status === "upgraded" && /^https?:\/\//i.test(esc.selected_editorial_source.url)) {
        resolved = await resolveAnalysisSource(esc, url);
      }
    }

    const fetched = await fetchSourceText({
      url: resolved.url,
      registeredDomain: escDomainOf(resolved.url),
      sourceName: null,
      rawFetch: denoRawFetch,
      resolveDns: denoResolveDns,
    });
    if (!fetched.ok) {
      return Response.json({ ok: false, error: fetched.reason, analysis_source: resolved }, { status: 422 });
    }
    const db = evidenceDbDeps(admin);
    const outcome = await analyzeEvidence(
      {
        clusterKey,
        storyType,
        sourceUrl: fetched.finalUrl,
        sourceDomain: escDomainOf(fetched.finalUrl),
        sourceTitle: fetched.title || null,
        sourceText: fetched.text,
        sourceKind: resolved.kind,
        editorialPrimaryUrl: resolved.primaryUrl,
      },
      {
        cacheGet: persist ? db.cacheGet : async () => null,
        cachePut: persist ? db.cachePut : async () => {},
        chat: chatEvidence,
      },
    );
    return Response.json({ ok: true, evidence: outcome, analysis_source: resolved, source_chars: fetched.charCount });
  }

  const gate = resolvePilotGate({
    authorized: true,
    requestedMode: (body as { writer_mode?: unknown })?.writer_mode,
    requestedLimit: (body as { pilot_limit?: unknown })?.pilot_limit,
    // E1.3F: an optional targeted source URL, honored ONLY for an authorized
    // pilot (limit=1). A legacy/cron/default request never reaches the pilot
    // branch of the gate, so pilot_source_url is ignored there. A supplied-but-
    // unusable URL is a hard gate rejection (HTTP 400, no ingestion).
    requestedSourceUrl: (body as { pilot_source_url?: unknown })?.pilot_source_url,
  });
  if (gate.mode === "rejected") {
    // No ingestion runs: a malformed pilot request must not fall through to a run.
    return Response.json({ ok: false, error: gate.reason }, { status: 400 });
  }
  const writerMode: WriterMode = gate.mode === "pilot" ? "pilot" : "legacy";
  const pilotLimit = gate.mode === "pilot" ? gate.limit : null;
  const targetedSourceUrl = gate.mode === "pilot" ? (gate.sourceUrl ?? null) : null;

  // ESL scheduled promotion: the Editorial Selection Layer runs server-side under
  // the ingest secret (trigger "cron") and, like the admin one-click path, hands
  // us the EXACT article URL + identifiers read from the TRUSTED
  // radar_shadow_articles row (never operator free text). It opts in with
  // op:"esl_promote"; a plain/legacy cron (no op) is unaffected and can still
  // never bypass the registry.
  const eslPromote = trigger === "cron" && (body as { op?: unknown })?.op === "esl_promote";

  // Radar one-click publish: URL-scoped authorization to fetch an unregistered
  // source. Granted ONLY when ALL hold: an authorized promoter — either an ADMIN
  // JWT (trigger "manual") or the ESL cron promotion (eslPromote) — an explicit
  // radar_authorized_source === true flag, and a resolved targeted pilot URL. The
  // authorization is scoped to exactly that URL — runIngestion mints the transient
  // synthetic source only when the pilot URL equals this value. A generic cron run
  // (no op:"esl_promote") can never reach this branch and never bypasses the
  // registry.
  const radarAuthorizedFlag = (body as { radar_authorized_source?: unknown })?.radar_authorized_source === true;
  const radarAuthorizedUrl = (trigger === "manual" || eslPromote) && radarAuthorizedFlag && targetedSourceUrl
    ? targetedSourceUrl
    : null;

  // Radar exact-article fallback identifiers, honored ONLY alongside a valid
  // URL-scoped authorization (same admin-manual + flag + resolved-URL scope).
  // These come from the TRUSTED radar_shadow_articles row (the server action
  // reads them from the DB, never from operator free text): provider selects the
  // fetch provider, provider_uri is the exact ER article id for the same-article
  // stored-body recovery, and source_title is the original publisher preserved as
  // the editorial source. A non-Radar/cron request never sets any of them.
  const asTrimmed = (v: unknown): string | null => {
    const s = String(v ?? "").trim();
    return s ? s : null;
  };
  const radarErProvider = radarAuthorizedUrl ? asTrimmed((body as { radar_provider?: unknown })?.radar_provider) : null;
  const radarErProviderUri = radarAuthorizedUrl
    ? asTrimmed((body as { radar_provider_uri?: unknown })?.radar_provider_uri)
    : null;
  const radarSourceTitle = radarAuthorizedUrl
    ? asTrimmed((body as { radar_source_title?: unknown })?.radar_source_title)
    : null;
  // Source language (ISO code) from the trusted radar row, for locale-aware
  // numeric grounding. Honored ONLY alongside a valid URL-scoped authorization.
  const radarSourceLang = radarAuthorizedUrl
    ? asTrimmed((body as { radar_source_lang?: unknown })?.radar_source_lang)
    : null;
  // Radar publish mode: "prepare" (تحرير في سلمى — create a draft for editing,
  // never publish here) vs "publish" (نشر مباشر — the direct one-click path).
  // Defaults to "publish" so existing callers are unchanged.
  const radarPublishMode: "publish" | "prepare" =
    (body as { radar_publish_mode?: unknown })?.radar_publish_mode === "prepare" ? "prepare" : "publish";

  // Radar row to finalize (terminal-state ownership). Present ONLY for an
  // authorized Radar one-click publish; a generic/cron/pilot request leaves it
  // null and this function never touches any radar row. radar_category_slug is
  // the optional operator category override, validated against categories.
  const radarArticleId = radarAuthorizedUrl
    ? asTrimmed((body as { radar_article_id?: unknown })?.radar_article_id)
    : null;
  const radarCategorySlug = radarArticleId
    ? asTrimmed((body as { radar_category_slug?: unknown })?.radar_category_slug)
    : null;

  // Primary Source Escalation (LIVE, ESL promotion only). Try to upgrade the
  // discovery source to a stronger, story-type-appropriate PRIMARY before the
  // Writer runs. Bounded + cached; any failure keeps the discovery source. This
  // never changes WHETHER we publish (still PENDING) — only WHICH source is the
  // Writer's primary. The discovery URL is preserved in provenance below.
  const bodyRec = body as Record<string, unknown>;
  let escalation: EscalationResult | null = null;
  let evidenceOutcome: EvidenceOutcome | null = null;
  let evidenceClusterKey: string | null = null;
  let evidenceResolved: ResolvedEvidenceSource | null = null;
  let evidenceAnalyzer: ((verified: SourceText) => Promise<EvidenceOutcome | null>) | null = null;
  let effSourceUrl = targetedSourceUrl;
  let effAuthorizedUrl = radarAuthorizedUrl;
  let effErProvider = radarErProvider;
  let effErProviderUri = radarErProviderUri;
  let effSourceTitle = radarSourceTitle;
  let effSourceLang = radarSourceLang;
  if (eslPromote && radarAuthorizedUrl && radarArticleId) {
    escalation = await runEscalation(admin, {
      clusterKey: asTrimmed(bodyRec.esl_cluster_key) ?? radarArticleId,
      storyType: asTrimmed(bodyRec.esl_story_type) ?? "general",
      discoveryUrl: radarAuthorizedUrl,
      discoveryDomain: escDomainOf(radarAuthorizedUrl),
      title: asTrimmed(bodyRec.esl_title),
      titleAr: asTrimmed(bodyRec.esl_title_ar),
    });
    // The analyzed/written source relative to the editorial primary. Default:
    // no upgrade → the discovery article IS the editorial primary.
    evidenceResolved = { kind: "primary", url: radarAuthorizedUrl, primaryUrl: null };
    if (escalation.status === "upgraded") {
      const up = escalation.selected_editorial_source.url;
      if (/^https?:\/\//i.test(up)) {
        // Fetchability-aware: the upgraded primary may be unreachable for the
        // sanctioned extractor (bot-block/paywall). Probe primary → validated
        // supporting → discovery, and hand the Writer the strongest FETCHABLE
        // one. The identified primary is preserved as provenance either way;
        // it is never silently presented as the analyzed/written source.
        evidenceResolved = await resolveAnalysisSource(escalation, radarAuthorizedUrl);
        if (evidenceResolved.kind !== "discovery_fallback") {
          // Writer fetches the resolved primary/supporting source (SSRF-safe
          // fetch re-validates).
          effSourceUrl = evidenceResolved.url;
          effAuthorizedUrl = evidenceResolved.url;
          effErProvider = null;      // resolved URL is NOT the discovery ER article
          effErProviderUri = null;
          effSourceTitle = escDomainOf(evidenceResolved.url);
          effSourceLang = null;      // likely a different language → let it be inferred
        }
        // discovery_fallback: keep every original discovery parameter (exact
        // URL, ER exact-article recovery, source title/lang) — the pipeline
        // behaves exactly as before the upgrade existed.
      }
    }

    // Evidence Intelligence: analyze the strongest FETCHABLE editorial source
    // (post-escalation) for THIS selected cluster, over the same verified text
    // the Writer will be grounded in. The analyzer runs inside the pipeline
    // (single fetch); the outcome is captured here for the content link +
    // response, and its provenance records which source kind was analyzed.
    evidenceClusterKey = asTrimmed(bodyRec.esl_cluster_key) ?? radarArticleId;
    const inner = makeEvidenceAnalyzer(admin, {
      clusterKey: evidenceClusterKey,
      storyType: asTrimmed(bodyRec.esl_story_type) ?? "general",
      sourceKind: evidenceResolved.kind,
      editorialPrimaryUrl: evidenceResolved.primaryUrl,
    });
    evidenceAnalyzer = async (verified) => {
      evidenceOutcome = await inner(verified);
      return evidenceOutcome;
    };
  }

  try {
    const result = await runIngestion(admin, {
      trigger,
      writerMode,
      pilotLimit,
      targetedSourceUrl: effSourceUrl,
      radarAuthorizedUrl: effAuthorizedUrl,
      radarErProvider: effErProvider,
      radarErProviderUri: effErProviderUri,
      radarSourceTitle: effSourceTitle,
      radarSourceLang: effSourceLang,
      evidenceAnalyzer,
    });
    // The pilot report (if any) is present only because runIngestion returned
    // normally, i.e. AFTER the mandatory audit persisted. It carries operational
    // counts only — no source text, keys, tokens, or headers.
    const pilot = (result as { pilot?: PilotReport }).pilot ?? null;

    // Radar one-click publish: own the terminal radar state transition here,
    // BEFORE responding, so it survives a terminated server action. The returned
    // outcome is echoed back for the server action to map to its UI result.
    let radarPublish: RadarPublishOutcome | null = null;
    if (radarArticleId) {
      radarPublish = await finalizeRadarPublish(admin, radarArticleId, pilot, radarCategorySlug, radarPublishMode);
    }

    // Provenance: when escalation upgraded the source, record every source that
    // is NOT the Writer's main source. Which rows apply depends on which source
    // the pipeline could actually fetch (evidenceResolved.kind):
    //  - primary written        → discovery "اكتُشِف عبر" (+ supporting context)
    //  - supporting written     → discovery + the identified-but-unfetchable primary
    //  - discovery written      → the identified primary (+ supporting context)
    // The identified primary is preserved even when unfetchable — never dropped,
    // never presented as the source the article/card was derived from.
    if (escalation && escalation.status === "upgraded" && pilot?.created_content_id) {
      try {
        const kind = evidenceResolved?.kind ?? "primary";
        const rows: { content_id: string; label: string; url: string }[] = [];
        if (kind !== "discovery_fallback") {
          rows.push({ content_id: pilot.created_content_id, label: "اكتُشِف عبر", url: escalation.discovery_source.url });
        }
        if (kind !== "primary" && evidenceResolved?.primaryUrl) {
          rows.push({
            content_id: pilot.created_content_id,
            label: "المصدر الأولي المحدد (تعذّر الجلب الآلي)",
            url: evidenceResolved.primaryUrl,
          });
        }
        if (escalation.supporting_url && kind !== "supporting") {
          rows.push({ content_id: pilot.created_content_id, label: "سياق مستقل", url: escalation.supporting_url });
        }
        if (rows.length) await admin.from("content_sources").insert(rows);
      } catch { /* provenance best-effort */ }
    }

    // Link the Evidence Intelligence audit row to the created Content so the
    // admin editor can show the card directly. Best-effort; the cluster-key
    // lookup via radar_editorial_selection remains the fallback path.
    if (evidenceClusterKey && pilot?.created_content_id) {
      try {
        await admin
          .from("radar_evidence_intelligence")
          .update({ content_id: pilot.created_content_id })
          .eq("cluster_key", evidenceClusterKey);
      } catch { /* link best-effort */ }
    }

    const evidenceSummary = evidenceOutcome
      ? {
        status: (evidenceOutcome as EvidenceOutcome).status,
        cached: (evidenceOutcome as EvidenceOutcome).cached,
        source_status: (evidenceOutcome as EvidenceOutcome).source_status,
        editorial_primary_url: evidenceResolved?.primaryUrl ?? null,
        evidence_type: (evidenceOutcome as EvidenceOutcome).card?.evidence_type ?? null,
        evidence_strength: (evidenceOutcome as EvidenceOutcome).card?.evidence_strength ?? null,
        claim_relationship: (evidenceOutcome as EvidenceOutcome).card?.claim_relationship ?? null,
      }
      : null;
    return Response.json({ ok: true, writer_mode: writerMode, radar_publish: radarPublish, source_escalation: escalation, evidence_intelligence: evidenceSummary, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "ingestion failed";
    // The pipeline threw before producing a pilot report → no Content was
    // created for this authorized run. Finalize the radar row as retryable
    // 'failed' (scoped to the 'processing' row we own) so the click never
    // orphans in 'processing'. Best-effort; a failure here still returns 500.
    if (radarArticleId) {
      try {
        await setRadarTerminal(admin, radarArticleId, {
          publish_status: "failed",
          published_content_id: null,
          publish_error: "pipeline_error",
        });
      } catch { /* ignore: response still reports the underlying error */ }
    }
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});

// Shared editorial-pipeline glue for Salma's edge functions.
//
// Extracted VERBATIM from ingest-news/index.ts (2026-10-10) so that both the
// ingestion pipeline and the Develop Story function reuse the exact same
// writer → Editorial Director → fidelity chain, Primary Source Escalation
// wiring and Evidence Intelligence wiring instead of duplicating any of it.
// index.ts cannot be imported directly because it calls Deno.serve at module
// top level — this module holds everything another function needs.
//
// Additive changes made during extraction (defaults preserve the ingest-news
// behavior exactly):
//   - LlmUsage: optional per-request token/cost accumulation on every chat
//     helper (OpenRouter `usage` field). ingest-news passes nothing and is
//     unchanged; develop-story records usage per phase.
//   - writeArticle: optional profile/config/extraInstructions/writerMaxTokens/
//     usage inputs for the Develop Story draft (news defaults untouched).

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  buildWritingInstructions,
  causationAsserted,
  parseWriterOutput,
  readingTimeMinutes,
  selectProfile,
  validateArticle,
  WRITER_PROMPT_VERSION,
  type WritingProfile,
} from "./salmaWriter.ts";
import {
  evaluateWriterCompletion,
  isForbiddenWriterModel,
  orchestrateWriter,
  type WriterHttpResult,
  type WriterModelConfig,
  type WriterValidation,
} from "./writerRouter.ts";
import {
  buildEditorInstructions,
  buildFactPacket,
  type EditorArticle,
  EDITOR_RESPONSE_FORMAT,
  type EditorCallResult,
  type EditorialAudit,
  renderEditorPacket,
  runEditorPass,
} from "./salmaEditor.ts";
import {
  fetchSourceText,
  isBlockedHostname,
  NEUTRAL_USER_AGENT,
  type RawResponse,
  type SourceText,
  validateResolvedAddresses,
} from "./fetchSourceText.ts";
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

// ---- OpenRouter usage/cost accounting -------------------------------------
//
// Optional per-request accumulator. OpenRouter returns a `usage` object on
// every completion; callers that care (develop-story) pass a collector into
// the chat helpers below. ingest-news passes nothing — zero behavior change.
export type LlmUsage = {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
};

export function newUsage(): LlmUsage {
  return { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 };
}

function addUsage(u: LlmUsage | undefined, data: unknown): void {
  if (!u) return;
  u.calls += 1;
  const usage = (data as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage) return;
  u.prompt_tokens += Number(usage.prompt_tokens ?? 0) || 0;
  u.completion_tokens += Number(usage.completion_tokens ?? 0) || 0;
  u.total_tokens += Number(usage.total_tokens ?? 0) || 0;
  u.cost += Number(usage.cost ?? 0) || 0;
}

export type Citation = { url: string; title: string };
export type WebChatResult = { content: string; citations: Citation[] };

// Evidence Intelligence analysis model. Medical/evidence interpretation needs a
// capable model (accuracy > minimal token cost) — default to the same tier as
// the sensitive writer route. Bounded to ≤ the ESL daily cap of stories/day,
// one call each, cached per canonical cluster.
export const EVIDENCE_MODEL = Deno.env.get("EVIDENCE_MODEL") || "anthropic/claude-sonnet-5";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_MODEL = Deno.env.get("OPENROUTER_MODEL") || "openai/gpt-oss-20b:free";

// E1.3C writer-model routing. Kept SEPARATE from OPENROUTER_MODEL (which still
// controls the discovery/editorial-selection call). Safe defaults match the
// approved E1.3B pilot routing; each can be overridden by its own env var.
// google/gemini-3-flash-preview must never be configured here (assertWriterConfig
// enforces this at run start).
export const WRITER_CONFIG: WriterModelConfig = {
  defaultModel: Deno.env.get("OPENROUTER_WRITER_DEFAULT_MODEL") || "openai/gpt-5.4-mini",
  sensitiveModel: Deno.env.get("OPENROUTER_WRITER_SENSITIVE_MODEL") || "anthropic/claude-sonnet-5",
  fallbackModel: Deno.env.get("OPENROUTER_WRITER_FALLBACK_MODEL") || "openai/gpt-4o-mini",
};

// E1.4A editorial-director model. Configured INDEPENDENTLY of the writer route
// (its own env var) so the editor model can be tuned without touching writer
// routing. It runs once on every validated writer draft; there is no fallback
// and no retry. google/gemini-3-flash-preview must never be configured here
// (assertEditorConfig enforces this at run start, same rule as the writer).
export const EDITOR_MODEL = Deno.env.get("OPENROUTER_EDITOR_MODEL") || "openai/gpt-5.4-mini";

export function assertEditorConfig(model: string): void {
  if (!model || !model.trim()) throw new Error("editor model is not configured");
  if (isForbiddenWriterModel(model)) {
    throw new Error(`forbidden editor model configured: ${model}`);
  }
}

// Optional writer-routing audit fields attached to a decision (E1.3C/D).
export type WriterAudit = {
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

export async function chatWeb(
  messages: { role: string; content: string }[],
  options: { temperature?: number; maxTokens?: number; maxResults?: number; model?: string; usage?: LlmUsage } = {},
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
  addUsage(options.usage, data);
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
export async function chatWriter(
  model: string,
  messages: { role: string; content: string }[],
  opts: { maxTokens?: number; usage?: LlmUsage } = {},
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
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: opts.maxTokens ?? 2000 }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return { ok: false, httpStatus: res.status };
    const data = await res.json().catch(() => null);
    addUsage(opts.usage, data);
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
export async function chatEditor(
  model: string,
  messages: { role: string; content: string }[],
  opts: { usage?: LlmUsage } = {},
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
    addUsage(opts.usage, data);
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
export async function chatEvidence(
  messages: { role: string; content: string }[],
  opts: { usage?: LlmUsage } = {},
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
    addUsage(opts.usage, data);
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

// ---- Generic structured-JSON chat call (Develop Story research brief) -----
//
// Same transport discipline as the other chat helpers (neutral headers only,
// bounded timeout, completion-metadata inspection before parsing, optional
// usage accounting). Used by develop-story for its brief call; ingest-news
// does not call it.
export async function chatJson(
  messages: { role: string; content: string }[],
  opts: {
    model: string;
    maxTokens?: number;
    temperature?: number;
    responseFormat?: unknown;
    timeoutMs?: number;
    usage?: LlmUsage;
  },
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) return { ok: false, reason: "api_key_missing" };
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
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 4000,
        ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90000),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const data = await res.json().catch(() => null);
    addUsage(opts.usage, data);
    const evald = evaluateWriterCompletion(data?.choices?.[0]);
    if (evald.ok) return { ok: true, content: evald.content };
    return {
      ok: false,
      reason: evald.kind === "completed_invalid" ? `completed_invalid:${evald.reason}` : "empty_completion",
    };
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    return { ok: false, reason: timedOut ? "timeout" : "network_error" };
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

export async function denoRawFetch(
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
export async function denoResolveDns(hostname: string): Promise<string[]> {
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

export type WriterOutcome =
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
export async function writeArticle(input: {
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
  // ---- Optional Develop Story extensions (defaults keep the ingest-news
  // behavior byte-identical) -------------------------------------------------
  // Explicit writing profile (skips routing-text profile selection).
  profile?: WritingProfile;
  // Extra system instructions APPENDED to buildWritingInstructions(profile)
  // (e.g. the Develop Story structure/direction overlay). Never replaces the
  // base Salma writing contract.
  extraInstructions?: string;
  // Alternative writer model routing (Develop Story always uses the premium
  // route). Defaults to the shared WRITER_CONFIG.
  config?: WriterModelConfig;
  // Larger completion budget for longer explainers (default 2000).
  writerMaxTokens?: number;
  // Extra system instructions APPENDED to the Editorial Director's prompt
  // (develop-story only: depth-preservation note). Never replaces the base
  // editor contract; factual re-validation is untouched.
  editorExtraInstructions?: string;
  // Token/cost accumulator (see LlmUsage).
  usage?: LlmUsage;
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
  const profile = input.profile ?? selectProfile({ sourceText: routingText });

  const messages = [
    {
      role: "system",
      content:
        buildWritingInstructions(profile) +
        (input.extraInstructions ? `\n\n${input.extraInstructions}` : ""),
    },
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
    config: input.config ?? WRITER_CONFIG,
    // On the one strict-JSON recovery, resend the SAME system+user packet with an
    // appended formatting-only directive; the base writer prompt is untouched.
    call: (model, opts) =>
      chatWriter(
        model,
        opts?.strictJsonRecovery ? [...messages, WRITER_JSON_RECOVERY_MESSAGE] : messages,
        { maxTokens: input.writerMaxTokens, usage: input.usage },
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
          chatEditor(
            model,
            [
            {
              role: "system",
              content:
                buildEditorInstructions(profile, {
                  strictJsonRecovery: opts?.strictRecovery,
                  repairIssues: opts?.repair?.issues,
                }) +
                (input.editorExtraInstructions ? `\n\n${input.editorExtraInstructions}` : ""),
            },
            {
              role: "user",
              // Editorial repair works from the FIRST edited draft; every other
              // call (normal + formatting recovery) works from the writer draft.
              content: renderEditorPacket({ packet, draft: opts?.repair?.draft ?? writerDraft }),
            },
            ],
            { usage: input.usage },
          ),
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
        { usage: input.usage },
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

// ---- Primary Source Escalation (bounded, ≤ selected/day) ------------------

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
  // BUG FIX (pre-existing, found during the Develop Story extraction):
  // validateResolvedAddresses returns {ok} — the old `cls !== "safe"` string
  // comparison was always true, so this helper ALWAYS returned [] and the
  // escalation "linked" step (STEP B) never fired in production. The SSRF
  // gate semantics are unchanged: any resolution failure still fails closed.
  const cls = await validateResolvedAddresses(u.hostname, denoResolveDns).catch(
    () => ({ ok: false as const, reason: "source_dns_resolution_failed" as const }),
  );
  if (!cls.ok) return [];
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
export async function runEscalation(
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
export type ResolvedEvidenceSource = {
  kind: EvidenceSourceKind;
  url: string;                // the source the Writer/analysis will fetch
  primaryUrl: string | null;  // identified primary when it is NOT `url`
};

export async function resolveAnalysisSource(
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
export function evidenceDbDeps(admin: SupabaseClient): {
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
export function makeEvidenceAnalyzer(
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

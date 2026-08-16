import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  fetchSourceText,
  type RawResponse,
} from "../ingest-news/fetchSourceText.ts";

// Fast News Radar — ON-DEMAND full-article translation (reading aid ONLY).
//
// Given a Radar article id, this function fetches the article's EXACT stored
// source URL through the SAME SSRF-hardened extraction path the ingestion
// pipeline uses (fetchSourceText: http/https only, host-locked, per-hop DNS
// classification, redirect/byte/time caps, HTML-only, no secret headers), then
// returns a faithful Arabic translation of the extracted text as a reading aid.
//
// HARD boundaries:
//   * It NEVER publishes and NEVER creates/updates content or news_sources.
//   * The translation is NOT persisted and is NEVER used as Writer input — the
//     one-click publish flow always re-extracts and grounds on the ORIGINAL
//     source, not this machine translation.
//   * Admin-only: verify_jwt is enforced at the gateway AND the caller's admin
//     role is re-checked here against profiles (service role).
//   * The fetched URL is read FROM the radar row (never a caller-supplied URL),
//     so translation is bound to that exact article + its exact stored source.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openai/gpt-4o-mini";

// Faithful body translation: translation only, no rewriting/summarizing/adding.
const BODY_TRANSLATE_PROMPT =
  "أنت مترجم محترف لمنصة أخبار صحية عربية (سلمى). ترجم النص التالي إلى العربية الفصحى ترجمةً أمينة فقط. " +
  "قواعد صارمة: (1) ترجمة فقط، بلا إعادة صياغة أو تلخيص أو تحرير أو إضافة أي سياق أو رأي أو عناوين. " +
  "(2) حافظ على المعنى والفقرات والترتيب بدقة. (3) احتفظ بأسماء الأشخاص والمؤسسات والأماكن والأرقام والإحصاءات " +
  "والوحدات والاقتباسات كما هي. (4) لا تضف معلومات غير موجودة ولا تحذف أي معلومة. " +
  "أعد النص العربي المترجم فقط دون أي تعليق.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Split long text into paragraph-aligned chunks so each translation call stays
// well within context and a single failure never loses the whole article.
function chunkText(text: string, maxChars = 6000): string[] {
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && (cur.length + p.length + 2) > maxChars) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

// --- SSRF-hardened network adapters (identical posture to ingest-news) -------
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
      // already released
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
  return { status: res.status, headers: res.headers, body: streamChunks(res.body) };
}

async function denoResolveDns(hostname: string): Promise<string[]> {
  const out: string[] = [];
  for (const recordType of ["A", "AAAA"] as const) {
    try {
      const addrs = await Deno.resolveDns(hostname, recordType);
      out.push(...addrs);
    } catch {
      // NotFound / no record of this type is normal; failing closed on [] is
      // handled by fetchSourceText.validateResolvedAddresses.
    }
  }
  return out;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

// Translate ONE chunk with a short transient-retry loop. Returns null on failure.
async function translateChunk(
  openrouterKey: string,
  text: string,
  usage: { prompt: number; completion: number; total: number; cost: number },
): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    let json: {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
      error?: { message?: string };
    };
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${openrouterKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: BODY_TRANSLATE_PROMPT },
            { role: "user", content: text },
          ],
        }),
        signal: ctrl.signal,
      });
      json = await res.json();
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (json.usage) {
      usage.prompt += json.usage.prompt_tokens ?? 0;
      usage.completion += json.usage.completion_tokens ?? 0;
      usage.total += json.usage.total_tokens ?? 0;
      usage.cost += json.usage.cost ?? 0;
    }
    const raw = json.choices?.[0]?.message?.content ?? "";
    if (json.error || !raw.trim()) continue;
    return raw.trim();
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
  if (!supabaseUrl || !serviceKey || !openrouterKey) {
    return Response.json({ ok: false, error: "missing service env" }, { status: 500 });
  }
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Admin authorization: verify_jwt gates at the edge; here we confirm the caller
  // is an active admin (defense in depth — a valid non-admin JWT is refused).
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7) : "";
  if (!token) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { data: profile } = await admin
    .from("profiles").select("role,disabled").eq("id", user.id).maybeSingle();
  if (!profile || profile.disabled || !["admin", "super_admin", "owner"].includes(profile.role)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const radarId = typeof body.radar_article_id === "string" ? body.radar_article_id : "";
  if (!radarId) return Response.json({ ok: false, error: "radar_article_id required" }, { status: 400 });

  // The URL is read FROM the radar row — never a caller-supplied URL — so the
  // fetch is bound to exactly this article's stored source.
  const { data: row, error: rowErr } = await admin
    .from("radar_shadow_articles")
    .select("id,url,title,title_ar,source_title,source_domain")
    .eq("id", radarId)
    .maybeSingle();
  if (rowErr) return Response.json({ ok: false, error: rowErr.message }, { status: 500 });
  if (!row || !row.url) return Response.json({ ok: false, error: "article or source url not found" }, { status: 404 });

  const host = hostOf(row.url);
  if (!host) return Response.json({ ok: false, error: "invalid source url" }, { status: 400 });

  const usage = { prompt: 0, completion: 0, total: 0, cost: 0 };

  // 1) Extract the ORIGINAL source text via the shared SSRF-hardened path.
  const extracted = await fetchSourceText({
    url: row.url,
    registeredDomain: host, // host-locked: fetch stays on this article's host
    sourceName: row.source_title ?? row.source_domain ?? null,
    rawFetch: denoRawFetch,
    resolveDns: denoResolveDns,
  });
  if (!extracted.ok) {
    return Response.json({ ok: false, error: "extraction_failed", reason: extracted.reason }, { status: 502 });
  }

  // 2) Faithful Arabic translation of the extracted body (chunked).
  const chunks = chunkText(extracted.text);
  const parts: string[] = [];
  for (const c of chunks) {
    const t = await translateChunk(openrouterKey, c, usage);
    if (t === null) {
      return Response.json({ ok: false, error: "translation_failed" }, { status: 502 });
    }
    parts.push(t);
    await sleep(150);
  }

  return Response.json({
    ok: true,
    radar_article_id: row.id,
    title_original: extracted.title || row.title || null,
    title_ar: row.title_ar ?? null,
    translated_text: parts.join("\n\n"),
    source_url: extracted.finalUrl,
    char_count: extracted.charCount,
    model: MODEL,
    cost: usage.cost,
    // Explicit: this translation is a reading aid and is NOT publishable content.
    publishable: false,
  }, { status: 200 });
});

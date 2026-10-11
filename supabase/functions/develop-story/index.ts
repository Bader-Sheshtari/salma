// AFTER THE NEWS / DEVELOP STORY — V2 (edge orchestrator).
//
// V2 = V1's two-phase job machine + an evidence-first research pipeline:
//
//   op:"start" (article OR radar cluster)
//     A. prior Salma coverage (find_prior_coverage — internal context only)
//     B. leads (original source url / cluster member urls — never evidence)
//     C. deterministic routing: claim domains + ADAPTIVE research depth
//        (owner adjustment #2: deep mode auto-activates for scientific /
//        trial / regulatory stories; «بحث معمّق» is only an optional override)
//     D. retrieval under caps: escalation + class-targeted searches +
//        PubMed + ClinicalTrials.gov + openFDA (all cached, all degradable)
//     E. development_evidence rows persisted with full provenance
//     F. ONE strict-JSON Brief ds2 call that may cite ONLY the [S#] ids it
//        was handed (schema-enumerated) → status 'brief_ready'
//   op:"draft"  — unchanged V1 chain (writer → Editorial Director → fidelity;
//     no validation weakened); ds1 jobs in flight still draft correctly.
//   op:"cancel" — unchanged.
//
// Failure discipline unchanged from V1: terminal states always written,
// stale runs healed, retries keep the brief, a failed retriever becomes an
// honest evidence gap — never fabricated evidence, never silent success.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  chatEvidence,
  chatJson,
  chatWeb,
  denoRawFetch,
  denoResolveDns,
  EDITOR_MODEL,
  ESCALATION_MODEL,
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
import { domainOf, roleTier } from "../ingest-news/sourceEscalation.ts";
import {
  BRIEF_V2_PROMPT_VERSION,
  buildBriefV2Messages,
  buildDevelopmentInstructions,
  DEVELOP_EDITOR_OVERLAY,
  type DevelopmentDirection,
  DIRECTIONS,
  type EvidenceCatalogItem,
  isDirection,
  parseBriefV2Output,
  renderBriefOrientation,
  renderBriefV2Orientation,
  type BriefV2,
  type ResearchBrief,
} from "./brief.ts";
import {
  adaptiveDepth,
  CLASS_LABELS_AR,
  classifyDomain,
  depthCaps,
  detectClaimDomains,
  DOMAIN_SEARCH_HINTS,
  PRIMARY_CLASSES,
  rankEvidence,
  roleToClass,
  shouldSearchLiterature,
  shouldSearchOpenFda,
  shouldSearchTrials,
  type ClaimDomain,
  type SourceClass,
} from "./sourceNetwork.ts";
import {
  buildSearchTerm,
  ctgovSearch,
  openFdaDrugLookup,
  pubmedSearch,
  type PubmedItem,
  type TrialItem,
} from "./retrievers.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NCBI_API_KEY = Deno.env.get("NCBI_API_KEY") ?? null;

const DEVELOPABLE_STATUSES = ["published", "pending", "unpublished"];
const STALE_RUN_MS = 12 * 60 * 1000;
const MAX_ARTICLE_CHARS = 12_000;
const CACHE_TTL = { pubmed: 7 * 24 * 3600_000, ctgov: 24 * 3600_000, openfda: 24 * 3600_000 } as const;

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
    try {
      const probe = createClient(SUPABASE_URL, jwt, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (!error) return { kind: "service", id: null };
    } catch { /* not a service key */ }
    return null;
  }
  const { data: profile } = await admin
    .from("profiles").select("role,disabled").eq("id", user.id).maybeSingle();
  if (profile && ["editor", "admin", "super_admin", "owner"].includes(profile.role) && !profile.disabled) {
    return { kind: "staff", id: user.id };
  }
  return null;
}

function slugify(input: string): string {
  return (
    input.trim()
      .replace(/[ً-ٟؐ-ؚ]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .toLowerCase() || "story"
  );
}

const trunc = (s: string | null | undefined, n: number): string => (s ?? "").slice(0, n);

function storyTypeForProfile(profile: WritingProfile): string {
  switch (profile) {
    case "research_study": return "scientific_study";
    case "safety_alert": return "product_safety_or_recall";
    case "regulation_or_service": return "regulatory_decision";
    default: return "general";
  }
}

// ---- trusted-API transport (fixed hosts only) -------------------------------
async function fetchJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": "SalmaResearch/2.0 (editorial research; contact via salma.health)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return await res.json();
}
async function fetchTextRaw(url: string, timeoutMs = 15_000): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "SalmaResearch/2.0 (editorial research; contact via salma.health)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return await res.text();
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cacheDeps(admin: SupabaseClient) {
  return {
    get: async (provider: string, key: string, maxAgeMs: number): Promise<unknown | null> => {
      const { data } = await admin
        .from("external_lookup_cache")
        .select("payload,fetched_at")
        .eq("provider", provider).eq("query_hash", key).maybeSingle();
      if (!data) return null;
      if (Date.now() - new Date(data.fetched_at).getTime() > maxAgeMs) return null;
      return data.payload;
    },
    put: async (provider: string, key: string, payload: unknown): Promise<void> => {
      await admin.from("external_lookup_cache").upsert(
        { provider, query_hash: key, payload, fetched_at: new Date().toISOString() },
        { onConflict: "provider,query_hash" },
      );
    },
  };
}

/** Cached wrapper around a retriever. */
async function cached<T>(
  admin: SupabaseClient, provider: keyof typeof CACHE_TTL, term: string,
  run: () => Promise<{ ok: true; items: T[] } | { ok: false; reason: string }>,
): Promise<{ ok: true; items: T[]; fromCache: boolean } | { ok: false; reason: string }> {
  const deps = cacheDeps(admin);
  const key = await sha256Hex(term.toLowerCase());
  try {
    const hit = await deps.get(provider, key, CACHE_TTL[provider]);
    if (hit) return { ok: true, items: hit as T[], fromCache: true };
  } catch { /* cache is best-effort */ }
  const r = await run();
  if (r.ok) {
    try { await deps.put(provider, key, r.items); } catch { /* best-effort */ }
    return { ...r, fromCache: false };
  }
  return r;
}

// ---- evidence assembly -------------------------------------------------------

type PendingEvidence = {
  kind: "web" | "pubmed" | "trial" | "regulator" | "salma_archive";
  url: string | null;
  title: string | null;
  publisher: string | null;
  published_date: string | null;
  source_class: SourceClass | null;
  tier: number | null;
  is_primary: boolean;
  doi?: string | null;
  pmid?: string | null;
  nct_id?: string | null;
  fetched: boolean;
  fetch_status: string;
  excerpt: string | null;
  confidence: "high" | "medium" | "low";
  meta?: Record<string, unknown>;
};

function classifyUrl(url: string): { cls: SourceClass; tier: number } {
  const d = domainOf(url);
  const hit = classifyDomain(d);
  if (hit) return { cls: hit.cls, tier: hit.tier };
  const rt = roleTier(d, new Map());
  return { cls: roleToClass(rt.role), tier: rt.tier };
}

function webEvidence(url: string, title: string | null, fetchedText: SourceText | null, publishedDate?: string | null): PendingEvidence {
  const { cls, tier } = classifyUrl(url);
  return {
    kind: "web",
    url, title: fetchedText?.title || title,
    publisher: domainOf(url),
    published_date: normalizeDate(fetchedText?.publishedDate ?? publishedDate ?? null),
    source_class: cls, tier,
    is_primary: PRIMARY_CLASSES.has(cls),
    fetched: Boolean(fetchedText),
    fetch_status: fetchedText ? "ok" : "not_fetched",
    excerpt: fetchedText ? trunc(fetchedText.text, 3000) : null,
    confidence: tier <= 1 ? "high" : tier <= 3 ? "medium" : "low",
  };
}

/** Best-effort YYYY-MM-DD (null when not parseable — never invented). */
function normalizeDate(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    const m = raw.match(/\b(19|20)\d{2}\b/);
    return m ? `${m[0]}-01-01` : null;
  }
  return d.toISOString().slice(0, 10);
}

function catalogItem(id: number, e: PendingEvidence): EvidenceCatalogItem {
  const classLabel = e.kind === "salma_archive"
    ? "أرشيف سلمى (تغطية سابقة)"
    : e.source_class ? CLASS_LABELS_AR[e.source_class] : "مصدر";
  return {
    id, kind: e.kind, source_class: e.source_class, class_label_ar: classLabel,
    title: e.title, publisher: e.publisher, published_date: e.published_date,
    url: e.url, doi: e.doi ?? null, pmid: e.pmid ?? null, nct_id: e.nct_id ?? null,
    fetched: e.fetched, excerpt: e.excerpt,
  };
}

// ---- job helpers (unchanged semantics from V1) --------------------------------

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
    .eq("id", id).maybeSingle();
  if (!data) return;
  await admin.from("story_developments").update({
    openrouter_calls: (data.openrouter_calls ?? 0) + usage.calls,
    prompt_tokens: (data.prompt_tokens ?? 0) + usage.prompt_tokens,
    completion_tokens: (data.completion_tokens ?? 0) + usage.completion_tokens,
    total_tokens: (data.total_tokens ?? 0) + usage.total_tokens,
    cost: Number(data.cost ?? 0) + usage.cost,
  }).eq("id", id);
}

type ContentRow = {
  id: string; title: string; slug: string; excerpt: string | null; body: string | null;
  status: string; category_slug: string | null; source_name: string | null;
  source_url: string | null; original_title: string | null; original_url: string | null;
  source_lang: string | null; published_at: string | null; cover_image_url: string | null;
  cover_credit_name: string | null; cover_credit_url: string | null;
  source_image_url: string | null; deleted_at: string | null;
};

type Lead = { url: string; title: string | null; domain: string; publishedAt: string | null };
type Origin =
  | { kind: "article"; row: ContentRow }
  | { kind: "cluster"; key: string; titleAr: string | null; title: string | null; leads: Lead[] };

const CONTENT_COLS =
  "id,title,slug,excerpt,body,status,category_slug,source_name,source_url,original_title,original_url,source_lang,published_at,cover_image_url,cover_credit_name,cover_credit_url,source_image_url,deleted_at";

// ---- Phase 1: research (V2 pipeline) ------------------------------------------

async function runResearch(
  admin: SupabaseClient, jobId: string, origin: Origin,
  direction: DevelopmentDirection, editorNote: string | null,
  depthOverride: "deep" | null,
): Promise<void> {
  const usage = newUsage();
  const started = Date.now();
  const gaps: string[] = [];
  const fail = async (category: string, message: string) => {
    await patchJob(admin, jobId, {
      status: "failed", phase: null, error_category: category,
      error_message: message.slice(0, 500), research_duration_ms: Date.now() - started,
    }, ["researching"]);
    await addJobUsage(admin, jobId, usage);
  };

  try {
    const originTitle = origin.kind === "article"
      ? origin.row.title
      : (origin.titleAr || origin.title || "قصة من رادار سلمى");
    const englishTitle = origin.kind === "article"
      ? (origin.row.original_title ?? origin.row.title)
      : (origin.title ?? origin.titleAr ?? "");
    const articleBody = origin.kind === "article" ? trunc(origin.row.body, MAX_ARTICLE_CHARS) : "";

    // ---- A. prior Salma coverage (internal context only) -------------------
    await patchJob(admin, jobId, { phase: "analyzing_context" }, ["researching"]);
    const priorText = `${originTitle} ${englishTitle}`.slice(0, 400);
    const excludeId = origin.kind === "article" ? origin.row.id : null;
    const { data: priorRows } = await admin.rpc("find_prior_coverage", {
      p_text: priorText, p_exclude: excludeId, p_limit: 6,
    });
    const priors = ((priorRows ?? []) as {
      id: string; title: string; slug: string; excerpt: string | null;
      original_url: string | null; published_at: string | null; relevance: number;
    }[]).filter((p) => p.relevance >= 0.25);

    // ---- B. leads + original-source fetch ----------------------------------
    await patchJob(admin, jobId, { phase: "fetching_sources" }, ["researching"]);
    const fetchOne = async (url: string): Promise<SourceText | null> => {
      const f = await fetchSourceText({
        url, registeredDomain: domainOf(url), sourceName: null,
        rawFetch: denoRawFetch, resolveDns: denoResolveDns,
      }).catch(() => null);
      return f && f.ok ? f : null;
    };

    const fetchedTexts: SourceText[] = [];
    const evidence: PendingEvidence[] = [];
    const seenUrls = new Set<string>();
    const pushWeb = (url: string, title: string | null, text: SourceText | null, publishedAt?: string | null) => {
      const key = url.replace(/[#?].*$/, "");
      if (seenUrls.has(key)) return;
      seenUrls.add(key);
      evidence.push(webEvidence(url, title, text, publishedAt));
      if (text) fetchedTexts.push(text);
    };

    let discoveryUrl: string | null = null;
    if (origin.kind === "article") {
      discoveryUrl = origin.row.original_url || origin.row.source_url || null;
      if (discoveryUrl && /^https?:\/\//i.test(discoveryUrl)) {
        pushWeb(discoveryUrl, origin.row.original_title ?? origin.row.title, await fetchOne(discoveryUrl));
      }
    } else {
      // Cluster leads: ASN-ranked, domain-deduped; top 2 fetched, the rest
      // recorded unfetched (coverage provenance). Leads are NEVER evidence
      // until fetched + validated like any other source.
      const rankedLeads = rankEvidence(
        origin.leads.map((l) => {
          const { cls, tier } = classifyUrl(l.url);
          return { ...l, tier, is_primary: PRIMARY_CLASSES.has(cls), published_date: l.publishedAt };
        }),
      );
      const domains = new Set<string>();
      const unique = rankedLeads.filter((l) => {
        if (domains.has(l.domain)) return false;
        domains.add(l.domain);
        return true;
      });
      discoveryUrl = unique[0]?.url ?? null;
      let fetchedLeads = 0;
      for (const l of unique.slice(0, 5)) {
        const text = fetchedLeads < 2 ? await fetchOne(l.url) : null;
        if (text) fetchedLeads++;
        pushWeb(l.url, l.title, text, l.publishedAt);
      }
    }

    // ---- C. routing + ADAPTIVE depth ---------------------------------------
    // PROFILE routing uses the ORIGIN story only (title + article body /
    // cluster headlines). Supplementary evidence texts (an FDA release is
    // full of risk vocabulary) must not flip an approval EXPLAINER into
    // safety_alert — whose prompt demands official actions the corpus never
    // gave, colliding with the invented-action guard. Validation still runs
    // over the FULL corpus; a genuinely safety-flavored origin still routes
    // to safety_alert with every guard intact.
    const profileText = [
      originTitle, englishTitle, articleBody,
      ...(origin.kind === "cluster" ? origin.leads.map((l) => l.title ?? "") : []),
    ].join("\n");
    const profile = selectProfile({ sourceText: profileText });
    // Claim-domain detection may read everything (wider = more retrievers).
    const routingText = [
      profileText,
      ...fetchedTexts.map((t) => trunc(t.text, 4000)),
    ].join("\n");
    const claimDomains = detectClaimDomains(routingText, profile);
    const depth = depthOverride ?? adaptiveDepth(claimDomains);
    const caps = depthCaps(depth);
    await patchJob(admin, jobId, { research_depth: depth }, ["researching"]);

    // ---- D1. escalation (shared infra, cached per dev cluster key) ---------
    await patchJob(admin, jobId, { phase: "escalating" }, ["researching"]);
    const clusterKey = origin.kind === "article"
      ? `dev:${origin.row.id}`
      : `devc:${await sha256Hex(origin.key)}`.slice(0, 60);
    let escalation = null;
    let primaryUrl: string | null = null;
    if (discoveryUrl) {
      escalation = await runEscalation(admin, {
        clusterKey, storyType: storyTypeForProfile(profile),
        discoveryUrl, discoveryDomain: domainOf(discoveryUrl),
        title: englishTitle || null, titleAr: originTitle,
      });
      const editorialUrl = escalation.selected_editorial_source?.url;
      if (escalation.status === "upgraded" && editorialUrl && /^https?:\/\//i.test(editorialUrl) && editorialUrl !== discoveryUrl) {
        primaryUrl = editorialUrl;
        const resolved = await resolveAnalysisSource(escalation, discoveryUrl);
        const text = resolved.url !== discoveryUrl ? await fetchOne(resolved.url) : null;
        pushWeb(editorialUrl, null, resolved.url === editorialUrl ? text : null);
        if (text && resolved.url !== editorialUrl) pushWeb(resolved.url, null, text);
      }
      if (escalation.supporting_url && /^https?:\/\//i.test(escalation.supporting_url)) {
        pushWeb(escalation.supporting_url, null, null);
      }
    }

    // ---- D2. class-targeted extra searches (capped; web plugin) ------------
    const classSatisfied = (cd: ClaimDomain): boolean => {
      const want: SourceClass[] = cd === "drug_regulatory" ? ["regulator"]
        : cd === "gcc_health" ? ["gcc_ministry", "regulator"]
        : cd === "scientific" ? ["primary_study", "systematic_review"]
        : cd === "medicine_disease" ? ["public_health_agency", "gcc_ministry", "regulator"]
        : [];
      return want.length === 0 || evidence.some((e) => e.source_class && want.includes(e.source_class));
    };
    const searchOrder: ClaimDomain[] = ["drug_regulatory", "gcc_health", "medicine_disease", "scientific"];
    let searchesUsed = 0;
    for (const cd of searchOrder) {
      if (searchesUsed >= caps.extraSearches) break;
      if (!claimDomains.has(cd) || classSatisfied(cd)) continue;
      const hint = DOMAIN_SEARCH_HINTS[cd];
      if (!hint) continue;
      searchesUsed++;
      await patchJob(admin, jobId, { phase: "escalating" }, ["researching"]);
      try {
        const r = await chatWeb(
          [
            { role: "system", content: "You find the single strongest AUTHORITATIVE primary source (regulator, ministry of health, public-health agency, peer-reviewed journal, or trial registry) for a specific health development. Return citations only; do not write prose." },
            { role: "user", content: `Find the most authoritative official/primary source URLs for this exact development: ${englishTitle || originTitle} ${hint}` },
          ],
          { maxResults: 5, temperature: 0, model: ESCALATION_MODEL, usage },
        );
        for (const c of r.citations.slice(0, 3)) {
          if (!/^https?:\/\//i.test(c.url)) continue;
          pushWeb(c.url, c.title || null, null);
        }
      } catch { gaps.push("تعذّر أحد عمليات البحث الموجّه عن مصادر رسمية إضافية."); }
    }

    // Fetch budget: upgrade the strongest UNFETCHED primary-class items.
    {
      const fetchedCount = () => evidence.filter((e) => e.fetched).length;
      const candidates = rankEvidence(evidence.filter((e) => !e.fetched && e.url && e.is_primary));
      for (const c of candidates) {
        if (fetchedCount() >= caps.webFetches) break;
        const text = await fetchOne(c.url!);
        if (text) {
          c.fetched = true;
          c.fetch_status = "ok";
          c.excerpt = trunc(text.text, 3000);
          c.title = c.title || text.title;
          c.published_date = c.published_date ?? normalizeDate(text.publishedDate);
          fetchedTexts.push(text);
        } else {
          c.fetch_status = "fetch_failed";
        }
      }
    }

    // ---- D3. literature / trials / regulator APIs ---------------------------
    const term = buildSearchTerm(`${englishTitle} ${fetchedTexts[0]?.title ?? ""}`);
    if (shouldSearchLiterature(claimDomains, depth)) {
      await patchJob(admin, jobId, { phase: "searching_literature" }, ["researching"]);
      const r = await cached<PubmedItem>(admin, "pubmed", `pm:${term}:${caps.literature}`, () =>
        pubmedSearch(term, caps.literature, { fetchJson, fetchText: fetchTextRaw, apiKey: NCBI_API_KEY }));
      if (r.ok) {
        for (const p of r.items) {
          const cls: SourceClass = p.pub_type === "meta_analysis" || p.pub_type === "systematic_review"
            ? "systematic_review" : "primary_study";
          evidence.push({
            kind: "pubmed",
            url: `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
            title: p.title, publisher: p.journal, published_date: normalizeDate(p.pubdate),
            source_class: cls, tier: 1,
            is_primary: p.pub_type !== "editorial" && p.pub_type !== "review",
            doi: p.doi, pmid: p.pmid,
            fetched: Boolean(p.abstract), fetch_status: p.abstract ? "ok" : "metadata_only",
            excerpt: p.abstract ? `${p.pub_type}: ${p.abstract}` : `نوع المنشور: ${p.pub_type}`,
            confidence: p.pub_type === "meta_analysis" || p.pub_type === "systematic_review" ? "high" : "medium",
            meta: { pub_type: p.pub_type },
          });
        }
        if (r.items.length === 0) gaps.push("بحث الأدبيات العلمية (PubMed) لم يُرجِع نتائج وثيقة الصلة.");
      } else {
        gaps.push("تعذّر البحث في الأدبيات العلمية (PubMed) — الأدلة أدناه بدون مسح للأدبيات.");
      }
    }

    if (shouldSearchTrials(claimDomains)) {
      await patchJob(admin, jobId, { phase: "checking_trials" }, ["researching"]);
      const nct = routingText.match(/NCT\d{8}/i)?.[0];
      // CT.gov's query.term works best on the DISTINCTIVE token (a drug/agent
      // name), not a 6-word phrase: prefer an explicit NCT, else the longest
      // unusual word of the English title, else the full term.
      const distinctive = (englishTitle.match(/[A-Za-z][A-Za-z-]{7,}/g) ?? [])
        .filter((w) => !/^(patients|advanced|metastatic|including|clinical|treatment|disease|against|between|results)$/i.test(w))
        .sort((a, b) => b.length - a.length)[0];
      const ctTerm = nct ?? distinctive ?? term;
      const r = await cached<TrialItem>(admin, "ctgov", `ct:${ctTerm}:${caps.trials}`, () =>
        ctgovSearch(ctTerm, caps.trials, { fetchJson }));
      if (r.ok) {
        if (r.items.length === 0) {
          gaps.push("سجل التجارب السريرية (ClinicalTrials.gov) لم يُرجِع تجارب مطابقة لهذا البحث.");
        }
        for (const t of r.items) {
          const rendered = [
            `تجربة ${t.nct_id}: ${t.title}`,
            t.phase ? `المرحلة: ${t.phase}` : "",
            t.overall_status ? `الحالة في السجل (حرفياً): ${t.overall_status}` : "",
            t.sponsor ? `الجهة الراعية: ${t.sponsor}` : "",
            t.enrollment != null ? `عدد المشاركين: ${t.enrollment}` : "",
            t.primary_outcomes.length ? `النواتج الأولية: ${t.primary_outcomes.join("؛ ")}` : "",
            t.start_date ? `بداية: ${t.start_date}` : "",
            t.completion_date ? `اكتمال متوقع/فعلي: ${t.completion_date}` : "",
          ].filter(Boolean).join("\n");
          evidence.push({
            kind: "trial",
            url: `https://clinicaltrials.gov/study/${t.nct_id}`,
            title: t.title, publisher: "ClinicalTrials.gov",
            published_date: normalizeDate(t.start_date),
            source_class: "trial_registry", tier: 1, is_primary: true,
            nct_id: t.nct_id, fetched: true, fetch_status: "ok",
            excerpt: rendered, confidence: "high",
            meta: { phase: t.phase, overall_status: t.overall_status, enrollment: t.enrollment },
          });
        }
      } else {
        gaps.push("تعذّر الاستعلام من سجل التجارب السريرية (ClinicalTrials.gov).");
      }
    }

    if (shouldSearchOpenFda(claimDomains)) {
      // openFDA only understands Latin names: prefer a quoted LATIN name,
      // else the strongest English term — never an Arabic token.
      const latinQuoted = routingText.match(/["«]([A-Za-z][\w -]{2,40})["»]/)?.[1];
      const fdaTerm = latinQuoted ?? buildSearchTerm(englishTitle, 2);
      if (fdaTerm) {
        const r = await cached(admin, "openfda", `fda:${fdaTerm}`, () => openFdaDrugLookup(fdaTerm, { fetchJson }));
        if (r.ok && r.items.length > 0) {
          for (const f of r.items.slice(0, 2)) {
            evidence.push({
              kind: "regulator",
              url: "https://www.accessdata.fda.gov/scripts/cder/daf/",
              title: `سجل FDA: ${f.brand_name ?? f.generic_name ?? fdaTerm}`,
              publisher: "openFDA", published_date: normalizeDate(f.latest_action_date),
              source_class: "regulator", tier: 1, is_primary: true,
              fetched: true, fetch_status: "ok",
              excerpt: [
                f.application_number ? `رقم الطلب: ${f.application_number}` : "",
                f.sponsor ? `الجهة: ${f.sponsor}` : "",
                f.generic_name ? `الاسم العلمي: ${f.generic_name}` : "",
                f.latest_action_type ? `آخر إجراء (حرفياً): ${f.latest_action_type} بتاريخ ${f.latest_action_date ?? "غير محدد"}` : "",
              ].filter(Boolean).join("\n"),
              confidence: "high",
            });
          }
        }
      }
    }

    // ---- D4. evidence card (V1-compatible, strongest fetched text) ----------
    await patchJob(admin, jobId, { phase: "analyzing_evidence" }, ["researching"]);
    let card: EvidenceCard | null = null;
    if (origin.kind === "article") {
      const { data: existingCard } = await admin
        .from("radar_evidence_intelligence").select("card,analysis_status")
        .eq("content_id", origin.row.id).maybeSingle();
      if (existingCard?.analysis_status === "complete" && existingCard.card) {
        card = existingCard.card as EvidenceCard;
      }
    }
    if (!card && fetchedTexts.length > 0) {
      const analysisText = fetchedTexts[0];
      const outcome = await analyzeEvidence(
        {
          clusterKey, storyType: storyTypeForProfile(profile),
          sourceUrl: analysisText.finalUrl, sourceDomain: domainOf(analysisText.finalUrl),
          sourceTitle: analysisText.title || null, sourceText: analysisText.text,
          sourceKind: primaryUrl ? "primary" : "discovery_fallback",
          editorialPrimaryUrl: primaryUrl,
        },
        { ...evidenceDbDeps(admin), chat: (m) => chatEvidence(m, { usage }) },
      ).catch(() => null);
      if (outcome?.status === "complete" && outcome.card) card = outcome.card;
    }

    // ---- E. persist evidence rows (external capped+ranked, archive appended) -
    for (const p of priors) {
      evidence.push({
        kind: "salma_archive",
        url: `https://salma.health/article/${p.slug}`,
        title: p.title, publisher: "سلمى",
        published_date: normalizeDate(p.published_at),
        source_class: null, tier: null, is_primary: false,
        fetched: true, fetch_status: "ok",
        excerpt: trunc(p.excerpt, 400),
        confidence: "high",
        meta: { content_id: p.id, relevance: p.relevance, original_url: p.original_url },
      });
    }
    const external = rankEvidence(evidence.filter((e) => e.kind !== "salma_archive"))
      .slice(0, caps.webFetches + caps.literature + caps.trials + 4);
    const archive = evidence.filter((e) => e.kind === "salma_archive");
    const toInsert = [...external, ...archive];
    const { data: inserted, error: insErr } = await admin
      .from("development_evidence")
      .insert(toInsert.map((e) => ({ development_id: jobId, ...e })))
      .select("id");
    if (insErr || !inserted) {
      await fail("evidence_persist_failed", insErr?.message ?? "insert failed");
      return;
    }
    const rows = toInsert.map((e, i) => ({ ...e, id: (inserted as { id: number }[])[i].id }));
    const externalRows = rows.filter((r) => r.kind !== "salma_archive");
    const archiveRows = rows.filter((r) => r.kind === "salma_archive");

    // ---- F. Brief ds2 synthesis ---------------------------------------------
    await patchJob(admin, jobId, { phase: "building_brief" }, ["researching"]);
    const originLabel = origin.kind === "article"
      ? "المقال المنشور على سلمى (مادة موثوقة سبق أن راجعها فريق التحرير)"
      : `قصة من رادار سلمى (عناوين تغطية متعددة — ليست أدلة بذاتها): ${originTitle}`;
    const originBody = origin.kind === "article"
      ? `العنوان: ${origin.row.title}\n${origin.row.excerpt ?? ""}\n${articleBody}`
      : origin.leads.map((l) => `- ${l.title ?? l.url} (${l.domain}${l.publishedAt ? `, ${l.publishedAt.slice(0, 10)}` : ""})`).join("\n");
    const validIds = rows.map((r) => `S${r.id}`);
    const messages = buildBriefV2Messages({
      originLabel, originBody,
      externalEvidence: externalRows.map((r) => catalogItem(r.id, r)),
      archiveEvidence: archiveRows.map((r) => catalogItem(r.id, r)),
      gaps, requestedDirection: direction, editorNote,
    });
    // No response_format: Anthropic rejects a strict grammar of ds2's size
    // ("compiled grammar is too large"). The JSON contract lives in the
    // prompt and parseBriefV2Output is the fail-closed gate (incl. dropping
    // any source id the model was not handed).
    const res = await chatJson(messages, {
      model: EVIDENCE_MODEL, maxTokens: 16_000, temperature: 0,
      timeoutMs: 180_000, usage,
    });
    if (!res.ok) { await fail("research_model_failed", res.reason); return; }
    const parsed = parseBriefV2Output(res.content, validIds);
    if (!parsed.ok) { await fail("brief_parse_failed", parsed.error); return; }

    // ---- freeze the grounding corpus -----------------------------------------
    const corpusParts: string[] = [];
    if (origin.kind === "article") {
      corpusParts.push(`مقال سلمى المنشور:\n${origin.row.title}\n${origin.row.excerpt ?? ""}\n${articleBody}`);
    }
    for (const t of fetchedTexts) {
      corpusParts.push(`نص مصدر (${t.finalUrl}):\n${t.title}\n${trunc(t.text, 9000)}`);
    }
    for (const r of externalRows) {
      if (r.kind !== "web" && r.excerpt) {
        corpusParts.push(`${r.title ?? r.kind} (${r.url ?? ""}):\n${r.excerpt}`);
      }
    }
    const corpus = corpusParts.join("\n\n").slice(0, caps.corpusChars);
    const mustPreserve = [...new Set(fetchedTexts.flatMap((t) => t.mustPreserve ?? []))].slice(0, 24);
    const bestSource = externalRows.find((r) => r.fetched && r.is_primary) ?? externalRows.find((r) => r.fetched) ?? externalRows[0];

    await patchJob(admin, jobId, {
      status: "brief_ready", phase: null,
      research_brief: parsed.brief,
      brief_sources: externalRows.slice(0, 8).map((r) => ({
        url: r.url, domain: r.publisher ?? (r.url ? domainOf(r.url) : ""),
        role: r.source_class ?? r.kind, label: r.title ?? r.publisher ?? r.kind,
        fetched: r.fetched, tier: r.tier,
      })),
      evidence_cluster_key: card ? clusterKey : null,
      escalation: escalation
        ? { status: escalation.status, method: escalation.method, editorial: escalation.selected_editorial_source, supporting_url: escalation.supporting_url, upgrade_reason: escalation.upgrade_reason }
        : null,
      draft_inputs: {
        corpus, must_preserve: mustPreserve,
        source_name: bestSource?.publisher ?? (origin.kind === "article" ? origin.row.source_name : null),
        source_url: bestSource?.url ?? discoveryUrl,
        profile,
        evidence_ids: rows.map((r) => r.id),
        // Threads join only STRONG priors (≥ 0.35); weaker archive matches
        // stay visible as brief context but don't pollute story threads.
        prior_content_ids: archiveRows
          .filter((r) => Number((r.meta as { relevance?: number })?.relevance ?? 0) >= 0.35)
          .map((r) => (r.meta as { content_id?: string })?.content_id)
          .filter(Boolean),
      },
      research_model: EVIDENCE_MODEL,
      research_prompt_version: BRIEF_V2_PROMPT_VERSION,
      research_duration_ms: Date.now() - started,
      research_completed_at: new Date().toISOString(),
    }, ["researching"]);
    await addJobUsage(admin, jobId, usage);
  } catch (e) {
    await fail("research_error", e instanceof Error ? e.message : String(e));
  }
}

// ---- Phase 2: draft (V1 chain; ds1/ds2 orientation branch; thread upsert) ----

async function runDraft(
  admin: SupabaseClient, jobId: string,
  origin: { original: ContentRow | null; clusterKey: string | null; clusterTitle: string | null },
  direction: Exclude<DevelopmentDirection, "auto">, editorNote: string | null,
): Promise<{ contentId: string } | { error: string }> {
  const usage = newUsage();
  const started = Date.now();
  const fail = async (category: string, message: string) => {
    await patchJob(admin, jobId, {
      status: "failed", phase: null, error_category: category,
      error_message: message.slice(0, 500), draft_duration_ms: Date.now() - started,
    }, ["drafting"]);
    await addJobUsage(admin, jobId, usage);
  };

  try {
    const { data: job } = await admin
      .from("story_developments")
      .select("research_brief,draft_inputs,research_prompt_version")
      .eq("id", jobId).maybeSingle();
    const inputs = (job?.draft_inputs ?? null) as
      | { corpus: string; must_preserve: string[]; source_name: string | null; source_url: string | null; profile: WritingProfile; evidence_ids?: number[]; prior_content_ids?: string[] }
      | null;
    if (!job?.research_brief || !inputs?.corpus) {
      await fail("missing_brief", "research brief unavailable");
      return { error: "missing_brief" };
    }
    const isV2 = job.research_prompt_version === BRIEF_V2_PROMPT_VERSION;
    const orientation = isV2
      ? renderBriefV2Orientation(job.research_brief as BriefV2)
      : renderBriefOrientation(job.research_brief as ResearchBrief);

    await patchJob(admin, jobId, { phase: "writing" }, ["drafting"]);
    const originTitle = origin.original?.title ?? origin.clusterTitle ?? "قصة سلمى";
    const verified: SourceText = {
      ok: true,
      title: originTitle,
      text: inputs.corpus,
      method: "main",
      publishedDate: null,
      charCount: inputs.corpus.length,
      wordCount: inputs.corpus.split(/\s+/).filter(Boolean).length,
      finalUrl: inputs.source_url || "https://salma.health/",
      mustPreserve: inputs.must_preserve ?? [],
    };

    let evCard: EvidenceCard | null = null;
    if (origin.original) {
      const { data: cardRow } = await admin
        .from("radar_evidence_intelligence")
        .select("card,analysis_status")
        .or(`content_id.eq.${origin.original.id},cluster_key.eq.dev:${origin.original.id}`)
        .eq("analysis_status", "complete").limit(1).maybeSingle();
      if (cardRow?.card) evCard = cardRow.card as EvidenceCard;
    }

    const outcome = await writeArticle({
      verified,
      discovery: { originalTitle: "", excerpt: "", body: orientation },
      sourceName: inputs.source_name,
      registeredDomain: inputs.source_url ? domainOf(inputs.source_url) : null,
      citationTitles: [],
      sourceLang: null,
      evidence: evCard,
      profile: inputs.profile,
      extraInstructions: buildDevelopmentInstructions({ direction, editorNote }),
      editorExtraInstructions: DEVELOP_EDITOR_OVERLAY,
      config: {
        defaultModel: EVIDENCE_MODEL,
        sensitiveModel: EVIDENCE_MODEL,
        fallbackModel: WRITER_CONFIG.fallbackModel,
      },
      writerMaxTokens: 6000,
      // claude-sonnet-5 defaults reasoning ON via OpenRouter — disable it for
      // the writing task so the full budget goes to the article itself.
      writerReasoning: { enabled: false },
      usage,
    });

    if (!outcome.ok) {
      await patchJob(admin, jobId, {
        editorial_audit: outcome.editorial ?? null,
        fidelity_audit: outcome.fidelity ?? null,
        writer_model: EVIDENCE_MODEL,
        writer_prompt_version: WRITER_PROMPT_VERSION,
        editor_model: EDITOR_MODEL,
        editor_prompt_version: EDITOR_PROMPT_VERSION,
        writing_profile: inputs.profile,
      }, ["drafting"]);
      await fail("draft_rejected", outcome.rejection);
      return { error: outcome.rejection };
    }

    const finalValidation = validateArticle({
      article: { ...outcome.article, profile: inputs.profile },
      source: { sourceText: inputs.corpus, mustPreserve: inputs.must_preserve, sourceLang: null },
    });

    await patchJob(admin, jobId, { phase: "saving" }, ["drafting"]);
    const slug = `${slugify(outcome.article.title)}-${Math.random().toString(36).slice(2, 7)}`;
    const o = origin.original;
    const { data: insertedContent, error: insErr } = await admin
      .from("content")
      .insert({
        type: "article", status: "pending", origin: "ai",
        title: outcome.article.title, slug,
        excerpt: outcome.article.excerpt,
        ai_summary: outcome.article.summary ?? null,
        body: outcome.article.body,
        read_minutes: outcome.readMinutes,
        category_slug: o?.category_slug ?? null,
        source_name: inputs.source_name,
        source_url: inputs.source_url,
        original_title: o?.original_title ?? originTitle,
        original_url: inputs.source_url,
        cover_image_url: o?.cover_image_url ?? null,
        cover_credit_name: o?.cover_credit_name ?? null,
        cover_credit_url: o?.cover_credit_url ?? null,
        source_image_url: o?.source_image_url ?? null,
        developed_from_content_id: o?.id ?? null,
      })
      .select("id").single();
    if (insErr || !insertedContent) {
      await fail("content_insert_failed", insErr?.message ?? "insert failed");
      return { error: "content_insert_failed" };
    }
    const newId = (insertedContent as { id: string }).id;

    // Public provenance rows from the strongest evidence items.
    const { data: evRows } = await admin
      .from("development_evidence")
      .select("kind,url,title,publisher,source_class,is_primary,fetched")
      .eq("development_id", jobId).order("id");
    const pub = ((evRows ?? []) as { kind: string; url: string | null; title: string | null; publisher: string | null; source_class: string | null; is_primary: boolean; fetched: boolean }[])
      .filter((r) => r.url && r.kind !== "salma_archive")
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
      .slice(0, 6);
    if (pub.length) {
      await admin.from("content_sources").insert(pub.map((r) => ({
        content_id: newId,
        label: `${r.source_class && CLASS_LABELS_AR[r.source_class as SourceClass] ? CLASS_LABELS_AR[r.source_class as SourceClass] : "مصدر"}: ${r.publisher ?? r.title ?? ""}`.slice(0, 160),
        url: r.url,
      })));
    }

    // Story thread (evolution): created/joined when prior coverage exists or
    // the job came from a cluster.
    let threadId: string | null = null;
    try {
      const priorIds = (inputs.prior_content_ids ?? []).filter(Boolean) as string[];
      if (priorIds.length > 0 || origin.clusterKey) {
        if (priorIds.length > 0) {
          const { data: member } = await admin
            .from("story_thread_members").select("thread_id")
            .in("content_id", priorIds).limit(1).maybeSingle();
          threadId = member?.thread_id ?? null;
        }
        if (!threadId) {
          const { data: th } = await admin
            .from("story_threads").insert({ title: originTitle.slice(0, 180) })
            .select("id").single();
          threadId = (th as { id: string } | null)?.id ?? null;
        }
        if (threadId) {
          const members = [
            ...priorIds.map((id) => ({ thread_id: threadId!, content_id: id, role: "prior_coverage" })),
            ...(o ? [{ thread_id: threadId, content_id: o.id, role: "original" }] : []),
            { thread_id: threadId, content_id: newId, role: priorIds.length > 0 ? "update" : "developed" },
          ];
          await admin.from("story_thread_members").upsert(members, { onConflict: "thread_id,content_id", ignoreDuplicates: true });
        }
      }
    } catch { /* threads are organizational metadata — never fail the draft */ }

    await patchJob(admin, jobId, {
      status: "draft_ready", phase: null,
      error_category: null, error_message: null,
      result_content_id: newId,
      draft_direction: direction,
      thread_id: threadId,
      writing_profile: inputs.profile,
      writer_model: outcome.audit.writer_model_used ?? EVIDENCE_MODEL,
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
    return { contentId: newId };
  } catch (e) {
    await fail("draft_error", e instanceof Error ? e.message : String(e));
    return { error: "draft_error" };
  }
}

// ---- cluster resolution --------------------------------------------------------

async function resolveCluster(admin: SupabaseClient, clusterKey: string): Promise<
  | { ok: true; titleAr: string | null; title: string | null; leads: Lead[] }
  | { ok: false; error: string }
> {
  const { data: sel } = await admin
    .from("radar_editorial_selection")
    .select("radar_article_id, chosen_source_title, story_type")
    .eq("cluster_key", clusterKey)
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle();

  let repId = sel?.radar_article_id ?? null;
  let canonical: string | null = null;
  if (repId) {
    const { data: rep } = await admin
      .from("radar_shadow_articles")
      .select("id, esl_canonical_key").eq("id", repId).maybeSingle();
    canonical = rep?.esl_canonical_key ?? null;
  }
  if (!repId && !canonical) {
    // Allow passing a canonical key directly — or a single shadow-row id
    // (uuid), which develops that one radar item as a single-lead cluster.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clusterKey)) {
      repId = clusterKey;
    } else {
      canonical = clusterKey;
    }
  }
  const query = admin
    .from("radar_shadow_articles")
    .select("id, title, title_ar, url, source_domain, published_at")
    .order("published_at", { ascending: false })
    .limit(10);
  const { data: members } = canonical
    ? await query.eq("esl_canonical_key", canonical)
    : await query.eq("id", repId!);
  type ShadowRow = { id: string; title: string | null; title_ar: string | null; url: string | null; source_domain: string | null; published_at: string | null };
  let withRep = (members ?? []) as ShadowRow[];
  if (repId && !withRep.some((r) => r.id === repId)) {
    const { data: rep } = await admin
      .from("radar_shadow_articles")
      .select("id,title,title_ar,url,source_domain,published_at")
      .eq("id", repId).maybeSingle();
    if (rep) withRep = [rep as ShadowRow, ...withRep];
  }
  const leads: Lead[] = withRep
    .filter((r) => r.url && /^https?:\/\//i.test(r.url))
    .map((r) => ({ url: r.url!, title: r.title, domain: r.source_domain || domainOf(r.url!), publishedAt: r.published_at }));
  if (leads.length === 0) return { ok: false, error: "cluster has no usable leads" };
  const first = withRep[0];
  return { ok: true, titleAr: first?.title_ar ?? sel?.chosen_source_title ?? null, title: first?.title ?? null, leads };
}

// ---- HTTP handler ----------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const actor = await authorize(req, admin);
  if (!actor) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const op = String(body.op ?? "");

  if (op === "cancel") {
    const jobId = String(body.job_id ?? "");
    if (!jobId) return Response.json({ ok: false, error: "job_id required" }, { status: 400 });
    await admin.from("story_developments")
      .update({ status: "cancelled", phase: null })
      .eq("id", jobId)
      .in("status", ["researching", "brief_ready", "drafting", "failed"]);
    return Response.json({ ok: true });
  }

  if (op === "start") {
    const contentId = String(body.content_id ?? "");
    const clusterKey = String(body.cluster_key ?? "");
    const direction = body.direction;
    const editorNote = String(body.editor_note ?? "").trim().slice(0, 500) || null;
    const depthOverride = body.depth === "deep" ? "deep" as const : null;
    if ((!contentId && !clusterKey) || (contentId && clusterKey) || !isDirection(direction)) {
      return Response.json({ ok: false, error: "exactly one of content_id/cluster_key plus a valid direction required" }, { status: 400 });
    }

    let origin: Origin;
    if (contentId) {
      const { data: original } = await admin
        .from("content").select(CONTENT_COLS).eq("id", contentId).maybeSingle();
      const row = original as ContentRow | null;
      if (!row || row.deleted_at || !DEVELOPABLE_STATUSES.includes(row.status)) {
        return Response.json({ ok: false, error: "article not developable" }, { status: 422 });
      }
      if (!row.body || row.body.trim().length < 80) {
        return Response.json({ ok: false, error: "article body too short" }, { status: 422 });
      }
      origin = { kind: "article", row };
    } else {
      const c = await resolveCluster(admin, clusterKey);
      if (!c.ok) return Response.json({ ok: false, error: c.error }, { status: 422 });
      origin = { kind: "cluster", key: clusterKey, titleAr: c.titleAr, title: c.title, leads: c.leads };
    }

    // Heal dead runs for this origin.
    const healBase = admin.from("story_developments")
      .update({ status: "failed", phase: null, error_category: "timeout", error_message: "stale run healed" })
      .in("status", ["researching", "drafting"])
      .lt("updated_at", new Date(Date.now() - STALE_RUN_MS).toISOString());
    if (contentId) await healBase.eq("original_content_id", contentId);
    else await healBase.eq("cluster_key", clusterKey);

    const { data: job, error: insErr } = await admin
      .from("story_developments")
      .insert({
        original_content_id: contentId || null,
        cluster_key: clusterKey || null,
        requested_by: actor.id,
        direction, editor_note: editorNote,
        status: "researching", phase: "analyzing_context",
        ...(depthOverride ? { research_depth: depthOverride } : {}),
      })
      .select("id").single();
    if (insErr || !job) {
      if (insErr?.code === "23505") {
        let activeQ = admin.from("story_developments").select("id,status")
          .in("status", ["researching", "brief_ready", "drafting"]);
        activeQ = contentId ? activeQ.eq("original_content_id", contentId) : activeQ.eq("cluster_key", clusterKey);
        const { data: active } = await activeQ.maybeSingle();
        return Response.json({ ok: true, job_id: active?.id ?? null, existing: true });
      }
      return Response.json({ ok: false, error: "could not create job" }, { status: 500 });
    }

    await runResearch(admin, job.id, origin, direction, editorNote, depthOverride);
    const { data: done } = await admin
      .from("story_developments").select("status,error_category").eq("id", job.id).maybeSingle();
    return Response.json({ ok: true, job_id: job.id, status: done?.status ?? "failed" });
  }

  if (op === "draft") {
    const jobId = String(body.job_id ?? "");
    const rawDirection = body.direction;
    const editorNote = String(body.editor_note ?? "").trim().slice(0, 500) || null;
    if (!jobId) return Response.json({ ok: false, error: "job_id required" }, { status: 400 });

    const { data: job } = await admin
      .from("story_developments")
      .select("id,original_content_id,cluster_key,status,direction,editor_note,research_brief")
      .eq("id", jobId).maybeSingle();
    if (!job) return Response.json({ ok: false, error: "job not found" }, { status: 404 });
    if (!(job.status === "brief_ready" || (job.status === "failed" && job.research_brief))) {
      return Response.json({ ok: false, error: `job not draftable (${job.status})` }, { status: 409 });
    }

    let direction = isDirection(rawDirection) && rawDirection !== "auto" ? rawDirection : null;
    if (!direction && isDirection(job.direction) && job.direction !== "auto") direction = job.direction;
    if (!direction) {
      const angles = ((job.research_brief ?? {}) as { suggested_angles?: { direction: string; recommended: boolean }[] }).suggested_angles ?? [];
      const rec = angles.find((a) => a.recommended) ?? angles[0];
      direction = rec && rec.direction in DIRECTIONS ? rec.direction as Exclude<DevelopmentDirection, "auto"> : "deeper_explainer";
    }

    const { data: locked } = await admin
      .from("story_developments")
      .update({ status: "drafting", phase: "writing", draft_direction: direction, ...(editorNote ? { editor_note: editorNote } : {}) })
      .eq("id", jobId).in("status", ["brief_ready", "failed"])
      .select("id").maybeSingle();
    if (!locked) return Response.json({ ok: false, error: "job already drafting" }, { status: 409 });

    let original: ContentRow | null = null;
    let clusterTitle: string | null = null;
    if (job.original_content_id) {
      const { data } = await admin
        .from("content").select(CONTENT_COLS).eq("id", job.original_content_id).maybeSingle();
      original = data as ContentRow | null;
      if (!original) {
        await patchJob(admin, jobId, { status: "failed", phase: null, error_category: "original_missing", error_message: "original article missing" }, ["drafting"]);
        return Response.json({ ok: false, error: "original missing" }, { status: 422 });
      }
    } else if (job.cluster_key) {
      const c = await resolveCluster(admin, job.cluster_key);
      clusterTitle = c.ok ? (c.titleAr ?? c.title) : null;
    }

    const r = await runDraft(
      admin, jobId,
      { original, clusterKey: job.cluster_key, clusterTitle },
      direction, editorNote ?? (job.editor_note as string | null),
    );
    const { data: done } = await admin
      .from("story_developments")
      .select("status,result_content_id,error_category,error_message")
      .eq("id", jobId).maybeSingle();
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

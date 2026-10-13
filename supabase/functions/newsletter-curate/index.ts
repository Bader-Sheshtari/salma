import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// NEWSLETTER CURATION ENGINE V1 — orchestrator.
//
// op:"curate" {issue_id}: gathers candidates for the issue's date range
// (published Salma articles + ranked external Radar items + doctor transfers),
// scores and balances them DETERMINISTICALLY (curation.ts), then polishes the
// newsletter copy (headlines/teasers/briefs/analysis/why-lines + issue title
// and intro) in ONE batched LLM call with a deterministic fallback — so the
// engine always returns a complete, editor-ready issue (§36: no per-candidate
// LLM calls).
//
// External items are SNAPSHOTTED into newsletter_items (url/source/author/
// date/type/verification): radar rows are retained only ~48h, so a newsletter
// item must never reference them.
//
// Deliberately NOT here (§35): sending, SMTP, campaigns, tracking.

import {
  chatJson,
  EDITOR_MODEL,
  fetchOutboundLinks,
  newUsage,
  type LlmUsage,
} from "../ingest-news/pipeline.ts";
import {
  buildTrendCounts,
  type Candidate,
  dedupeCandidates,
  fallbackCopy,
  isResearchPrimary,
  type NewsletterSection,
  normalizeArabic,
  scoreBand,
  scoreCandidate,
  type ScoredCandidate,
  SECTION_LABELS,
  selectIssue,
  type SignalContext,
} from "./curation.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_EXTERNAL_CANDIDATES = 120;
const MAX_ARTICLE_CANDIDATES = 100;

type Actor = { kind: "staff"; id: string } | { kind: "service"; id: null };

// Structural slice of the PostgREST filter builder (just the chainable methods
// the radar pool pulls use), so both pulls share one filter set without
// widening to `any`. An interface because polymorphic `this` returns are only
// legal on interface/class members; awaiting it yields the usual {data} shape.
// (A generic <T extends …> version trips TS2589 against supabase-js's own
// deeply-generic builder types, hence the single explicit cast per call site.)
interface RadarPoolQuery extends PromiseLike<{ data: unknown[] | null }> {
  not(column: string, operator: string, value: unknown): this;
  in(column: string, values: readonly unknown[]): this;
  eq(column: string, value: unknown): this;
  is(column: string, value: null): this;
  gte(column: string, value: string): this;
  lte(column: string, value: string): this;
  order(column: string, opts: { ascending: boolean; nullsFirst?: boolean }): this;
  limit(n: number): this;
}

// Same staff-or-service authorization as develop-story.
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

// --- Source-quality tiers (§29) ----------------------------------------------

const DEFAULT_TIER1 = new Set([
  "who.int", "fda.gov", "cdc.gov", "ema.europa.eu", "nejm.org", "thelancet.com",
  "nature.com", "bmj.com", "jamanetwork.com", "nih.gov",
]);
const DEFAULT_TIER2 = new Set(["reuters.com", "bbc.com", "statnews.com", "apnews.com"]);

function normDomain(d: string | null): string {
  return (d ?? "").trim().toLowerCase().replace(/^www\./, "");
}

function buildTierOf(
  newsSources: { domain: string; tier: string }[],
  gccSources: { domain: string; authority_tier: number }[],
): (domain: string | null) => number {
  const map = new Map<string, number>();
  for (const s of newsSources) {
    const t = s.tier === "1" ? 1 : s.tier === "2" ? 2 : s.tier === "3" ? 3 : 5;
    map.set(normDomain(s.domain), t);
  }
  for (const s of gccSources) map.set(normDomain(s.domain), s.authority_tier);
  return (domain) => {
    const d = normDomain(domain);
    if (!d) return 3.5;
    const hit = map.get(d);
    if (hit !== undefined) return hit;
    if (DEFAULT_TIER1.has(d)) return 1;
    if (DEFAULT_TIER2.has(d)) return 2;
    return 3.5;
  };
}

function externalSourceType(c: ScoredCandidate, gccClass: string | null, nsType: string | null):
  "official" | "research" | "institution" | "media" | "expert" | "other" {
  if (c.opinion) return "expert";
  if (c.section === "research" || c.eslEvidenceClass === "research") return "research";
  if (gccClass === "government" || gccClass === "regulator" || nsType === "official") return "official";
  if (nsType === "research") return "research";
  if (gccClass && ["provider", "insurance", "digital_health", "pharma_medtech", "investment"].includes(gccClass)) {
    return "institution";
  }
  if (nsType === "medical_institution") return "institution";
  if (gccClass === "wire" || gccClass === "media" || nsType === "media") return "media";
  return "other";
}

// --- Batched copy pass (§36) ---------------------------------------------------

type CopyOut = {
  issue_title: string | null;
  intro: string | null;
  items: Map<number, { headline?: string; teaser?: string; analysis?: string; why?: string }>;
};

function buildCopyPrompt(
  picks: { candidate: ScoredCandidate; section: NewsletterSection }[],
): { role: string; content: string }[] {
  const lines = picks.map((p, i) => {
    const c = p.candidate;
    const facts: string[] = [
      `${i}. [${SECTION_LABELS[p.section]}] ${c.titleAr ?? c.title}`,
    ];
    if (c.titleAr && c.title && c.titleAr !== c.title) facts.push(`   العنوان الأصلي: ${c.title.slice(0, 160)}`);
    if (c.summary) facts.push(`   ملخص: ${c.summary.slice(0, 350)}`);
    if (c.sourceName || c.sourceDomain) facts.push(`   المصدر: ${c.sourceName ?? c.sourceDomain}`);
    if (c.gcc?.whyAr) facts.push(`   إشارة: ${c.gcc.whyAr}`);
    if (c.kind === "transfer" && c.transfer) {
      facts.push(`   انتقال: ${c.transfer.doctorName} | من ${c.transfer.from ?? "—"} إلى ${c.transfer.to ?? "—"} | ${c.transfer.specialty ?? ""}`);
    }
    if (c.kind === "external") facts.push(`   النوع: عنصر خارجي (موجز نشرة فقط)`);
    if (c.opinion) facts.push(`   تصنيف: رأي/مقال خبير — لا يُقدَّم كحقيقة خبرية`);
    return facts.join("\n");
  });

  const system = `أنت محرر نشرة «سلمى» الصحية. اكتب نصوص النشرة بالعربية وفق «لغة القارئ أولاً»:
- جمل قصيرة وواضحة، بلا لغة أكاديمية أو بيروقراطية، وبلا تهويل أو عناوين أقوى من الحقيقة.
- العنوان الصحفي أمين: لا يتجاوز أقوى ادعاء مدعوم.
- teaser لعنصر خارجي = موجز نشرة من 60 إلى 150 كلمة يجيب: ماذا حدث؟ لماذا يهم؟ مع معلومة سياق واحدة مفيدة.
- analysis (للعناصر المهمة فقط): جملة إلى جملتين عن «ما معناه» لا «ما حدث».
- why = سطر واحد «لماذا يستحق وقتك؟» مفيد لا تسويقي.
- عنصر الرأي يُقدَّم بوضوح كرأي خبير لا كخبر.
- الانتقالات سطر واحد مضغوط، بلا سيرة ذاتية.
أعد JSON فقط بلا أي نص آخر وبلا أسوار كود، بهذه البنية:
{"issue_title": "عنوان قصير جذاب للإصدار", "intro": "افتتاحية من جملتين إلى ثلاث تخبر القارئ لماذا يستحق هذا العدد وقته، بلا حشو", "items": [{"i": 0, "headline": "...", "teaser": "...", "analysis": "...", "why": "..."}]}
قواعد الحقول: headline مطلوب لكل عنصر. teaser مطلوب للعناصر الخارجية ومرغوب لغيرها (حتى 40 كلمة للمقالات الداخلية). analysis فقط لعناصر [${SECTION_LABELS.lead}] و[${SECTION_LABELS.top_missed}] و[${SECTION_LABELS.economy}] و[${SECTION_LABELS.research}]. why للعناصر البارزة فقط. اترك الحقل غير المطلوب بلا إدراج.`;

  const user = `عناصر العدد:\n\n${lines.join("\n\n")}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseCopyOutput(raw: string, count: number): CopyOut {
  const stripped = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const out: CopyOut = { issue_title: null, intro: null, items: new Map() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.issue_title === "string") out.issue_title = obj.issue_title.trim().slice(0, 180);
  if (typeof obj.intro === "string") out.intro = obj.intro.trim().slice(0, 1200);
  if (Array.isArray(obj.items)) {
    for (const it of obj.items) {
      if (!it || typeof it !== "object") continue;
      const row = it as Record<string, unknown>;
      const i = Number(row.i);
      if (!Number.isInteger(i) || i < 0 || i >= count) continue;
      out.items.set(i, {
        headline: typeof row.headline === "string" ? row.headline.trim().slice(0, 200) : undefined,
        teaser: typeof row.teaser === "string" ? row.teaser.trim().slice(0, 1500) : undefined,
        analysis: typeof row.analysis === "string" ? row.analysis.trim().slice(0, 700) : undefined,
        why: typeof row.why === "string" ? row.why.trim().slice(0, 300) : undefined,
      });
    }
  }
  return out;
}

// --- Handler -------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const actor = await authorize(req, admin);
  if (!actor) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });

  let body: { op?: unknown; issue_id?: unknown } = {};
  try {
    body = await req.json();
  } catch { /* empty */ }
  if (body.op !== "curate" || typeof body.issue_id !== "string") {
    return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const issueId = body.issue_id;

  try {
    const { data: issue } = await admin
      .from("newsletter_issues")
      .select("id,title,intro_ar,status,range_start,range_end")
      .eq("id", issueId)
      .maybeSingle();
    if (!issue) return Response.json({ ok: false, error: "issue_not_found" }, { status: 404 });
    if (issue.status === "archived") {
      return Response.json({ ok: false, error: "issue_archived" }, { status: 409 });
    }
    const rangeStart = issue.range_start as string;
    const rangeEnd = issue.range_end as string;

    // ---- Gather signal context -------------------------------------------
    const [nsRes, gccSrcRes, audRes, searchRes] = await Promise.all([
      admin.from("news_sources").select("domain,tier,source_type").eq("active", true),
      admin.from("gcc_sources").select("domain,authority_tier,source_class"),
      admin.from("newsletter_audience_profiles").select("topics").limit(2000),
      admin.from("search_queries").select("query_norm,result_count")
        .gte("created_at", rangeStart).lte("created_at", rangeEnd).limit(2000),
    ]);
    const tierOf = buildTierOf(
      (nsRes.data ?? []) as { domain: string; tier: string }[],
      (gccSrcRes.data ?? []) as { domain: string; authority_tier: number }[],
    );
    const nsTypeByDomain = new Map(
      ((nsRes.data ?? []) as { domain: string; source_type: string }[])
        .map((s) => [normDomain(s.domain), s.source_type]),
    );
    const gccClassByDomain = new Map(
      ((gccSrcRes.data ?? []) as { domain: string; source_class: string }[])
        .map((s) => [normDomain(s.domain), s.source_class]),
    );

    const audienceTopics: Record<string, number> = {};
    for (const row of (audRes.data ?? []) as { topics: string[] | null }[]) {
      for (const t of row.topics ?? []) audienceTopics[t] = (audienceTopics[t] ?? 0) + 1;
    }

    const termCounts = new Map<string, { term: string; count: number; zero: boolean }>();
    for (const q of (searchRes.data ?? []) as { query_norm: string; result_count: number }[]) {
      const key = normalizeArabic(q.query_norm);
      const cur = termCounts.get(key) ?? { term: q.query_norm, count: 0, zero: true };
      cur.count += 1;
      if ((q.result_count ?? 0) > 0) cur.zero = false;
      termCounts.set(key, cur);
    }
    const allTerms = [...termCounts.values()].sort((a, b) => b.count - a.count);
    const searchTerms = allTerms.slice(0, 20).map(({ term, count }) => ({ term, count }));
    const zeroResultTerms = allTerms.filter((t) => t.zero && t.count >= 2).slice(0, 10).map((t) => t.term);

    // ---- Candidates: published Salma articles ----------------------------
    const { data: articles } = await admin
      .from("content")
      .select("id,title,slug,excerpt,ai_summary,category_slug,published_at,is_breaking,developed_from_content_id,source_name")
      .eq("status", "published")
      .is("deleted_at", null)
      .gte("published_at", rangeStart)
      .lte("published_at", rangeEnd)
      .order("published_at", { ascending: false })
      .limit(MAX_ARTICLE_CANDIDATES);
    const articleRows = (articles ?? []) as {
      id: string; title: string; slug: string; excerpt: string | null; ai_summary: string | null;
      category_slug: string | null; published_at: string | null; is_breaking: boolean | null;
      developed_from_content_id: string | null; source_name: string | null;
    }[];
    const articleIds = articleRows.map((a) => a.id);

    // Published developed children of in-range articles (the stronger version
    // may itself be outside the range — include it so the swap can happen).
    const childByOriginal = new Map<string, string>();
    if (articleIds.length > 0) {
      const { data: children } = await admin
        .from("content")
        .select("id,title,slug,excerpt,ai_summary,category_slug,published_at,is_breaking,developed_from_content_id,source_name")
        .eq("status", "published")
        .is("deleted_at", null)
        .in("developed_from_content_id", articleIds);
      for (const ch of (children ?? []) as typeof articleRows) {
        childByOriginal.set(ch.developed_from_content_id!, ch.id);
        if (!articleRows.some((a) => a.id === ch.id)) articleRows.push(ch);
      }
    }

    // Reader metrics (rollups cover long-term; raw events the last days).
    const stats = new Map<string, { views: number; engaged: number; completed: number }>();
    if (articleRows.length > 0) {
      const ids = articleRows.map((a) => a.id);
      const { data: daily } = await admin
        .from("reader_daily_stats")
        .select("content_id,views,engaged,completed")
        .gte("day", rangeStart.slice(0, 10))
        .in("content_id", ids);
      for (const d of (daily ?? []) as { content_id: string; views: number; engaged: number; completed: number }[]) {
        const cur = stats.get(d.content_id) ?? { views: 0, engaged: 0, completed: 0 };
        cur.views += d.views; cur.engaged += d.engaged; cur.completed += d.completed;
        stats.set(d.content_id, cur);
      }
    }

    const candidates: Candidate[] = articleRows.map((a) => ({
      kind: "article",
      refId: a.id,
      title: a.title,
      titleAr: a.title,
      summary: a.excerpt ?? a.ai_summary,
      url: null,
      sourceDomain: null,
      sourceName: a.source_name,
      categorySlug: a.category_slug,
      publishedAt: a.published_at,
      isBreaking: a.is_breaking ?? false,
      developedFromId: a.developed_from_content_id,
      developedChildId: childByOriginal.get(a.id) ?? null,
      views: stats.get(a.id)?.views ?? 0,
      engaged: stats.get(a.id)?.engaged ?? 0,
      completed: stats.get(a.id)?.completed ?? 0,
    }));

    // ---- Candidates: external (ranked Radar, not already in Salma) --------
    // NOTE: radar retention keeps unselected rows ~48h, so the external pool
    // skews to the most recent days of the range. Snapshot everything needed.
    //
    // V1.1: the pool is pulled in TWO passes. The LLM ranker clusters global
    // stories at high scores, so a naive top-N by priority_score can crowd
    // tier-1 officials (e.g. SFDA at 75 vs a wall of 80s) out of the pool
    // entirely. Pass 2 guarantees every ranked item from a tier-1/2 REGISTRY
    // domain a seat at the table; the engine's own scoring decides from there.
    const RADAR_SELECT =
      "id,title,title_ar,url,source_title,source_domain,language,country,published_at,first_seen_at,priority_level,priority_score,editorial_value,esl_evidence_class,esl_canonical_key";
    const radarPoolFilters = (q: RadarPoolQuery): RadarPoolQuery =>
      q
        .not("ranked_at", "is", null)
        .in("priority_level", ["important", "very_important"])
        .eq("duplicate_status", "new")
        .is("publish_status", null)
        .is("matched_content_id", null)
        .not("url", "is", null)
        .gte("first_seen_at", rangeStart)
        .lte("first_seen_at", rangeEnd);
    const authorityDomains = [
      ...((nsRes.data ?? []) as { domain: string; tier: string }[])
        .filter((s) => s.tier === "1" || s.tier === "2").map((s) => s.domain),
      ...((gccSrcRes.data ?? []) as { domain: string; authority_tier: number }[])
        .filter((s) => s.authority_tier <= 2).map((s) => s.domain),
    ];
    const radarPoolQuery = (): RadarPoolQuery =>
      admin.from("radar_shadow_articles").select(RADAR_SELECT) as unknown as RadarPoolQuery;
    const [{ data: radarTop }, { data: radarAuthority }] = await Promise.all([
      radarPoolFilters(radarPoolQuery())
        .order("priority_score", { ascending: false, nullsFirst: false })
        .limit(MAX_EXTERNAL_CANDIDATES),
      authorityDomains.length > 0
        ? radarPoolFilters(radarPoolQuery())
          .in("source_domain", authorityDomains)
          .order("priority_score", { ascending: false, nullsFirst: false })
          .limit(60)
        : Promise.resolve({ data: [] as unknown[] | null }),
    ]);
    const radarById = new Map<string, Record<string, unknown>>();
    for (const r of [...(radarTop ?? []), ...(radarAuthority ?? [])] as { id: string }[]) {
      radarById.set(r.id, r as unknown as Record<string, unknown>);
    }
    const radar = [...radarById.values()];
    const radarRows = (radar ?? []) as {
      id: string; title: string | null; title_ar: string | null; url: string;
      source_title: string | null; source_domain: string | null; language: string | null;
      country: string | null; published_at: string | null; first_seen_at: string;
      priority_level: "very_important" | "important" | "low" | null; priority_score: number | null;
      editorial_value: string | null; esl_evidence_class: string | null; esl_canonical_key: string | null;
    }[];

    const gccByArticle = new Map<string, {
      country_code: string; topics: string[]; signals: string[]; strategic: boolean;
      gcc_score: number; why_ar: string | null;
    }>();
    if (radarRows.length > 0) {
      const { data: intel } = await admin
        .from("radar_gcc_intel")
        .select("radar_article_id,country_code,topics,signals,strategic,gcc_score,why_ar")
        .in("radar_article_id", radarRows.map((r) => r.id));
      for (const i of (intel ?? []) as ({ radar_article_id: string } & {
        country_code: string; topics: string[]; signals: string[]; strategic: boolean;
        gcc_score: number; why_ar: string | null;
      })[]) {
        gccByArticle.set(i.radar_article_id, i);
      }
    }

    for (const r of radarRows) {
      const g = gccByArticle.get(r.id);
      candidates.push({
        kind: "external",
        refId: r.id,
        title: r.title ?? "",
        titleAr: r.title_ar,
        summary: null,
        url: r.url,
        sourceDomain: r.source_domain,
        sourceName: r.source_title,
        country: r.country,
        categorySlug: null,
        publishedAt: r.published_at ?? r.first_seen_at,
        priorityLevel: r.priority_level,
        priorityScore: r.priority_score,
        editorialValue: r.editorial_value,
        eslEvidenceClass: r.esl_evidence_class,
        eslCanonicalKey: r.esl_canonical_key,
        gcc: g
          ? {
            countryCode: g.country_code,
            topics: g.topics ?? [],
            signals: g.signals ?? [],
            strategic: g.strategic,
            gccScore: Number(g.gcc_score ?? 0),
            whyAr: g.why_ar,
          }
          : null,
      });
    }

    // ---- Candidates: doctor transfers (§7) --------------------------------
    const { data: transfers } = await admin
      .from("doctor_transfers")
      .select("id,doctor_name,from_hospital,to_hospital,specialty,published_at,created_at")
      .eq("status", "published")
      .is("deleted_at", null)
      .or(`and(published_at.gte.${rangeStart},published_at.lte.${rangeEnd}),and(published_at.is.null,created_at.gte.${rangeStart},created_at.lte.${rangeEnd})`)
      .limit(20);
    for (const t of (transfers ?? []) as {
      id: string; doctor_name: string; from_hospital: string | null; to_hospital: string | null;
      specialty: string | null; published_at: string | null; created_at: string;
    }[]) {
      candidates.push({
        kind: "transfer",
        refId: t.id,
        title: t.doctor_name,
        titleAr: t.doctor_name,
        summary: null,
        url: null,
        sourceDomain: null,
        sourceName: null,
        categorySlug: null,
        publishedAt: t.published_at ?? t.created_at,
        transfer: {
          doctorName: t.doctor_name,
          from: t.from_hospital,
          to: t.to_hospital,
          specialty: t.specialty,
        },
      });
    }

    // ---- Deterministic engine ---------------------------------------------
    const maxViews = Math.max(0, ...candidates.map((c) => c.views ?? 0));
    const ctx: SignalContext = { tierOf, searchTerms, audienceTopics, maxViews };
    const prelim = candidates.map((c) => scoreCandidate(c, ctx));

    // ---- Primary-source escalation (V1.1 §5) ------------------------------
    // For promising-but-unverified externals (secondary media), try to locate
    // the primary/official/original source via the hardened outbound-link
    // escalation (ingest STEP B — no brittle scraping, no LLM). A found
    // tier-1/2 primary drives verification + authority; the secondary URL
    // stays as reader-facing context.
    const ESCALATION_BUDGET_MS = 45_000;
    const escStarted = Date.now();
    const escTargets = prelim
      .filter((c) => c.kind === "external" && !c.verified && c.score >= 0.45 && c.url)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    let escalated = 0;
    for (const t of escTargets) {
      if (Date.now() - escStarted > ESCALATION_BUDGET_MS) break;
      const links = await fetchOutboundLinks(t.url!).catch(() => [] as string[]);
      let best: { url: string; domain: string; tier: number } | null = null;
      for (const link of links) {
        try {
          const u = new URL(link);
          const domain = u.hostname.replace(/^www\./, "");
          const tier = tierOf(domain);
          // Prefer true primaries: regulators/official (tier 1), then original
          // research outlets; never "escalate" to another ordinary media site.
          if (tier <= 2 || isResearchPrimary(domain)) {
            const effTier = isResearchPrimary(domain) ? Math.min(tier, 1.5) : tier;
            if (!best || effTier < best.tier) best = { url: u.href, domain, tier: effTier };
          }
        } catch { /* skip malformed */ }
      }
      if (best) {
        const cand = candidates.find((c) => c.refId === t.refId);
        if (cand) {
          cand.hasPrimary = true;
          cand.primaryUrl = best.url;
          cand.primaryDomain = best.domain;
          escalated++;
        }
      }
    }

    const scored = candidates.map((c) => scoreCandidate(c, ctx));
    const trendGroupCounts = buildTrendCounts(scored);
    const selectionCtx: SignalContext = { ...ctx, trendGroupCounts };
    const deduped = dedupeCandidates(scored);

    // Keep editor decisions: existing accepted/rejected/manual items survive a
    // re-curation; their references are excluded from new suggestions.
    const { data: existing } = await admin
      .from("newsletter_items")
      .select("id,editor_state,section,content_id,transfer_id,external_url")
      .eq("issue_id", issueId);
    const existingRows = (existing ?? []) as {
      id: string; editor_state: string; section: string; content_id: string | null;
      transfer_id: string | null; external_url: string | null;
    }[];
    const keptRefs = new Set<string>();
    // Sections already occupied by editor-kept items: the engine fills AROUND
    // them (an occupied lead is never re-filled — §2 exactly one).
    const keptSectionCounts: Partial<Record<NewsletterSection, number>> = {};
    for (const row of existingRows) {
      if (row.editor_state === "suggested") continue;
      if (row.content_id) keptRefs.add(row.content_id);
      if (row.transfer_id) keptRefs.add(row.transfer_id);
      if (row.external_url) keptRefs.add(row.external_url);
      if (row.section !== "opportunities") {
        const s = row.section as NewsletterSection;
        keptSectionCounts[s] = (keptSectionCounts[s] ?? 0) + 1;
      }
    }
    const pool = deduped.filter((c) => !keptRefs.has(c.refId) && !(c.url && keptRefs.has(c.url)));

    const { picks, emptySections, opportunities } = selectIssue(pool, selectionCtx, keptSectionCounts);

    // ---- One batched copy pass (fallback keeps the engine deterministic) --
    const usage: LlmUsage = newUsage();
    let copy: CopyOut = { issue_title: null, intro: null, items: new Map() };
    let copyMode: "llm" | "fallback" = "fallback";
    if (picks.length > 0) {
      const res = await chatJson(buildCopyPrompt(picks), {
        model: EDITOR_MODEL,
        maxTokens: 7000,
        temperature: 0.2,
        timeoutMs: 100_000,
        usage,
      });
      if (res.ok) {
        const parsed = parseCopyOutput(res.content, picks.length);
        if (parsed.items.size > 0 || parsed.issue_title) {
          copy = parsed;
          copyMode = "llm";
        }
      }
    }

    // ---- Persist: replace previous SUGGESTED items only --------------------
    await admin.from("newsletter_items")
      .delete()
      .eq("issue_id", issueId)
      .eq("editor_state", "suggested");

    const toRow = (c: ScoredCandidate, section: string, position: number,
      llm: { headline?: string; teaser?: string; analysis?: string; why?: string }) => {
      const fb = fallbackCopy(c);
      // Authority/type follow the PRIMARY domain when escalation found one (§5).
      const domain = normDomain(c.primaryDomain ?? c.sourceDomain);
      const gccClass = gccClassByDomain.get(domain) ?? null;
      const nsType = nsTypeByDomain.get(domain) ?? null;
      return {
        issue_id: issueId,
        item_type: c.kind,
        content_id: c.kind === "article" ? c.refId : null,
        transfer_id: c.kind === "transfer" ? c.refId : null,
        external_url: c.kind === "external" ? c.url : null,
        external_source_name: c.kind === "external" ? (c.sourceName ?? c.sourceDomain) : null,
        external_source_domain: c.kind === "external" ? c.sourceDomain : null,
        external_published_at: c.kind === "external" ? c.publishedAt : null,
        external_source_type: c.kind === "external"
          ? externalSourceType(c, gccClass, nsType)
          : null,
        primary_url: c.primaryUrl ?? null,
        primary_source_name: c.primaryDomain ?? null,
        verification_status: c.verified ? "verified" : "needs_check",
        section,
        position,
        newsletter_headline: llm.headline ?? fb.headline,
        teaser: llm.teaser ?? fb.teaser,
        short_analysis: llm.analysis ?? null,
        why_ar: llm.why ?? fb.whyAr,
        is_opinion: c.opinion,
        reasons: c.reasons,
        score: c.score,
        score_parts: c.parts,
        editor_state: "suggested",
      };
    };

    const inserts = picks.map((p, i) => toRow(p.candidate, p.section, p.position, copy.items.get(i) ?? {}));
    // §10: the editor-only opportunities pool gets deterministic copy only
    // (no LLM spend on items that are not in the issue).
    const oppInserts = opportunities
      .filter((c) => !keptRefs.has(c.refId) && !(c.url && keptRefs.has(c.url)))
      .map((c, i) => toRow(c, "opportunities", i, {}));
    const allInserts = [...inserts, ...oppInserts];
    if (allInserts.length > 0) {
      const { error: insErr } = await admin.from("newsletter_items").insert(allInserts);
      if (insErr) throw new Error(`items_insert_failed: ${insErr.message}`);
    }

    const curationMeta = {
      curated_at: new Date().toISOString(),
      engine_version: "v1.1",
      candidates: {
        articles: articleRows.length,
        external: radarRows.length,
        transfers: (transfers ?? []).length,
        after_dedupe: deduped.length,
      },
      picks: picks.length,
      opportunities: oppInserts.length,
      escalation: { attempted: escTargets.length, primaries_found: escalated },
      bands: {
        strong: picks.filter((p) => scoreBand(p.candidate.score) === "strong").length,
        good: picks.filter((p) => scoreBand(p.candidate.score) === "good").length,
      },
      empty_sections: emptySections,
      copy_mode: copyMode,
      zero_result_search_terms: zeroResultTerms, // editorial leads (§27)
      audience_topics: audienceTopics,
      usage,
    };
    await admin.from("newsletter_issues").update({
      status: issue.status === "draft" ? "curated" : issue.status,
      // Never overwrite an editor's own title/intro.
      ...(issue.title ? {} : { title: copy.issue_title }),
      ...(issue.intro_ar ? {} : { intro_ar: copy.intro }),
      curation_meta: curationMeta,
    }).eq("id", issueId);

    return Response.json({
      ok: true,
      issue_id: issueId,
      inserted: inserts.length,
      opportunities: oppInserts.length,
      escalation: { attempted: escTargets.length, primaries_found: escalated },
      empty_sections: emptySections,
      copy_mode: copyMode,
      usage,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});

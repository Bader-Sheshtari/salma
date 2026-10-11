// DEVELOP STORY V2 — scientific/regulatory retrievers (pure parsers + thin
// clients with injectable transport for tests).
//
// Three STABLE public APIs only — no scrapers:
//   PubMed            NCBI E-utilities (esearch + esummary + efetch abstracts)
//   ClinicalTrials.gov API v2 (/api/v2/studies)
//   openFDA           drugsfda (approval records)
// Every client returns { ok } | { ok:false, reason } and NEVER throws: a
// failed lookup degrades to an honest evidence gap, it never fails the job.
// Results are cached in external_lookup_cache (TTL enforced by the caller).

export type FetchJson = (url: string, timeoutMs?: number) => Promise<unknown>;

export type CacheDeps = {
  get: (provider: string, queryHash: string, maxAgeMs: number) => Promise<unknown | null>;
  put: (provider: string, queryHash: string, payload: unknown) => Promise<void>;
};

export type PubType = "meta_analysis" | "systematic_review" | "rct" | "review" | "editorial" | "primary";

export type PubmedItem = {
  pmid: string;
  title: string;
  journal: string | null;
  pubdate: string | null; // as reported, e.g. "2026 Mar 4"
  doi: string | null;
  pub_type: PubType;
  abstract: string | null;
};

export type TrialItem = {
  nct_id: string;
  title: string;
  phase: string | null;
  overall_status: string | null; // registry wording VERBATIM — never interpreted
  sponsor: string | null;
  study_type: string | null;
  enrollment: number | null;
  primary_outcomes: string[];
  start_date: string | null;
  completion_date: string | null;
};

export type FdaApproval = {
  application_number: string | null;
  sponsor: string | null;
  brand_name: string | null;
  generic_name: string | null;
  latest_action_date: string | null;
  latest_action_type: string | null;
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "after", "into", "over",
  "new", "study", "says", "could", "will", "would", "been", "were", "their",
  "about", "more", "than", "amid", "between", "during",
]);

/** Build a bounded PubMed/CT query from ENGLISH material (title + cues). */
export function buildSearchTerm(englishText: string, maxTerms = 6): string {
  const words = (englishText ?? "")
    .replace(/[^A-Za-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= maxTerms) break;
  }
  return out.join(" ");
}

export function classifyPubTypes(types: string[]): PubType {
  const t = types.map((x) => x.toLowerCase());
  if (t.some((x) => x.includes("meta-analysis"))) return "meta_analysis";
  if (t.some((x) => x.includes("systematic review"))) return "systematic_review";
  if (t.some((x) => x.includes("randomized controlled trial"))) return "rct";
  if (t.some((x) => x.includes("editorial") || x.includes("comment") || x.includes("letter"))) {
    return "editorial";
  }
  if (t.some((x) => x.includes("review"))) return "review";
  return "primary";
}

/** Relevance-ish ordering weight: evidence strength class + keeps API order
 *  (esearch best-match) as the final tiebreak via stable sort. */
const PUBTYPE_WEIGHT: Record<PubType, number> = {
  meta_analysis: 0,
  systematic_review: 0,
  rct: 1,
  primary: 2,
  review: 3,
  editorial: 4,
};

export function orderPubmedItems(items: PubmedItem[]): PubmedItem[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => PUBTYPE_WEIGHT[a.it.pub_type] - PUBTYPE_WEIGHT[b.it.pub_type] || a.i - b.i)
    .map((x) => x.it);
}

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

export async function pubmedSearch(
  term: string,
  limit: number,
  deps: { fetchJson: FetchJson; fetchText: (url: string, timeoutMs?: number) => Promise<string>; apiKey?: string | null },
): Promise<{ ok: true; items: PubmedItem[] } | { ok: false; reason: string }> {
  try {
    const q = term.trim();
    if (q.length < 4) return { ok: true, items: [] };
    const key = deps.apiKey ? `&api_key=${deps.apiKey}` : "";
    const es = (await deps.fetchJson(
      `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=25&sort=relevance&term=${encodeURIComponent(q)}${key}`,
    )) as { esearchresult?: { idlist?: string[] } };
    const ids = (es?.esearchresult?.idlist ?? []).slice(0, 25);
    if (ids.length === 0) return { ok: true, items: [] };

    const sum = (await deps.fetchJson(
      `${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}${key}`,
    )) as { result?: Record<string, Record<string, unknown>> };
    const items: PubmedItem[] = [];
    for (const id of ids) {
      const r = sum?.result?.[id];
      if (!r) continue;
      const articleIds = (r.articleids ?? []) as { idtype: string; value: string }[];
      items.push({
        pmid: id,
        title: String(r.title ?? "").trim(),
        journal: (r.fulljournalname as string) ?? null,
        pubdate: (r.pubdate as string) ?? null,
        doi: articleIds.find((a) => a.idtype === "doi")?.value ?? null,
        pub_type: classifyPubTypes((r.pubtype ?? []) as string[]),
        abstract: null,
      });
    }
    const kept = orderPubmedItems(items.filter((i) => i.title)).slice(0, limit);

    // One efetch call for the kept items' abstracts (plain text blocks).
    if (kept.length > 0) {
      try {
        const text = await deps.fetchText(
          `${EUTILS}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=${kept.map((k) => k.pmid).join(",")}${key}`,
        );
        const blocks = text.split(/\n\s*\n\s*\n/);
        for (const k of kept) {
          const blk = blocks.find((b) => b.includes(`PMID: ${k.pmid}`) || b.includes(k.title.slice(0, 60)));
          if (blk) k.abstract = blk.replace(/\s+/g, " ").trim().slice(0, 1500);
        }
      } catch {
        // abstracts are optional enrichment
      }
    }
    return { ok: true, items: kept };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "pubmed_failed" };
  }
}

export async function ctgovSearch(
  term: string,
  limit: number,
  deps: { fetchJson: FetchJson },
): Promise<{ ok: true; items: TrialItem[] } | { ok: false; reason: string }> {
  try {
    const q = term.trim();
    if (q.length < 4) return { ok: true, items: [] };
    const nct = q.match(/NCT\d{8}/i)?.[0];
    const url = nct
      ? `https://clinicaltrials.gov/api/v2/studies/${nct.toUpperCase()}`
      : `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(q)}&pageSize=${Math.min(limit, 5)}`;
    const data = (await deps.fetchJson(url)) as Record<string, unknown>;
    const studies = nct ? [data] : ((data?.studies ?? []) as Record<string, unknown>[]);

    const items: TrialItem[] = [];
    for (const s of studies.slice(0, limit)) {
      const proto = (s?.protocolSection ?? {}) as Record<string, Record<string, unknown>>;
      const idm = proto.identificationModule ?? {};
      const status = proto.statusModule ?? {};
      const design = proto.designModule ?? {};
      const sponsor = (proto.sponsorCollaboratorsModule ?? {}) as Record<string, Record<string, unknown>>;
      const outcomes = (proto.outcomesModule ?? {}) as { primaryOutcomes?: { measure?: string }[] };
      const nctId = String(idm.nctId ?? "").trim();
      if (!nctId) continue;
      items.push({
        nct_id: nctId,
        title: String(idm.briefTitle ?? "").trim(),
        phase: Array.isArray(design.phases) ? (design.phases as string[]).join("/") : null,
        overall_status: (status.overallStatus as string) ?? null,
        sponsor: (sponsor.leadSponsor?.name as string) ?? null,
        study_type: (design.studyType as string) ?? null,
        enrollment: Number((design.enrollmentInfo as Record<string, unknown>)?.count ?? NaN) || null,
        primary_outcomes: (outcomes.primaryOutcomes ?? []).map((o) => String(o.measure ?? "")).filter(Boolean).slice(0, 4),
        start_date: ((status.startDateStruct as Record<string, unknown>)?.date as string) ?? null,
        completion_date: ((status.completionDateStruct as Record<string, unknown>)?.date as string) ?? null,
      });
    }
    return { ok: true, items };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "ctgov_failed" };
  }
}

export async function openFdaDrugLookup(
  term: string,
  deps: { fetchJson: FetchJson },
): Promise<{ ok: true; items: FdaApproval[] } | { ok: false; reason: string }> {
  try {
    const q = term.trim();
    if (q.length < 3) return { ok: true, items: [] };
    const search = encodeURIComponent(
      `openfda.brand_name:"${q}" openfda.generic_name:"${q}"`.replace(/\s+/g, "+"),
    );
    const data = (await deps.fetchJson(
      `https://api.fda.gov/drug/drugsfda.json?search=${search}&limit=3`,
    )) as { results?: Record<string, unknown>[] };
    const items: FdaApproval[] = [];
    for (const r of data?.results ?? []) {
      const products = (r.products ?? []) as Record<string, unknown>[];
      const subs = ((r.submissions ?? []) as Record<string, unknown>[])
        .filter((s) => s.submission_status_date)
        .sort((a, b) => String(b.submission_status_date).localeCompare(String(a.submission_status_date)));
      const openfda = (r.openfda ?? {}) as Record<string, string[]>;
      items.push({
        application_number: (r.application_number as string) ?? null,
        sponsor: (r.sponsor_name as string) ?? null,
        brand_name: openfda.brand_name?.[0] ?? (products[0]?.brand_name as string) ?? null,
        generic_name: openfda.generic_name?.[0] ?? null,
        latest_action_date: (subs[0]?.submission_status_date as string) ?? null,
        latest_action_type: (subs[0]?.submission_type as string) ?? null,
      });
    }
    return { ok: true, items };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "openfda_failed" };
  }
}

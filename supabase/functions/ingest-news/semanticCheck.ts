// P4R2 — Semantic fidelity checker (pure; the model transport is injected).
//
// The lexical guards (numbers, dates, quotes, entities, actions, glosses) cannot
// see a sentence that keeps every token-level fact but changes its MEANING:
// a merged sentence that turns "tracheal aspirates" into "exhaled air", an age
// limit re-attached from a drug's indication to the disease, a timing
// qualifier moved from registration to designation, "1 in 8 child deaths
// averted" rendered as "1 in 8 children saved", or general advice narrowed to
// one group. s3.0 is a single JUDGMENT per pair (s2.0's extract-then-compare
// was retired after its acceptance run: long completions, equivalent subjects
// read as differences). It keeps s2.0's pairing:
//   1. ALIGN the sentences worth checking (deterministic):
//      (a) editor-changed / merged sentences ↔ their writer counterpart(s),
//          plus the best source-support sentence as context;
//      (b) editor-ADDED sentences ↔ the best-supporting source sentence(s);
//      (c) writer "risk-class" sentences ↔ best source support.
//      Pairs whose support scores below SUPPORT_FLOOR are SKIPPED (a fact-box
//      line such as "Cases : 80" is not support); function-word-only editor
//      pairs and duplicate pairs are dropped; pairs/texts are capped.
//   2. ONE model call per article asks JUDGMENT_QUESTION per pair under the
//      hard negative rules (JUDGMENT_NEGATIVE_RULES): materially_different +
//      one dimension + a one-line reason. Dimension → semantic_* code is fixed.
//   3. (unchanged) see Decision below.
//   4. Decision: editor pair difference → revert to the writer draft; writer
//      pair difference → needs_human_review (BLOCKING only for a safety_alert
//      risk/action sentence whose support is a prose sentence); checker error /
//      timeout / unparseable output → needs_human_review. Never upgrades.
// Everything is OFF unless SEMANTIC_CHECK_ENABLED is explicitly "true"/"1".

import {
  contentWordSet,
  extractNumberEntries,
  extractOfficialActions,
  normalizeForCompare,
  type WritingProfile,
} from "./salmaWriter.ts";
import type { EditorArticle, EditorPassResult, SemanticCheckAudit } from "./salmaEditor.ts";

export const SEMANTIC_CHECK_VERSION = "s3.0-salma-semantic" as const;
export const SEMANTIC_FLAG_ENV = "SEMANTIC_CHECK_ENABLED" as const;
export const SEMANTIC_MODEL_ENV = "OPENROUTER_SEMANTIC_MODEL" as const;
export const SEMANTIC_MODEL_DEFAULT = "openai/gpt-5.4-mini" as const;
// Bounded input: at most this many pairs per article (editor pairs first).
export const SEMANTIC_MAX_PAIRS = 24;
const MAX_TEXT_CHARS = 600;
// Bounded input: at most this many distinct texts across the sent pairs.
export const SEMANTIC_MAX_TEXTS = 40;
// Completion budget: per-pair verdicts only (id + bool + enum + one line).
export const SEMANTIC_MAX_TOKENS = 1200;
// Minimum support score for a writer/added pair to be checked at all.
export const SUPPORT_FLOOR = 4;
// A support sentence must have at least this many words to make a writer
// mismatch BLOCKING (a fact-box line is never blocking evidence).
export const PROSE_MIN_WORDS = 6;
// Minimum score for the source CONTEXT attached to an editor_changed pair. It
// is scored on the candidate + its writer counterpart(s) together (a merged or
// compressed sentence shares few words with the source on its own).
export const CONTEXT_FLOOR = 2;

/** The feature flag. DEFAULT FALSE: only an explicit "true"/"1" enables it. */
export function semanticCheckEnabled(getEnv: (k: string) => string | undefined): boolean {
  const v = (getEnv(SEMANTIC_FLAG_ENV) ?? "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/** The checker model (env override, else the default). */
export function semanticModel(getEnv: (k: string) => string | undefined): string {
  return (getEnv(SEMANTIC_MODEL_ENV) ?? "").trim() || SEMANTIC_MODEL_DEFAULT;
}

// --- Dimensions → codes ------------------------------------------------------
// The six comparison dimensions (one per compared field) and their codes.

export const SEMANTIC_DIMENSIONS = [
  "agent_subject",
  "scope_qualifier",
  "polarity_tense_status",
  "ratio_semantics",
  "material_noun",
  "attribution",
] as const;
export type SemanticDimension = (typeof SEMANTIC_DIMENSIONS)[number];

export const DIMENSION_CODE: Record<SemanticDimension, string> = {
  agent_subject: "semantic_subject_changed",
  scope_qualifier: "semantic_scope_changed",
  polarity_tense_status: "semantic_polarity_changed",
  ratio_semantics: "semantic_ratio_changed",
  material_noun: "semantic_material_changed",
  attribution: "semantic_attribution_changed",
};

/** Deterministic dimension → code mapping (stable order, deduped). */
export function semanticCodes(dims: readonly SemanticDimension[]): string[] {
  return SEMANTIC_DIMENSIONS.filter((d) => dims.includes(d)).map((d) => DIMENSION_CODE[d]);
}

// --- Sentences & tokens -------------------------------------------------------

/** Split into sentences: paragraphs, then a terminal . ! ? ؟ followed by space
 *  (so "82.2%" and "1.100" never split). */
export function splitSentences(text: string): string[] {
  return (text ?? "")
    .split(/\n\s*\n|\n/)
    .flatMap((p) => p.split(/(?<=[.!?؟])\s+/))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

const exactKey = (s: string) => normalizeForCompare(s);

function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}

// --- (a) writer ↔ editor sentence alignment -----------------------------------

export type SentenceAlignment = {
  // editor sentence index → the writer sentence indexes it derives from
  // (≥2 = a merge). Exact (normalized) matches are NOT listed — unchanged.
  pairs: { editor: number; writer: number[] }[];
  unchanged: { editor: number; writer: number }[];
  added: number[]; // editor sentences with no writer counterpart
  removed: number[]; // writer sentences not carried into any editor sentence
};

const PAIR_JACCARD = 0.3;
const MERGE_MIN_SHARED = 3;
const MERGE_MIN_NEW = 2;
const MERGE_MIN_COVERAGE = 0.45;
const SPLIT_MIN_CONTAINMENT = 0.6;

/**
 * Align editor sentences to writer sentences: (1) exact normalized matches are
 * removed as unchanged; (2) one-to-one greedy pairing by content-word Jaccard
 * ≥ 0.3; (3) merge detection — every still-unmatched writer sentence that shares
 * ≥3 content words with an editor sentence and adds ≥2 of its not-yet-covered
 * words is attached to it; an unpaired editor sentence whose attached writer
 * sentences cover ≥45% of its content words becomes a (possibly merged) pair;
 * (4) split detection — an editor sentence ≥60% contained in one writer
 * sentence pairs with it; (5) the rest are added / removed.
 */
export function alignSentences(writer: string[], editor: string[]): SentenceAlignment {
  const wTok = writer.map((s) => contentWordSet(s));
  const eTok = editor.map((s) => contentWordSet(s));
  const usedW = new Set<number>();
  const doneE = new Set<number>();
  const unchanged: { editor: number; writer: number }[] = [];
  editor.forEach((e, j) => {
    const i = writer.findIndex((w, k) => !usedW.has(k) && exactKey(w) === exactKey(e));
    if (i >= 0) {
      usedW.add(i);
      doneE.add(j);
      unchanged.push({ editor: j, writer: i });
    }
  });
  const groups = new Map<number, number[]>();
  const cands: { i: number; j: number; s: number }[] = [];
  writer.forEach((_, i) => {
    if (usedW.has(i)) return;
    editor.forEach((_, j) => {
      if (doneE.has(j)) return;
      const s = jaccardSets(wTok[i], eTok[j]);
      if (s >= PAIR_JACCARD) cands.push({ i, j, s });
    });
  });
  cands.sort((a, b) => b.s - a.s);
  for (const c of cands) {
    if (usedW.has(c.i) || groups.has(c.j)) continue;
    usedW.add(c.i);
    groups.set(c.j, [c.i]);
  }
  // Merge detection over every non-exact editor sentence.
  const covered = new Map<number, Set<string>>();
  editor.forEach((_, j) => {
    if (doneE.has(j)) return;
    const cov = new Set<string>();
    for (const i of groups.get(j) ?? []) for (const t of wTok[i]) if (eTok[j].has(t)) cov.add(t);
    covered.set(j, cov);
  });
  let progress = true;
  while (progress) {
    progress = false;
    let best: { i: number; j: number; gain: number } | null = null;
    writer.forEach((_, i) => {
      if (usedW.has(i)) return;
      for (const [j, cov] of covered) {
        let shared = 0;
        let gain = 0;
        for (const t of wTok[i]) {
          if (!eTok[j].has(t)) continue;
          shared++;
          if (!cov.has(t)) gain++;
        }
        if (shared >= MERGE_MIN_SHARED && gain >= MERGE_MIN_NEW && (!best || gain > best.gain)) best = { i, j, gain };
      }
    });
    if (best) {
      const { i, j } = best;
      usedW.add(i);
      groups.set(j, [...(groups.get(j) ?? []), i]);
      for (const t of wTok[i]) if (eTok[j].has(t)) covered.get(j)!.add(t);
      progress = true;
    }
  }
  const pairs: { editor: number; writer: number[] }[] = [];
  const added: number[] = [];
  editor.forEach((_, j) => {
    if (doneE.has(j)) return;
    const g = groups.get(j);
    const cov = covered.get(j)?.size ?? 0;
    const single = g && g.length === 1 && jaccardSets(wTok[g[0]], eTok[j]) >= PAIR_JACCARD;
    if (g && (single || cov / Math.max(1, eTok[j].size) >= MERGE_MIN_COVERAGE)) {
      pairs.push({ editor: j, writer: [...g].sort((a, b) => a - b) });
      return;
    }
    if (g) for (const i of g) usedW.delete(i);
    // Split detection: an editor sentence mostly contained in ONE writer
    // sentence (already used or not) is a split-off part of it, not an addition.
    let bestI = -1;
    let bestC = 0;
    writer.forEach((_, i) => {
      let shared = 0;
      for (const t of eTok[j]) if (wTok[i].has(t)) shared++;
      const c = shared / Math.max(1, eTok[j].size);
      if (shared >= MERGE_MIN_SHARED && c > bestC) {
        bestC = c;
        bestI = i;
      }
    });
    if (bestI >= 0 && bestC >= SPLIT_MIN_CONTAINMENT) {
      usedW.add(bestI);
      pairs.push({ editor: j, writer: [bestI] });
    } else {
      added.push(j);
    }
  });
  const removed = writer.map((_, i) => i).filter((i) => !usedW.has(i));
  return { pairs, unchanged, added, removed };
}

// --- (b)/(c) best-supporting source sentence(s) -------------------------------

// Cross-lingual alignment aid ONLY (English source ↔ Arabic draft): English
// word → normalized Arabic stems. It never decides meaning; it only helps pick
// which source sentence to show the checker.
const EN_AR_LEXICON: Record<string, string[]> = {
  camel: ["ابل", "جمال"], dromedary: ["ابل"], milk: ["حليب"], urine: ["بول"], raw: ["ني", "نيي"],
  meat: ["لحم"], cooked: ["مطهو"], undercooked: ["مطهو"], avoid: ["تجنب"], contact: ["مخالط", "تماس"],
  chronic: ["مزمن"], comorbiditie: ["مزمن"], comorbidity: ["مزمن"], condition: ["امراض", "حال"],
  disease: ["مرض", "امراض"], death: ["وفا", "وفيات"], mortality: ["وفيات"], child: ["طفل", "اطفال"],
  children: ["طفل", "اطفال"], vaccine: ["لقاح"], eligible: ["موهل"], year: ["سنوات", "عام", "اعوام"],
  four: ["اربع"], case: ["حالات", "حاله", "اصاب"], hospital: ["مستشفي"], hospitalized: ["مستشفي"],
  recall: ["سحب"], approval: ["موافق", "وافق"], approved: ["وافق"], registration: ["تسجيل"],
  designation: ["تعيين"], drug: ["دوا", "دواء"], medicine: ["دوا", "دواء"], patient: ["مرضي", "مريض"],
  women: ["نسا", "نساء"], cancer: ["سرطان"], study: ["دراس"], trial: ["تجرب"], risk: ["خطر"],
  severe: ["شديد", "خطير"], symptom: ["اعراض"], infection: ["عدوي", "اصاب"], outbreak: ["تفشي"],
  hygiene: ["نظاف"], product: ["منتجات", "منتج"], older: ["كبار", "مسن"], elderly: ["كبار", "مسن"],
  aged: ["عمر", "عاما"], age: ["عمر"], adult: ["بالغ"], dose: ["جرع"], tablet: ["اقراص"],
  injection: ["حقن"], test: ["فحص"], survival: ["نجا"], month: ["اشهر", "شهر"], week: ["اسبوع", "اسابيع"],
  ministry: ["وزار"], authority: ["هيي"], laboratory: ["مختبر"], facility: ["منشا", "مرافق"],
  aspirate: ["افرازات", "شفط"], tracheal: ["رغامي"], air: ["هوا"], exhaled: ["زفير", "خارج"],
  protein: ["بروتين"], biomarker: ["موشرات", "مؤشرات"], severity: ["شده"], preterm: ["خدج"],
  infant: ["خدج", "اطفال", "رضع"], averted: ["دون", "منع"], recommend: ["توصي", "اوصت", "ينصح"],
  transmission: ["انتقال", "ينتقل"], human: ["بشر"], virus: ["فيروس"], treatment: ["علاج"],
};

function englishLexKeys(sentence: string): string[] {
  const out = new Set<string>();
  for (const raw of (sentence ?? "").toLowerCase().match(/[a-z]+/g) ?? []) {
    for (const w of [raw, raw.replace(/s$/, ""), raw.replace(/es$/, ""), raw.replace(/ed$/, ""), raw.replace(/ing$/, "")]) {
      if (EN_AR_LEXICON[w]) {
        out.add(w);
        break;
      }
    }
  }
  return [...out];
}

function stemHit(tokens: string[], stem: string): boolean {
  return tokens.some((t) => t === stem || (stem.length >= 3 && t.includes(stem) && t.length - stem.length <= 4));
}

function numberValues(text: string): Set<string> {
  // Numbers by VALUE; single digits are too common to anchor on.
  return new Set(
    extractNumberEntries(text, "en", { decimalCommaFallback: true })
      .map((e) => e.value)
      .filter((v): v is string => v !== null && !/^\d$/.test(v)),
  );
}

function latinTokens(text: string): Set<string> {
  return new Set(((text ?? "").match(/[A-Za-z][A-Za-z0-9\-]{2,}/g) ?? []).map((t) => t.toLowerCase()));
}

/** Support score of `source` for `draft`: shared Arabic content words + English
 *  lexicon hits + 2 × shared numbers + 2 × shared Latin tokens. */
export function supportScore(draft: string, source: string): number {
  const dTok = contentWordSet(draft);
  const dArr = [...dTok];
  let score = 0;
  for (const t of contentWordSet(source)) if (dTok.has(t) && /[؀-ۿ]/.test(t)) score++;
  for (const k of englishLexKeys(source)) if (EN_AR_LEXICON[k].some((s) => stemHit(dArr, s))) score++;
  const dn = numberValues(draft);
  for (const v of numberValues(source)) if (dn.has(v)) score += 2;
  const dl = latinTokens(draft);
  for (const l of latinTokens(source)) if (dl.has(l)) score += 2;
  return score;
}


export type ScoredSupport = { sentence: string; score: number };

/** Up to `k` best-supporting source sentences scoring ≥ `floor`, best first. */
export function scoredSourceSupport(draft: string, sourceSentences: string[], k = 2, floor = SUPPORT_FLOOR): ScoredSupport[] {
  return sourceSentences
    .map((s, idx) => ({ sentence: s, idx, score: supportScore(draft, s) }))
    .filter((x) => x.score >= floor)
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, k)
    .map(({ sentence, score }) => ({ sentence, score }));
}

/** Up to `k` best-supporting source sentences (score ≥ SUPPORT_FLOOR). */
export function bestSourceSupport(draft: string, sourceSentences: string[], k = 2): string[] {
  return scoredSourceSupport(draft, sourceSentences, k).map((x) => x.sentence);
}

const wordCount = (s: string) => (s ?? "").trim().split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;

/** A prose sentence (≥ PROSE_MIN_WORDS words) — not a fact-box/label line. */
export function isProseSentence(s: string): boolean {
  return wordCount(s) >= PROSE_MIN_WORDS && !/^[^:]{1,40}\s*:\s*\S{1,20}$/.test((s ?? "").trim());
}

// --- (c) risk-class & risk/action sentences ------------------------------------

const n = (s: string) => normalizeForCompare(s);
const RATIO_RE = /بالمئه|في المئه|من كل|واحد(?:ه)? من|نسبه|اضعاف|ضعف/;
const SCOPE_RE = /عمر|عاما|اعوام|سنوات|فاكثر|فاقل|اطفال|الاطفال|بالغين|البالغين|حوامل|الحوامل|مرضعات|كبار السن|جرعه|جرعات|ملغ|مليغرام|ميكروغرام|الفيه|الفئه|فقط|لدي من|من لديهم/;
const STATUS_RE = /تعيين|تسجيل|موافقه|وافقت|وافق|سحب|اعتماد|اعتمدت|ترخيص|مرخص|حظر|ايقاف|تعليق/;
const RECO_RE = /توصي|اوصت|يوصي|ينصح|نصحت|يجب|ينبغي|تجنب|دعت|حذرت|يحذر|تحذر/;
const RISK_RE = /خطر|خطير|مضاعفات|وفاه|وفيات|تسمم|نزيف|عدوي|انسداد|تجلط/;

/** (c) A writer sentence whose meaning is high-stakes to get exactly right. */
export function isRiskClassSentence(s: string): boolean {
  const t = n(s);
  return /[%٪]/.test(s ?? "") || RATIO_RE.test(t) || SCOPE_RE.test(t) || STATUS_RE.test(t) || RECO_RE.test(t);
}

/** A risk/action sentence (a safety alert's warning or instruction): an
 *  official action, a recommendation verb, or risk vocabulary. */
export function isRiskActionSentence(s: string): boolean {
  const t = n(s);
  return extractOfficialActions(s).length > 0 || RECO_RE.test(t) || RISK_RE.test(t);
}

// --- Pair construction -----------------------------------------------------------

export type SemanticPairKind = "editor_changed" | "editor_added" | "writer_risk";
export type SemanticPair = {
  id: string;
  kind: SemanticPairKind;
  field: "title" | "excerpt" | "summary" | "body";
  candidate: string;
  // Writer counterpart(s) for editor_changed (plus the source context below);
  // source support for editor_added / writer_risk.
  reference: string[];
  // editor_changed only: the best source-support sentence (third context).
  sourceContext: string[];
  riskAction: boolean;
  // The best support sentence is prose (≥ PROSE_MIN_WORDS words).
  supportProse: boolean;
  candidateId: string;
  referenceIds: string[];
};

export type SemanticText = { id: string; text: string };

const clip = (s: string) => (s.length > MAX_TEXT_CHARS ? `${s.slice(0, MAX_TEXT_CHARS)}…` : s);

/**
 * Build the aligned pairs and the DISTINCT texts to extract for one article.
 * `edited` is null when no edit was accepted (then only writer risk pairs).
 */
export function buildSemanticPairs(input: {
  writer: EditorArticle;
  edited: EditorArticle | null;
  sourceText: string;
}): { pairs: SemanticPair[]; texts: SemanticText[]; truncated: number; unaligned: number; skipped_low_support: number } {
  const srcSents = splitSentences(input.sourceText);
  type Draft = Omit<SemanticPair, "id" | "candidateId" | "referenceIds">;
  const editorPairs: Draft[] = [];
  const addedPairs: Draft[] = [];
  const writerPairs: Draft[] = [];
  let unaligned = 0;
  let skippedLow = 0;
  const support = (s: string) => {
    const all = scoredSourceSupport(s, srcSents, 2, 1);
    const kept = all.filter((x) => x.score >= SUPPORT_FLOOR);
    if (!all.length) unaligned++;
    else if (!kept.length) skippedLow++;
    return kept;
  };
  const sameContent = (a: string, b: string) => {
    const A = contentWordSet(a);
    const B = contentWordSet(b);
    return A.size === B.size && [...A].every((t) => B.has(t));
  };
  const addVsSource = (field: SemanticPair["field"], s: string) => {
    const sup = support(s);
    if (!sup.length) return;
    addedPairs.push({
      kind: "editor_added", field, candidate: s, reference: sup.map((x) => x.sentence), sourceContext: [],
      riskAction: isRiskActionSentence(s), supportProse: isProseSentence(sup[0].sentence),
    });
  };
  const changed = (field: SemanticPair["field"], cand: string, refs: string[]) => {
    if (refs.length === 1 && sameContent(cand, refs[0])) return; // morphology/function words only
    const ctx = scoredSourceSupport([cand, ...refs].join(" "), srcSents, 1, CONTEXT_FLOOR).map((x) => x.sentence);
    editorPairs.push({
      kind: "editor_changed", field, candidate: cand, reference: refs, sourceContext: ctx,
      riskAction: isRiskActionSentence(cand), supportProse: ctx.length > 0 && isProseSentence(ctx[0]),
    });
  };

  if (input.edited) {
    const e = input.edited;
    const w = input.writer;
    for (const f of ["title", "excerpt", "summary"] as const) {
      const ev = (e[f] ?? "").trim();
      const wv = (w[f] ?? "").trim();
      if (!ev || exactKey(ev) === exactKey(wv)) continue;
      if (!wv) {
        for (const s of splitSentences(ev)) addVsSource(f, s);
        continue;
      }
      changed(f, ev, [wv]);
    }
    const ws = splitSentences(w.body);
    const es = splitSentences(e.body);
    const al = alignSentences(ws, es);
    for (const p of al.pairs) changed("body", es[p.editor], p.writer.map((i) => ws[i]));
    for (const j of al.added) addVsSource("body", es[j]);
  }

  for (const f of ["excerpt", "summary", "body"] as const) {
    for (const s of splitSentences(input.writer[f] ?? "")) {
      if (!isRiskClassSentence(s)) continue;
      const sup = support(s);
      if (!sup.length) continue;
      writerPairs.push({
        kind: "writer_risk", field: f, candidate: s, reference: sup.map((x) => x.sentence), sourceContext: [],
        riskAction: isRiskActionSentence(s), supportProse: isProseSentence(sup[0].sentence),
      });
    }
  }

  // Distinct texts (deduped), bounded; a pair is kept only if all its texts fit.
  const textIds = new Map<string, string>();
  const texts: SemanticText[] = [];
  const all = [...editorPairs, ...addedPairs, ...writerPairs];
  const pairs: SemanticPair[] = [];
  let truncated = 0;
  const seenPairs = new Set<string>();
  for (const d of all) {
    const needed = [d.candidate, ...d.reference, ...d.sourceContext].map(clip);
    const key = `${d.kind}|${needed.join("\u0001")}`;
    if (seenPairs.has(key)) continue; // duplicate pair (dedup)
    seenPairs.add(key);
    const fresh = [...new Set(needed.filter((t) => !textIds.has(t)))];
    if (pairs.length >= SEMANTIC_MAX_PAIRS || texts.length + fresh.length > SEMANTIC_MAX_TEXTS) {
      truncated++;
      continue;
    }
    for (const t of fresh) {
      const id = `t${texts.length + 1}`;
      textIds.set(t, id);
      texts.push({ id, text: t });
    }
    const [cid, ...rids] = needed.map((t) => textIds.get(t) as string);
    pairs.push({
      ...d,
      id: `p${pairs.length + 1}`,
      candidate: needed[0],
      reference: d.reference.map(clip),
      sourceContext: d.sourceContext.map(clip),
      candidateId: cid,
      referenceIds: rids,
    });
  }
  return { pairs, texts, truncated, unaligned, skipped_low_support: skippedLow };
}

// --- Judgment (one verdict per pair) -------------------------------------------

export const JUDGMENT_DIMENSIONS = [...SEMANTIC_DIMENSIONS, "none"] as const;
export type JudgmentDimension = (typeof JUDGMENT_DIMENSIONS)[number];

export const SEMANTIC_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "salma_semantic_judgment",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["results"],
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "materially_different", "dimension", "reason"],
            properties: {
              id: { type: "string" },
              materially_different: { type: "boolean" },
              dimension: { type: "string", enum: [...JUDGMENT_DIMENSIONS] },
              reason: { type: "string" },
            },
          },
        },
      },
    },
  },
} as const;

/** The question asked of every pair (verbatim in the prompt). */
export const JUDGMENT_QUESTION =
  "هل يفهم قارئ حريص من النص المرشح شيئاً مختلفاً مادياً عن المرجع في: من الفاعل الحقيقي، ماذا حدث لمن/لماذا، كم (بما فيه مقام النسبة)، متى/الحالة (منجز أم منتظر)، أي مادة/عينة؟";

/** HARD negative rules (learned from the s1/s2 acceptance runs), verbatim. */
export const JUDGMENT_NEGATIVE_RULES = [
  "الحذف أو الاختصار ليس اختلافاً: إذا قال المرشح أقلّ من المرجع فالجواب false.",
  "تغيّر الزمن أو صيغة الفعل ليس اختلافاً («قال» = «يقول»، «أعلنت» = «تعلن»، المبني للمجهول = المبني للمعلوم).",
  "الصياغة المختلفة المكافئة للفاعل ليست اختلافاً: «قالت الجهة إن X حدث» ≈ «حدث X»، والدولة ≈ سلطاتها الصحية، والجهة ≈ مختصرها أو اسمها الكامل.",
  "أسلوب النسبة ليس اختلافاً: «كشفت التفتيشات…» ≈ «قالت السلطات إن التفتيشات كشفت…»، ووجود النسبة أو غيابها ليس اختلافاً.",
  "التفصيل المضاف الذي يدعمه المصدر (المرجع أو سياق المصدر) ليس اختلافاً.",
  "قيود المكان يجوز أن تنتقل أو تُضاف أو تُحذف («في السعودية» في العنوان ليس اختلافاً).",
] as const;

// Six GENERIC calibration examples (synthesized; not taken from any story).
const JUDGMENT_EXAMPLES = `أمثلة معايرة:
1) المرجع: «جرى تجنّب وفاة واحدة من كل 8 وفيات بين الأطفال» | المرشح: «أنقذ اللقاح طفلاً واحداً من كل 8 أطفال» → true، ratio_semantics، «المقام تغيّر من الوفيات إلى الأطفال».
2) المرجع: «سيُعلن قرار التسجيل بعد استكمال التقييم» | المرشح: «سُجّل الدواء بعد استكمال التقييم» → true، polarity_tense_status، «قرار منتظر صار منجزاً».
3) المرجع: «قيست البروتينات في سائل مسحوب من القصبة الهوائية» | المرشح: «قيست البروتينات في هواء الزفير» → true، material_noun، «العينة تغيّرت من سائل إلى هواء».
4) المرجع: «قالت الوزارة إن الحملة انتهت» | المرشح: «انتهت الحملة» → false، none، «صياغة مكافئة للفاعل».
5) المرجع: «قيس البروتين في عينات الدم المأخوذة من البالغين المصابين خلال الأسبوع الأول» | المرشح: «قيس البروتين في الدم» → false، none، «اختصار».
6) المرجع: «أعلنت السلطات سحب الدفعة» | المرشح: «تسحب السلطات الدفعة في المملكة» (والمصدر يذكر المملكة) → false، none، «زمن الفعل ومكان يدعمه المصدر».`;

const SEMANTIC_SYSTEM_PROMPT = `أنت مدقّق أمانة المعنى في غرفة أخبار صحية عربية (${SEMANTIC_CHECK_VERSION}). لكل زوج: «المرشح» نص، و«المرجع» هو النص الذي يجب أن يطابقه معنىً (صياغة المحرّر الأصلية أو نص المصدر)، و«سياق المصدر» إن وُجد جملة من المصدر للاستئناس فقط.
السؤال لكل زوج: ${JUDGMENT_QUESTION}
قواعد صارمة — هذه ليست اختلافات أبداً:
${JUDGMENT_NEGATIVE_RULES.map((r) => `- ${r}`).join("\n")}
أجب true فقط إذا كان القارئ الحريص سيفهم واقعة مختلفة. dimension واحد من: agent_subject (الفاعل الحقيقي)، scope_qualifier (لمن/أيّ فئة أو شرط — ما عدا المكان)، ratio_semantics (كم، بما فيه مقام النسبة)، polarity_tense_status (منجز أم منتظر أم منفي)، material_noun (المادة/العينة)، attribution (من قال — فقط إذا انتقل القول إلى جهة أخرى). وإذا كان الجواب false فالبعد none.
${JUDGMENT_EXAMPLES}
أعد فقط {"results":[{"id":"…","materially_different":true|false,"dimension":"…","reason":"سطر واحد"}]} بنتيجة واحدة لكل id.`;

export function buildSemanticMessages(pairs: SemanticPair[]): { role: string; content: string }[] {
  const payload = pairs.map((p) => ({
    id: p.id,
    candidate: p.candidate,
    reference: p.reference,
    ...(p.sourceContext.length ? { source_context: p.sourceContext } : {}),
  }));
  return [
    { role: "system", content: SEMANTIC_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ pairs: payload }) },
  ];
}

export type SemanticJudgment = { id: string; materially_different: boolean; dimension: JudgmentDimension; reason: string };

/** Strict parser: one verdict per pair id, enum dimension, consistent
 *  (different ⇔ dimension ≠ none). Anything else is unparseable. */
export function parseSemanticOutput(
  content: string,
  ids: string[],
): { ok: true; results: SemanticJudgment[] } | { ok: false; error: string } {
  let text = (content ?? "").trim();
  const fence = text.match(/^```(?:json)?\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, error: "semantic_output_invalid_json" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "semantic_output_schema_invalid" };
  const o = obj as Record<string, unknown>;
  if (Object.keys(o).length !== 1 || !Array.isArray(o.results)) return { ok: false, error: "semantic_output_schema_invalid" };
  const want = new Set(ids);
  const seen = new Set<string>();
  const out: SemanticJudgment[] = [];
  for (const r of o.results as unknown[]) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, error: "semantic_output_schema_invalid" };
    const x = r as Record<string, unknown>;
    if (Object.keys(x).sort().join(",") !== "dimension,id,materially_different,reason") return { ok: false, error: "semantic_output_schema_invalid" };
    if (typeof x.id !== "string" || !want.has(x.id) || seen.has(x.id)) return { ok: false, error: "semantic_output_ids_mismatch" };
    if (typeof x.materially_different !== "boolean" || typeof x.reason !== "string") return { ok: false, error: "semantic_output_schema_invalid" };
    if (!(JUDGMENT_DIMENSIONS as readonly string[]).includes(x.dimension as string)) return { ok: false, error: "semantic_output_unknown_dimension" };
    if (x.materially_different === (x.dimension === "none")) return { ok: false, error: "semantic_output_inconsistent" };
    seen.add(x.id);
    out.push({ id: x.id, materially_different: x.materially_different, dimension: x.dimension as JudgmentDimension, reason: x.reason.slice(0, 200) });
  }
  if (seen.size !== want.size) return { ok: false, error: "semantic_output_ids_mismatch" };
  return { ok: true, results: out };
}

// --- Orchestration ---------------------------------------------------------------

export type SemanticCall = (
  messages: { role: string; content: string }[],
) => Promise<{ ok: true; content: string } | { ok: false; reason: string }>;

export type SemanticFinding = SemanticCheckAudit["findings"][number] & { riskAction: boolean; supportProse: boolean; details: string[] };
// (details = the model's one-line reason for the verdict)

export type SemanticResult = {
  status: "passed" | "mismatch" | "checker_failed";
  model: string | null;
  pairs_checked: number;
  pairs_truncated: number;
  unaligned: number;
  skipped_low_support: number;
  failure_reason: string | null;
  editor_findings: SemanticFinding[];
  writer_findings: SemanticFinding[];
};

/**
 * Run the checker for one article, or return null WITHOUT any call when the
 * flag is off. No pairs → "passed" without a call. A transport failure, a
 * thrown error or an unparseable output → "checker_failed" (fail-safe review).
 */
export async function maybeRunSemanticCheck(input: {
  enabled: boolean;
  model: string;
  writer: EditorArticle;
  edited: EditorArticle | null;
  sourceText: string;
  call: SemanticCall;
}): Promise<SemanticResult | null> {
  if (!input.enabled) return null;
  const built = buildSemanticPairs({ writer: input.writer, edited: input.edited, sourceText: input.sourceText });
  const base = {
    model: input.model,
    pairs_checked: built.pairs.length,
    pairs_truncated: built.truncated,
    unaligned: built.unaligned,
    skipped_low_support: built.skipped_low_support,
  };
  if (!built.pairs.length) {
    return { ...base, status: "passed", failure_reason: null, editor_findings: [], writer_findings: [] };
  }
  const fail = (reason: string): SemanticResult => ({ ...base, status: "checker_failed", failure_reason: reason, editor_findings: [], writer_findings: [] });
  let res: Awaited<ReturnType<SemanticCall>>;
  try {
    res = await input.call(buildSemanticMessages(built.pairs));
  } catch (e) {
    return fail(`semantic_call_threw:${e instanceof Error ? e.name : "error"}`);
  }
  if (!res.ok) return fail(`semantic_call_failed:${res.reason}`);
  const parsed = parseSemanticOutput(res.content, built.pairs.map((p) => p.id));
  if (!parsed.ok) return fail(parsed.error);
  const byId = new Map(parsed.results.map((x) => [x.id, x]));
  const editor_findings: SemanticFinding[] = [];
  const writer_findings: SemanticFinding[] = [];
  for (const p of built.pairs) {
    const v = byId.get(p.id)!;
    if (!v.materially_different || v.dimension === "none") continue;
    const f: SemanticFinding = {
      pair_id: p.id,
      kind: p.kind,
      field: p.field,
      codes: [DIMENSION_CODE[v.dimension]],
      candidate: p.candidate,
      reference: [...p.reference, ...p.sourceContext],
      riskAction: p.riskAction,
      supportProse: p.supportProse,
      details: [v.reason],
    };
    (p.kind === "writer_risk" ? writer_findings : editor_findings).push(f);
  }
  return {
    ...base,
    status: editor_findings.length || writer_findings.length ? "mismatch" : "passed",
    failure_reason: null,
    editor_findings,
    writer_findings,
  };
}

// --- Decision -------------------------------------------------------------------

/**
 * Apply a checker result to the editor pass (pure). Never upgrades a verdict:
 *  - editor pair difference on an ACCEPTED edit → revert to the writer draft
 *    (decision factual_rejected, the pairs quoted in audit reasons);
 *  - writer pair difference → needs_human_review; BLOCKING (returned in
 *    `blocking`, the pipeline rejects) only for a safety_alert risk/action
 *    sentence whose support is a prose sentence;
 *  - checker failure → needs_human_review (fail-safe);
 *  - null (flag off) → the pass is returned unchanged.
 */
export function applySemanticDecision(
  pass: EditorPassResult,
  original: { article: EditorArticle; readMinutes: number },
  result: SemanticResult | null,
  profile: WritingProfile,
): { pass: EditorPassResult; reviewRequired: boolean; blocking: string[] } {
  if (!result) return { pass, reviewRequired: false, blocking: [] };
  const audit = { ...pass.audit, reasons: [...pass.audit.reasons] };
  let article = pass.article;
  let readMinutes = pass.readMinutes;
  const quote = (f: SemanticFinding) =>
    `${f.codes.join("+")}:${f.field}:«${f.candidate}» ⟵ «${f.reference.join(" | ")}» [${f.details.join("; ")}]`;

  const reverted = result.editor_findings.length > 0 && audit.edited_draft_accepted;
  if (reverted) {
    const codes = [...new Set(result.editor_findings.flatMap((f) => f.codes))];
    article = original.article;
    readMinutes = original.readMinutes;
    audit.edited_draft_accepted = false;
    audit.final_draft_source = "original";
    audit.decision = "factual_rejected";
    audit.editor_rejection_reason = codes.join("|");
    audit.final_rejection_reason = codes.join("|");
    audit.final_editor_failure_reason = codes.join("|");
    for (const f of result.editor_findings) audit.reasons.push(`semantic_editor:${quote(f)}`);
  }
  for (const f of result.writer_findings) audit.reasons.push(`semantic_writer:${quote(f)}`);
  if (result.status === "checker_failed") audit.reasons.push(`semantic_check_failed:${result.failure_reason}`);

  const blocking =
    profile === "safety_alert"
      ? [...new Set(result.writer_findings.filter((f) => f.riskAction && f.supportProse).flatMap((f) => f.codes))]
      : [];
  const reviewRequired = reverted || result.writer_findings.length > 0 || result.status === "checker_failed";
  if (reviewRequired) {
    audit.editorial_verdict = "needs_human_review";
    audit.final_editorial_verdict = "needs_human_review";
  }
  audit.semantic_check = {
    status: result.status,
    model: result.model,
    pairs_checked: result.pairs_checked,
    pairs_truncated: result.pairs_truncated,
    unaligned: result.unaligned,
    failure_reason: result.failure_reason,
    editor_reverted: reverted,
    review_required: reviewRequired,
    blocking,
    findings: [...result.editor_findings, ...result.writer_findings].map((f) => ({
      pair_id: f.pair_id,
      kind: f.kind,
      field: f.field,
      codes: f.codes,
      candidate: f.candidate,
      reference: f.reference,
    })),
  };
  return { pass: { ...pass, article, readMinutes, audit }, reviewRequired, blocking };
}

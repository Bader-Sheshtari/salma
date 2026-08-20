// Salma AI cover-image generator — runs inside Supabase (Deno).
//
// An admin (from the content form) sends the article's title/excerpt/summary/
// category; this function asks OpenRouter for a few editorial cover options (one
// prompt per option, each with a different visual angle so they differ), uploads
// each to the public `media` bucket, and returns their URLs. Calling it again
// simply produces a fresh set (the "generate another set" flow).
//
// This endpoint spends real OpenRouter credit, so access is locked down in
// layers, ALL enforced before any paid call:
//   1. verify_jwt: true  — the Supabase gateway rejects any request without a
//      valid, signed user JWT before our code even runs.
//   2. authorizeAdmin()  — we re-verify the caller is a real user whose profile
//      role ∈ {admin, super_admin, owner} and is not disabled (the anon key is
//      explicitly rejected). Only privileged staff can generate.
//   3. strict input validation — body size, JSON, quality, count, title.
//   4. ATOMIC reservation (public.reserve_ai_image) — in one serialized
//      transaction it checks per-user + global rolling limits and inserts a
//      "reserved" usage row. Concurrent requests cannot bypass the caps because
//      the check + insert are serialized by an advisory lock. Only after the
//      reservation succeeds do we call OpenRouter; afterwards we mark the
//      reservation succeeded/failed with the ACTUAL image count.
// The OpenRouter key lives ONLY as a Supabase function secret, never in the
// browser or the Next.js env; all paid model access stays server-side.
//
// Required function secret: OPENROUTER_API_KEY.
// Optional models:  OPENROUTER_IMAGE_MODEL (fast override), IMAGE_MODEL_PREMIUM.
// Optional limits (integers, safe fallbacks if missing/invalid):
//   AI_IMAGE_MAX_REQUESTS_PER_MINUTE   (default 3, per user)
//   AI_IMAGE_MAX_IMAGES_PER_USER_24H   (default 20)
//   AI_IMAGE_MAX_IMAGES_GLOBAL_24H     (default 30)
//   AI_IMAGE_MAX_PREMIUM_GLOBAL_24H    (default 15)
//   AI_IMAGE_RESERVATION_TIMEOUT_SEC   (default 180, stale-reservation expiry)
// Raising a limit later = update the Supabase secret and redeploy env; no code
// change, no new migration, no frontend rebuild.
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Two quality tiers, both image-capable Gemini models that share the SAME
// OpenRouter chat-completions response shape (images in choices[].message.images):
//   - fast    (default): quick + cheap, a few seconds per image.
//   - premium (opt-in) : higher fidelity, slower + pricier per image.
// The edge function has a ~150s wall-clock cap, so premium is used with a small
// option count. The same OPENROUTER_API_KEY works for both (account-level key).
const IMAGE_MODEL_FAST =
  Deno.env.get("OPENROUTER_IMAGE_MODEL") || "google/gemini-2.5-flash-image";
const IMAGE_MODEL_PREMIUM =
  Deno.env.get("IMAGE_MODEL_PREMIUM") || "google/gemini-3-pro-image-preview";

type Quality = "fast" | "premium";

function modelFor(quality: Quality): string {
  return quality === "premium" ? IMAGE_MODEL_PREMIUM : IMAGE_MODEL_FAST;
}

// ---- Prompt -------------------------------------------------------------

// The article context available to the visual planner. Only text — never raw
// unbounded article dumps; `body` is truncated by the caller and again here.
type Brief = {
  title: string;
  originalTitle?: string;
  excerpt?: string;
  summary?: string;
  body?: string;
  category?: string;
  sourceName?: string;
  country?: string;
  // Whether the article already has a preserved ORIGINAL source image (a real
  // publisher photo). Lets the planner recommend using it when it is the
  // strongest, most credible editorial cover for a real-world-anchored story.
  hasSourceImage?: boolean;
};

// A structured ARTICLE-TO-IMAGE BRIEF for one cover concept. The planner must
// first extract the story's real discrete elements (entity / mechanism /
// condition / news event), then design a concept that visibly COMBINES at least
// two or three of them and passes a specificity gate — so the cover is
// unmistakably about THIS article, not a generic "medical mood". One brief per
// requested image; `concept_summary` + `interpretation_lens` accumulate as the
// regeneration "avoid history".
type Concept = {
  // Extracted real elements of the story (each "" only if genuinely absent).
  story_angle: string; // the core editorial news angle in one line
  primary_entity: string; // main named company/org/product/person (e.g. "Moderna")
  secondary_entity: string; // partner/second entity if any
  medical_mechanism: string; // technology/mechanism (e.g. "mRNA personalized vaccine")
  condition: string; // disease/condition (e.g. "melanoma / skin cancer")
  news_event_type: string; // trial result | approval | partnership | manufacturing | expansion | discovery | market reaction | ...
  // The designed concept, built from the elements above.
  primary_visual_subject: string; // the strongest truthful HERO subject
  secondary_visual_cue: string; // a supporting cue tying in another element
  people_needed: boolean;
  geographic_relevance: string; // "none" | "kuwait" | "gulf" | "global" | free text
  must_show: string[];
  must_avoid: string[];
  proposed_visual_direction: string; // 1-2 vivid renderable sentences
  // Which real elements this concept makes legible together (>= 2, ideally 3).
  elements_combined: string[];
  // Why this image is unmistakably about THIS article and would NOT fit many
  // unrelated health stories (the specificity gate's justification).
  specificity_rationale: string;
  // The distinct editorial interpretation this concept uses, so successive
  // generations explore a genuinely different reading (not a re-pose). E.g.
  // "entity+mechanism+condition" | "development/manufacturing/research" |
  // "clinical/personalized-treatment" | "business/science hybrid".
  interpretation_lens: string;
  concept_summary: string; // short (<=12 words) label
  // Editorial ASSET decision — which cover would be strongest and most truthful:
  //   "original_source" — the preserved publisher image is best (needs one to exist)
  //   "official_asset"  — a real image from an AUTHORITATIVE source tied to the
  //                       story (official company/hospital/person/product page)
  //   "generate"        — an AI editorial illustration is the best fit
  asset_recommendation: "original_source" | "official_asset" | "generate";
  asset_reason: string;
};

// Text models for the editorial-visual planning step (NOT image models). Fast
// uses a cheap, capable model; Premium a stronger one for richer art direction.
// Never a google/gemini text model (reserved rule); both env-overridable.
const PLANNER_MODEL_FAST =
  Deno.env.get("IMAGE_PLANNER_MODEL") || "openai/gpt-5.4-mini";
const PLANNER_MODEL_PREMIUM =
  Deno.env.get("IMAGE_PLANNER_MODEL_PREMIUM") || "anthropic/claude-sonnet-5";

function plannerModelFor(quality: Quality): string {
  return quality === "premium" ? PLANNER_MODEL_PREMIUM : PLANNER_MODEL_FAST;
}

// Generic clichés the cover must avoid UNLESS the article specifically calls for
// them. This is the anti-bias core: it removes the office/meeting/handshake/
// dishdasha/stock-healthcare defaults the old fixed template produced.
const GENERIC_AVOID = [
  "office meetings, conference rooms, boardrooms, executives around a table, business discussions, handshakes, signing ceremonies;",
  "people staring at laptops or phones; staged smiling doctors; a doctor holding a tablet or clipboard; posed thumbs-up;",
  "generic hospital corridors, generic waiting rooms, and meaningless healthcare backdrops;",
  "generic healthcare stock photography and stock clichés;",
  "generic blue futuristic 'healthcare technology' holograms, glowing circuit overlays, and generic AI-brain imagery;",
  "a company name or logo floating alone as the WHOLE cover with no editorial scene (it may appear as a supporting element, not the entire image);",
  "Gulf/Kuwaiti clothing (dishdasha/thobe/abaya) or Gulf-styled people added for decoration when the story does not involve them;",
  "plastic, waxy or artificial-looking people; duplicated or distorted faces and hands;",
  "gibberish/garbled text, a fabricated exact brand logo, a fake branded product, invented numbers/statistics/charts, captions or watermarks (a short, correctly-spelled entity name as clean editorial typography is fine when it strengthens the cover);",
  "blurry, low-detail, low-resolution or noisy rendering.",
].join(" ");

// Medical/news responsibility + editorial-honesty guardrails (every image).
const HONESTY = [
  "Editorial honesty: this is an illustrative editorial/conceptual cover, NOT documentary evidence.",
  "Do NOT INVENT identity: no fabricated exact brand logo, no fake branded product, and no fake photograph or generated face of a specific real named person; do NOT stage a fake documentary photo of a real meeting/doctor/executive; do NOT fabricate clinical results, charts, numbers or statistics. (A recognizable real-world entity CONTEXT and a short correctly-spelled entity name are allowed; verified REAL logos/photos come from the editor's source-aware asset workflow, not from generation.)",
  "Do NOT show identifiable patients, real illness or injury, blood, gore, wounds, or graphic clinical/surgical content, and do NOT imply a diagnosis, treatment claim or outcome the article does not state.",
  "Keep it realistic, credible and calm — never alarmist, sensational or fear-based.",
].join(" ");

const FAST_RENDER =
  "Look and feel: credible editorial photography / clean conceptual visualization with natural, believable light and realistic materials; crisp and high-resolution; 16:9 landscape.";

// Premium adds genuine art direction — not more fantasy, better editorial thinking.
const PREMIUM_RENDER = [
  "Art direction (premium editorial): compose like a cover for a high-end health/science publication.",
  "Use a sophisticated, intentional composition with a clear visual hierarchy and a single strong focal idea; build real depth with distinct foreground/midground/background; rich authentic texture and material detail; cinematic, directional natural light.",
  "Interpret the story ambitiously through the real subject, scale, and conceptual visualization — striking but truthful, never surreal decoration or false medical claims.",
  "Crisp, high-resolution, gallery-grade rendering; 16:9 landscape; far fewer AI clichés than typical generations.",
].join(" ");

/** Build the image prompt from ONE planned concept. The scene is driven by the
 * article-specific concept, not a fixed template. People appear only when the
 * concept says they are needed; Gulf styling only when geographically relevant. */
function buildImagePrompt(c: Concept, quality: Quality): string {
  const geo = (c.geographic_relevance || "").toLowerCase();
  const gulfRelevant = /kuwait|gulf|khalij|خليج|الكويت/.test(geo);
  const people = c.people_needed
    ? [
        "People may appear ONLY as needed to tell this specific story; keep them natural, candid and modest, never posed stock models.",
        gulfRelevant
          ? "Since the story is set in Kuwait/the Gulf, any people and setting may reflect that context modestly and respectfully."
          : "Do NOT add Gulf/Arab clothing or region-specific styling unless the concept requires it.",
      ].join(" ")
    : "Do NOT include any people — focus entirely on the real subject described above (the object/mechanism/environment/technology). Do not invent people because they are convenient.";

  // The real story elements this cover must make legible TOGETHER — the anti-
  // genericness core. A cover that renders only one weak clue is not acceptable.
  const elements = [
    c.primary_entity ? `entity/company: ${c.primary_entity}` : "",
    c.secondary_entity ? `second entity: ${c.secondary_entity}` : "",
    c.medical_mechanism ? `mechanism/technology: ${c.medical_mechanism}` : "",
    c.condition ? `condition/disease: ${c.condition}` : "",
    c.news_event_type ? `news event: ${c.news_event_type}` : "",
  ].filter(Boolean).join("; ");

  return [
    "Editorial cover image for an Arabic health-news article. It must be UNMISTAKABLY about THIS specific story — an editor should instantly say 'yes, this is that article' — never a generic health or medical mood that could fit many unrelated stories.",
    `Story angle: ${c.story_angle}.`,
    elements ? `Make legible the strongest 2-3 of these real story anchors (chosen for this concept — do NOT cram in every element; keep the composition clean and uncluttered): ${elements}.` : "",
    `Hero subject: ${c.primary_visual_subject}.`,
    c.secondary_visual_cue ? `Supporting cue (secondary, must not dominate): ${c.secondary_visual_cue}.` : "",
    `Visual direction: ${c.proposed_visual_direction}.`,
    c.primary_entity
      ? `Keep the identity of ${c.primary_entity} recognizable through its real-world context (its research/manufacturing/product/clinical setting); a short, correctly-spelled "${c.primary_entity}" may appear as tasteful editorial typography if it strengthens the cover. Do NOT invent a fake exact logo or branded product, and do NOT depict a specific real person's face.`
      : "",
    c.must_show.length ? `Must show: ${c.must_show.join("; ")}.` : "",
    c.must_avoid.length ? `For this story specifically, avoid: ${c.must_avoid.join("; ")}.` : "",
    // Hard anti-generic rule tuned to the reported failure mode.
    "Do NOT reduce the cover to a single weak clue (e.g. a bare skin/shoulder close-up for a cancer story, an unlabelled vial, a lone doctor, or an anonymous body part). If a body part or object is used, it must be combined with the entity/mechanism context so the specific story is clear.",
    people,
    quality === "premium" ? PREMIUM_RENDER : FAST_RENDER,
    HONESTY,
    `Avoid entirely (generic clichés): ${GENERIC_AVOID}`,
  ]
    .filter(Boolean)
    .join(" ");
}

// ---- Editorial visual planner (text-only step) --------------------------

function truncate(s: string | undefined, n: number): string {
  const t = (s ?? "").trim();
  return t.length > n ? t.slice(0, n) : t;
}

/** System prompt: Salma's editorial visual director. Produces STRICT-JSON
 * concepts grounded in what actually happened, with people as a decision (not a
 * default) and generic clichés explicitly discouraged. */
function plannerSystem(quality: Quality): string {
  return [
    "You are the editorial visual director for «سلمى», an independent Arabic health-news publication.",
    "Your job: design THE SINGLE STRONGEST editorial COVER for a SPECIFIC article — the way a top photo editor picks a magazine cover. A merely attractive 'medical-looking' image is a FAILURE. The cover must be unmistakably about THIS article.",

    // STEP 1 — read the article and EXTRACT its real discrete elements.
    "STEP 1 — Read the article closely and extract its REAL elements: story_angle (the core news angle), primary_entity (the main named company/organization/product/person, e.g. 'Moderna'), secondary_entity (partner/second entity, if any), medical_mechanism (the technology/mechanism, e.g. 'mRNA personalized cancer vaccine'), condition (the disease/condition, e.g. 'melanoma / skin cancer'), and news_event_type (e.g. trial result, approval, partnership, manufacturing, expansion, discovery, market reaction). Fill each field from the article; use \"\" ONLY if the element is genuinely absent. Do not invent elements.",

    // STEP 2 — combine the STRONGEST 2-3 anchors (specificity WITHOUT clutter).
    "STEP 2 — Choose the STRONGEST TWO OR THREE anchors from those elements for THIS concept (NOT all of them) and make just those legible together in one coherent, uncluttered image; list the chosen ones in elements_combined. The purpose is specificity, not cramming every entity/fact into one frame. A concept resting on only ONE weak clue is REJECTED (e.g. a bare shoulder/skin close-up for a skin-cancer story shows only the condition and misses the company and the mechanism) — but equally, do NOT overload the cover with every element at once.",

    // STEP 3 — the specificity gate.
    "STEP 3 — SPECIFICITY GATE: ask 'could this exact image plausibly illustrate many unrelated health stories?' If yes, it FAILS — redesign it to be more specific. In specificity_rationale, state in one line WHY this cover is unmistakably about THIS article (name the 2-3 anchors it renders). If the story is specifically about, say, Moderna, the cover must NOT look like it could equally be Pfizer, AstraZeneca or an anonymous biotech.",

    // Named entities → KEEP identity recognizable; invent nothing.
    "When the article names a company/product/hospital/person that is CENTRAL to the news, KEEP that identity recognizable — do not reduce the cover to an anonymous lab/factory merely to avoid branding. Allowed for a GENERATED image: the entity's real-world CONTEXT (its kind of research/manufacturing/product/clinical setting), and a short correctly-spelled entity NAME used tastefully as editorial typography (a supporting element, not garbled text). PROHIBITED: inventing a fake exact logo, a fake branded product, or a fake photo/generated face of a specific real named person. (A VERIFIED real logo or real person photo may be used — but only via the editor's separate source-aware asset workflow, never fabricated here.)",
    "If the story is a company + a medical innovation, tie company identity to the scientific/medical mechanism and its clinical meaning — but pick the best 2-3 anchors, don't force all in. A market/business angle is a SECONDARY cue only, never dominating unless the article is primarily a business story.",

    // People: a decision, not a reflex.
    "People are a DECISION, not a reflex. Use a dignified, generic human moment when the human stake IS the story; otherwise depict the real subject/mechanism/environment with no people. Never a specific identifiable individual.",
    "Never propose as the hero: random patient body-part close-ups (shoulders, skin, hands) with no story-specific grounding, generic doctors in conversation, generic lab scenes with no article-specific anchor, office meetings, conference rooms, handshakes, people at laptops, staged doctors, meaningless hospital corridors, generic healthcare stock, blue futuristic holograms or AI-brain imagery, or a logo as the main subject.",
    "Do not add Gulf/Kuwaiti clothing or region-specific people as decoration; regional context matters only when the story is actually about a place/people.",
    "Editorial honesty: concepts are illustrative/conceptual, never fake documentary evidence — no specific real named person, no staged fake events, no fabricated clinical results.",

    // Distinct interpretation per generation (successive-generation policy).
    "interpretation_lens: name the ONE editorial reading this concept uses, chosen from (but not limited to): 'entity+mechanism+condition', 'development/manufacturing/research environment', 'clinical/personalized-treatment', 'business/science hybrid'. If prior concepts are listed to avoid, you MUST choose a DIFFERENT lens and a different hero subject — a genuinely different valid interpretation of the SAME article, not a re-pose or a minor composition change. Every lens must still stay faithful to the extracted elements.",

    // Asset decision (unchanged intent).
    "ASSET DECISION — for asset_recommendation choose the strongest, most truthful cover: 'original_source' (the preserved publisher image is best; only if one exists); 'official_asset' (a REAL image from an authoritative source tied to the story would be strongest — name the likely source in asset_reason); or 'generate' (an AI editorial illustration is the best fit). Always still design a full generated concept as the alternative.",

    quality === "premium"
      ? "This is a PREMIUM cover: more ambitious and original — sophisticated composition, real-world specificity, layered conceptual visualization and clear visual hierarchy that fuse entity + mechanism + condition — striking but always truthful."
      : "This is a FAST cover: one strong, SPECIFIC, story-true direction that combines the real elements; efficient but never generic.",

    "Return STRICT JSON only, matching exactly: {\"concepts\":[{\"story_angle\":string,\"primary_entity\":string,\"secondary_entity\":string,\"medical_mechanism\":string,\"condition\":string,\"news_event_type\":string,\"primary_visual_subject\":string,\"secondary_visual_cue\":string,\"people_needed\":boolean,\"geographic_relevance\":string,\"must_show\":string[],\"must_avoid\":string[],\"proposed_visual_direction\":string,\"elements_combined\":string[],\"specificity_rationale\":string,\"interpretation_lens\":string,\"concept_summary\":string,\"asset_recommendation\":\"original_source\"|\"official_asset\"|\"generate\",\"asset_reason\":string}]}.",
    "concept_summary is a short (<=12 words) label. proposed_visual_direction is 1-2 vivid sentences an image model can render.",
  ].join(" ");
}

function plannerUser(brief: Brief, count: number, avoid: string[]): string {
  const parts = [
    brief.title ? `Arabic title: ${brief.title}` : "",
    brief.originalTitle ? `Original/source title: ${brief.originalTitle}` : "",
    brief.summary ? `Summary: ${brief.summary}` : "",
    brief.excerpt ? `Excerpt: ${brief.excerpt}` : "",
    brief.body ? `Article body (may be truncated): ${brief.body}` : "",
    brief.category ? `Category: ${brief.category}` : "",
    brief.sourceName ? `Original source/publisher: ${brief.sourceName}` : "",
    brief.country ? `Geographic context from the story: ${brief.country}` : "",
    brief.hasSourceImage
      ? "An ORIGINAL source (publisher) image IS available — you MAY set asset_recommendation='original_source' if it is the strongest, most credible cover."
      : "No original source image is available — do NOT set asset_recommendation='original_source'.",
  ].filter(Boolean);
  const avoidLine = avoid.length
    ? `\n\nAlready-used concepts to AVOID (each begins with its [interpretation_lens]). You MUST choose an interpretation_lens NOT already listed here AND a different hero subject — a genuinely different valid reading of the SAME article, never a re-pose or minor re-composition, still faithful to the same extracted elements: ${avoid.map((a) => `“${a}”`).join(", ")}.`
    : "";
  return (
    `Design ${count} DISTINCT cover concept${count > 1 ? "s" : ""} for this article. ` +
    (count > 1
      ? "Each concept must use a DIFFERENT interpretation_lens and a different hero subject (not variations of one idea). "
      : "") +
    "First extract the real elements, then combine at least two or three of them, then pass the specificity gate.\n\n" +
    parts.join("\n") +
    avoidLine
  );
}

/** Parse the planner's JSON (tolerating code fences / prose) into Concepts. */
function parseConcepts(text: string): Concept[] {
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  const obj = JSON.parse(s) as { concepts?: unknown };
  const arr = Array.isArray(obj?.concepts) ? obj.concepts : [];
  return arr.map((raw) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const strArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 8) : [];
    return {
      story_angle: String(c.story_angle ?? "").slice(0, 300),
      primary_entity: String(c.primary_entity ?? "").slice(0, 160),
      secondary_entity: String(c.secondary_entity ?? "").slice(0, 160),
      medical_mechanism: String(c.medical_mechanism ?? "").slice(0, 200),
      condition: String(c.condition ?? "").slice(0, 160),
      news_event_type: String(c.news_event_type ?? "").slice(0, 120),
      primary_visual_subject: String(c.primary_visual_subject ?? c.real_world_subject ?? "").slice(0, 300),
      secondary_visual_cue: String(c.secondary_visual_cue ?? "").slice(0, 300),
      people_needed: c.people_needed === true,
      geographic_relevance: String(c.geographic_relevance ?? "none").slice(0, 60),
      must_show: strArr(c.must_show),
      must_avoid: strArr(c.must_avoid),
      proposed_visual_direction: String(c.proposed_visual_direction ?? "").slice(0, 500),
      elements_combined: strArr(c.elements_combined),
      specificity_rationale: String(c.specificity_rationale ?? "").slice(0, 300),
      interpretation_lens: String(c.interpretation_lens ?? "").slice(0, 80),
      concept_summary: String(c.concept_summary ?? "").slice(0, 120),
      asset_recommendation:
        c.asset_recommendation === "original_source" || c.asset_recommendation === "official_asset"
          ? c.asset_recommendation
          : "generate",
      asset_reason: String(c.asset_reason ?? "").slice(0, 200),
    };
  });
}

/** Deterministic fallback concepts if the planner call/parse fails, so image
 * generation still proceeds with anti-generic guardrails (never a hard failure).
 * Grounded in the title/summary; varies direction per index for a multi set. */
function fallbackConcepts(brief: Brief, count: number): Concept[] {
  const base = brief.summary || brief.excerpt || brief.title || "the article's topic";
  const lenses = [
    { lens: "entity+mechanism+condition", dir: "an editorial visualization that ties together the article's main entity, its medical mechanism, and the specific condition it addresses, in one coherent composition" },
    { lens: "development/manufacturing/research environment", dir: "the specific research or manufacturing environment behind this development, rendered with real material detail tied to the article's mechanism" },
    { lens: "clinical/personalized-treatment", dir: "the clinical or personalized-treatment meaning of this development for the specific condition in the article" },
  ];
  return Array.from({ length: count }, (_, i) => {
    const L = lenses[i % lenses.length];
    return {
      story_angle: base.slice(0, 300),
      primary_entity: "",
      secondary_entity: "",
      medical_mechanism: "",
      condition: "",
      news_event_type: "",
      primary_visual_subject: "the specific real subject, entity context and mechanism at the center of THIS article (never a generic health scene or a lone body part)",
      secondary_visual_cue: "",
      people_needed: false,
      geographic_relevance: "none",
      must_show: [],
      must_avoid: [],
      proposed_visual_direction: L.dir,
      elements_combined: [],
      specificity_rationale: "grounded in the article's own subject and mechanism, not a generic medical mood",
      interpretation_lens: L.lens,
      concept_summary: (brief.title ?? base).slice(0, 80),
      asset_recommendation: "generate",
      asset_reason: "",
    };
  });
}

/** Run the text-only planner: one call → `count` distinct concepts. Falls back
 * to deterministic concepts on any failure so the image step always proceeds. */
async function planConcepts(
  apiKey: string,
  quality: Quality,
  brief: Brief,
  count: number,
  avoid: string[],
): Promise<Concept[]> {
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
        model: plannerModelFor(quality),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: plannerSystem(quality) },
          { role: "user", content: plannerUser(brief, count, avoid) },
        ],
      }),
    });
    if (!res.ok) return fallbackConcepts(brief, count);
    const data = await res.json().catch(() => null);
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) return fallbackConcepts(brief, count);
    const concepts = parseConcepts(text).filter((c) => c.proposed_visual_direction || c.primary_visual_subject);
    if (concepts.length === 0) return fallbackConcepts(brief, count);
    // Pad (or trim) to exactly `count` so we generate the requested number.
    while (concepts.length < count) concepts.push(...fallbackConcepts(brief, count - concepts.length));
    return concepts.slice(0, count);
  } catch {
    return fallbackConcepts(brief, count);
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** One prompt → one uploaded image. Returns a public URL, or a reason string on
 * failure. Called once per option; the handler runs several in parallel. */
async function generateOne(
  apiKey: string,
  admin: SupabaseClient,
  model: string,
  prompt: string,
): Promise<{ url: string } | { reason: string; status?: number }> {
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://salma.health",
        "X-Title": "Salma",
      },
      body: JSON.stringify({
        model,
        modalities: ["image", "text"],
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return { reason: "connect" };
  }

  if (!res.ok) return { reason: "openrouter", status: res.status };

  const data = await res.json().catch(() => null);
  const dataUrl: string | undefined = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return { reason: "no_image" };

  const parsed = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
  if (!parsed) return { reason: "bad_format" };
  const contentType = parsed[1];
  const bytes = base64ToBytes(parsed[2]);
  const ext = (contentType.split("/")[1] || "png").replace("jpeg", "jpg");

  const now = new Date();
  const path = `ai/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;

  const { error: upErr } = await admin.storage.from("media").upload(path, bytes, {
    contentType,
    cacheControl: "3600",
    upsert: false,
  });
  if (upErr) return { reason: "upload" };

  const { data: pub } = admin.storage.from("media").getPublicUrl(path);
  return { url: pub.publicUrl };
}

// ---- Auth + HTTP entrypoint --------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Verify the caller is a real, enabled admin user and return their id (used to
// scope rate limiting). Returns null for anyone who isn't authorized.
async function authorizeAdmin(
  req: Request,
  admin: SupabaseClient,
): Promise<{ userId: string } | null> {
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
  const ok =
    !!profile &&
    ["admin", "super_admin", "owner"].includes(profile.role) &&
    !profile.disabled;
  return ok ? { userId: user.id } : null;
}

// ---- Configurable usage limits -----------------------------------------
// Read from Supabase secrets with SAFE fallbacks. A missing / non-integer /
// zero-or-negative value falls back to the documented default rather than
// disabling the protection. Never sent to the browser.
function intEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback; // invalid => safe default
  return n;
}

type Limits = {
  maxRequestsPerMinute: number;
  maxImagesPerUser24h: number;
  maxImagesGlobal24h: number;
  maxPremiumGlobal24h: number;
  reservationTimeoutSec: number;
};

function readLimits(): Limits {
  return {
    maxRequestsPerMinute: intEnv("AI_IMAGE_MAX_REQUESTS_PER_MINUTE", 3),
    maxImagesPerUser24h: intEnv("AI_IMAGE_MAX_IMAGES_PER_USER_24H", 20),
    maxImagesGlobal24h: intEnv("AI_IMAGE_MAX_IMAGES_GLOBAL_24H", 30),
    maxPremiumGlobal24h: intEnv("AI_IMAGE_MAX_PREMIUM_GLOBAL_24H", 15),
    reservationTimeoutSec: intEnv("AI_IMAGE_RESERVATION_TIMEOUT_SEC", 180),
  };
}

// ---- Atomic reservation (DB-backed) ------------------------------------
// The check + insert happen inside public.reserve_ai_image under an advisory
// lock, so simultaneous requests cannot each pass a limit before any usage row
// exists. Fail-CLOSED: an RPC error rejects rather than risk unmetered spend.
type Reservation = { ok: true; id: number } | { ok: false; reason: string };

async function reserveImages(
  admin: SupabaseClient,
  userId: string,
  quality: Quality,
  requested: number,
  limits: Limits,
): Promise<Reservation> {
  const { data, error } = await admin.rpc("reserve_ai_image", {
    p_user_id: userId,
    p_quality: quality,
    p_requested: requested,
    p_max_req_per_min: limits.maxRequestsPerMinute,
    p_max_images_user_24h: limits.maxImagesPerUser24h,
    p_max_images_global_24h: limits.maxImagesGlobal24h,
    p_max_premium_global_24h: limits.maxPremiumGlobal24h,
    p_stale_seconds: limits.reservationTimeoutSec,
  });
  if (error) return { ok: false, reason: "reservation_failed" }; // fail closed
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.allowed !== true || typeof row.reservation_id !== "number") {
    return { ok: false, reason: String(row?.reason ?? "rate_limited") };
  }
  return { ok: true, id: row.reservation_id };
}

/** Mark a reservation succeeded (with the ACTUAL image count) or failed. Best
 * effort: never throws into the request path. */
async function completeReservation(
  admin: SupabaseClient,
  reservationId: number,
  userId: string,
  status: "succeeded" | "failed",
  actual: number,
  failureReason: string | null,
): Promise<void> {
  await admin
    .rpc("complete_ai_image", {
      p_reservation_id: reservationId,
      p_user_id: userId,
      p_status: status,
      p_actual: status === "succeeded" ? actual : 0,
      p_failure_reason: failureReason ? failureReason.slice(0, 200) : null,
    })
    .then(
      () => {},
      () => {},
    );
}

// ---- Request body limits ------------------------------------------------
// Raised to accommodate a truncated article body + a small avoid-history so the
// planner can understand the story; still bounded against abuse.
const MAX_BODY_BYTES = 48_000; // reject oversized payloads outright
const FIELD_MAX: Record<string, number> = {
  title: 300,
  original_title: 300,
  excerpt: 2000,
  summary: 2000,
  body: 6000,
  category: 120,
  source_name: 160,
  country: 120,
};

function field(body: Record<string, unknown>, key: keyof typeof FIELD_MAX): string {
  return String(body?.[key] ?? "").trim().slice(0, FIELD_MAX[key]);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const auth = await authorizeAdmin(req, admin);
  if (!auth) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // ---- Strict server-side input validation ----
  // Reject oversized bodies before parsing (cheap DoS / abuse guard).
  const declaredLen = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return Response.json({ ok: false, reason: "too_large" }, { status: 413 });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ ok: false, reason: "too_large" }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, reason: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ ok: false, reason: "bad_request" }, { status: 400 });
  }

  const title = field(body, "title");
  const originalTitle = field(body, "original_title");
  const excerpt = field(body, "excerpt");
  const summary = field(body, "summary");
  const bodyText = field(body, "body");
  const category = field(body, "category");
  const sourceName = field(body, "source_name");
  const country = field(body, "country");
  const hasSourceImage = (body as { has_source_image?: unknown })?.has_source_image === true;

  // Regeneration diversity: concise concept summaries already generated in this
  // editor session; the planner is told to explore materially different ideas.
  const avoidConcepts: string[] = Array.isArray((body as { avoid_concepts?: unknown })?.avoid_concepts)
    ? ((body as { avoid_concepts: unknown[] }).avoid_concepts)
        .map((x) => String(x ?? "").trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 12)
    : [];

  // quality: exactly one mode. Absent => "fast" (backward-compatible);
  // present-but-invalid => reject.
  let quality: Quality = "fast";
  if (body?.quality !== undefined) {
    if (body.quality !== "fast" && body.quality !== "premium") {
      return Response.json({ ok: false, reason: "bad_quality" }, { status: 400 });
    }
    quality = body.quality;
  }

  // count: default 1 for BOTH modes. Must be an integer restricted to 1, 2 or 3;
  // malformed (non-integer / NaN) or out-of-range values are rejected.
  let count = 1;
  if (body?.count !== undefined) {
    const n = Number(body.count);
    if (!Number.isInteger(n) || n < 1 || n > 3) {
      return Response.json({ ok: false, reason: "bad_count" }, { status: 400 });
    }
    count = n;
  }

  if (title.length < 4) {
    return Response.json({ ok: false, reason: "no_title" });
  }

  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    return Response.json({ ok: false, error: "OPENROUTER_API_KEY is not set" }, { status: 500 });
  }

  // ---- Atomic reservation BEFORE spending any credit ----
  const limits = readLimits();
  const reservation = await reserveImages(admin, auth.userId, quality, count, limits);
  if (!reservation.ok) {
    const status = reservation.reason === "reservation_failed" ? 503 : 429;
    return Response.json({ ok: false, reason: reservation.reason }, { status });
  }

  const brief: Brief = {
    title,
    originalTitle,
    excerpt,
    summary,
    body: truncate(bodyText, FIELD_MAX.body),
    category,
    sourceName,
    country,
    hasSourceImage,
  };
  const model = modelFor(quality);

  // STEP 1 (text-only): the editorial visual director understands the story and
  // designs `count` DISTINCT article-specific concepts, avoiding already-used
  // ones. One planner call regardless of count → no wasteful hidden loops.
  const concepts = await planConcepts(apiKey, quality, brief, count, avoidConcepts);

  // STEP 2: one image per concept (each a genuinely different visual direction),
  // run in parallel so total latency stays close to a single image.
  let attempts: Array<({ url: string } & { concept: Concept }) | { reason: string; status?: number }>;
  try {
    attempts = await Promise.all(
      concepts.map((c) =>
        generateOne(apiKey, admin, model, buildImagePrompt(c, quality)).then((r) =>
          "url" in r ? { ...r, concept: c } : r,
        ),
      ),
    );
  } catch {
    // Unexpected failure: release the reservation so it never blocks the user.
    await completeReservation(admin, reservation.id, auth.userId, "failed", 0, "unexpected");
    return Response.json({ ok: false, reason: "no_image" });
  }

  const candidates = attempts.flatMap((a) =>
    "url" in a
      ? [{
          url: a.url,
          // Tag the summary with its interpretation lens so the accumulated
          // avoid-history (fed back on the next click) drives lens rotation —
          // each new generation explores a genuinely different editorial reading.
          concept_summary:
            (a.concept.interpretation_lens ? `[${a.concept.interpretation_lens}] ` : "") + a.concept.concept_summary,
          mode: quality,
        }]
      : [],
  );
  if (candidates.length === 0) {
    // Surface the first failure reason; mark the reservation failed (0 images).
    const firstFail = attempts.find((a) => "reason" in a) as
      | { reason: string; status?: number }
      | undefined;
    await completeReservation(admin, reservation.id, auth.userId, "failed", 0, firstFail?.reason ?? "no_image");
    return Response.json({ ok: false, reason: firstFail?.reason ?? "no_image", status: firstFail?.status });
  }

  // Meter only the images we actually produced.
  await completeReservation(admin, reservation.id, auth.userId, "succeeded", candidates.length, null);
  const urls = candidates.map((c) => c.url);

  // Editorial asset decision (non-binding hint): does a REAL image beat an AI
  // one for this story? Prefer the first concept's decision; downgrade an
  // 'original_source' recommendation to 'generate' when no source image exists.
  const primary = concepts[0];
  let decision: Concept["asset_recommendation"] = primary?.asset_recommendation ?? "generate";
  if (decision === "original_source" && !hasSourceImage) decision = "generate";
  const recommendation = { decision, reason: primary?.asset_reason ?? "" };

  // `candidates` carries per-image concept metadata; `urls`/`url` stay for
  // backward-compatible callers.
  return Response.json({ ok: true, candidates, urls, url: urls[0], recommendation });
});

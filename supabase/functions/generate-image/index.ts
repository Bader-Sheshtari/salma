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

// One planned editorial cover concept, grounded in what actually happened in the
// article. The planner returns one per requested image; `concept_summary` is the
// short line accumulated as regeneration "avoid history".
type Concept = {
  story_type: string;
  what_happened: string;
  core_visual_fact: string;
  key_entities: string[];
  real_world_subject: string;
  geographic_relevance: string; // "none" | "kuwait" | "gulf" | "global" | free text
  people_needed: boolean;
  must_show: string[];
  must_avoid: string[];
  proposed_visual_direction: string;
  concept_summary: string;
  // Source-aware recommendation: true when the article has a strong real-world
  // anchor (a specific named person/company/hospital/product, or a powerful human
  // moment) whose ORIGINAL source image would be a stronger, more credible cover
  // than a generated concept. Only meaningful when a source image exists.
  prefer_source_image: boolean;
  source_image_reason: string;
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
  "a company or organization name, logo or wordmark used as the main visual subject;",
  "Gulf/Kuwaiti clothing (dishdasha/thobe/abaya) or Gulf-styled people added for decoration when the story does not involve them;",
  "plastic, waxy or artificial-looking people; duplicated or distorted faces and hands;",
  "any text, letters, words, numbers, logos, captions or watermarks;",
  "blurry, low-detail, low-resolution or noisy rendering.",
].join(" ");

// Medical/news responsibility + editorial-honesty guardrails (every image).
const HONESTY = [
  "Editorial honesty: this is an illustrative editorial/conceptual cover, NOT documentary evidence.",
  "Do NOT depict a specific real, named or identifiable person; do NOT stage a fake photograph of a real meeting, a real doctor, or named executives; do NOT present an invented exact product/device design as if factual; do NOT fabricate clinical results, charts, numbers or statistics.",
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

  return [
    "Editorial cover image for an Arabic health-news article. It must make a reader feel this image belongs to THIS SPECIFIC story — not a generic health or medical theme.",
    `What happened in the article: ${c.what_happened}.`,
    `Core visual fact to convey: ${c.core_visual_fact}.`,
    `Depict this real-world subject: ${c.real_world_subject}.`,
    `Visual direction: ${c.proposed_visual_direction}.`,
    c.must_show.length ? `Must show: ${c.must_show.join("; ")}.` : "",
    c.must_avoid.length ? `For this story specifically, avoid: ${c.must_avoid.join("; ")}.` : "",
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
    "Your job: choose THE SINGLE STRONGEST editorial COVER for a SPECIFIC article — the way a top photo editor picks a magazine cover — not merely 'a nice image about the topic'.",
    "Think first: WHAT ACTUALLY HAPPENED in this story, and what is the human or real-world stake? Then: what one image would make a reader instantly feel this belongs to THIS article and want to read it?",
    "Ground the concept in the real subject of THIS story — the specific people affected, the real place, the actual development, the specific cells/mechanism/organ/drug/device/diagnostic/service/institution discussed.",
    "IMPORTANT — do not default to safe symbolic abstractions. Do NOT make the MAIN subject a floating vaccine vial or bottle, a map, a giant mosquito, syringes on a plain background, an abstract infographic/chart scene, or a generic 'science' motif UNLESS that object is genuinely the strongest possible cover for this exact story. Such elements may appear as SUPPORTING detail, not as the lazy default hero.",
    "When the strongest story is HUMAN — e.g. a vaccine that protects real children, a community affected by a disease, patients who benefit — a strong, dignified, real-world human moment is often the best cover; prefer it over a symbolic object when it tells the story better. (Represent people respectfully and generically; never a specific identifiable real individual.)",
    "People are still a DECISION, not a reflex: use people when the human stake is the story; use the real object/mechanism/place when THAT is the story. Either way, pick the most evocative, specific, truthful image.",
    "Never propose as the hero: office meetings, conference rooms, handshakes, executives around a table, people at laptops, staged doctors, a doctor holding a tablet, meaningless hospital corridors, generic healthcare stock, generic blue futuristic holograms or AI-brain imagery, or a company name/logo as the main subject — UNLESS the article is specifically about that.",
    "Do not add Gulf/Kuwaiti clothing or region-specific people as decoration; regional context matters only when the story is actually about a place/people.",
    "Editorial honesty: concepts are illustrative/conceptual, never fake documentary evidence — no specific real named person, no staged fake events, no fabricated clinical results.",
    // Source-aware: when a real-world anchor + an original source image exist,
    // recommend using that real image instead of forcing a generated concept.
    "SOURCE-AWARENESS: if the article is anchored to a concrete real-world entity — a named company, a named person, a specific hospital/institution, a specific product, or a powerful documented human situation — AND an original source (publisher) image is available, a real photograph is usually MORE credible and editorially stronger than an invented illustration. In that case set prefer_source_image=true with a one-line source_image_reason. If no source image is available, or the story is best served by a conceptual/scientific illustration, set prefer_source_image=false. You still design a full concept regardless (it is a fallback/alternative).",
    quality === "premium"
      ? "This is a PREMIUM cover: be more ambitious and original — sophisticated composition, real-world specificity, conceptual visualization, editorial metaphor and clear visual hierarchy — striking but always truthful to the article."
      : "This is a FAST cover: one strong, specific, story-true visual direction; efficient but never generic.",
    "Return STRICT JSON only, matching exactly: {\"concepts\":[{\"story_type\":string,\"what_happened\":string,\"core_visual_fact\":string,\"key_entities\":string[],\"real_world_subject\":string,\"geographic_relevance\":string,\"people_needed\":boolean,\"must_show\":string[],\"must_avoid\":string[],\"proposed_visual_direction\":string,\"concept_summary\":string,\"prefer_source_image\":boolean,\"source_image_reason\":string}]}.",
    "concept_summary is a short (<=12 words) label of the visual idea. proposed_visual_direction is 1-2 vivid sentences an image model can render.",
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
      ? "An ORIGINAL source (publisher) image IS available for this article — consider recommending it (prefer_source_image=true) if it is the strongest, most credible cover."
      : "No original source image is available — do not recommend one (prefer_source_image=false).",
  ].filter(Boolean);
  const avoidLine = avoid.length
    ? `\n\nAlready-used concepts to AVOID (choose materially different visual directions — different subject, composition and storytelling, not a rearrangement): ${avoid.map((a) => `“${a}”`).join(", ")}.`
    : "";
  return (
    `Design ${count} DISTINCT cover concept${count > 1 ? "s" : ""} for this article. ` +
    (count > 1
      ? "Each concept must be genuinely different from the others in subject, composition and storytelling (not three variations of one idea). "
      : "") +
    "Ground every concept in what actually happened.\n\n" +
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
      story_type: String(c.story_type ?? "health_news"),
      what_happened: String(c.what_happened ?? "").slice(0, 500),
      core_visual_fact: String(c.core_visual_fact ?? "").slice(0, 300),
      key_entities: strArr(c.key_entities),
      real_world_subject: String(c.real_world_subject ?? "").slice(0, 300),
      geographic_relevance: String(c.geographic_relevance ?? "none").slice(0, 60),
      people_needed: c.people_needed === true,
      must_show: strArr(c.must_show),
      must_avoid: strArr(c.must_avoid),
      proposed_visual_direction: String(c.proposed_visual_direction ?? "").slice(0, 500),
      concept_summary: String(c.concept_summary ?? "").slice(0, 120),
      prefer_source_image: c.prefer_source_image === true,
      source_image_reason: String(c.source_image_reason ?? "").slice(0, 200),
    };
  });
}

/** Deterministic fallback concepts if the planner call/parse fails, so image
 * generation still proceeds with anti-generic guardrails (never a hard failure).
 * Grounded in the title/summary; varies direction per index for a multi set. */
function fallbackConcepts(brief: Brief, count: number): Concept[] {
  const base = brief.summary || brief.excerpt || brief.title || "the article's topic";
  const dirs = [
    "a concrete close-up of the real subject or object at the center of this story, with authentic texture and shallow depth of field",
    "a conceptual visualization of the mechanism, process or idea the article describes, rendered cleanly and truthfully",
    "the real environment or scientific/medical subject of the story shown with strong sense of place and depth",
  ];
  return Array.from({ length: count }, (_, i) => ({
    story_type: "health_news",
    what_happened: base.slice(0, 500),
    core_visual_fact: (brief.title ?? base).slice(0, 300),
    key_entities: [],
    real_world_subject: "the specific real subject at the center of this article (not a generic health scene)",
    geographic_relevance: "none",
    people_needed: false,
    must_show: [],
    must_avoid: [],
    proposed_visual_direction: dirs[i % dirs.length],
    concept_summary: (brief.title ?? base).slice(0, 80),
    prefer_source_image: false,
    source_image_reason: "",
  }));
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
    const concepts = parseConcepts(text).filter((c) => c.proposed_visual_direction || c.real_world_subject);
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
    "url" in a ? [{ url: a.url, concept_summary: a.concept.concept_summary, mode: quality }] : [],
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

  // Source-aware recommendation: if any planned concept judged the ORIGINAL
  // source image the stronger cover (only possible when one exists), surface that
  // as a non-binding hint so the editor can prefer «الصورة الأصلية».
  const rec = concepts.find((c) => c.prefer_source_image && hasSourceImage);
  const recommendation = rec
    ? { prefer_source_image: true, reason: rec.source_image_reason }
    : { prefer_source_image: false, reason: "" };

  // `candidates` carries per-image concept metadata; `urls`/`url` stay for
  // backward-compatible callers.
  return Response.json({ ok: true, candidates, urls, url: urls[0], recommendation });
});

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

type Brief = { title: string; excerpt?: string; summary?: string; category?: string };

/** Three deliberately different treatments of the SAME story so the option set
 * offers real choice rather than three near-identical frames. Each generated
 * option uses one, in order. */
const ANGLES = [
  "ANGLE A — WIDE CONTEXTUAL SCENE: an establishing environmental shot that situates this specific story in a real, believable place. Build depth with distinct foreground, midground and background layers; people, if present, sit naturally within the scene rather than posing. Convey a strong sense of place and atmosphere.",
  "ANGLE B — HUMAN-CENTERED EDITORIAL SCENE: an authentic, candid human moment directly relevant to the story, captured photojournalistically. Natural expressions, genuine gestures and real body language; respectful and modest. Do NOT depict any identifiable, sick, injured or distressed patient.",
  "ANGLE C — CONCEPTUAL CLOSE-UP / STILL LIFE: a tightly framed detail, object or symbolic element tied to the article's core idea. Shallow depth of field, tactile texture and materials, elegant and intentional simplicity.",
];

/** Positive visual direction applied to every option — the "premium editorial"
 * look the site wants, not generic stock. */
const QUALITY = [
  "Look and feel: premium magazine-style editorial photography with a realistic healthcare/news documentary sensibility, as if shot by a professional photojournalist for a high-end publication.",
  "Lighting: cinematic yet natural; soft, directional, believable light — not flat studio lighting.",
  "Composition: refined and intentional, clear foreground/background separation with a natural shallow depth of field, real-world believable setting, rich authentic detail and texture.",
  "Rendering: crisp, high-resolution, sharp where it matters; polished but never plastic, artificial or exaggerated. 16:9 landscape framing.",
].join(" ");

/** Medical/news responsibility guardrails applied to every option. */
const SAFETY = [
  "Responsibility: keep the imagery realistic, credible and documentary in tone — never exaggerated, sensational, alarmist, fear-based or misleading.",
  "Do NOT fabricate medical procedures, surgeries, charts, graphs, test results, numbers or statistics.",
  "Do NOT show identifiable patients, real illness or injury, blood, gore, wounds, or graphic clinical/surgical content.",
  "Do NOT imply a specific diagnosis, treatment claim or medical outcome that the article does not state.",
].join(" ");

/** Things the image must avoid — steers away from stock-photo clichés and common
 * generation artifacts. */
const NEGATIVE = [
  "Avoid entirely: generic stock-photo aesthetics and cliché;",
  "plastic-looking, waxy or artificial people;",
  "over-smiling, posed doctors or thumbs-up gestures;",
  "clichéd empty hospital corridors;",
  "blurry, low-detail, low-resolution or noisy results;",
  "duplicated, warped or distorted faces and hands;",
  "unrealistic, futuristic or fictional medical devices;",
  "any text, letters, words, numbers, logos, captions or watermarks.",
].join(" ");

/** Build an English editorial-photo prompt from the article's own text so the
 * generated cover is actually related to the news. `angle` selects one of the
 * ANGLES variants to diversify a multi-option set. */
function buildPrompt(brief: Brief, angle: number): string {
  const details = [
    brief.title ? `Title: ${brief.title}` : "",
    brief.summary ? `Summary: ${brief.summary}` : "",
    brief.excerpt ? `Excerpt: ${brief.excerpt}` : "",
    brief.category ? `Category: ${brief.category}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  return [
    "Create a premium, photorealistic editorial cover photograph for an Arabic health-news website.",
    "Anchor the image to the SPECIFIC main idea of THIS article — not a generic health or medical theme.",
    `Article details — ${details}.`,
    "Tone: calm, credible and professional health-news mood appropriate to this story; avoid alarmism.",
    ANGLES[angle % ANGLES.length],
    QUALITY,
    "Keep it culturally appropriate and modest for a Gulf/Kuwaiti audience.",
    SAFETY,
    NEGATIVE,
  ]
    .filter(Boolean)
    .join(" ");
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
const MAX_BODY_BYTES = 16_384; // reject oversized payloads outright
const FIELD_MAX: Record<string, number> = {
  title: 300,
  excerpt: 2000,
  summary: 2000,
  category: 120,
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
  const excerpt = field(body, "excerpt");
  const summary = field(body, "summary");
  const category = field(body, "category");

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

  const brief = { title, excerpt, summary, category };
  const model = modelFor(quality);
  // One prompt per option, each with a different visual angle, run in parallel
  // so total latency stays close to a single image (well under the ~150s cap).
  let attempts: Array<{ url: string } | { reason: string; status?: number }>;
  try {
    attempts = await Promise.all(
      Array.from({ length: count }, (_, i) => generateOne(apiKey, admin, model, buildPrompt(brief, i))),
    );
  } catch {
    // Unexpected failure: release the reservation so it never blocks the user.
    await completeReservation(admin, reservation.id, auth.userId, "failed", 0, "unexpected");
    return Response.json({ ok: false, reason: "no_image" });
  }

  const urls = attempts.flatMap((a) => ("url" in a ? [a.url] : []));
  if (urls.length === 0) {
    // Surface the first failure reason; mark the reservation failed (0 images).
    const firstFail = attempts.find((a) => "reason" in a) as
      | { reason: string; status?: number }
      | undefined;
    await completeReservation(admin, reservation.id, auth.userId, "failed", 0, firstFail?.reason ?? "no_image");
    return Response.json({ ok: false, reason: firstFail?.reason ?? "no_image", status: firstFail?.status });
  }

  // Meter only the images we actually produced.
  await completeReservation(admin, reservation.id, auth.userId, "succeeded", urls.length, null);
  // `url` kept for backward-compatible single-image callers.
  return Response.json({ ok: true, urls, url: urls[0] });
});

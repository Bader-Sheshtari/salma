// Salma AI cover-image generator — runs inside Supabase (Deno).
//
// An admin (from the content form) sends the article's title/excerpt/category;
// this function asks OpenRouter for an editorial cover image, uploads it to the
// public `media` bucket, and returns its URL. Calling it again simply produces a
// fresh image (the "generate another" flow).
//
// Auth (verify_jwt is disabled; this function does its own check): the admin UI
// invokes it with the admin's session JWT in the Authorization header; we verify
// role ∈ {admin, super_admin, owner}. This mirrors synthesize-url so the
// OpenRouter key lives ONLY as a Supabase function secret, never in the browser
// or the Next.js env.
//
// Required function secret: OPENROUTER_API_KEY. Optional: OPENROUTER_IMAGE_MODEL.
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Image generation needs an image-capable model (the text ingestion model can't
// produce images). Override with OPENROUTER_IMAGE_MODEL.
const IMAGE_MODEL = Deno.env.get("OPENROUTER_IMAGE_MODEL") || "openai/gpt-5.4-image-2";

// ---- Prompt -------------------------------------------------------------

/** Build an English editorial-photo prompt from the article's own text so the
 * generated cover is actually related to the news. */
function buildPrompt(title: string, excerpt?: string, category?: string): string {
  const topic = [title, excerpt].filter(Boolean).join(". ");
  return [
    "Create a high-quality, photorealistic editorial news cover image for an Arabic health-news website.",
    `The article is about: ${topic}.`,
    category ? `Topic/category: ${category}.` : "",
    "Style: clean, modern, professional editorial photography, soft natural lighting, 16:9 landscape framing.",
    "Keep it culturally appropriate and modest for a Gulf/Kuwaiti audience.",
    "Do NOT include any text, letters, words, logos, captions, or watermarks in the image.",
    "Avoid graphic or distressing medical imagery; keep the mood tasteful and reassuring.",
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

// ---- Auth + HTTP entrypoint --------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

async function authorizeAdmin(req: Request, admin: SupabaseClient): Promise<boolean> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt === ANON_KEY) return false;

  const authClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) return false;

  const { data: profile } = await admin
    .from("profiles")
    .select("role,disabled")
    .eq("id", user.id)
    .maybeSingle();
  return (
    !!profile &&
    ["admin", "super_admin", "owner"].includes(profile.role) &&
    !profile.disabled
  );
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (!(await authorizeAdmin(req, admin))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let title = "";
  let excerpt = "";
  let category = "";
  try {
    const body = await req.json();
    title = String(body?.title ?? "").trim();
    excerpt = String(body?.excerpt ?? "").trim();
    category = String(body?.category ?? "").trim();
  } catch {
    // fall through to validation
  }
  if (title.length < 4) {
    return Response.json({ ok: false, reason: "no_title" });
  }

  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    return Response.json({ ok: false, error: "OPENROUTER_API_KEY is not set" }, { status: 500 });
  }

  const prompt = buildPrompt(title, excerpt, category);

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
        model: IMAGE_MODEL,
        modalities: ["image", "text"],
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    return Response.json({ ok: false, reason: "connect" });
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return Response.json({ ok: false, reason: "openrouter", status: res.status, detail: detail.slice(0, 500) });
  }

  const data = await res.json().catch(() => null);
  const dataUrl: string | undefined = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return Response.json({ ok: false, reason: "no_image" });
  }

  const parsed = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
  if (!parsed) return Response.json({ ok: false, reason: "bad_format" });
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
  if (upErr) return Response.json({ ok: false, reason: "upload" });

  const { data: pub } = admin.storage.from("media").getPublicUrl(path);
  return Response.json({ ok: true, url: pub.publicUrl });
});

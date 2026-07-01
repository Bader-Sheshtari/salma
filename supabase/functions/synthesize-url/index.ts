// Salma URL-synthesis tool — runs inside Supabase (Deno).
//
// An admin pastes an article URL; this function fetches the page, extracts the
// readable text + title + cover image, asks OpenRouter to rewrite it as an
// Arabic draft, and stores it as `pending` content (origin = 'ai') with the
// original link kept as a reference. The AI never authors facts beyond the
// source page.
//
// Auth (verify_jwt is disabled; this function does its own check): the admin UI
// invokes it with the admin's session JWT in the Authorization header; we
// verify role = 'admin'.
//
// Required function secret: OPENROUTER_API_KEY. Optional: OPENROUTER_MODEL.
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = Deno.env.get("OPENROUTER_MODEL") || "openai/gpt-oss-20b:free";

const VALID_CATEGORIES = [
  "kuwait",
  "gulf",
  "world",
  "health-economy",
  "lifestyle",
  "investigations",
];

type Draft = {
  title: string;
  excerpt: string;
  body: string;
  category_slug: string;
  read_minutes: number;
};

// ---- OpenRouter (no web plugin: we supply the page text) -----------------

async function chat(
  messages: { role: string; content: string }[],
  options: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
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
      model: DEFAULT_MODEL,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2600,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenRouter request failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ---- Helpers ------------------------------------------------------------

function dedupeKeyFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return null;
  }
}

function metaContent(html: string, patterns: RegExp[], base: string): string | null {
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      try {
        return new URL(m[1].trim(), base).href;
      } catch {
        return m[1].trim();
      }
    }
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Pulls `articleBody` out of any schema.org NewsArticle/Article JSON-LD block.
function jsonLdArticleBody(html: string): string | null {
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b[1].trim());
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed["@graph"] ?? [])];
      for (const n of nodes) {
        const body = n && typeof n === "object" ? String(n.articleBody ?? "").trim() : "";
        if (body.length > 0) return body;
      }
    } catch {
      // skip malformed JSON-LD
    }
  }
  return null;
}

type PageData = { title: string; text: string; image: string | null; siteName: string | null };

async function fetchPage(url: string): Promise<PageData> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Accept-Language": "ar,en;q=0.9",
    },
    signal: AbortSignal.timeout(12000),
  });
  // 403/429/503 are how bot-protection services (e.g. Cloudflare) reject
  // automated fetches — surface them as "blocked" so the caller can tell the
  // admin the site can't be read automatically rather than a vague failure.
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    throw new Error("blocked");
  }
  if (!res.ok) throw new Error(`fetch failed (${res.status})`);
  const html = (await res.text()).slice(0, 400000);

  // Some services return 200 with a JS "challenge" interstitial instead of the
  // article — detect the common markers and treat them as a block too.
  if (/Just a moment\.\.\.|cf-browser-verification|challenge-platform|_cf_chl_/i.test(html)) {
    throw new Error("blocked");
  }

  const ogTitle = metaContent(
    html,
    [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    ],
    url,
  );
  const htmlTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
  const title = decodeEntities((ogTitle ?? htmlTitle).trim()).slice(0, 300);

  const image = metaContent(
    html,
    [
      /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    ],
    url,
  );

  const siteName = metaContent(
    html,
    [/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i],
    url,
  );

  // Strip scripts/styles, drop tags, collapse whitespace to get readable text.
  const body = html.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? html;
  let text = decodeEntities(
    body
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, 12000);

  // Fallback for JS-rendered pages whose <body> ships almost no static text:
  // try the JSON-LD `articleBody`, then the meta description.
  if (text.length < 200) {
    const fromLd = jsonLdArticleBody(html);
    if (fromLd && fromLd.length > text.length) text = fromLd.slice(0, 12000);
  }
  if (text.length < 200) {
    const desc = metaContent(
      html,
      [
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      ],
      url,
    );
    if (desc && desc.length > text.length) text = decodeEntities(desc);
  }

  return { title, text, image, siteName: siteName ? decodeEntities(siteName) : null };
}

function slugify(input: string): string {
  return (
    input
      .trim()
      .replace(/[\u064B-\u065F\u0610-\u061A]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .toLowerCase() || "article"
  );
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in response");
  return JSON.parse(text.slice(start, end + 1));
}

const SYSTEM = `أنت محرّر صحي في منصة "سلمى" الإخبارية الكويتية. تتلقى نص مقال حقيقي (وعنوانه) وتعيد صياغته كمقال عربي فصيح مبسّط لقارئ عام في الكويت والخليج.

قواعد صارمة:
- استخدم فقط المعلومات الموجودة في نص المقال المرفق. لا تختلق أي حقائق أو أرقام أو أسماء أو روابط.
- ترجم وبسّط مع الحفاظ على الدقة الكاملة.
- صنّف المقال إلى أحد الأقسام: kuwait, gulf, world, health-economy, lifestyle, investigations.
- اكتب نصاً وافياً ومنظّماً في فقرات.

أعد النتيجة بصيغة JSON فقط دون أي نص إضافي بالشكل:
{"title":"العنوان بالعربية","excerpt":"موجز قصير","body":"النص الكامل بالعربية","category_slug":"world","read_minutes":4}`;

function sanitize(parsed: unknown): Draft | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const title = String(o.title ?? "").trim();
  const body = String(o.body ?? "").trim();
  if (title.length < 4 || body.length < 40) return null;
  return {
    title,
    excerpt: String(o.excerpt ?? "").trim(),
    body,
    category_slug: VALID_CATEGORIES.includes(String(o.category_slug))
      ? String(o.category_slug)
      : "world",
    read_minutes: Number(o.read_minutes) || 4,
  };
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
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (!(await authorizeAdmin(req, admin))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let url = "";
  try {
    const body = await req.json();
    url = String(body?.url ?? "").trim();
  } catch {
    // fall through to validation
  }
  if (!/^https?:\/\//i.test(url)) {
    return Response.json({ ok: false, error: "invalid url" }, { status: 400 });
  }

  try {
    const key = dedupeKeyFromUrl(url);
    if (key) {
      const { data: existing } = await admin
        .from("content")
        .select("id,title")
        .eq("dedupe_key", key)
        .maybeSingle();
      if (existing) {
        return Response.json({
          ok: true,
          id: (existing as { id: string }).id,
          title: (existing as { title: string }).title,
          duplicate: true,
        });
      }
    }

    const page = await fetchPage(url);
    if (page.text.length < 200) {
      // Return 200 so the caller can read the machine-readable reason and show
      // an accurate message (this is a readable-content problem, not an error).
      return Response.json({ ok: false, reason: "no_text" });
    }

    const raw = await chat(
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `العنوان الأصلي: ${page.title}\n\nنص المقال:\n${page.text}`,
        },
      ],
      { temperature: 0.3, maxTokens: 3000 },
    );

    let draft: Draft | null = null;
    try {
      draft = sanitize(extractJson(raw));
    } catch {
      draft = null;
    }
    if (!draft) {
      return Response.json({ ok: false, reason: "synthesis" });
    }

    const sourceName = page.siteName || (() => {
      try {
        return new URL(url).host.replace(/^www\./, "");
      } catch {
        return "المصدر";
      }
    })();

    const slug = `${slugify(draft.title)}-${Math.random().toString(36).slice(2, 7)}`;
    const payload = {
      title: draft.title,
      slug,
      type: "article",
      status: "pending",
      origin: "ai",
      category_slug: draft.category_slug,
      excerpt: draft.excerpt || null,
      body: draft.body || null,
      read_minutes: draft.read_minutes,
      original_title: page.title || null,
      original_url: url,
      cover_image_url: page.image,
      cover_credit_name: page.image ? sourceName : null,
      cover_credit_url: page.image ? url : null,
      dedupe_key: key,
    };

    const { data, error } = await admin
      .from("content")
      .insert(payload)
      .select("id")
      .single();
    if (error || !data) {
      if ((error as { code?: string } | null)?.code === "23505") {
        return Response.json({ ok: false, error: "already exists" }, { status: 409 });
      }
      return Response.json({ ok: false, error: "could not save draft" }, { status: 500 });
    }

    const contentId = (data as { id: string }).id;
    await admin.from("content_sources").insert({
      content_id: contentId,
      label: sourceName,
      url,
    });

    return Response.json({ ok: true, id: contentId, title: draft.title });
  } catch (e) {
    const message = e instanceof Error ? e.message : "synthesis failed";
    // Bot-protection block (Cloudflare etc.) — return 200 so the caller reads
    // the reason and shows an accurate "site can't be fetched" message.
    if (message === "blocked") {
      return Response.json({ ok: false, reason: "blocked" });
    }
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});

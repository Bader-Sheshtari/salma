/**
 * Minimal OpenRouter client. Server-only — never import in client components
 * (it reads OPENROUTER_API_KEY).
 *
 * Uses a free model by default (configurable via OPENROUTER_MODEL).
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-oss-20b:free";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatOptions = {
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

function headers(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL || "https://salma.health",
    "X-Title": "Salma",
  };
}

export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({
      model: options.model || DEFAULT_MODEL,
      messages,
      temperature: options.temperature ?? 0.4,
      max_tokens: options.maxTokens ?? 1024,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenRouter request failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/** A real source link returned by the web plugin (never model-fabricated). */
export type Citation = { url: string; title: string };

export type WebChatResult = { content: string; citations: Citation[] };

/**
 * Chat with OpenRouter's web-search plugin enabled. The plugin performs a live
 * web search, injects the real results into the model context, and returns the
 * real source URLs as message annotations. We surface those annotations as
 * `citations` so callers can attach REAL links and reject any URL the model
 * invents on its own.
 */
export async function chatWeb(
  messages: ChatMessage[],
  options: ChatOptions & { maxResults?: number } = {},
): Promise<WebChatResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({
      model: options.model || DEFAULT_MODEL,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2048,
      plugins: [{ id: "web", max_results: options.maxResults ?? 6 }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenRouter web request failed (${res.status}): ${detail}`);
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message ?? {};
  const annotations = Array.isArray(message.annotations) ? message.annotations : [];
  const citations: Citation[] = [];
  for (const a of annotations) {
    const c = a?.url_citation;
    if (c?.url) citations.push({ url: String(c.url), title: String(c.title ?? "") });
  }
  return { content: message.content ?? "", citations };
}

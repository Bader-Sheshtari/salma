// E1.3D — verified source-text extraction (pure, no Deno/Supabase imports).
//
// Fetches and extracts the plain-text article body of the ONE final, registered,
// final_source_allowed source URL chosen for a story, so the Salma writer and
// validator are grounded in the real source page — never in model-generated
// discovery text. The network call is injected (RawFetch) so every branch is
// unit-testable with mocked HTML fixtures and no live internet (see
// fetchSourceText.test.ts). index.ts supplies the real, hardened Deno fetch.
//
// Security posture (SSRF-hardened): only http/https, the final hostname must
// match the registered selected source domain, every redirect hop is
// re-validated, redirects are capped, private/loopback/link-local/metadata and
// internal hosts are refused, the download is byte-capped and time-boxed, only
// HTML content types are accepted, and NO Supabase/OpenRouter/Auth/cookie
// secrets are ever sent. A fetch or security failure rejects the candidate with
// a discrete reason and yields no source text (the caller creates no draft).

// --- Public result / reason types ------------------------------------------

// Every discrete failure the caller records on the audit row. All are plain
// strings so ingestion_decisions.rejection_reason (free text) needs no schema
// change.
export type SourceFetchReason =
  | "source_fetch_failed"
  | "source_fetch_timeout"
  | "source_domain_mismatch"
  | "source_content_too_short"
  | "source_text_unavailable"
  | "source_pdf_not_supported"
  | "source_format_not_supported"
  // E1.3E — DNS-resolution SSRF layer. Raised BEFORE any socket is opened when
  // the hostname's resolved addresses are missing/unsafe. A DNS/security failure
  // yields no source text (the caller creates no draft, calls no writer).
  | "source_dns_resolution_failed"
  | "source_private_address"
  | "source_unsafe_resolved_address";

export type ExtractionMethod = "json-ld" | "article" | "main" | "paragraphs";

export type SourceText = {
  ok: true;
  title: string;
  text: string;
  method: ExtractionMethod;
  publishedDate: string | null;
  charCount: number;
  wordCount: number;
  finalUrl: string;
  // Deterministically-extracted essential entities found IN the source text
  // (org/country/batch/sample size). Used to populate the writer's mustPreserve.
  mustPreserve: string[];
};

export type SourceFetchResult = SourceText | { ok: false; reason: SourceFetchReason };

// --- Tunables (conservative) -----------------------------------------------

export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 8000;
export const MAX_DOWNLOAD_BYTES = 2_000_000; // 2 MB hard cap
export const MIN_TEXT_CHARS = 250;
export const MAX_TEXT_CHARS = 40_000;
// A neutral user agent — never anything that leaks the platform or a secret.
export const NEUTRAL_USER_AGENT = "Mozilla/5.0 (compatible; SalmaSourceFetch/1.0)";

// --- Injected low-level fetch ----------------------------------------------

// A SINGLE HTTP request that MUST NOT auto-follow redirects (redirect:"manual")
// so this module can validate each hop. Body is exposed as a chunk stream so the
// module can enforce the byte cap while downloading.
export type RawResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
};
export type RawFetch = (
  url: string,
  init: { headers: Record<string, string>; timeoutMs: number; maxBytes: number },
) => Promise<RawResponse>;

// --- Injected DNS resolution (E1.3E SSRF layer) ----------------------------

// Resolve a hostname to the list of numeric IP addresses (IPv4 and/or IPv6)
// it currently points at. Injected so tests never touch live DNS. index.ts
// supplies a real adapter over Deno.resolveDns("A") + Deno.resolveDns("AAAA").
// A throw or an empty result is treated as an unresolvable host (fail closed).
export type DnsResolver = (hostname: string) => Promise<string[]>;

// --- Host / URL security ---------------------------------------------------

function normalizeHostname(host: string): string {
  return (host ?? "").trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/** IPv4 dotted-quad literal? */
function parseIpv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map((n) => Number(n));
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

function isPrivateIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0 || a === 127) return true; // this-network / loopback
  if (a === 10) return true; // private
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

/**
 * Is this hostname a loopback/private/link-local/metadata or internal name that
 * must never be fetched? Blocks ALL IP literals (a registered source is a
 * hostname, so an IP can never legitimately match it) and any private/internal
 * suffix. IPv6 literals are blocked wholesale (bracketed or bare).
 */
export function isBlockedHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  for (const suffix of [".local", ".internal", ".lan", ".home", ".corp", ".intranet"]) {
    if (h.endsWith(suffix)) return true;
  }
  // IPv6 literal (URL host keeps the brackets) or any colon-bearing host.
  if (h.includes(":") || h.startsWith("[")) return true;
  const v4 = parseIpv4(h);
  if (v4) return isPrivateIpv4(v4); // private/reserved v4 blocked; a public v4 still fails the domain match
  return false;
}

/** The final hostname must equal the registered domain or be a subdomain of it. */
export function hostnameMatchesDomain(hostname: string, registeredDomain: string): boolean {
  const h = normalizeHostname(hostname);
  const d = normalizeHostname(registeredDomain);
  if (!h || !d) return false;
  return h === d || h.endsWith("." + d);
}

/**
 * Validate one URL (initial or redirect target) against the registered source
 * domain and the SSRF blocklist. Returns the parsed URL or a discrete reason.
 */
export function validateFetchTarget(
  rawUrl: string,
  registeredDomain: string,
): { ok: true; url: URL } | { ok: false; reason: SourceFetchReason } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "source_fetch_failed" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "source_fetch_failed" };
  }
  if (isBlockedHostname(url.hostname)) return { ok: false, reason: "source_domain_mismatch" };
  if (!hostnameMatchesDomain(url.hostname, registeredDomain)) {
    return { ok: false, reason: "source_domain_mismatch" };
  }
  return { ok: true, url };
}

// --- DNS-resolution SSRF layer (E1.3E) -------------------------------------

// The classification of one resolved address. "private" (loopback / RFC1918 /
// link-local incl. cloud metadata / CGNAT / ULA) and "unsafe" (unspecified /
// documentation / benchmarking / multicast / reserved / unparsable) are both
// blocked; only "safe" (ordinary public) may be fetched.
export type AddressClass = "safe" | "private" | "unsafe";

function classifyIpv4(parts: number[]): AddressClass {
  const [a, b, c] = parts;
  if (a === 0) return "unsafe"; // 0.0.0.0/8 "this network" / unspecified
  if (a === 127) return "private"; // loopback
  if (a === 10) return "private"; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return "private"; // RFC1918
  if (a === 192 && b === 168) return "private"; // RFC1918
  if (a === 169 && b === 254) return "private"; // link-local incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT (RFC6598)
  if (a === 192 && b === 0 && c === 0) return "unsafe"; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return "unsafe"; // TEST-NET-1 (documentation)
  if (a === 198 && b === 51 && c === 100) return "unsafe"; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return "unsafe"; // TEST-NET-3
  if (a === 198 && (b === 18 || b === 19)) return "unsafe"; // benchmarking
  if (a >= 224) return "unsafe"; // 224/4 multicast + 240/4 reserved + 255 broadcast
  return "safe";
}

function classifyIpv6(addr: string): AddressClass {
  // addr is already lowercased with brackets and any %zone-id stripped.
  if (addr === "::1") return "private"; // loopback
  if (addr === "::") return "unsafe"; // unspecified
  // IPv4-mapped / -compatible (::ffff:x.x.x.x / ::x.x.x.x): classify by the
  // embedded IPv4 so ::ffff:127.0.0.1 or ::ffff:169.254.169.254 can't slip past.
  const mapped = addr.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    const v4 = parseIpv4(mapped[1]);
    return v4 ? classifyIpv4(v4) : "unsafe";
  }
  const head = addr.split(":")[0]; // first hextet
  if (["fe8", "fe9", "fea", "feb"].some((p) => head.startsWith(p))) return "private"; // fe80::/10 link-local
  if (head.startsWith("fc") || head.startsWith("fd")) return "private"; // fc00::/7 ULA
  if (head.startsWith("ff")) return "unsafe"; // ff00::/8 multicast
  if (addr.startsWith("2001:db8") || addr.startsWith("2001:0db8")) return "unsafe"; // documentation
  return "safe";
}

/**
 * Classify a single resolved IP address (IPv4 or IPv6 literal, as returned by a
 * DNS resolver) as safe / private / unsafe. Anything that cannot be parsed as a
 * numeric address is treated as "unsafe" (fail closed) — a resolver must return
 * numeric addresses, never names.
 */
export function classifyResolvedAddress(ip: string): AddressClass {
  const raw = (ip ?? "").trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "");
  if (!raw) return "unsafe";
  const v4 = parseIpv4(raw);
  if (v4) return classifyIpv4(v4);
  if (raw.includes(":")) return classifyIpv6(raw);
  return "unsafe";
}

/**
 * Resolve a hostname and reject if ANY resolved address is unsafe to fetch.
 * Fail closed: a throw or an empty answer is source_dns_resolution_failed. A
 * mixed public+private answer (a classic DNS-rebinding response) is blocked
 * because "any private" is reported first. Called before EVERY network request,
 * including every redirect hop, so a rebinding across hops is re-checked.
 *
 * DNS-rebinding limitation (honest): Deno's fetch performs its OWN DNS
 * resolution and does not let us pin the resolved IP onto the socket, so a
 * TTL=0 attacker could in principle answer with a public address here and a
 * private one microseconds later for the real fetch. This pre-flight check is
 * conservative defense-in-depth; it does NOT fully eliminate the rebinding race
 * in the Deno runtime.
 */
export async function validateResolvedAddresses(
  hostname: string,
  resolveDns: DnsResolver,
): Promise<{ ok: true } | { ok: false; reason: SourceFetchReason }> {
  let addresses: string[];
  try {
    addresses = await resolveDns(hostname);
  } catch {
    return { ok: false, reason: "source_dns_resolution_failed" };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, reason: "source_dns_resolution_failed" };
  }
  const classes = addresses.map(classifyResolvedAddress);
  if (classes.includes("private")) return { ok: false, reason: "source_private_address" };
  if (classes.includes("unsafe")) return { ok: false, reason: "source_unsafe_resolved_address" };
  return { ok: true };
}

// --- Content-type classification -------------------------------------------

export function classifyContentType(
  contentType: string | null,
): { kind: "html" } | { kind: "reject"; reason: SourceFetchReason } {
  const ct = (contentType ?? "").toLowerCase();
  if (!ct) return { kind: "html" }; // absent header: attempt HTML parse, extraction still guards length
  if (ct.includes("application/pdf")) return { kind: "reject", reason: "source_pdf_not_supported" };
  if (ct.includes("text/html") || ct.includes("application/xhtml+xml")) return { kind: "html" };
  return { kind: "reject", reason: "source_format_not_supported" };
}

// --- Byte-capped body read --------------------------------------------------

async function collectCappedText(
  body: AsyncIterable<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; overLimit: boolean }> {
  if (!body) return { text: "", overLimit: false };
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let text = "";
  let overLimit = false;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      overLimit = true;
      break;
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return { text, overLimit };
}

// --- HTML → plain text extraction ------------------------------------------

function decodeEntities(s: string): string {
  return (s ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)));
}

function safeFromCodePoint(code: number): string {
  try {
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  } catch {
    return "";
  }
}

function stripTags(html: string): string {
  return (html ?? "").replace(/<[^>]+>/g, " ");
}

function cleanText(s: string): string {
  return decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();
}

/** Remove non-editorial blocks (scripts, styles, chrome, ads) wholesale. */
function removeBoilerplateBlocks(html: string): string {
  let h = html ?? "";
  h = h.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of ["script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form"]) {
    h = h.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  return h;
}

const BOILERPLATE_MARKERS = [
  "cookie", "consent", "subscribe", "newsletter", "advertisement", "sponsored",
  "share this", "related", "read more", "read also", "sign up", "follow us",
  "اقرأ أيضا", "اقرأ أيضاً", "شاهد أيضا", "اقرأ المزيد", "المزيد من", "تابعنا",
  "اشترك", "النشرة البريدية", "إعلان", "شارك", "حقوق النشر", "جميع الحقوق",
  "ملفات تعريف الارتباط", "الكوكيز",
];

function isBoilerplateParagraph(text: string): boolean {
  const t = text.toLowerCase();
  return text.length < 160 && BOILERPLATE_MARKERS.some((m) => t.includes(m.toLowerCase()));
}

/** Pull editorial paragraphs (p / h1-3 / li / blockquote) from an HTML fragment. */
function paragraphsFromHtml(fragment: string): string[] {
  const out: string[] = [];
  const re = /<(p|h[1-3]|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    const t = cleanText(m[2]);
    if (t.length >= 2 && !isBoilerplateParagraph(t)) out.push(t);
  }
  return out;
}

function firstBlock(html: string, tag: string): string | null {
  const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : null;
}

function extractTitle(html: string): string {
  const ld = extractJsonLdField(html, "headline");
  if (ld) return ld;
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og?.[1]) return decodeEntities(og[1]).trim();
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? cleanText(t[1]) : "";
}

function extractPublishedDate(html: string): string | null {
  const ld = extractJsonLdField(html, "datePublished");
  if (ld) return ld;
  const meta = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i);
  if (meta?.[1]) return meta[1].trim();
  const time = html.match(/<time[^>]+datetime=["']([^"']+)["']/i);
  return time?.[1]?.trim() ?? null;
}

/** Walk every ld+json block, returning the first Article-like object found. */
function jsonLdObjects(html: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const stack: unknown[] = [parsed];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) stack.push(...node);
      else if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        blocks.push(obj);
        if (Array.isArray(obj["@graph"])) stack.push(...(obj["@graph"] as unknown[]));
      }
    }
  }
  return blocks;
}

function extractJsonLdField(html: string, field: string): string | null {
  for (const obj of jsonLdObjects(html)) {
    const v = obj[field];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function extractJsonLdArticleBody(html: string): string | null {
  for (const obj of jsonLdObjects(html)) {
    const body = obj["articleBody"];
    if (typeof body === "string" && body.trim().length >= MIN_TEXT_CHARS) {
      return body.replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
    }
  }
  return null;
}

/**
 * Extract the plain-text article from an HTML document. Prefers a JSON-LD
 * articleBody, then <article>, then <main>, then whole-document paragraphs.
 * Returns a discrete reason (too_short / unavailable) when no reliable editorial
 * body can be recovered — it NEVER falls back to any caller-supplied draft.
 */
export function extractArticle(
  html: string,
): { ok: true; title: string; text: string; method: ExtractionMethod; publishedDate: string | null }
  | { ok: false; reason: "source_content_too_short" | "source_text_unavailable" } {
  const title = extractTitle(html);
  const publishedDate = extractPublishedDate(html);

  const candidates: { method: ExtractionMethod; text: string }[] = [];

  const ld = extractJsonLdArticleBody(html);
  if (ld) candidates.push({ method: "json-ld", text: ld });

  const cleaned = removeBoilerplateBlocks(html);
  for (const [tag, method] of [["article", "article"], ["main", "main"]] as const) {
    const block = firstBlock(cleaned, tag);
    if (block) {
      const paras = paragraphsFromHtml(block);
      const text = paras.join("\n\n") || cleanText(block);
      if (text) candidates.push({ method, text });
    }
  }
  const wholeParas = paragraphsFromHtml(cleaned);
  if (wholeParas.length) candidates.push({ method: "paragraphs", text: wholeParas.join("\n\n") });

  // Choose the first candidate that clears the minimum length (priority order).
  let best: { method: ExtractionMethod; text: string } | null = null;
  let sawAnyText = false;
  for (const c of candidates) {
    const normalized = c.text.replace(/\n{3,}/g, "\n\n").trim();
    if (normalized.length > 0) sawAnyText = true;
    if (normalized.length >= MIN_TEXT_CHARS) {
      best = { method: c.method, text: normalized.slice(0, MAX_TEXT_CHARS) };
      break;
    }
  }

  if (!best) {
    return { ok: false, reason: sawAnyText ? "source_content_too_short" : "source_text_unavailable" };
  }
  return { ok: true, title, text: best.text, method: best.method, publishedDate };
}

// --- Deterministic essential-entity extraction (for mustPreserve) ----------

const COUNTRY_TERMS = [
  "الكويت", "السعودية", "الإمارات", "قطر", "البحرين", "عُمان", "عمان",
  "مصر", "الأردن", "لبنان", "العراق", "اليمن", "سوريا",
  "Kuwait", "Saudi", "Emirates", "UAE", "Qatar", "Bahrain", "Oman",
];

/**
 * A lot/batch capture is kept only when it plausibly LOOKS like an identifier,
 * not an ordinary sentence word that merely followed "lot"/"batch" wording
 * (e.g. "lot number displayed on the label" must not yield "displayed"). A real
 * lot/batch code either carries a digit (25202, AB12C, AB-123, 25A, ABC123/4)
 * or is a short all-uppercase alphanumeric code — the only digit-free shape a
 * genuine code takes. Lowercase/mixed-case words with no digit (displayed,
 * printed, shown, located, found, listed, provided, appearing, …) are rejected.
 */
export function looksLikeBatchIdentifier(value: string): boolean {
  const v = (value ?? "").trim();
  if (!v) return false;
  if (/\d/.test(v)) return true; // any digit → identifier (covers 25202, AB12C, AB-123, 25A, ABC123/4)
  return /^[A-Z][A-Z/-]*$/.test(v) && v.length <= 6; // short all-uppercase digit-free code
}

/**
 * Extract essential entities that appear IN the verified source text: the
 * registered organization name (only if present in the text), country names,
 * batch/lot identifiers, and a study sample size. Model-generated entities are
 * never used here — everything returned is grounded in the extracted body.
 */
export function extractEssentialEntities(
  text: string,
  opts: { sourceName?: string | null } = {},
): string[] {
  const out: string[] = [];
  const t = text ?? "";
  const lower = t.toLowerCase();

  const org = (opts.sourceName ?? "").trim();
  if (org && lower.includes(org.toLowerCase())) out.push(org);

  for (const country of COUNTRY_TERMS) {
    if (t.includes(country)) out.push(country);
  }

  // Batch / lot identifiers.
  const batchRes = [
    /(?:دفعة|تشغيلة)\s*(?:رقم\s*)?[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{2,})/g,
    /(?:batch|lot)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{2,})/gi,
  ];
  for (const re of batchRes) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      if (looksLikeBatchIdentifier(m[1])) out.push(m[1]);
    }
  }

  // Medicine / product names, extracted conservatively so a safety alert keeps
  // the exact product it concerns. Arabic: a drug/product keyword immediately
  // followed by a «…» or "…" quoted name. English: an FDA-style "recall of …"
  // phrase bounded by a dosage-form/reason cue so only the product name is
  // captured. Only names that are clearly delimited are taken — no free-form
  // guessing — because a wrong or invented product name is worse than none.
  const productRes = [
    /(?:دواء|عقار|لقاح|مستحضر صيدلاني|مستحضر|منتج)\s*«([^»]{2,60})»/g,
    /(?:دواء|عقار|لقاح|مستحضر صيدلاني|مستحضر|منتج)\s*"([^"]{2,60})"/g,
    /recall of (?:one lot of |a lot of |all lots of )?([A-Z][A-Za-z0-9][\w .\-]{2,58}?)(?=,| USP| Injection| Tablets| Capsules| due| because| after|\.|$)/g,
  ];
  for (const re of productRes) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) out.push(m[1].trim());
  }

  // Study sample size ("شملت 1200 مشارك" / "عيّنة من 800" / "n = 1500").
  const sample = t.match(/(?:شملت|عيّنة من|عينة من|n\s*=\s*)\s*([\u0660-\u06691-9][\u0660-\u06690-9,]{1,})/i);
  if (sample?.[1]) out.push(sample[1].replace(/,/g, ""));

  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

// --- Orchestration ----------------------------------------------------------

function countWords(text: string): number {
  return (text ?? "").trim().split(/\s+/).filter((tok) => /[\p{L}\p{N}]/u.test(tok)).length;
}

/**
 * Fetch and extract the verified source text for ONE final, registered source
 * URL. Validates the initial URL and every redirect hop against the registered
 * domain + SSRF blocklist, caps redirects/bytes/time, accepts only HTML, and
 * returns extracted plain text plus deterministically-extracted essential
 * entities. Any failure returns a discrete reason and NO text.
 */
export async function fetchSourceText(args: {
  url: string;
  registeredDomain: string;
  sourceName?: string | null;
  rawFetch: RawFetch;
  resolveDns: DnsResolver;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<SourceFetchResult> {
  const maxBytes = args.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const timeoutMs = args.timeoutMs ?? FETCH_TIMEOUT_MS;
  const headers: Record<string, string> = {
    // Neutral UA; explicitly NO Authorization / Cookie / apikey headers.
    "User-Agent": NEUTRAL_USER_AGENT,
    "Accept": "text/html,application/xhtml+xml",
  };

  let currentUrl = args.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = validateFetchTarget(currentUrl, args.registeredDomain);
    if (!target.ok) return { ok: false, reason: target.reason };

    // E1.3E: resolve the final hostname and refuse any unsafe address BEFORE
    // opening a socket. Re-run on every hop so a redirect (or a rebinding
    // answer) is re-validated, never trusted from the previous iteration.
    const dnsCheck = await validateResolvedAddresses(target.url.hostname, args.resolveDns);
    if (!dnsCheck.ok) return { ok: false, reason: dnsCheck.reason };

    let res: RawResponse;
    try {
      res = await args.rawFetch(target.url.href, { headers, timeoutMs, maxBytes });
    } catch (e) {
      const timedOut = isTimeout(e);
      return { ok: false, reason: timedOut ? "source_fetch_timeout" : "source_fetch_failed" };
    }

    // Redirect: re-validate the next hop on the following loop iteration.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, reason: "source_fetch_failed" };
      let next: string;
      try {
        next = new URL(location, target.url.href).href;
      } catch {
        return { ok: false, reason: "source_fetch_failed" };
      }
      currentUrl = next;
      continue;
    }

    if (res.status < 200 || res.status >= 300) return { ok: false, reason: "source_fetch_failed" };

    const ct = classifyContentType(res.headers.get("content-type"));
    if (ct.kind === "reject") return { ok: false, reason: ct.reason };

    const { text: rawHtml, overLimit } = await collectCappedText(res.body, maxBytes);
    if (overLimit) return { ok: false, reason: "source_fetch_failed" };

    const extracted = extractArticle(rawHtml);
    if (!extracted.ok) return { ok: false, reason: extracted.reason };

    const mustPreserve = extractEssentialEntities(extracted.text, { sourceName: args.sourceName });
    return {
      ok: true,
      title: extracted.title,
      text: extracted.text,
      method: extracted.method,
      publishedDate: extracted.publishedDate,
      charCount: extracted.text.length,
      wordCount: countWords(extracted.text),
      finalUrl: target.url.href,
      mustPreserve,
    };
  }
  // Exhausted the redirect budget.
  return { ok: false, reason: "source_fetch_failed" };
}

function isTimeout(e: unknown): boolean {
  if (e && typeof e === "object" && "name" in e) {
    const name = (e as { name?: unknown }).name;
    return name === "TimeoutError" || name === "AbortError";
  }
  return false;
}

// --- Fetch → write sequencing (pure, injectable) ---------------------------

/**
 * Sequence "extract verified source text, then write" so the invariant is
 * unit-testable and shared with index.ts: the writer is called EXACTLY once and
 * ONLY when extraction succeeds. A source-fetch/extraction failure returns the
 * discrete reason and performs NO write (so no draft and no paid writer call).
 */
export async function groundedWrite<T>(args: {
  fetchSource: () => Promise<SourceFetchResult>;
  write: (verified: SourceText) => Promise<T>;
}): Promise<{ ok: true; value: T } | { ok: false; reason: SourceFetchReason }> {
  const source = await args.fetchSource();
  if (!source.ok) return { ok: false, reason: source.reason };
  const value = await args.write(source);
  return { ok: true, value };
}

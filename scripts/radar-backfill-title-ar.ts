// Fast News Radar — one-time title_ar BACKFILL (translation only).
//
// Fills radar_shadow_articles.title_ar for the existing backlog. This is a
// TRANSLATION-ONLY pass: it writes ONLY title_ar and touches nothing else — no
// reranking, no priority/level/category/editorial_value/duplicate_status change,
// no publish state. Arabic-language originals are kept verbatim (no model call);
// non-Arabic originals get a faithful Arabic translation via the same pinned
// gpt-4o-mini + prompt the live radar-rank uses, so backfilled and forward rows
// are consistent.
//
// Idempotent: only rows with title_ar IS NULL (and a non-empty title) are
// processed, so re-running never re-translates or overwrites existing values.
//
// Run: node --experimental-strip-types scripts/radar-backfill-title-ar.ts

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// --- env (parse .env.local; do not print secrets) ---------------------------
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY!;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openai/gpt-4o-mini"; // same pinned model as radar-rank

// Mirrors radar-rank TRANSLATE_PROMPT exactly (faithful translation only).
const TRANSLATE_PROMPT =
  "أنت مترجم عناوين محترف لمنصة أخبار صحية عربية (سلمى). مهمتك ترجمة عنوان الخبر الأصلي إلى العربية الفصحى ترجمةً " +
  "أمينة فقط. قواعد صارمة: (1) ترجمة فقط، بلا إعادة صياغة أو تحرير أو تلخيص أو إضافة أي سياق أو رأي. " +
  "(2) حافظ على المعنى الأصلي بدقة. (3) احتفظ بأسماء الأشخاص والمؤسسات والأماكن والأرقام والإحصاءات والوحدات كما هي. " +
  "(4) لا تضف معلومات غير موجودة في العنوان الأصلي ولا تحذف أي معلومة منه. (5) أعِد عنوانًا عربيًا طبيعيًا موجزًا " +
  "مطابقًا لمضمون الأصل. " +
  'أعد فقط مصفوفة JSON صالحة، عنصر لكل عنوان بنفس الأرقام المُعطاة، بالشكل: ' +
  '[{"i":<رقم>,"ar":"<العنوان بالعربية>"}] دون أي نص آخر.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isArabicLang = (lang: string | null) => (lang ?? "").trim().toLowerCase().startsWith("ar");
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

type Row = { id: string; title: string | null; language: string | null };

async function translateBatch(batch: Row[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const lines = batch.map((a, j) => `${j}. ${a.title ?? ""}`).join("\n");
  let parsed: { i: number; ar: string }[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    let json: {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: TRANSLATE_PROMPT },
            { role: "user", content: `ترجم هذه العناوين:\n${lines}` },
          ],
        }),
        signal: ctrl.signal,
      });
      json = await res.json();
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
    const raw = json.choices?.[0]?.message?.content ?? "";
    if (json.error || !raw) continue;
    try {
      const s = raw.indexOf("["); const e = raw.lastIndexOf("]");
      parsed = JSON.parse(raw.slice(s, e + 1));
      break;
    } catch {
      parsed = [];
    }
  }
  for (const p of parsed) {
    const a = batch[p.i];
    const ar = String(p.ar ?? "").trim();
    if (a && ar) out.set(a.id, ar);
  }
  return out;
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data, error } = await supabase
    .from("radar_shadow_articles")
    .select("id,title,language")
    .is("title_ar", null)
    .not("title", "is", null)
    .order("first_seen_at", { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as Row[];
  const withTitle = rows.filter((r) => (r.title ?? "").trim().length > 0);
  console.log(`Backfill candidates (title_ar IS NULL, non-empty title): ${withTitle.length}`);

  let arabicVerbatim = 0;
  let translated = 0;
  let unresolved = 0;

  // Arabic originals → verbatim (no model call).
  const arabic = withTitle.filter((r) => isArabicLang(r.language));
  for (const batch of chunk(arabic, 200)) {
    for (const r of batch) {
      const { error: upErr } = await supabase
        .from("radar_shadow_articles")
        .update({ title_ar: (r.title ?? "").trim() })
        .eq("id", r.id)
        .is("title_ar", null); // never overwrite an existing value
      if (upErr) throw upErr;
      arabicVerbatim++;
    }
  }

  // Non-Arabic → batched faithful translation.
  const nonArabic = withTitle.filter((r) => !isArabicLang(r.language));
  for (const batch of chunk(nonArabic, 20)) {
    const map = await translateBatch(batch);
    for (const r of batch) {
      const ar = map.get(r.id);
      if (!ar) { unresolved++; continue; }
      const { error: upErr } = await supabase
        .from("radar_shadow_articles")
        .update({ title_ar: ar })
        .eq("id", r.id)
        .is("title_ar", null);
      if (upErr) throw upErr;
      translated++;
    }
    console.log(`  …translated ${translated}/${nonArabic.length} (unresolved so far: ${unresolved})`);
    await sleep(250);
  }

  console.log(
    `Done. arabic_verbatim=${arabicVerbatim} translated=${translated} unresolved=${unresolved} ` +
    `(unresolved rows keep title_ar NULL and can be re-run later).`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });

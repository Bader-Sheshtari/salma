"use client";

import { Fragment, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type RadarArticle,
  type RadarPriorityLevel,
  PRIORITY_LABEL,
  UNRANKED_LABEL,
  DUPLICATE_LABEL,
  langLabel,
  countryDisplay,
} from "@/lib/radar";
import {
  publishRadarStory,
  prepareRadarStory,
  translateRadarStory,
  getRadarPublishStates,
  type PublishRadarResult,
  type RadarPublishState,
} from "../../radar-actions";
import type { RadarContentLink } from "@/lib/admin-queries";

type Cat = { slug: string; name_ar: string };

// Per-article one-click publish result, held in the client so the card shows an
// unmistakable state without leaving the page or exposing raw internal codes.
type PublishUi =
  | { kind: "published" } // ✅ تم النشر في سلمى — open the article
  | { kind: "draft"; needsCover: boolean } // جاهز للتحرير — a draft Content exists, open it
  | { kind: "needs_review" } // ⚠️ يحتاج مراجعة — a Content row exists, open it
  | { kind: "already" } // موجود في سلمى — open the existing article
  | { kind: "rejected"; reason: string | null } // ⛔ pipeline stopped before Content — retry
  | { kind: "info"; msg: string }; // transient note (e.g. already publishing)

// Human-readable Arabic for an internal rejection code. Raw codes are NEVER
// shown in the normal admin UI; anything unmapped falls back to a safe generic
// editorial-validation message.
function rejectionMessage(reason: string | null): string {
  switch (reason) {
    case "invented_quotation":
      return "تم إيقاف النشر بسبب وجود اقتباس غير موثق في المسودة.";
    case "source_fetch_failed":
    case "ingest_invoke_failed":
    case "no_content_created":
      return "تعذّر تجهيز المقال من المصدر — لم يجتز التحقق التحريري.";
    case "session_expired":
      return "انتهت الجلسة أثناء المعالجة. أعد المحاولة.";
    case "processing_timeout":
      return "تأخّرت المعالجة أكثر من المعتاد فتوقّفت. أعد المحاولة.";
    default:
      return "لم يتم النشر — لم تجتز المسودة التحقق التحريري.";
  }
}

// Importance filter modes. "default" = editorial opportunities (very + important).
type ImportanceMode = "default" | "very_important" | "low" | "unranked" | "all";
// Duplicate filter modes. "opportunities" = new + possible (hides already-in-Salma).
type DupeMode = "opportunities" | "new" | "already" | "all";

const IMPORTANCE_FILTERS: { key: ImportanceMode; label: string }[] = [
  { key: "default", label: "مهم (افتراضي)" },
  { key: "very_important", label: "مهم جدًا" },
  { key: "low", label: "منخفض" },
  { key: "unranked", label: "غير مصنّف" },
  { key: "all", label: "الكل" },
];

const DUPE_FILTERS: { key: DupeMode; label: string }[] = [
  { key: "opportunities", label: "فرص (جديد + محتمل)" },
  { key: "new", label: "جديد" },
  { key: "already", label: "موجود في سلمى" },
  { key: "all", label: "الكل" },
];

function priorityClass(level: RadarPriorityLevel | null): string {
  if (level === "very_important") return "bg-red-50 text-red-700 border-red-200";
  if (level === "important") return "bg-amber-50 text-amber-700 border-amber-200";
  if (level === "low") return "bg-gray-50 text-gray-500 border-line";
  return "bg-cream text-gray border-line"; // unranked
}

function dateKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function dateGroupLabel(key: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (key === today) return "اليوم";
  if (key === yesterday) return "أمس";
  return new Date(key + "T00:00:00Z").toLocaleDateString("ar", {
    day: "numeric", month: "long", year: "numeric",
  });
}

function timeLabel(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
}

// Bidi-safe headline. The base direction is fixed by `dir` (rtl for the Arabic
// translation so a title STARTING with a Latin acronym does not flip the whole
// sentence; auto for the original headline). Each embedded Latin-script run —
// company/organization/drug names, acronyms, scientific terms, versioned tokens
// like "IMSS Bienestar", "COVID-19", "gpt-5.4" — is isolated in <bdi> so it keeps
// its natural LTR word order without disturbing the surrounding Arabic. Fully
// generic (no hard-coded strings); the stored title text is never altered.
function BidiHeadline({ text, dir, className }: { text: string; dir: "rtl" | "auto"; className?: string }) {
  const parts = useMemo(() => {
    // A Latin word: starts with a Latin letter (incl. accented Latin for names
    // like "Bienestar"), then letters/digits and intra-run punctuation. A run is
    // one or more Latin words joined by spaces ("IMSS Bienestar"); an interior
    // number joins the run ONLY when another Latin word follows it, so
    // "type 2 diabetes" stays one LTR run while a trailing Arabic-context number
    // (e.g. "Aspirin 2 حبة") is NOT swallowed.
    const word = "[A-Za-z\\u00C0-\\u024F][A-Za-z0-9\\u00C0-\\u024F.&/'’\\-]*";
    const num = "[0-9][0-9.,]*";
    const re = new RegExp(`${word}(?:\\s+(?:${num}\\s+)*${word})*`, "g");
    const out: { s: string; ltr: boolean }[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ s: text.slice(last, m.index), ltr: false });
      out.push({ s: m[0], ltr: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ s: text.slice(last), ltr: false });
    return out;
  }, [text]);
  return (
    <span className={className} dir={dir}>
      {parts.map((p, i) => (p.ltr ? <bdi key={i}>{p.s}</bdi> : <Fragment key={i}>{p.s}</Fragment>))}
    </span>
  );
}

// Per-article local UI state for translation-on-demand (never persisted).
type TranslationState = { loading: boolean; text?: string; title?: string; error?: string };

export default function RadarInbox({
  items,
  categories,
  contentLinks,
}: {
  items: RadarArticle[];
  categories: Cat[];
  contentLinks: Record<string, RadarContentLink>;
}) {
  const [importance, setImportance] = useState<ImportanceMode>("default");
  const [dupe, setDupe] = useState<DupeMode>("opportunities");
  const [cat, setCat] = useState<string>("");

  const router = useRouter();

  // Interaction state (details drawer, publish result, translation, category).
  const [openId, setOpenId] = useState<string | null>(null);
  // The row + action currently running, so the card shows the right progress
  // label (تجهيز المسودة vs النشر) and disables only that row's buttons.
  const [busy, setBusy] = useState<{ id: string; mode: "prepare" | "publish" } | null>(null);
  const [, startTransition] = useTransition();
  const [pubUi, setPubUi] = useState<Record<string, PublishUi>>({});
  // Possible-duplicate confirmation, remembering which action asked (so "continue
  // anyway" re-runs the same primary/secondary action).
  const [confirm, setConfirm] = useState<{ id: string; mode: "prepare" | "publish" } | null>(null);
  const [catOverride, setCatOverride] = useState<Record<string, string>>({});
  const [translation, setTranslation] = useState<Record<string, TranslationState>>({});

  // Live publish-state overlay for rows persisted as 'processing'. A processing
  // row can only reach its terminal state via the Edge Function's own write, so
  // we lightweightly poll (never re-running the pipeline) until it resolves,
  // then reflect the result without a manual page refresh.
  const [liveState, setLiveState] = useState<Record<string, RadarPublishState>>({});

  // Ids to poll: rows the server still reports as 'processing' whose latest poll
  // (if any) has not yet returned a terminal state. Empty → polling is idle.
  const pollIds = useMemo(
    () =>
      items
        .filter((a) => {
          if (a.publish_status !== "processing") return false;
          const ls = liveState[a.id]?.publish_status;
          return !ls || ls === "processing";
        })
        .map((a) => a.id),
    [items, liveState],
  );
  const pollKey = pollIds.join(",");

  useEffect(() => {
    if (!pollKey) return;
    const ids = pollKey.split(",");
    let cancelled = false;
    const tick = async () => {
      const res = await getRadarPublishStates(ids);
      if (!cancelled) setLiveState((m) => ({ ...m, ...res }));
    };
    const iv = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [pollKey]);

  // Open the actual public Salma article by content id, when its slug is known.
  const articleHref = (contentId: string | null): string | null => {
    if (!contentId) return null;
    const link = contentLinks[contentId];
    return link?.slug ? `/article/${link.slug}` : null;
  };

  const catName = useMemo(() => {
    const m = new Map(categories.map((c) => [c.slug, c.name_ar]));
    return (slug: string | null) => (slug ? m.get(slug) ?? slug : "—");
  }, [categories]);

  // Today's summary (by detection time — when Radar first observed the story).
  const today = new Date().toISOString().slice(0, 10);
  const summary = useMemo(() => {
    const t = items.filter((a) => dateKey(a.first_seen_at) === today);
    const s = { total: t.length, very: 0, important: 0, low: 0, unranked: 0, isNew: 0, already: 0, possible: 0 };
    for (const a of t) {
      if (a.priority_level === "very_important") s.very++;
      else if (a.priority_level === "important") s.important++;
      else if (a.priority_level === "low") s.low++;
      else s.unranked++;
      if (a.duplicate_status === "new") s.isNew++;
      else if (a.duplicate_status === "already_in_salma") s.already++;
      else if (a.duplicate_status === "possible_duplicate") s.possible++;
    }
    return s;
  }, [items, today]);

  const filtered = useMemo(() => {
    return items.filter((a) => {
      // Importance
      const lvl = a.priority_level;
      if (importance === "default" && !(lvl === "very_important" || lvl === "important")) return false;
      if (importance === "very_important" && lvl !== "very_important") return false;
      if (importance === "low" && lvl !== "low") return false;
      if (importance === "unranked" && lvl !== null) return false;
      // Duplicate status
      const d = a.duplicate_status;
      if (dupe === "opportunities" && !(d === "new" || d === "possible_duplicate")) return false;
      if (dupe === "new" && d !== "new") return false;
      if (dupe === "already" && d !== "already_in_salma") return false;
      // Category
      if (cat && a.expected_category_slug !== cat) return false;
      return true;
    });
  }, [items, importance, dupe, cat]);

  // Group filtered rows by detection date, newest date first. Within a group the
  // order is a STABLE, status-independent key: detection time (newest first) with
  // the row id as a deterministic tiebreaker. This mirrors the server order and
  // guarantees a card never moves merely because its workflow status changed
  // (untouched→processing→draft/failed/published all update the SAME card in place).
  const groups = useMemo(() => {
    const map = new Map<string, RadarArticle[]>();
    for (const a of filtered) {
      const k = dateKey(a.first_seen_at);
      (map.get(k) ?? map.set(k, []).get(k)!).push(a);
    }
    for (const rows of map.values()) {
      rows.sort((x, y) => {
        if (x.first_seen_at !== y.first_seen_at) return x.first_seen_at < y.first_seen_at ? 1 : -1;
        return x.id < y.id ? 1 : x.id > y.id ? -1 : 0;
      });
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered]);

  // Map the server result to a single clear card state. Raw internal reasons
  // (e.g. source_fetch_failed) are NEVER surfaced here — they stay in the logs.
  function applyPublishResult(a: RadarArticle, res: PublishRadarResult, mode: "prepare" | "publish") {
    const set = (ui: PublishUi) => setPubUi((m) => ({ ...m, [a.id]: ui }));
    if ("error" in res) { set({ kind: "info", msg: res.error }); return; }
    if ("ok" in res && res.ok) {
      if (res.status === "published" || res.status === "already_published") set({ kind: "published" });
      else if (res.status === "draft") set({ kind: "draft", needsCover: res.needsCover });
      else if (res.status === "needs_review") set({ kind: "needs_review" });
      return;
    }
    if ("status" in res) {
      if (res.status === "already_processing") set({ kind: "info", msg: "جارٍ التجهيز بالفعل…" });
      else if (res.status === "already_in_salma") set({ kind: "already" });
      else if (res.status === "needs_confirmation") setConfirm({ id: a.id, mode });
      else if (res.status === "failed") set({ kind: "rejected", reason: res.reason });
    }
  }

  // PRIMARY action: prepare a draft, then open the existing Content editor on it.
  // Idempotent (an existing draft/published item is opened, never re-created).
  function doPrepare(a: RadarArticle, confirmPossibleDuplicate = false) {
    setBusy({ id: a.id, mode: "prepare" });
    setPubUi((m) => { const n = { ...m }; delete n[a.id]; return n; });
    startTransition(async () => {
      const res = await prepareRadarStory(a.id, {
        categorySlug: catOverride[a.id] ?? a.expected_category_slug ?? null,
        confirmPossibleDuplicate,
      });
      applyPublishResult(a, res, "prepare");
      setBusy(null);
      setConfirm((c) => (c?.id === a.id ? null : c));
      // On a prepared/existing draft, go straight to the editor to review/publish.
      if ("ok" in res && res.ok && (res.status === "draft" || res.status === "needs_review")) {
        router.push(`/admin/content/${res.contentId}`);
      }
    });
  }

  // SECONDARY action: direct publish. A clean article with no cover falls back to
  // 'draft' (never an image-less publish) — shown on the card, not auto-opened.
  function doPublish(a: RadarArticle, confirmPossibleDuplicate = false) {
    setBusy({ id: a.id, mode: "publish" });
    setPubUi((m) => { const n = { ...m }; delete n[a.id]; return n; });
    startTransition(async () => {
      const res = await publishRadarStory(a.id, {
        categorySlug: catOverride[a.id] ?? a.expected_category_slug ?? null,
        confirmPossibleDuplicate,
      });
      applyPublishResult(a, res, "publish");
      setBusy(null);
      setConfirm((c) => (c?.id === a.id ? null : c));
    });
  }

  function doTranslate(a: RadarArticle) {
    setTranslation((t) => ({ ...t, [a.id]: { loading: true } }));
    startTransition(async () => {
      const res = await translateRadarStory(a.id);
      if ("error" in res) setTranslation((t) => ({ ...t, [a.id]: { loading: false, error: res.error } }));
      else setTranslation((t) => ({ ...t, [a.id]: { loading: false, text: res.text, title: res.titleOriginal ?? undefined } }));
    });
  }

  return (
    <div>
      {/* Summary bar */}
      <div className="mb-4 flex flex-wrap gap-2 text-[12.5px]">
        <SummaryCard label="اليوم" value={summary.total} strong />
        <SummaryCard label="🔴 مهم جدًا" value={summary.very} />
        <SummaryCard label="🟡 مهم" value={summary.important} />
        <SummaryCard label="⚪ منخفض" value={summary.low} />
        <SummaryCard label="جديد" value={summary.isNew} />
        <SummaryCard label="موجود في سلمى" value={summary.already} />
        {summary.unranked > 0 && <SummaryCard label="◻︎ غير مصنّف" value={summary.unranked} warn />}
      </div>

      {summary.unranked > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
          يوجد {summary.unranked} خبر غير مُصنّف بعد (التصنيف الآلي يُشغَّل لاحقًا). لعرضها اختر «غير مصنّف» أو «الكل».
        </div>
      )}

      {/* Filters */}
      <div className="mb-3 space-y-2">
        <FilterRow label="الأهمية">
          {IMPORTANCE_FILTERS.map((f) => (
            <Chip key={f.key} active={importance === f.key} onClick={() => setImportance(f.key)}>
              {f.label}
            </Chip>
          ))}
        </FilterRow>
        <FilterRow label="التكرار">
          {DUPE_FILTERS.map((f) => (
            <Chip key={f.key} active={dupe === f.key} onClick={() => setDupe(f.key)}>
              {f.label}
            </Chip>
          ))}
        </FilterRow>
        <FilterRow label="القسم">
          <Chip active={cat === ""} onClick={() => setCat("")}>الكل</Chip>
          {categories.map((c) => (
            <Chip key={c.slug} active={cat === c.slug} onClick={() => setCat(c.slug)}>
              {c.name_ar}
            </Chip>
          ))}
        </FilterRow>
      </div>

      <div className="mb-3 text-[12px] text-gray">{filtered.length} خبر معروض</div>

      {groups.length === 0 && (
        <div className="rounded-lg border border-line bg-white p-6 text-center text-[13px] text-gray">
          لا توجد أخبار مطابقة للفلاتر الحالية.
        </div>
      )}

      {groups.map(([key, rows]) => (
        <section key={key} className="mb-5">
          <h2 className="mb-2 text-[13px] font-bold text-gray">{dateGroupLabel(key)}</h2>
          <div className="space-y-2">
            {rows.map((a) => {
              const isOpen = openId === a.id;
              const isBusy = busy?.id === a.id;
              const busyMode = isBusy ? busy!.mode : null;
              const ui = pubUi[a.id];
              // Effective state = persisted publish_status (authoritative after
              // revalidation), overlaid — ONLY while the server still says
              // 'processing' — with the latest lightweight poll result, then with
              // this session's one-click result. Once the server reports a
              // terminal state we trust it and drop the poll overlay.
              const live = a.publish_status === "processing" ? liveState[a.id] : undefined;
              const effStatus = live?.publish_status ?? a.publish_status;
              const effContentId = live?.published_content_id ?? a.published_content_id;
              const effError = live?.publish_error ?? a.publish_error;
              const effSlug = live?.slug ?? null;
              const hasContent = !!effContentId;
              // Publication is derived from the LINKED Content's status (the single
              // source of truth): a 'draft' row whose Content was published in the
              // editor shows as published without any content→radar write-back.
              const linkedStatus = effContentId
                ? (live?.content_status ?? contentLinks[effContentId]?.status ?? null)
                : null;
              const published = effStatus === "published" || linkedStatus === "published" || ui?.kind === "published";
              const processing = !published && (effStatus === "processing" || isBusy);
              // Prepared draft: a real Content item exists, kept `pending`, ready to
              // edit. needsCover flags a missing cover image (publish_error marker).
              const isDraft = !published && !processing && hasContent &&
                (effStatus === "draft" || ui?.kind === "draft");
              const needsCover = isDraft &&
                (ui?.kind === "draft" ? ui.needsCover : effError === "needs_cover");
              // Case 1 — a Content row exists and awaits human review (only via a
              // direct publish of an unclean article). Distinct from a draft.
              const needsReview = !published && !isDraft && hasContent &&
                (effStatus === "needs_review" || ui?.kind === "needs_review");
              const alreadyInSalma = a.duplicate_status === "already_in_salma" || ui?.kind === "already";
              // Case 2 — the pipeline stopped BEFORE any Content row: source
              // retrieval failed, or Writer/Editor/Fidelity/validation rejected the
              // draft. Includes legacy rows persisted as 'needs_review' before this
              // fix (needs_review + null published_content_id).
              const rejected = !published && !needsReview && !isDraft && (
                effStatus === "failed" ||
                ui?.kind === "rejected" ||
                (effStatus === "needs_review" && !hasContent)
              );
              const rejectionReason = ui?.kind === "rejected" ? ui.reason : effError;
              // Link targets: published → the public article; draft/needs-review →
              // the Content editor; duplicate → the existing public article.
              const publishedArticleHref =
                articleHref(effContentId) ?? (effSlug ? `/article/${effSlug}` : null);
              const editorHref = effContentId ? `/admin/content/${effContentId}` : null;
              const existingArticleHref = articleHref(a.matched_content_id);
              const tr = translation[a.id];
              const selectedCat = catOverride[a.id] ?? a.expected_category_slug ?? "";
              const country = countryDisplay(a.country);
              const sourceName = a.source_title ?? a.source_domain ?? null;
              return (
                <article key={a.id} className="rounded-xl border border-line bg-white p-3">
                  {/* Top tag row: RADAR · priority · category · country · source · duplicate. */}
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="rounded-md bg-ink px-1.5 py-0.5 font-sans text-[9px] font-bold tracking-wide text-white">
                      RADAR
                    </span>
                    <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-bold ${priorityClass(a.priority_level)}`}>
                      {a.priority_level ? PRIORITY_LABEL[a.priority_level] : UNRANKED_LABEL}
                      {a.priority_score !== null && <span className="opacity-60"> · {a.priority_score}</span>}
                    </span>
                    <span className="rounded-md border border-line bg-cream px-1.5 py-0.5 text-[11px] font-semibold text-teal">
                      {catName(a.expected_category_slug)}
                    </span>
                    {country && (
                      <span className="rounded-md border border-line bg-white px-1.5 py-0.5 text-[11px] font-semibold text-ink">
                        {country.flag && <span className="me-0.5">{country.flag}</span>}
                        {country.label}
                      </span>
                    )}
                    {sourceName && (
                      <span
                        title={sourceName}
                        className="inline-block max-w-[150px] truncate rounded-md border border-line bg-white px-1.5 py-0.5 align-middle text-[11px] font-medium text-gray"
                      >
                        {sourceName}
                      </span>
                    )}
                    {a.duplicate_status && a.duplicate_status !== "new" ? (
                      a.matched_content_id ? (
                        <Link
                          href={`/admin/content/${a.matched_content_id}`}
                          className="rounded-md border border-line px-1.5 py-0.5 text-[11px] font-semibold text-ink underline hover:bg-cream"
                        >
                          {DUPLICATE_LABEL[a.duplicate_status]} ↗
                        </Link>
                      ) : (
                        <span className="rounded-md border border-line px-1.5 py-0.5 text-[11px] font-semibold text-gray">
                          {DUPLICATE_LABEL[a.duplicate_status]}
                        </span>
                      )
                    ) : a.duplicate_status === "new" ? (
                      <span className="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                        جديد
                      </span>
                    ) : null}
                    {published && (
                      <span className="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-bold text-emerald-700">
                        منشور
                      </span>
                    )}
                    {isDraft && (
                      <span className="rounded-md border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[11px] font-bold text-sky-700">
                        مسودة
                      </span>
                    )}
                    {needsReview && (
                      <span className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-bold text-amber-700">
                        يحتاج مراجعة
                      </span>
                    )}
                  </div>

                  {/* Primary headline: Arabic title_ar (RTL base, Latin runs
                      isolated). Secondary: original headline in its own natural
                      direction. Stored text is never modified. */}
                  <div className="mb-1" dir="rtl">
                    <BidiHeadline
                      text={a.title_ar ?? a.title ?? "—"}
                      dir={a.title_ar ? "rtl" : "auto"}
                      className="block text-[15.5px] font-bold leading-snug text-ink"
                    />
                    {a.title_ar && a.title && a.title_ar !== a.title && (
                      <BidiHeadline
                        text={a.title}
                        dir="auto"
                        className="mt-0.5 block text-[12px] leading-snug text-gray"
                      />
                    )}
                  </div>

                  {/* Bottom metadata: language · published time · Radar detected time. */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 font-sans text-[11px] text-gray">
                    <span>{langLabel(a.language)}</span>
                    {a.published_at && <span>· نُشر {timeLabel(a.published_at)}</span>}
                    <span>· رُصد {timeLabel(a.first_seen_at)}</span>
                  </div>

                  {/* Actions + the unmistakable one-click publish result. Stays
                      on this page; never shows a raw internal code. */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setOpenId(isOpen ? null : a.id)}
                      className="rounded-lg border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-cream"
                    >
                      {isOpen ? "إخفاء التفاصيل" : "عرض التفاصيل"}
                    </button>

                    {published ? (
                      <>
                        <span className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[12.5px] font-bold text-emerald-700">
                          ✅ تم النشر في سلمى
                        </span>
                        {publishedArticleHref ? (
                          <Link href={publishedArticleHref} target="_blank" className="text-[12.5px] font-semibold text-teal underline">
                            فتح المقال ↗
                          </Link>
                        ) : editorHref ? (
                          <Link href={editorHref} className="text-[12.5px] font-semibold text-teal underline">
                            فتح في المحتوى ↗
                          </Link>
                        ) : null}
                      </>
                    ) : processing ? (
                      <span className="rounded-lg border border-line bg-cream px-3 py-1.5 text-[12.5px] font-bold text-gray">
                        {busyMode === "publish" ? "جاري النشر…" : "جاري تجهيز المسودة…"}
                      </span>
                    ) : isDraft ? (
                      <>
                        <span className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-[12.5px] font-bold text-sky-700">
                          جاهز للتحرير{needsCover ? " — يحتاج صورة غلاف" : ""}
                        </span>
                        {editorHref && (
                          <Link href={editorHref} className="rounded-lg bg-teal px-3 py-1.5 text-[12.5px] font-bold text-white">
                            فتح المسودة
                          </Link>
                        )}
                      </>
                    ) : needsReview ? (
                      <>
                        <span className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[12.5px] font-bold text-amber-700">
                          ⚠️ يحتاج مراجعة
                        </span>
                        {editorHref && (
                          <Link href={editorHref} className="text-[12.5px] font-semibold text-teal underline">
                            فتح في المحتوى ↗
                          </Link>
                        )}
                      </>
                    ) : alreadyInSalma ? (
                      <>
                        <span className="rounded-lg border border-line bg-cream px-3 py-1.5 text-[12.5px] font-bold text-gray">
                          موجود في سلمى
                        </span>
                        {existingArticleHref ? (
                          <Link href={existingArticleHref} target="_blank" className="text-[12.5px] font-semibold text-teal underline">
                            فتح المقال الموجود ↗
                          </Link>
                        ) : a.matched_content_id ? (
                          <Link href={`/admin/content/${a.matched_content_id}`} className="text-[12.5px] font-semibold text-teal underline">
                            فتح في المحتوى ↗
                          </Link>
                        ) : null}
                      </>
                    ) : rejected ? (
                      <>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => doPrepare(a)}
                          className="rounded-lg bg-teal px-3 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-50"
                        >
                          إعادة المحاولة
                        </button>
                        <span className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-[12.5px] font-bold text-red-700">
                          ⛔ لم يتم تجهيز المقال
                        </span>
                        <span className="text-[12px] text-gray">{rejectionMessage(rejectionReason)}</span>
                        <a href={a.url ?? "#"} target="_blank" rel="noopener noreferrer" className="text-[12.5px] font-semibold text-teal underline">
                          فتح المصدر الأصلي ↗
                        </a>
                      </>
                    ) : (
                      <>
                        {/* PRIMARY: prepare a draft in the Content editor. */}
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => doPrepare(a)}
                          className="rounded-lg bg-teal px-3 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-50"
                        >
                          تحرير في سلمى
                        </button>
                        {/* SECONDARY: direct publish (validated one-click pipeline). */}
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => doPublish(a)}
                          className="rounded-lg border border-line bg-white px-3 py-1.5 text-[12px] font-semibold text-gray hover:bg-cream disabled:opacity-50"
                        >
                          نشر مباشر
                        </button>
                      </>
                    )}
                  </div>

                  {/* Possible-duplicate confirmation. */}
                  {confirm?.id === a.id && (
                    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[12.5px] text-amber-900">
                      قد يكون هذا الخبر مكررًا لخبر موجود في سلمى.
                      {a.matched_content_id && (
                        <Link href={`/admin/content/${a.matched_content_id}`} className="mx-1 underline">
                          افتح الخبر الموجود ↗
                        </Link>
                      )}
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => (confirm?.mode === "publish" ? doPublish(a, true) : doPrepare(a, true))}
                          className="rounded-md bg-amber-600 px-2.5 py-1 text-[12px] font-bold text-white disabled:opacity-50"
                        >
                          {confirm?.mode === "publish" ? "انشر على أي حال" : "تابع التحرير على أي حال"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirm(null)}
                          className="rounded-md border border-amber-300 px-2.5 py-1 text-[12px] font-semibold text-amber-800"
                        >
                          إلغاء
                        </button>
                      </div>
                    </div>
                  )}

                  {ui?.kind === "info" && (
                    <div className="mt-2 text-[12px] font-semibold text-ink">{ui.msg}</div>
                  )}

                  {/* Details drawer. */}
                  {isOpen && (
                    <div className="mt-2.5 rounded-lg border border-line bg-cream/60 p-3">
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-gray sm:grid-cols-3">
                        <Meta label="المصدر" value={a.source_title ?? a.source_domain ?? "—"} />
                        <Meta label="الدولة" value={a.country ?? "—"} />
                        <Meta label="اللغة" value={langLabel(a.language)} />
                        <Meta label="القيمة التحريرية" value={a.priority_level ? PRIORITY_LABEL[a.priority_level] : UNRANKED_LABEL} />
                        <Meta label="القسم المقترح" value={catName(a.expected_category_slug)} />
                        <Meta label="التكرار" value={a.duplicate_status ? DUPLICATE_LABEL[a.duplicate_status] : "—"} />
                      </dl>

                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <a
                          href={a.url ?? "#"}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[12.5px] font-semibold text-teal underline"
                        >
                          فتح المصدر الأصلي ↗
                        </a>

                        {/* Inline category override before publishing. */}
                        <label className="flex items-center gap-1.5 text-[12px] text-gray">
                          القسم عند النشر:
                          <select
                            value={selectedCat}
                            onChange={(e) => setCatOverride((m) => ({ ...m, [a.id]: e.target.value }))}
                            className="rounded-md border border-line bg-white px-2 py-1 text-[12.5px] text-ink"
                          >
                            <option value="">— اختر —</option>
                            {categories.map((c) => (
                              <option key={c.slug} value={c.slug}>{c.name_ar}</option>
                            ))}
                          </select>
                        </label>
                      </div>

                      {/* On-demand translation (reading aid; never auto, never published). */}
                      <div className="mt-3 border-t border-line pt-2.5">
                        <button
                          type="button"
                          disabled={tr?.loading}
                          onClick={() => doTranslate(a)}
                          className="rounded-lg border border-teal px-3 py-1.5 text-[12.5px] font-semibold text-teal hover:bg-teal/5 disabled:opacity-50"
                        >
                          {tr?.loading ? "…جارٍ الترجمة" : "ترجمة الخبر (قراءة فقط)"}
                        </button>
                        <p className="mt-1 text-[11px] text-gray">
                          ترجمة للقراءة فقط — لا تُنشر ولا تُستخدم في الكتابة. يعتمد النشر دائمًا على المصدر الأصلي.
                        </p>
                        {tr?.error && <div className="mt-2 text-[12px] text-red-600">{tr.error}</div>}
                        {tr?.text && (
                          <div className="mt-2 rounded-md border border-line bg-white p-2.5" dir="rtl">
                            {tr.title && <div className="mb-1 text-[13px] font-bold text-ink" dir="auto">{tr.title}</div>}
                            <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{tr.text}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10.5px] font-semibold text-gray/70">{label}</dt>
      <dd className="font-semibold text-ink">{value}</dd>
    </div>
  );
}

function SummaryCard({ label, value, strong, warn }: { label: string; value: number; strong?: boolean; warn?: boolean }) {
  return (
    <div
      className={`rounded-lg border px-3 py-1.5 ${
        warn ? "border-amber-200 bg-amber-50 text-amber-800" : "border-line bg-white text-ink"
      }`}
    >
      <span className={strong ? "font-bold" : "font-semibold"}>{label}: </span>
      <span className="font-bold">{value}</span>
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[12px] font-semibold text-gray">{label}</span>
      <div className="salma-scroll flex gap-1.5 overflow-x-auto">{children}</div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`whitespace-nowrap rounded-full px-3 py-1 text-[12.5px] font-semibold ${
        active ? "bg-teal text-white" : "border border-line bg-white text-gray hover:bg-cream"
      }`}
    >
      {children}
    </button>
  );
}

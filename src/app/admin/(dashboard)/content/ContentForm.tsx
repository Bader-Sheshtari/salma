"use client";

import { useActionState, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { saveContent, setStatus, softDeleteContent, type ContentSaveResult } from "../../actions";
import {
  generateCoverImage,
  fetchOfficialAssets,
  type ImageCandidate,
  type OfficialAsset,
} from "../../image-actions";
import { uploadToMedia } from "@/lib/upload";
import type { Content, ContentSource, ContentMedia, Category } from "@/lib/queries";

const TYPES = [
  { v: "news", l: "خبر" },
  { v: "article", l: "مقال" },
  { v: "video", l: "فيديو" },
  { v: "investigation", l: "تحقيق" },
];

const STATUSES = [
  { v: "draft", l: "مسودّة" },
  { v: "pending", l: "بانتظار المراجعة" },
  { v: "published", l: "منشور" },
];

const field =
  "mt-1.5 w-full rounded-lg border border-gray/40 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-teal";
const label = "block text-[13px] font-semibold text-ink";
const subField =
  "w-full rounded-lg border border-gray/40 bg-white px-3 py-2 text-sm outline-none focus:border-teal";

type MediaItem = {
  type: "image" | "video";
  url: string;
  storage_path: string | null;
  caption: string;
  credit_name: string;
  credit_url: string;
};

export function ContentForm({
  content,
  sources,
  media,
  categories,
}: {
  content?: Content;
  sources?: ContentSource[];
  media?: ContentMedia[];
  categories: Category[];
}) {
  const [state, formAction, pending] = useActionState<ContentSaveResult, FormData>(saveContent, null);
  const [rows, setRows] = useState<{ label: string; url: string }[]>(
    sources && sources.length > 0
      ? sources.map((s) => ({ label: s.label, url: s.url ?? "" }))
      : [{ label: "", url: "" }],
  );
  const [type, setType] = useState(content?.type ?? "news");

  // After a successful save the action returns { ok, id, status } instead of
  // redirecting, so we can offer next-action buttons. `savedId` lets a freshly
  // created item keep editing the same row rather than inserting a duplicate.
  const saved = state && "ok" in state ? state : null;
  const savedId = saved?.id ?? content?.id ?? "";
  const [dismissed, setDismissed] = useState(false);
  // Re-show the success panel whenever a new save result arrives. Tracking the
  // previous `state` and adjusting during render (instead of in an effect)
  // avoids the extra render pass the set-state-in-effect rule warns about while
  // keeping identical behavior: reset only on a fresh "ok" result, never on mount.
  const [prevState, setPrevState] = useState(state);
  if (state !== prevState) {
    setPrevState(state);
    if (state && "ok" in state) setDismissed(false);
  }

  // Publication-readiness mirrors: kept in sync with the uncontrolled fields via
  // onChange so the readiness banner + the no-cover publish guard react live.
  const [titleVal, setTitleVal] = useState(content?.title ?? "");
  const [categoryVal, setCategoryVal] = useState(content?.category_slug ?? "");
  const [bodyVal, setBodyVal] = useState(content?.body ?? "");
  const [statusVal, setStatusVal] = useState(content?.status ?? "draft");
  const [noCoverConfirm, setNoCoverConfirm] = useState(false);
  // When the admin explicitly confirms publishing without a cover, let the next
  // submit through without re-prompting.
  const bypassNoCover = useRef(false);

  // Cover
  const formRef = useRef<HTMLFormElement>(null);
  const [coverUrl, setCoverUrl] = useState(content?.cover_image_url ?? "");
  const [coverBusy, setCoverBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  // AI candidates ACCUMULATED across this editor session (deduped by url), so
  // earlier generations stay comparable and selectable — a new generation adds
  // candidates, never destroys prior ones.
  const [aiCandidates, setAiCandidates] = useState<ImageCandidate[]>([]);
  const [aiQuality, setAiQuality] = useState<"fast" | "premium">("fast");
  // URLs from the MOST RECENT generation — badged «جديدة» so a new candidate is
  // unmistakable without changing the current cover.
  const [freshUrls, setFreshUrls] = useState<Set<string>>(new Set());
  // Non-binding editorial hint from the planner: which cover is strongest — the
  // original image, a real official asset from an authoritative source, or an AI
  // illustration. Generation is intentionally ONE image per click (no batch).
  const [assetRec, setAssetRec] = useState<{ decision: "original_source" | "official_asset" | "generate"; reason: string }>({
    decision: "generate",
    reason: "",
  });
  // The ORIGINAL source image (publisher), persisted separately from the cover.
  // Always available as a selectable candidate; never overwritten by AI/upload.
  const originalImageUrl = content?.source_image_url ?? "";
  // Official images pulled from authoritative pages ALREADY linked to the article
  // (retrieval ≠ selection — they only appear as candidates until clicked).
  const [officialAssets, setOfficialAssets] = useState<OfficialAsset[]>([]);
  const [officialBusy, setOfficialBusy] = useState(false);
  const [officialError, setOfficialError] = useState("");
  const [officialFetched, setOfficialFetched] = useState(false);

  // Media gallery
  const [items, setItems] = useState<MediaItem[]>(
    (media ?? []).map((m) => ({
      type: m.type === "video" ? "video" : "image",
      url: m.url,
      storage_path: m.storage_path,
      caption: m.caption ?? "",
      credit_name: m.credit_name ?? "",
      credit_url: m.credit_url ?? "",
    })),
  );
  const [busy, setBusy] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState("");

  const patchItem = (i: number, patch: Partial<MediaItem>) =>
    setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function handleCover(file: File) {
    setUploadError("");
    setCoverBusy(true);
    try {
      const up = await uploadToMedia(file);
      // An upload becomes the current cover but does NOT destroy the original
      // image option or the session's AI candidates (they stay selectable).
      setCoverUrl(up.url);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "تعذّر رفع الصورة.");
    } finally {
      setCoverBusy(false);
    }
  }

  async function handleGenerateCover() {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    const title = String(fd.get("title") ?? "").trim();
    const excerpt = String(fd.get("excerpt") ?? "").trim();
    const summary = String(fd.get("ai_summary") ?? "").trim();
    const bodyContent = String(fd.get("body") ?? "").trim();
    const category = String(fd.get("category_slug") ?? "").trim();
    const sourceName = String(fd.get("source_name") ?? "").trim();
    if (title.length < 4) {
      setAiError("أدخل عنوان الخبر أولاً لتُبنى الصورة عليه.");
      return;
    }
    setAiError("");
    setAiBusy(true);
    try {
      // Steer the planner AWAY from concepts already generated this session so a
      // new request explores a genuinely different visual direction.
      const avoidConcepts = aiCandidates.map((c) => c.conceptSummary).filter(Boolean);
      const r = await generateCoverImage({
        title,
        originalTitle: content?.original_title ?? "",
        excerpt,
        summary,
        body: bodyContent,
        category,
        sourceName,
        quality: aiQuality,
        count: 1, // intentionally ONE image per click (sequential, cost-controlled)
        avoidConcepts,
        hasSourceImage: !!originalImageUrl,
      });
      if ("ok" in r) {
        // Add the new candidate(s) to the gallery, NEWEST FIRST, and badge them
        // «جديدة». Generation NEVER changes the current cover — selection is a
        // separate, explicit action (the editor clicks a candidate to use it).
        const fresh = new Set<string>();
        setAiCandidates((prev) => {
          const seen = new Set(prev.map((c) => c.url));
          const added: ImageCandidate[] = [];
          for (const c of r.candidates) if (!seen.has(c.url)) { seen.add(c.url); added.push(c); fresh.add(c.url); }
          return [...added, ...prev];
        });
        setFreshUrls(fresh);
        setAssetRec({ decision: r.recommendation.decision, reason: r.recommendation.reason });
      } else {
        setAiError(r.error);
      }
    } catch {
      setAiError("تعذّر توليد الصور، حاول مرة أخرى.");
    } finally {
      setAiBusy(false);
    }
  }

  // Already-known authoritative URLs for this article (its source links). NEVER
  // open-web discovery — only URLs already associated with the content.
  const knownSourceUrls = useMemo(() => {
    const seen = new Set<string>();
    const out: { url: string; label: string }[] = [];
    const add = (url?: string | null, label?: string | null) => {
      const u = String(url ?? "").trim();
      if (/^https?:\/\//i.test(u) && !seen.has(u)) { seen.add(u); out.push({ url: u, label: String(label ?? "").trim() }); }
    };
    for (const r of rows) add(r.url, r.label);
    add(content?.source_url, content?.source_name);
    add(content?.original_url, content?.source_name);
    return out;
  }, [rows, content?.source_url, content?.original_url, content?.source_name]);

  async function handleFetchOfficial() {
    setOfficialError("");
    setOfficialBusy(true);
    try {
      const r = await fetchOfficialAssets({ urls: knownSourceUrls });
      if ("ok" in r) {
        // Dedupe against the original image so it isn't listed twice.
        setOfficialAssets(r.assets.filter((a) => a.imageUrl !== originalImageUrl));
        setOfficialFetched(true);
      } else {
        setOfficialError(r.error);
      }
    } catch {
      setOfficialError("تعذّر جلب الصور الرسمية.");
    } finally {
      setOfficialBusy(false);
    }
  }

  async function handleItemUpload(i: number, file: File) {
    setUploadError("");
    setBusy(i);
    try {
      const up = await uploadToMedia(file);
      patchItem(i, { url: up.url, storage_path: up.storage_path });
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "تعذّر رفع الملف.");
    } finally {
      setBusy(null);
    }
  }

  // Publication-readiness warnings (non-blocking): surfaced so a normal article
  // is not published looking incomplete. A missing cover is highlighted because
  // the editorial default is that a Salma article HAS a cover image.
  const readiness = useMemo(() => {
    const w: string[] = [];
    if (!coverUrl) w.push("لا توجد صورة غلاف");
    if (titleVal.trim().length < 4) w.push("عنوان فارغ");
    if (bodyVal.trim().length < 40) w.push("محتوى غير مكتمل");
    if (!categoryVal.trim()) w.push("لم يتم اختيار القسم");
    return w;
  }, [coverUrl, titleVal, bodyVal, categoryVal]);

  // Guard: never SILENTLY publish an image-less article (the main editor form OR
  // the quick «نشر الآن» shortcut). If a publish is requested with no cover, prompt
  // once; the admin may deliberately continue. Remembers which form to resubmit.
  const pendingForm = useRef<HTMLFormElement | null>(null);
  function guardSubmit(e: React.FormEvent<HTMLFormElement>, isPublishing: boolean) {
    if (bypassNoCover.current) { bypassNoCover.current = false; return; }
    if (isPublishing && !coverUrl) {
      e.preventDefault();
      pendingForm.current = e.currentTarget;
      setNoCoverConfirm(true);
    }
  }
  function confirmPublishNoCover() {
    setNoCoverConfirm(false);
    bypassNoCover.current = true;
    pendingForm.current?.requestSubmit();
  }

  return (
    <>
    {noCoverConfirm && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
        <div className="w-full max-w-md rounded-xl border border-line bg-white p-4 shadow-lg">
          <div className="text-[14px] font-bold text-ink">نشر بدون صورة غلاف؟</div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-gray">
            لا توجد صورة غلاف لهذا المقال. المقال الاعتيادي في سلمى يُنشر عادةً بصورة غلاف.
            يمكنك إضافة صورة الآن، أو المتابعة والنشر بدون صورة بشكل صريح.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setNoCoverConfirm(false)}
              className="rounded-md border border-line px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-cream"
            >
              إضافة صورة أولًا
            </button>
            <button
              type="button"
              onClick={confirmPublishNoCover}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-[12.5px] font-bold text-white"
            >
              انشر بدون صورة
            </button>
          </div>
        </div>
      </div>
    )}
    <form ref={formRef} action={formAction} onSubmit={(e) => guardSubmit(e, statusVal === "published")} className="flex max-w-2xl flex-col gap-4">
      {savedId ? <input type="hidden" name="id" value={savedId} /> : null}

      {readiness.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
          <span className="font-bold">تنبيهات الجاهزية للنشر:</span>{" "}
          {readiness.join(" · ")}
          {!coverUrl && (
            <span className="mt-1 block text-[11.5px] text-amber-800">
              المقال الاعتيادي في سلمى يجب أن يحتوي صورة غلاف. أضِف صورة قبل النشر، أو تابع النشر بدون صورة بشكل صريح.
            </span>
          )}
        </div>
      )}

      <label className={label}>
        العنوان
        <input name="title" defaultValue={content?.title ?? ""} onChange={(e) => setTitleVal(e.target.value)} required className={field} />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          النوع
          <select name="type" value={type} onChange={(e) => setType(e.target.value)} className={field}>
            {TYPES.map((t) => (
              <option key={t.v} value={t.v}>{t.l}</option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] leading-relaxed text-gray">
            «فيديو» يظهر في قسم «فيديو وتبسيط طبي» بالصفحة الرئيسية. لإضافة فيديو داخل خبر أو مقال
            يبقى في قسمه المختار فقط، اختر «خبر» أو «مقال» والصق الرابط في حقل «رابط فيديو» أدناه.
          </span>
        </label>
        <label className={label}>
          الحالة
          <select name="status" defaultValue={content?.status ?? "draft"} onChange={(e) => setStatusVal(e.target.value)} className={field}>
            {STATUSES.map((s) => (
              <option key={s.v} value={s.v}>{s.l}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          القسم
          <select name="category_slug" defaultValue={content?.category_slug ?? ""} onChange={(e) => setCategoryVal(e.target.value)} className={field}>
            <option value="">— بدون —</option>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>{c.name_ar}</option>
            ))}
          </select>
        </label>
        <label className={label}>
          الرابط (slug) — اختياري
          <input name="slug" defaultValue={content?.slug ?? ""} dir="ltr" placeholder="auto" className={field} />
        </label>
      </div>

      <label className={label}>
        مقتطف
        <textarea name="excerpt" defaultValue={content?.excerpt ?? ""} rows={2} className={field} />
      </label>

      <label className={label}>
        باختصار (ملخص سريع يظهر أعلى المقال)
        <textarea
          name="ai_summary"
          defaultValue={content?.ai_summary ?? ""}
          rows={3}
          placeholder="نقاط سريعة تلخّص الخبر للقارئ المستعجل — اتركه فارغاً لإخفاء الصندوق."
          className={field}
        />
      </label>

      <label className={label}>
        النص
        <textarea name="body" defaultValue={content?.body ?? ""} onChange={(e) => setBodyVal(e.target.value)} rows={8} className={field} />
      </label>

      {/* COVER IMAGE (uploaded) + credit */}
      <div className="rounded-2xl border border-line p-4">
        <div className="mb-2 text-[13px] font-bold">صورة الغلاف</div>
        <input type="hidden" name="cover_image_url" value={coverUrl} />
        {coverUrl ? (
          <div className="mb-3 overflow-hidden rounded-lg border border-line">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={coverUrl} alt="معاينة الغلاف" className="aspect-[16/9] w-full object-cover" />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <label className="cursor-pointer rounded-lg border border-line px-4 py-2 text-[13px] font-semibold text-teal hover:bg-cream">
            {coverBusy ? "جارٍ الرفع…" : coverUrl ? "تغيير الصورة" : "رفع صورة الغلاف"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={coverBusy || aiBusy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleCover(f);
                e.target.value = "";
              }}
            />
          </label>
          <button
            type="button"
            onClick={handleGenerateCover}
            disabled={aiBusy || coverBusy}
            className="rounded-lg border border-teal bg-teal/5 px-4 py-2 text-[13px] font-semibold text-teal hover:bg-teal/10 disabled:opacity-60"
          >
            {aiBusy
              ? "جارٍ التوليد…"
              : aiCandidates.length > 0
                ? "توليد صورة أخرى ✨"
                : "توليد صورة بالذكاء الاصطناعي ✨"}
          </button>
          {knownSourceUrls.length > 0 ? (
            <button
              type="button"
              onClick={handleFetchOfficial}
              disabled={officialBusy || aiBusy || coverBusy}
              title="يفحص صفحات المصادر الرسمية المرتبطة بالخبر ويعرض صورها الرسمية — دون بحث عام على الويب"
              className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold text-ink hover:bg-cream disabled:opacity-60"
            >
              {officialBusy ? "جارٍ الجلب…" : "جلب صور من المصادر الرسمية"}
            </button>
          ) : null}
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-gray">الوضع:</span>
            <div className="inline-flex overflow-hidden rounded-lg border border-line text-[12px] font-semibold">
              <button
                type="button"
                onClick={() => setAiQuality("fast")}
                disabled={aiBusy || coverBusy}
                aria-pressed={aiQuality === "fast"}
                className={`px-3 py-2 transition ${aiQuality === "fast" ? "bg-teal text-white" : "text-teal hover:bg-cream"}`}
              >
                توليد سريع
              </button>
              <button
                type="button"
                onClick={() => setAiQuality("premium")}
                disabled={aiBusy || coverBusy}
                aria-pressed={aiQuality === "premium"}
                className={`px-3 py-2 transition ${aiQuality === "premium" ? "bg-teal text-white" : "text-teal hover:bg-cream"}`}
              >
                جودة عالية
              </button>
            </div>
          </div>
          {coverUrl ? (
            <button
              type="button"
              onClick={() => setCoverUrl("")}
              className="text-[13px] font-semibold text-coral"
            >
              إزالة
            </button>
          ) : null}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-gray">
          يفهم النظام محتوى المقال أولاً ثم يبني أقوى مفهوم بصري خاص بهذا الخبر تحديداً. كل ضغطة على الزر
          تُولّد صورة واحدة جديدة باتجاه بصري مختلف عمّا سبق. التوليد لا يغيّر الغلاف الحالي؛ تظهر الصورة
          الجديدة في المعرض بشارة «جديدة»، وتصبح غلافاً فقط عند الضغط عليها. «توليد سريع» أسرع، و«جودة
          عالية» إخراج تحريري أعمق. تبقى «الصورة الأصلية» وكل الصور المُولّدة في هذه الجلسة متاحة للاختيار.
        </p>
        {aiError ? <div className="mt-2 text-[13px] text-coral">{aiError}</div> : null}
        {assetRec.decision === "original_source" && originalImageUrl ? (
          <div className="mt-2 rounded-lg border border-teal/40 bg-teal/5 px-3 py-2 text-[12px] text-teal">
            توصية تحريرية: «الصورة الأصلية» من المصدر قد تكون الأقوى لهذا الخبر.
            {assetRec.reason ? <span className="text-gray"> — {assetRec.reason}</span> : null}
          </div>
        ) : assetRec.decision === "official_asset" ? (
          <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
            <div className="font-semibold">
              توصية تحريرية: صورة رسمية من مصدر موثوق قد تكون الأقوى والأصدق لهذا الخبر.
              {assetRec.reason ? <span className="font-normal"> — {assetRec.reason}</span> : null}
            </div>
            {rows.some((r) => /^https?:\/\//i.test(r.url.trim())) ? (
              <div className="mt-1 text-[11px]">
                افتح المصدر الرسمي، واحفظ الصورة الرسمية (شعار/مبنى/منتج/صورة شخصية رسمية) ثم ارفعها عبر «رفع صورة الغلاف»
                مع الحفاظ على نسبة المصدر:
                <span className="ms-1 inline-flex flex-wrap gap-x-2">
                  {rows
                    .filter((r) => /^https?:\/\//i.test(r.url.trim()))
                    .slice(0, 6)
                    .map((r, i) => (
                      <a key={i} href={r.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-teal underline">
                        {r.label || new URL(r.url).host.replace(/^www\./, "")} ↗
                      </a>
                    ))}
                </span>
              </div>
            ) : (
              <div className="mt-1 text-[11px] text-amber-800">
                لا توجد روابط مصادر رسمية مرتبطة بهذا المقال بعد — أضِف مصدراً رسمياً في قسم «المصادر» أدناه، أو استخدم الصورة الأصلية / التوليد.
              </div>
            )}
          </div>
        ) : null}
        {officialError ? <div className="mt-2 text-[12px] text-coral">{officialError}</div> : null}
        {officialFetched && officialAssets.length === 0 && !officialBusy ? (
          <div className="mt-2 text-[11px] text-gray">لم تُعثر على صورة رسمية قابلة للاستخدام في صفحات المصادر المرتبطة.</div>
        ) : null}
        {(originalImageUrl || officialAssets.length > 0 || aiCandidates.length > 0) ? (
          <div className="mt-3">
            <div className="mb-2 text-[11px] font-semibold text-gray">اختر صورة الغلاف:</div>
            <div className="grid grid-cols-3 gap-2">
              {/* The ORIGINAL source image — always first and always selectable. */}
              {originalImageUrl ? (
                <button
                  type="button"
                  onClick={() => setCoverUrl(originalImageUrl)}
                  aria-pressed={originalImageUrl === coverUrl}
                  className={`relative overflow-hidden rounded-lg border-2 transition ${
                    originalImageUrl === coverUrl ? "border-teal ring-2 ring-teal/30" : "border-line hover:border-teal/50"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={originalImageUrl} alt="الصورة الأصلية" className="aspect-[16/9] w-full object-cover" />
                  <span className="absolute top-1 right-1 rounded bg-ink/80 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    الصورة الأصلية{assetRec.decision === "original_source" ? " · موصى بها" : ""}
                  </span>
                  {originalImageUrl === coverUrl ? (
                    <span className="absolute bottom-1 left-1 rounded bg-teal px-1.5 py-0.5 text-[10px] font-bold text-white">
                      الغلاف ✓
                    </span>
                  ) : null}
                </button>
              ) : null}
              {/* Official images from authoritative source pages ALREADY linked to
                  the article. Retrieval ≠ selection: selectable, never auto-set. */}
              {officialAssets.map((a) => {
                const selected = a.imageUrl === coverUrl;
                return (
                  <button
                    key={a.imageUrl}
                    type="button"
                    onClick={() => setCoverUrl(a.imageUrl)}
                    aria-pressed={selected}
                    title={`${a.assetType === "official_logo" ? "شعار رسمي" : "صورة رسمية"} — ${a.attribution || a.sourceName}`}
                    className={`relative overflow-hidden rounded-lg border-2 transition ${
                      selected ? "border-teal ring-2 ring-teal/30" : "border-emerald-300 hover:border-emerald-400"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.imageUrl} alt={a.attribution || "صورة رسمية"} className="aspect-[16/9] w-full object-cover" />
                    <span className="absolute top-1 right-1 max-w-[95%] truncate rounded bg-emerald-700/90 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {a.assetType === "official_logo" ? "شعار رسمي" : "المصدر الرسمي"}{a.sourceName ? ` · ${a.sourceName}` : ""}
                    </span>
                    {selected ? (
                      <span className="absolute bottom-1 left-1 rounded bg-teal px-1.5 py-0.5 text-[10px] font-bold text-white">
                        الغلاف ✓
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {/* Session AI candidates — NEWEST FIRST; the latest generation is
                  badged «جديدة». Clicking a candidate is what sets the cover. */}
              {aiCandidates.map((c, i) => {
                const selected = c.url === coverUrl;
                const isFresh = freshUrls.has(c.url);
                return (
                  <button
                    key={c.url}
                    type="button"
                    onClick={() => setCoverUrl(c.url)}
                    aria-pressed={selected}
                    title={c.conceptSummary || undefined}
                    className={`relative overflow-hidden rounded-lg border-2 transition ${
                      selected ? "border-teal ring-2 ring-teal/30" : isFresh ? "border-teal/60 ring-2 ring-teal/20" : "border-line hover:border-teal/50"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.url} alt={c.conceptSummary || `خيار ${i + 1}`} className="aspect-[16/9] w-full object-cover" />
                    {isFresh ? (
                      <span className="absolute top-1 left-1 rounded bg-teal px-1.5 py-0.5 text-[10px] font-bold text-white">
                        جديدة
                      </span>
                    ) : null}
                    {c.mode === "premium" ? (
                      <span className="absolute top-1 right-1 rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                        جودة عالية
                      </span>
                    ) : null}
                    {selected ? (
                      <span className="absolute bottom-1 left-1 rounded bg-teal px-1.5 py-0.5 text-[10px] font-bold text-white">
                        الغلاف ✓
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <input
            name="cover_credit_name"
            defaultValue={content?.cover_credit_name ?? ""}
            placeholder="مصدر الصورة (مثال: Getty Images)"
            className={subField}
          />
          <input
            name="cover_credit_url"
            defaultValue={content?.cover_credit_url ?? ""}
            placeholder="رابط المصدر (اختياري)"
            dir="ltr"
            className={subField}
          />
        </div>
      </div>

      {/* Video embed — available on any type so news/articles can carry a video
          alongside their cover image, not just video-type posts. */}
      <label className={label}>
        رابط فيديو (يوتيوب/Vimeo) — اختياري
        <input
          name="video_url"
          defaultValue={content?.video_url ?? ""}
          dir="ltr"
          placeholder="https://youtube.com/watch?v=…  أو  https://vimeo.com/…"
          className={field}
        />
        <span className="mt-1 block text-[11px] leading-relaxed text-gray">
          يظهر كفيديو مضمّن داخل صفحة المقال. اتركه فارغاً إن لم يكن هناك فيديو.
          روابط يوتيوب تُستخدم صورتها المصغّرة كصورة غلاف تلقائياً عند عدم رفع صورة،
          بينما تحتاج روابط Vimeo إلى رفع صورة غلاف يدوياً.
        </span>
      </label>

      {type === "video" ? (
        <label className={label}>
          مدة الفيديو
          <input name="video_duration" defaultValue={content?.video_duration ?? ""} dir="ltr" placeholder="3:12" className={field} />
        </label>
      ) : (
        <label className={label}>
          دقائق القراءة — اختياري
          <input
            name="read_minutes"
            type="number"
            min={0}
            defaultValue={content?.read_minutes ?? ""}
            placeholder="اتركه فارغاً لإخفاء وقت القراءة"
            className={field}
          />
        </label>
      )}

      <div className="flex gap-5">
        <label className="flex items-center gap-2 text-[13px] font-semibold">
          <input type="checkbox" name="is_breaking" defaultChecked={content?.is_breaking ?? false} /> عاجل
        </label>
        <label className="flex items-center gap-2 text-[13px] font-semibold">
          <input type="checkbox" name="is_featured" defaultChecked={content?.is_featured ?? false} /> مميّز (هيرو)
        </label>
      </div>

      {/* ARTICLE SOURCE / CREDIT */}
      <div className="rounded-2xl border border-line p-4">
        <div className="mb-2 text-[13px] font-bold">مصدر المقال (اختياري)</div>
        <div className="grid grid-cols-2 gap-3">
          <input
            name="source_name"
            defaultValue={content?.source_name ?? ""}
            placeholder="اسم المصدر (مثال: Reuters)"
            className={subField}
          />
          <input
            name="source_url"
            defaultValue={content?.source_url ?? ""}
            placeholder="رابط المصدر (اختياري)"
            dir="ltr"
            className={subField}
          />
        </div>
      </div>

      {/* MEDIA GALLERY */}
      <div className="rounded-2xl border border-line p-4">
        <input type="hidden" name="media_json" value={JSON.stringify(items)} />
        <div className="mb-2 text-[13px] font-bold">الوسائط (صور وفيديوهات)</div>
        <div className="flex flex-col gap-4">
          {items.map((m, i) => (
            <div key={i} className="rounded-xl border border-line p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <select
                  value={m.type}
                  onChange={(e) =>
                    patchItem(i, { type: e.target.value as MediaItem["type"] })
                  }
                  className="rounded-lg border border-gray/40 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-teal"
                >
                  <option value="image">صورة</option>
                  <option value="video">فيديو</option>
                </select>
                <button
                  type="button"
                  onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}
                  className="rounded-lg border border-line px-3 py-1 text-coral"
                >
                  حذف
                </button>
              </div>

              {m.url ? (
                m.type === "image" ? (
                  <div className="mb-2 overflow-hidden rounded-lg border border-line">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.url} alt="معاينة" className="max-h-48 w-full object-cover" />
                  </div>
                ) : (
                  <div className="mb-2 truncate text-[12px] text-gray" dir="ltr">{m.url}</div>
                )
              ) : null}

              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold text-teal hover:bg-cream">
                    {busy === i ? "جارٍ الرفع…" : m.type === "video" ? "رفع فيديو" : "رفع صورة"}
                    <input
                      type="file"
                      accept={m.type === "video" ? "video/*" : "image/*"}
                      className="hidden"
                      disabled={busy === i}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleItemUpload(i, f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {m.type === "video" ? (
                    <span className="text-[12px] text-gray">أو الصق رابطاً خارجياً ↓</span>
                  ) : null}
                </div>

                {m.type === "video" ? (
                  <input
                    value={m.url}
                    onChange={(e) => patchItem(i, { url: e.target.value, storage_path: null })}
                    placeholder="https://youtube.com/watch?v=… أو https://vimeo.com/…"
                    dir="ltr"
                    className={subField}
                  />
                ) : null}

                <input
                  value={m.caption}
                  onChange={(e) => patchItem(i, { caption: e.target.value })}
                  placeholder="تعليق توضيحي (سطر أو سطران)"
                  className={subField}
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={m.credit_name}
                    onChange={(e) => patchItem(i, { credit_name: e.target.value })}
                    placeholder="نسبة/مصدر (مثال: Photo: AP)"
                    className={subField}
                  />
                  <input
                    value={m.credit_url}
                    onChange={(e) => patchItem(i, { credit_url: e.target.value })}
                    placeholder="رابط المصدر (اختياري)"
                    dir="ltr"
                    className={subField}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() =>
            setItems((xs) => [
              ...xs,
              { type: "image", url: "", storage_path: null, caption: "", credit_name: "", credit_url: "" },
            ])
          }
          className="mt-2 text-[13px] font-semibold text-teal"
        >
          + إضافة وسائط
        </button>
        {uploadError ? <div className="mt-2 text-[13px] text-coral">{uploadError}</div> : null}
      </div>

      {/* SOURCES */}
      <div className="rounded-2xl border border-line p-4">
        <div className="mb-2 text-[13px] font-bold">المصادر والمراجع</div>
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <div key={i} className="flex gap-2">
              <input
                name="source_label"
                value={r.label}
                onChange={(e) =>
                  setRows((rs) => rs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                }
                placeholder="اسم المصدر"
                className="flex-1 rounded-lg border border-gray/40 bg-white px-3 py-2 text-sm outline-none focus:border-teal"
              />
              <input
                name="source_url"
                value={r.url}
                onChange={(e) =>
                  setRows((rs) => rs.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))
                }
                placeholder="https://"
                dir="ltr"
                className="flex-1 rounded-lg border border-gray/40 bg-white px-3 py-2 text-sm outline-none focus:border-teal"
              />
              <button
                type="button"
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                className="rounded-lg border border-line px-3 text-coral"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setRows((rs) => [...rs, { label: "", url: "" }])}
          className="mt-2 text-[13px] font-semibold text-teal"
        >
          + إضافة مصدر
        </button>
      </div>

      {state && "error" in state ? (
        <div className="text-[13px] text-coral">{state.error}</div>
      ) : null}

      <button
        type="submit"
        disabled={pending || coverBusy || aiBusy || busy !== null}
        className="self-start rounded-lg bg-teal px-6 py-2.5 text-sm font-bold text-white disabled:opacity-60"
      >
        {pending ? "جارٍ الحفظ…" : "حفظ"}
      </button>
    </form>

    {/* Post-save next actions. Kept OUTSIDE the editor form (HTML forbids nested
        forms) so publish/delete submit to their own server actions. */}
    {saved && !dismissed ? (
      <div className="mt-4 max-w-2xl rounded-2xl border border-teal/40 bg-teal/5 p-4">
        <div className="mb-3 text-[14px] font-bold text-teal">تم الحفظ بنجاح ✓</div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/admin/content"
            className="rounded-lg border border-line bg-white px-4 py-2 text-[13px] font-semibold text-ink hover:bg-cream"
          >
            العودة إلى قائمة المحتوى
          </Link>
          {saved.status !== "published" ? (
            <form action={setStatus} onSubmit={(e) => guardSubmit(e, true)}>
              <input type="hidden" name="id" value={saved.id} />
              <input type="hidden" name="status" value="published" />
              <button className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white hover:opacity-90">
                نشر الآن
              </button>
            </form>
          ) : null}
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="rounded-lg border border-line bg-white px-4 py-2 text-[13px] font-semibold text-ink hover:bg-cream"
          >
            متابعة التحرير
          </button>
          <form action={softDeleteContent}>
            <input type="hidden" name="id" value={saved.id} />
            <button className="rounded-lg border border-line bg-white px-4 py-2 text-[13px] font-semibold text-coral hover:bg-cream">
              حذف
            </button>
          </form>
        </div>
      </div>
    ) : null}
    </>
  );
}

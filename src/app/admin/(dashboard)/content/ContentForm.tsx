"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { saveContent, setStatus, softDeleteContent, type ContentSaveResult } from "../../actions";
import { generateCoverImage } from "../../image-actions";
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
  "mt-1.5 w-full rounded-lg border border-gray/40 px-3.5 py-2.5 text-sm outline-none focus:border-teal";
const label = "block text-[13px] font-semibold text-ink";
const subField =
  "w-full rounded-lg border border-gray/40 px-3 py-2 text-sm outline-none focus:border-teal";

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
  useEffect(() => {
    if (state && "ok" in state) setDismissed(false);
  }, [state]);

  // Cover
  const formRef = useRef<HTMLFormElement>(null);
  const [coverUrl, setCoverUrl] = useState(content?.cover_image_url ?? "");
  const [coverBusy, setCoverBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");

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
    const category = String(fd.get("category_slug") ?? "").trim();
    if (title.length < 4) {
      setAiError("أدخل عنوان الخبر أولاً لتُبنى الصورة عليه.");
      return;
    }
    setAiError("");
    setAiBusy(true);
    try {
      const r = await generateCoverImage({ title, excerpt, category });
      if ("ok" in r) setCoverUrl(r.url);
      else setAiError(r.error);
    } catch {
      setAiError("تعذّر توليد الصورة، حاول مرة أخرى.");
    } finally {
      setAiBusy(false);
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

  return (
    <>
    <form ref={formRef} action={formAction} className="flex max-w-2xl flex-col gap-4">
      {savedId ? <input type="hidden" name="id" value={savedId} /> : null}

      <label className={label}>
        العنوان
        <input name="title" defaultValue={content?.title ?? ""} required className={field} />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          النوع
          <select name="type" value={type} onChange={(e) => setType(e.target.value)} className={field}>
            {TYPES.map((t) => (
              <option key={t.v} value={t.v}>{t.l}</option>
            ))}
          </select>
        </label>
        <label className={label}>
          الحالة
          <select name="status" defaultValue={content?.status ?? "draft"} className={field}>
            {STATUSES.map((s) => (
              <option key={s.v} value={s.v}>{s.l}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          القسم
          <select name="category_slug" defaultValue={content?.category_slug ?? ""} className={field}>
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
        <textarea name="body" defaultValue={content?.body ?? ""} rows={8} className={field} />
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
            {aiBusy ? "جارٍ التوليد…" : coverUrl ? "توليد صورة جديدة ✨" : "توليد صورة بالذكاء الاصطناعي ✨"}
          </button>
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
          تُبنى الصورة على عنوان الخبر ومقتطفه. إن لم تعجبك، اضغط «توليد صورة جديدة» للحصول على أخرى.
        </p>
        {aiError ? <div className="mt-2 text-[13px] text-coral">{aiError}</div> : null}
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
                  className="rounded-lg border border-gray/40 px-2.5 py-1.5 text-[13px] outline-none focus:border-teal"
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
                className="flex-1 rounded-lg border border-gray/40 px-3 py-2 text-sm outline-none focus:border-teal"
              />
              <input
                name="source_url"
                value={r.url}
                onChange={(e) =>
                  setRows((rs) => rs.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))
                }
                placeholder="https://"
                dir="ltr"
                className="flex-1 rounded-lg border border-gray/40 px-3 py-2 text-sm outline-none focus:border-teal"
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
            <form action={setStatus}>
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

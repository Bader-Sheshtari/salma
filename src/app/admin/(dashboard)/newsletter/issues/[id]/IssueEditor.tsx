"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ISSUE_STATUS_AR,
  type NewsletterIssue,
  type NewsletterItem,
  reasonLabel,
  SECTION_ORDER,
  sectionLabel,
  SOURCE_TYPE_AR,
} from "@/lib/newsletter-issues";
import {
  addArticleItem,
  addExternalItem,
  curateNewsletterIssue,
  deleteItem,
  moveItem,
  saveIssueMeta,
  saveItemCopy,
  setIssueStatus,
  setItemState,
  setItemVerification,
} from "../../../../newsletter-issue-actions";

type ContentLink = { slug: string; status: string; title: string };

// Single-issue editor: the engine proposes, the human decides (§25). Every
// mutation calls a server action and refreshes the server-rendered data.
export default function IssueEditor({
  issue,
  items,
  contentLinks,
}: {
  issue: NewsletterIssue;
  items: NewsletterItem[];
  contentLinks: Record<string, ContentLink>;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [title, setTitle] = useState(issue.title ?? "");
  const [intro, setIntro] = useState(issue.intro_ar ?? "");
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const run = (key: string, fn: () => Promise<{ error?: string } | { ok: true }>) => {
    setBusy(key);
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if ("error" in res && res.error) setError(res.error);
      setBusy(null);
      router.refresh();
    });
  };

  const bySection = useMemo(() => {
    const map = new Map<string, NewsletterItem[]>();
    for (const it of items) {
      (map.get(it.section) ?? map.set(it.section, []).get(it.section)!).push(it);
    }
    for (const rows of map.values()) rows.sort((a, b) => a.position - b.position);
    return map;
  }, [items]);

  const activeCount = items.filter((i) => i.editor_state !== "rejected").length;

  return (
    <div>
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link href="/admin/newsletter/issues" className="text-[12.5px] font-semibold text-teal underline">
          → إصدارات النشرة
        </Link>
        <span className="rounded-md border border-line bg-cream px-1.5 py-0.5 text-[11px] font-bold text-ink">
          {ISSUE_STATUS_AR[issue.status]}
        </span>
        {issue.curation_meta?.copy_mode === "fallback" && (
          <span className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">
            نصوص أولية بلا صياغة ذكية — أعد الاقتراح أو حرّر يدوياً
          </span>
        )}
        <span className="ms-auto flex gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run("curate", () => curateNewsletterIssue(issue.id))}
            className="rounded-lg border border-teal px-3 py-1.5 text-[12.5px] font-bold text-teal hover:bg-teal/5 disabled:opacity-50"
          >
            {busy === "curate" ? "جارٍ إعادة الاقتراح…" : "أعد الاقتراح"}
          </button>
          <button
            type="button"
            onClick={() => setPreview((p) => !p)}
            className="rounded-lg border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-cream"
          >
            {preview ? "عودة للتحرير" : "معاينة"}
          </button>
          {issue.status !== "ready" && issue.status !== "archived" && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run("ready", () => setIssueStatus(issue.id, "ready"))}
              className="rounded-lg bg-teal px-3 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-50"
            >
              وضع «جاهز»
            </button>
          )}
          {issue.status === "ready" && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run("archive", () => setIssueStatus(issue.id, "archived"))}
              className="rounded-lg border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray hover:bg-cream disabled:opacity-50"
            >
              أرشفة
            </button>
          )}
        </span>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700">
          {error}
        </div>
      )}

      {preview ? (
        <IssuePreview issue={issue} items={items} contentLinks={contentLinks} titleDraft={title} introDraft={intro} />
      ) : (
        <>
          {/* Title + intro (§24) */}
          <div className="mb-4 rounded-xl border border-line bg-white p-3" dir="rtl">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => run("meta", () => saveIssueMeta(issue.id, { title }))}
              placeholder="عنوان الإصدار…"
              className="mb-2 w-full rounded-md border border-line px-3 py-2 text-[16px] font-bold text-ink"
            />
            <textarea
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              onBlur={() => run("meta", () => saveIssueMeta(issue.id, { intro_ar: intro }))}
              placeholder="افتتاحية قصيرة تخبر القارئ لماذا يستحق هذا العدد وقته…"
              rows={2}
              className="w-full rounded-md border border-line px-3 py-2 text-[13.5px] leading-relaxed text-ink"
            />
            <div className="mt-1 text-[11.5px] text-gray">
              {activeCount} عنصرًا فعالاً · التعديلات تُحفظ عند مغادرة الحقل.
              {issue.curation_meta?.zero_result_search_terms?.length ? (
                <> · عمليات بحث بلا نتائج (أفكار تحريرية): {issue.curation_meta.zero_result_search_terms.join("، ")}</>
              ) : null}
            </div>
          </div>

          {/* Sections */}
          {SECTION_ORDER.map((sec) => {
            const rows = bySection.get(sec) ?? [];
            if (rows.length === 0) return null;
            return (
              <section key={sec} className="mb-5">
                <div className="mb-2 flex items-center gap-2">
                  {renaming === sec ? (
                    <>
                      <input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        className="rounded-md border border-line px-2 py-1 text-[13px] font-bold"
                      />
                      <button
                        type="button"
                        className="text-[12px] font-bold text-teal"
                        onClick={() => {
                          const next = { ...(issue.section_titles ?? {}), [sec]: renameValue };
                          run("rename", () => saveIssueMeta(issue.id, { section_titles: next }));
                          setRenaming(null);
                        }}
                      >
                        حفظ
                      </button>
                      <button type="button" className="text-[12px] text-gray" onClick={() => setRenaming(null)}>
                        إلغاء
                      </button>
                    </>
                  ) : (
                    <>
                      <h2 className="text-[15px] font-bold text-ink">
                        {sectionLabel(sec, issue.section_titles)}
                      </h2>
                      <button
                        type="button"
                        title="تغيير عنوان القسم"
                        className="text-[11px] text-gray underline"
                        onClick={() => {
                          setRenaming(sec);
                          setRenameValue(sectionLabel(sec, issue.section_titles));
                        }}
                      >
                        تعديل العنوان
                      </button>
                    </>
                  )}
                </div>
                <div className="space-y-2">
                  {rows.map((it) => (
                    <ItemCard
                      key={it.id}
                      item={it}
                      issue={issue}
                      contentLink={it.content_id ? contentLinks[it.content_id] : undefined}
                      busy={busy}
                      editing={editingItem === it.id}
                      setEditing={(on) => setEditingItem(on ? it.id : null)}
                      run={run}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          <AddForms issueId={issue.id} run={run} busy={busy} />
        </>
      )}
    </div>
  );
}

// --- Item card ----------------------------------------------------------------

function ItemCard({
  item,
  issue,
  contentLink,
  busy,
  editing,
  setEditing,
  run,
}: {
  item: NewsletterItem;
  issue: NewsletterIssue;
  contentLink?: ContentLink;
  busy: string | null;
  editing: boolean;
  setEditing: (on: boolean) => void;
  run: (key: string, fn: () => Promise<{ error?: string } | { ok: true }>) => void;
}) {
  const [headline, setHeadline] = useState(item.newsletter_headline ?? "");
  const [teaser, setTeaser] = useState(item.teaser ?? "");
  const [analysis, setAnalysis] = useState(item.short_analysis ?? "");
  const [why, setWhy] = useState(item.why_ar ?? "");

  const rejected = item.editor_state === "rejected";
  const accepted = item.editor_state === "accepted";
  const manual = item.editor_state === "manual";
  const frame = rejected
    ? "border-line bg-cream/40 opacity-60"
    : accepted
    ? "border-emerald-300 bg-white"
    : manual
    ? "border-sky-300 bg-white"
    : "border-line bg-white";

  const href = item.item_type === "article"
    ? (contentLink?.slug ? `/article/${contentLink.slug}` : null)
    : item.external_url;

  return (
    <article className={`rounded-xl border p-3 ${frame}`} dir="rtl">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        {item.is_opinion && (
          <span className="rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[11px] font-bold text-violet-700">
            رأي خبير
          </span>
        )}
        {item.item_type === "external" && (
          <span
            className={`rounded-md border px-1.5 py-0.5 text-[11px] font-bold ${
              item.verification_status === "verified"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-amber-200 bg-amber-50 text-amber-700"
            }`}
          >
            {item.verification_status === "verified" ? "مصدر موثّق" : "يحتاج تحقق المصدر"}
          </span>
        )}
        {item.external_source_type && (
          <span className="rounded-md border border-line bg-white px-1.5 py-0.5 text-[11px] font-semibold text-gray">
            {SOURCE_TYPE_AR[item.external_source_type] ?? item.external_source_type}
          </span>
        )}
        {item.reasons.map((r) => (
          <span key={r} className="rounded-md border border-teal/30 bg-teal/5 px-1.5 py-0.5 text-[11px] font-semibold text-teal">
            {reasonLabel(r)}
          </span>
        ))}
        {item.score !== null && item.editor_state === "suggested" && (
          <span
            className="rounded-md border border-line bg-cream px-1.5 py-0.5 text-[11px] font-semibold text-gray"
            title={item.score_parts
              ? `لماذا تم اقتراحه؟ تحريري ${item.score_parts.editorial} · موثوقية ${item.score_parts.authority} · اهتمام ${item.score_parts.interest} · قرّاء ${item.score_parts.reader} · خليج ${item.score_parts.gcc}`
              : undefined}
          >
            {Math.round((item.score ?? 0) * 100)}٪
          </span>
        )}
      </div>

      <div className="text-[14.5px] font-bold leading-snug text-ink">
        {item.newsletter_headline ?? "—"}
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer" className="ms-2 text-[11.5px] font-semibold text-teal underline">
            {item.item_type === "article" ? "المقال ↗" : item.external_source_name ?? "المصدر ↗"}
          </a>
        )}
      </div>
      {item.teaser && <p className="mt-1 text-[13px] leading-relaxed text-ink/85">{item.teaser}</p>}
      {item.short_analysis && (
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink/75">
          <span className="font-bold text-teal">ما معناه؟ </span>
          {item.short_analysis}
        </p>
      )}
      {item.why_ar && (
        <p className="mt-1 text-[12px] font-semibold text-teal">لماذا يستحق وقتك؟ <span className="font-medium text-ink/70">{item.why_ar}</span></p>
      )}

      {/* Actions */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
        {item.editor_state === "suggested" && (
          <>
            <button type="button" disabled={busy !== null} onClick={() => run(item.id, () => setItemState(item.id, issue.id, "accepted"))} className="rounded-md bg-emerald-600 px-2.5 py-1 font-bold text-white disabled:opacity-50">
              قبول
            </button>
            <button type="button" disabled={busy !== null} onClick={() => run(item.id, () => setItemState(item.id, issue.id, "rejected"))} className="rounded-md border border-line bg-white px-2.5 py-1 font-semibold text-gray disabled:opacity-50">
              استبعاد
            </button>
          </>
        )}
        {(accepted || rejected) && (
          <button type="button" disabled={busy !== null} onClick={() => run(item.id, () => setItemState(item.id, issue.id, "suggested"))} className="rounded-md border border-line bg-white px-2.5 py-1 font-semibold text-gray disabled:opacity-50">
            تراجع
          </button>
        )}
        <button type="button" disabled={busy !== null} onClick={() => run(item.id, () => moveItem(item.id, issue.id, { direction: "up" }))} className="rounded-md border border-line bg-white px-2 py-1 text-gray disabled:opacity-50">↑</button>
        <button type="button" disabled={busy !== null} onClick={() => run(item.id, () => moveItem(item.id, issue.id, { direction: "down" }))} className="rounded-md border border-line bg-white px-2 py-1 text-gray disabled:opacity-50">↓</button>
        <select
          value={item.section}
          disabled={busy !== null}
          onChange={(e) => run(item.id, () => moveItem(item.id, issue.id, { section: e.target.value }))}
          className="rounded-md border border-line bg-white px-1.5 py-1 text-[11.5px] text-gray"
        >
          {SECTION_ORDER.map((s) => (
            <option key={s} value={s}>{sectionLabel(s, issue.section_titles)}</option>
          ))}
        </select>
        <button type="button" onClick={() => setEditing(!editing)} className="rounded-md border border-line bg-white px-2.5 py-1 font-semibold text-gray">
          {editing ? "إغلاق التحرير" : "تحرير النص"}
        </button>
        {item.item_type === "external" && item.editor_state === "manual" && item.verification_status === "needs_check" && (
          <button type="button" disabled={busy !== null} onClick={() => run(item.id, () => setItemVerification(item.id, issue.id, "verified"))} className="rounded-md border border-emerald-300 bg-white px-2.5 py-1 font-semibold text-emerald-700 disabled:opacity-50">
            تأكيد التحقق من المصدر
          </button>
        )}
        <button type="button" disabled={busy !== null} onClick={() => run(item.id, () => deleteItem(item.id, issue.id))} className="ms-auto rounded-md border border-red-200 bg-white px-2.5 py-1 font-semibold text-red-600 disabled:opacity-50">
          حذف
        </button>
      </div>

      {editing && (
        <div className="mt-2 space-y-2 rounded-lg border border-line bg-cream/50 p-2.5">
          <input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="العنوان" className="w-full rounded-md border border-line px-2 py-1.5 text-[13px] font-bold" />
          <textarea value={teaser} onChange={(e) => setTeaser(e.target.value)} placeholder="الموجز / teaser" rows={3} className="w-full rounded-md border border-line px-2 py-1.5 text-[12.5px]" />
          <textarea value={analysis} onChange={(e) => setAnalysis(e.target.value)} placeholder="ما معناه؟ (تحليل قصير)" rows={2} className="w-full rounded-md border border-line px-2 py-1.5 text-[12.5px]" />
          <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="لماذا يستحق وقتك؟" className="w-full rounded-md border border-line px-2 py-1.5 text-[12.5px]" />
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              run(item.id, () => saveItemCopy(item.id, issue.id, { headline, teaser, analysis, why }));
              setEditing(false);
            }}
            className="rounded-md bg-teal px-3 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-50"
          >
            حفظ النص
          </button>
        </div>
      )}
    </article>
  );
}

// --- Manual add (§25) -----------------------------------------------------------

function AddForms({
  issueId,
  run,
  busy,
}: {
  issueId: string;
  run: (key: string, fn: () => Promise<{ error?: string } | { ok: true }>) => void;
  busy: string | null;
}) {
  const [articleRef, setArticleRef] = useState("");
  const [articleSection, setArticleSection] = useState("top_missed");
  const [extUrl, setExtUrl] = useState("");
  const [extHeadline, setExtHeadline] = useState("");
  const [extSource, setExtSource] = useState("");
  const [extAuthor, setExtAuthor] = useState("");
  const [extType, setExtType] = useState("media");
  const [extSection, setExtSection] = useState("quick");

  return (
    <div className="mt-6 grid gap-3 md:grid-cols-2" dir="rtl">
      <div className="rounded-xl border border-line bg-white p-3">
        <div className="mb-2 text-[13px] font-bold text-ink">إضافة مقال من سلمى</div>
        <div className="flex flex-wrap gap-2">
          <input
            value={articleRef}
            onChange={(e) => setArticleRef(e.target.value)}
            placeholder="رابط المقال أو الـ slug أو المعرّف"
            className="min-w-0 flex-1 rounded-md border border-line px-2 py-1.5 text-[12.5px]"
          />
          <select value={articleSection} onChange={(e) => setArticleSection(e.target.value)} className="rounded-md border border-line px-1.5 py-1.5 text-[12px]">
            {SECTION_ORDER.map((s) => <option key={s} value={s}>{sectionLabel(s)}</option>)}
          </select>
          <button
            type="button"
            disabled={busy !== null || !articleRef.trim()}
            onClick={() => {
              run("add-article", () => addArticleItem(issueId, articleRef, articleSection));
              setArticleRef("");
            }}
            className="rounded-md bg-teal px-3 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-50"
          >
            إضافة
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-white p-3">
        <div className="mb-2 text-[13px] font-bold text-ink">إضافة عنصر خارجي</div>
        <div className="space-y-2">
          <input value={extUrl} onChange={(e) => setExtUrl(e.target.value)} placeholder="رابط المصدر (https://…)" className="w-full rounded-md border border-line px-2 py-1.5 text-[12.5px]" dir="ltr" />
          <input value={extHeadline} onChange={(e) => setExtHeadline(e.target.value)} placeholder="عنوان العنصر في النشرة" className="w-full rounded-md border border-line px-2 py-1.5 text-[12.5px]" />
          <div className="flex flex-wrap gap-2">
            <input value={extSource} onChange={(e) => setExtSource(e.target.value)} placeholder="اسم المصدر" className="min-w-0 flex-1 rounded-md border border-line px-2 py-1.5 text-[12.5px]" />
            <input value={extAuthor} onChange={(e) => setExtAuthor(e.target.value)} placeholder="الكاتب (اختياري)" className="min-w-0 flex-1 rounded-md border border-line px-2 py-1.5 text-[12.5px]" />
            <select value={extType} onChange={(e) => setExtType(e.target.value)} className="rounded-md border border-line px-1.5 py-1.5 text-[12px]">
              {Object.entries(SOURCE_TYPE_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={extSection} onChange={(e) => setExtSection(e.target.value)} className="rounded-md border border-line px-1.5 py-1.5 text-[12px]">
              {SECTION_ORDER.map((s) => <option key={s} value={s}>{sectionLabel(s)}</option>)}
            </select>
            <button
              type="button"
              disabled={busy !== null || !extUrl.trim() || !extHeadline.trim()}
              onClick={() => {
                run("add-external", () =>
                  addExternalItem(issueId, {
                    url: extUrl,
                    headline: extHeadline,
                    sourceName: extSource,
                    author: extAuthor,
                    section: extSection,
                    sourceType: extType,
                  }));
                setExtUrl(""); setExtHeadline(""); setExtSource(""); setExtAuthor("");
              }}
              className="rounded-md bg-teal px-3 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-50"
            >
              إضافة
            </button>
          </div>
          <div className="text-[11px] text-gray">
            العناصر الخارجية المضافة يدوياً تبدأ بوسم «يحتاج تحقق المصدر» حتى يؤكد المحرر التحقق.
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Preview (§31) ---------------------------------------------------------------

function IssuePreview({
  issue,
  items,
  contentLinks,
  titleDraft,
  introDraft,
}: {
  issue: NewsletterIssue;
  items: NewsletterItem[];
  contentLinks: Record<string, ContentLink>;
  titleDraft: string;
  introDraft: string;
}) {
  const active = items.filter((i) => i.editor_state !== "rejected");
  const bySection = new Map<string, NewsletterItem[]>();
  for (const it of active) {
    (bySection.get(it.section) ?? bySection.set(it.section, []).get(it.section)!).push(it);
  }
  for (const rows of bySection.values()) rows.sort((a, b) => a.position - b.position);

  return (
    <div className="mx-auto max-w-2xl rounded-2xl border border-line bg-white p-6" dir="rtl">
      <div className="mb-1 text-center text-[13px] font-bold tracking-wide text-teal">نشرة سلمى</div>
      <h1 className="mb-2 text-center text-[22px] font-extrabold leading-snug text-ink">
        {titleDraft || issue.title || "عدد النشرة"}
      </h1>
      {(introDraft || issue.intro_ar) && (
        <p className="mb-5 text-center text-[14px] leading-relaxed text-ink/80">
          {introDraft || issue.intro_ar}
        </p>
      )}
      {SECTION_ORDER.map((sec) => {
        const rows = bySection.get(sec) ?? [];
        if (rows.length === 0) return null;
        return (
          <section key={sec} className="mb-6">
            <h2 className="mb-2 border-b border-line pb-1 text-[16px] font-bold text-teal">
              {sectionLabel(sec, issue.section_titles)}
            </h2>
            <div className="space-y-4">
              {rows.map((it) => {
                const href = it.item_type === "article"
                  ? (it.content_id && contentLinks[it.content_id]?.slug
                    ? `/article/${contentLinks[it.content_id].slug}`
                    : null)
                  : it.external_url;
                return (
                  <div key={it.id}>
                    <div className="text-[15px] font-bold leading-snug text-ink">
                      {it.is_opinion && <span className="me-1 text-[11.5px] font-bold text-violet-700">[رأي خبير]</span>}
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          {it.newsletter_headline}
                        </a>
                      ) : it.newsletter_headline}
                    </div>
                    {it.teaser && <p className="mt-0.5 text-[13.5px] leading-relaxed text-ink/85">{it.teaser}</p>}
                    {it.short_analysis && (
                      <p className="mt-0.5 text-[13px] leading-relaxed text-ink/70">
                        <span className="font-bold">ما معناه؟</span> {it.short_analysis}
                      </p>
                    )}
                    {it.why_ar && (
                      <p className="mt-0.5 text-[12.5px] font-semibold text-teal">
                        لماذا يستحق وقتك؟ <span className="font-medium text-ink/70">{it.why_ar}</span>
                      </p>
                    )}
                    {it.item_type === "external" && (
                      <div className="mt-0.5 text-[11.5px] text-gray">
                        المصدر: {it.external_source_name ?? it.external_source_domain}
                        {it.external_author ? ` — ${it.external_author}` : ""}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      <div className="mt-6 border-t border-line pt-3 text-center text-[11.5px] text-gray">
        معاينة تحريرية — ليست قالب البريد النهائي.
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Cover } from "@/components/site/cards";
import { TYPE_LABEL_AR } from "@/lib/content-search";
import { absAr, type VersionMeta, type VersionSnapshot } from "@/lib/content-history";
import { restoreContentVersion } from "../../actions";

const RESTORE_FOOTNOTE = "قائمة المصادر والوسائط المتعددة والرابط الدائم (slug) لا تتغير عند الاستعادة.";
const PUBLISHED_WARNING = "المادة منشورة حاليًا — سيظهر المحتوى المستعاد للقراء فور الاستعادة.";
const confirmText = (n: number) =>
  `سيعود محتوى المادة إلى الإصدار ${n}. حالة النشر الحالية لن تتغير، وستُحفظ النسخة الحالية كإصدار جديد — لن يُحذف أي سجل.`;

/**
 * Read-only view of one stored version (rendered the way the article preview
 * renders content: plain-text paragraphs split on blank lines), with the
 * «استعادة هذا الإصدار» flow. `changedFields` (Arabic labels) is computed
 * server-side by comparing the live row with this snapshot.
 */
export default function VersionView({
  contentId,
  version,
  meta,
  categoryName,
  categoryAccent,
  changedFields,
  isPublished,
  isTrashed,
}: {
  contentId: string;
  version: VersionSnapshot;
  meta: VersionMeta;
  categoryName: string | null;
  categoryAccent: string | null;
  changedFields: string[];
  isPublished: boolean;
  isTrashed: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const n = version.version_no;
  const paragraphs = (version.body ?? "").split(/\n{2,}/).filter((p) => p.trim());
  const backHref = `/admin/content/${contentId}?view=versions`;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pending]);

  const blocked = isTrashed
    ? "لا يمكن استعادة إصدار لمادة في المحذوفات — استعدها من المحذوفات أولًا."
    : changedFields.length === 0
      ? "هذا الإصدار مطابق للنسخة الحالية — لا شيء للاستعادة."
      : null;

  function restore() {
    setError(null);
    startTransition(async () => {
      const res = await restoreContentVersion(contentId, n);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
      if (res.noChange) {
        setInfo("هذا الإصدار مطابق للنسخة الحالية — لم يتغير شيء.");
        return;
      }
      const nv = res.newVersion != null ? `&nv=${res.newVersion}` : "";
      router.push(`${backHref}&restored=${n}${nv}`);
    });
  }

  return (
    <div>
      {/* Banner */}
      <div className="mb-4 rounded-2xl border border-gold/40 bg-gold/10 px-4 py-3">
        <div className="text-[14px] font-bold text-ink">
          الإصدار {n}
          {meta.author_name || meta.authored_at ? (
            <span className="ms-2 font-sans text-[12.5px] font-semibold text-gray">
              {meta.author_name ?? ""}
              {meta.author_name && meta.authored_at ? " · " : ""}
              {absAr(meta.authored_at)}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[12px] text-gray">نسخة محفوظة للعرض فقط — ليست النسخة الحالية.</div>
      </div>

      {/* Snapshot (read-only) */}
      <article className="rounded-2xl border border-line bg-white p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          {categoryName ? (
            <span
              className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-white"
              style={{ background: categoryAccent ?? "var(--salma-gray)" }}
            >
              {categoryName}
            </span>
          ) : version.category_slug ? (
            <span className="rounded-md bg-cream px-2.5 py-1 text-[11px] font-semibold text-gray">
              {version.category_slug}
            </span>
          ) : null}
          <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[10.5px] font-semibold text-teal">
            {TYPE_LABEL_AR[version.type] ?? version.type}
          </span>
        </div>

        <h2 className="mt-3 text-xl font-bold leading-snug sm:text-2xl">{version.title}</h2>
        <div className="mt-1 break-all font-sans text-[11.5px] text-gray" dir="ltr">
          /{version.slug}
        </div>

        {version.ai_summary ? (
          <aside className="mt-4 rounded-2xl border border-teal/25 bg-teal/[0.06] p-4">
            <span className="inline-flex rounded-md bg-teal px-2.5 py-1 text-[11px] font-bold text-white">
              باختصار
            </span>
            <div className="mt-2 flex flex-col gap-1.5 text-[14px] leading-loose text-ink">
              {version.ai_summary
                .split(/\n+/)
                .filter((l) => l.trim())
                .map((l, i) => (
                  <p key={i}>{l}</p>
                ))}
            </div>
          </aside>
        ) : null}

        {version.cover_image_url ? (
          <figure className="mt-4">
            <div className="aspect-[16/9] w-full overflow-hidden rounded-2xl border border-line">
              <Cover src={version.cover_image_url} alt="صورة الغلاف" />
            </div>
            {version.cover_credit_name || version.cover_credit_url ? (
              <figcaption className="mt-1.5 text-[11.5px] text-gray">
                الصورة: {version.cover_credit_name ?? ""}
                {version.cover_credit_url ? (
                  <a
                    href={version.cover_credit_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    dir="ltr"
                    className="ms-1.5 break-all text-teal underline underline-offset-2"
                  >
                    {version.cover_credit_url}
                  </a>
                ) : null}
              </figcaption>
            ) : null}
          </figure>
        ) : null}

        {version.excerpt ? (
          <p className="mt-4 border-r-4 border-teal pr-4 text-[15px] font-medium leading-loose text-gray">
            {version.excerpt}
          </p>
        ) : null}

        <div className="mt-4 flex flex-col gap-4 text-[15.5px] leading-loose text-ink">
          {paragraphs.length ? (
            paragraphs.map((p, i) => <p key={i}>{p}</p>)
          ) : (
            <p className="text-[13px] text-gray">(لا يوجد نص في هذا الإصدار)</p>
          )}
        </div>

        <dl className="mt-5 grid gap-1.5 border-t border-line pt-4 text-[12.5px]">
          {version.source_name || version.source_url ? (
            <div>
              <dt className="inline font-semibold">المصدر: </dt>
              <dd className="inline">
                {version.source_name ?? ""}
                {version.source_url ? (
                  <a
                    href={version.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    dir="ltr"
                    className="ms-1.5 break-all text-teal underline underline-offset-2"
                  >
                    {version.source_url}
                  </a>
                ) : null}
              </dd>
            </div>
          ) : null}
          {version.video_url ? (
            <div>
              <dt className="inline font-semibold">رابط الفيديو: </dt>
              <dd className="inline">
                <a
                  href={version.video_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  dir="ltr"
                  className="break-all text-teal underline underline-offset-2"
                >
                  {version.video_url}
                </a>
              </dd>
            </div>
          ) : null}
        </dl>

        <p className="mt-4 text-[11.5px] text-gray">{RESTORE_FOOTNOTE}</p>
      </article>

      {/* Action bar — sticky on mobile */}
      <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-line bg-white px-4 py-3 sm:-mx-6 sm:px-6 md:static md:mx-0 md:rounded-2xl md:border md:px-4">
        {blocked || info || error ? (
          <div className={`mb-2 text-[12.5px] ${error ? "text-coral" : "text-gray"}`}>
            {error ?? info ?? blocked}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <Link
            href={backHref}
            className="rounded-lg border border-line px-3 py-2 text-[13px] font-semibold text-ink hover:bg-cream"
          >
            رجوع
          </Link>
          <button
            type="button"
            disabled={!!blocked || !!info || pending}
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
            className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
          >
            استعادة هذا الإصدار
          </button>
        </div>
      </div>

      {open ? (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4">
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => !pending && setOpen(false)}
            className="absolute inset-0 cursor-default"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-title"
            className="relative w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
          >
            <h3 id="restore-title" className="text-[16px] font-bold">
              استعادة الإصدار {n}؟
            </h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink">{confirmText(n)}</p>
            {isPublished ? (
              <p className="mt-3 rounded-lg border border-coral/40 bg-coral/10 px-3 py-2 text-[13.5px] font-bold leading-relaxed text-coral">
                {PUBLISHED_WARNING}
              </p>
            ) : null}
            <div className="mt-3 text-[12.5px] font-semibold text-gray">الحقول التي ستتغير:</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {changedFields.map((f) => (
                <span key={f} className="rounded-md bg-cream px-2 py-0.5 text-[12px] font-semibold text-ink">
                  {f}
                </span>
              ))}
            </div>
            <p className="mt-3 text-[11.5px] text-gray">{RESTORE_FOOTNOTE}</p>
            {error ? <div className="mt-2 text-[12.5px] text-coral">{error}</div> : null}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => setOpen(false)}
                className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold hover:bg-cream disabled:opacity-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={restore}
                className="rounded-lg bg-teal px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
              >
                {pending ? "جارٍ الاستعادة…" : `استعادة الإصدار ${n}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

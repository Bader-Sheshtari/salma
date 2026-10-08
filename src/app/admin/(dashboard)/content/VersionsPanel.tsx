"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { VersionMeta } from "@/lib/content-history";
import { loadMoreVersions } from "./content-actions";
import { RelTime } from "./history-ui";

/**
 * Stored versions of an article (metadata only — bodies load in VersionView).
 * Pinned top row = the live content; stored snapshots below, newest first,
 * «تحميل المزيد» via a server action (Phase 2 keyset pattern).
 */
export default function VersionsPanel({
  contentId,
  current,
  initialVersions,
  initialHasMore,
  error,
  restoredNotice,
}: {
  contentId: string;
  current: { version: number; editorName: string; editedAt: string | null };
  initialVersions: VersionMeta[];
  initialHasMore: boolean;
  error: string | null;
  restoredNotice: string | null;
}) {
  const [extra, setExtra] = useState<VersionMeta[]>([]);
  const [moreHasMore, setMoreHasMore] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();

  const seen = new Set(initialVersions.map((v) => v.version_no));
  const versions = [...initialVersions, ...extra.filter((v) => !seen.has(v.version_no))];
  const hasMore = moreHasMore ?? initialHasMore;

  function loadMore() {
    const last = versions[versions.length - 1];
    if (!last) return;
    setLoadError(null);
    startLoading(async () => {
      const res = await loadMoreVersions(contentId, last.version_no);
      if (res.error) {
        setLoadError("تعذّر تحميل المزيد.");
        return;
      }
      setExtra((prev) => [...prev, ...res.versions]);
      setMoreHasMore(res.hasMore);
    });
  }

  return (
    <div>
      {restoredNotice ? (
        <div className="mb-3 rounded-xl border border-teal/30 bg-teal/[0.06] px-4 py-2.5 text-[13px] font-semibold text-teal">
          {restoredNotice}
        </div>
      ) : null}

      <ul className="divide-y divide-line rounded-2xl border border-line bg-white">
        <li className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-cream/40 px-4 py-3 text-[13.5px]">
          <span className="font-bold text-ink">الإصدار {current.version}</span>
          <span className="rounded bg-teal px-1.5 py-0.5 text-[10.5px] font-bold text-white">
            النسخة الحالية
          </span>
          <span className="font-sans text-[12px] text-gray">
            {current.editorName}
            {current.editedAt ? (
              <>
                {" · "}
                <RelTime iso={current.editedAt} />
              </>
            ) : null}
          </span>
        </li>

        {error ? (
          <li className="px-4 py-4 text-[13.5px] text-coral">تعذّر تحميل الإصدارات. حاول مرة أخرى.</li>
        ) : versions.length === 0 ? (
          <li className="px-4 py-4 text-[13.5px] text-gray">لا إصدارات سابقة</li>
        ) : (
          versions.map((v) => (
            <li key={v.version_no} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 text-[13.5px]">
                <span className="font-bold text-ink">الإصدار {v.version_no}</span>
                {v.author_name || v.authored_at ? (
                  <span className="ms-2 font-sans text-[12px] text-gray">
                    {v.author_name ?? ""}
                    {v.author_name && v.authored_at ? " · " : ""}
                    <RelTime iso={v.authored_at} />
                  </span>
                ) : null}
              </div>
              <Link
                href={`/admin/content/${contentId}?view=versions&v=${v.version_no}`}
                className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-cream"
              >
                عرض
              </Link>
            </li>
          ))
        )}
      </ul>

      {!error && versions.length > 0 ? (
        <div className="mt-3 flex flex-col items-center gap-1.5">
          {hasMore ? (
            <button
              type="button"
              onClick={loadMore}
              disabled={loading}
              className="rounded-lg border border-line bg-white px-4 py-2 text-[13px] font-semibold hover:bg-cream disabled:opacity-50"
            >
              {loading ? "جارٍ التحميل…" : "تحميل المزيد"}
            </button>
          ) : null}
          {loadError ? <div className="text-[12px] text-coral">{loadError}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

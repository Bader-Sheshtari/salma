"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { describeEvent, type AuditEvent } from "@/lib/content-history";
import { loadMoreAuditLog } from "./content-actions";
import { RelTime } from "./history-ui";

/** Events that carry a version the editor can open (when a snapshot exists). */
const VERSION_LINKED = new Set(["edited", "version_restored"]);

/**
 * Article activity timeline (CMS Phase 4), newest first. First page arrives
 * from the server component; «تحميل المزيد» appends keyset pages via a server
 * action (same pattern as the Phase 2 content table).
 */
export default function ActivityTimeline({
  contentId,
  currentVersion,
  initialEvents,
  initialHasMore,
  error,
}: {
  contentId: string;
  currentVersion: number;
  initialEvents: AuditEvent[];
  initialHasMore: boolean;
  error: string | null;
}) {
  const [extra, setExtra] = useState<AuditEvent[]>([]);
  const [moreHasMore, setMoreHasMore] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();

  const seen = new Set(initialEvents.map((e) => e.id));
  const events = [...initialEvents, ...extra.filter((e) => !seen.has(e.id))];
  const hasMore = moreHasMore ?? initialHasMore;

  function loadMore() {
    const last = events[events.length - 1];
    if (!last) return;
    setLoadError(null);
    startLoading(async () => {
      const res = await loadMoreAuditLog(contentId, { ts: last.created_at, id: last.id });
      if (res.error) {
        setLoadError("تعذّر تحميل المزيد.");
        return;
      }
      setExtra((prev) => [...prev, ...res.events]);
      setMoreHasMore(res.hasMore);
    });
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-line bg-white p-6 text-[14px] text-coral">
        تعذّر تحميل سجل النشاط. حاول مرة أخرى.
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-white p-6 text-[14px] text-gray">
        لا يوجد نشاط مسجّل لهذه المادة.
      </div>
    );
  }

  return (
    <div>
      <ol className="divide-y divide-line rounded-2xl border border-line bg-white">
        {events.map((e) => {
          const s = describeEvent(e);
          const linkable =
            VERSION_LINKED.has(e.event) && e.version_no != null && e.version_no < currentVersion;
          const sentence = (
            <>
              {s.actor ? <span className="font-bold text-ink">{s.actor} </span> : null}
              <span>{s.text}</span>
              {s.transition ? (
                <span className="font-sans text-[12px] text-gray"> ({s.transition})</span>
              ) : null}
            </>
          );
          return (
            <li key={e.id} className="flex items-start gap-3 px-4 py-3">
              <span
                aria-hidden
                className={`mt-2 size-2 shrink-0 rounded-full ${
                  e.event === "imported" ? "bg-line" : e.actor_id ? "bg-teal" : "bg-gray"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] leading-relaxed text-ink">
                  {linkable ? (
                    <Link
                      href={`/admin/content/${contentId}?view=versions&v=${e.version_no}`}
                      className="hover:text-teal hover:underline"
                    >
                      {sentence}
                      <span className="ms-1.5 whitespace-nowrap font-sans text-[11.5px] font-semibold text-teal">
                        الإصدار {e.version_no} ‹
                      </span>
                    </Link>
                  ) : (
                    sentence
                  )}
                </div>
                {s.note ? <div className="mt-0.5 text-[11.5px] font-semibold text-coral">{s.note}</div> : null}
                <div className="mt-0.5 font-sans text-[11.5px] text-gray">
                  <RelTime iso={e.created_at} />
                </div>
              </div>
            </li>
          );
        })}
      </ol>

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
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { auditActionLabel, describeAuditDetails } from "@/lib/audit-labels";
import { ROLE_LABEL } from "@/lib/roles";
import { formatStampAr } from "@/lib/format";
import type { SecurityEvent, SecurityEventFilters } from "@/lib/admin-queries";
import { loadMoreSecurityEvents } from "../../security-actions";
import { RelTime } from "../content/history-ui";

/** Security-relevant actions get a coral dot; the rest teal. */
const ALERT_ACTIONS = new Set([
  "denied_attempt",
  "user_suspended",
  "mfa_disabled",
  "security_setting_changed",
  "sessions_revoked",
  "ownership_transfer",
]);

/**
 * «سجل الأمان» list, newest first. First page from the server component;
 * «تحميل المزيد» appends keyset pages (list_security_events) via a server action.
 */
export function SecurityLog({
  filters,
  initialEvents,
  initialHasMore,
  error,
}: {
  filters: SecurityEventFilters;
  initialEvents: SecurityEvent[];
  initialHasMore: boolean;
  error: string | null;
}) {
  const [extra, setExtra] = useState<SecurityEvent[]>([]);
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
      try {
        const res = await loadMoreSecurityEvents(filters, { ts: last.created_at, id: last.id });
        if (res.error) {
          setLoadError("تعذّر تحميل المزيد.");
          return;
        }
        setExtra((prev) => [...prev, ...res.events]);
        setMoreHasMore(res.hasMore);
      } catch {
        setLoadError("تعذّر تحميل المزيد.");
      }
    });
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-line bg-white p-6 text-[14px] text-coral">
        تعذّر تحميل سجل الأمان. حاول مرة أخرى.
      </div>
    );
  }
  if (!events.length) {
    return (
      <div className="rounded-2xl border border-line bg-white p-6 text-[14px] text-gray">
        لا توجد أحداث مطابقة.
      </div>
    );
  }

  return (
    <div>
      <ol className="divide-y divide-line rounded-2xl border border-line bg-white">
        {events.map((e) => {
          const bits = describeAuditDetails(e);
          const target = e.target_name?.trim() || e.target_email || null;
          const selfTarget = !!e.target_id && e.target_id === e.actor_id;
          return (
            <li key={e.id} className="flex items-start gap-3 px-4 py-3">
              <span
                aria-hidden
                className={`mt-2 size-2 shrink-0 rounded-full ${ALERT_ACTIONS.has(e.action) ? "bg-coral" : "bg-teal"}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-[13.5px] font-bold text-ink">{auditActionLabel(e.action)}</span>
                  {target && !selfTarget ? (
                    <span className="text-[12.5px] text-gray">
                      ← <span className="font-semibold text-ink">{target}</span>
                      {e.target_name && e.target_email ? (
                        <span dir="ltr" className="ms-1 font-sans text-[11.5px]">
                          ({e.target_email})
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-gray">
                  <span>بواسطة</span>
                  <span className="font-semibold text-ink">
                    {e.actor_kind === "system" && !e.actor_id ? "النظام" : e.actor_name || "—"}
                  </span>
                  {e.actor_role ? (
                    <span className="whitespace-nowrap rounded bg-cream px-1.5 py-0.5 font-sans text-[10.5px] font-semibold text-teal">
                      {ROLE_LABEL[e.actor_role] ?? e.actor_role}
                    </span>
                  ) : null}
                  {selfTarget ? <span>(على حسابه)</span> : null}
                </div>
                {bits.length ? (
                  <div className="mt-1 text-[12px] leading-5 text-gray">{bits.join(" · ")}</div>
                ) : null}
                <div className="mt-1 font-sans text-[11.5px] text-gray">
                  <RelTime iso={e.created_at} />
                  <span className="mx-1">·</span>
                  <span suppressHydrationWarning>{formatStampAr(e.created_at)}</span>
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

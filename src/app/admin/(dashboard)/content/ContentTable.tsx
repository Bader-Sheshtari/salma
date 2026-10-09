"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { timeAgoAr } from "@/lib/format";
import {
  STATUS_LABEL_AR,
  SYSTEM_AUTHOR_LABEL,
  TYPE_LABEL_AR,
  cursorOf,
  type ContentSearchRow,
  type ContentTab,
  type SearchContentParams,
} from "@/lib/content-search";
import { restoreContent, setStatus, softDeleteContent } from "../../actions";
import { loadMoreContent } from "./content-actions";
import RowMenu, { type Action } from "./RowMenu";

const NEEDS_REVIEW = "بحاجة مراجعة";
const btn =
  "inline-flex items-center rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold hover:bg-cream";
const btnPrimary =
  "inline-flex items-center rounded-lg bg-teal px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50";

const CONFIRM_UNPUBLISH = "ستُرفع من الموقع فورًا وتبقى في الأرشيف بحالة غير منشور. متابعة؟";
const CONFIRM_REPUBLISH = "ستعود للموقع بتاريخ نشرها الأصلي. متابعة؟";
const confirmTrash = (title: string) =>
  `نقل «${title}» إلى المحذوفات؟ يمكن استعادتها لاحقًا من تبويب المحذوفات.`;

const absFmt = new Intl.DateTimeFormat("ar-KW", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  numberingSystem: "latn",
});
function absAr(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : absFmt.format(d);
}

/** Relative Arabic date with the absolute date/time on hover. */
function RelTime({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-gray">—</span>;
  return (
    <time dateTime={iso} title={absAr(iso)} suppressHydrationWarning>
      {timeAgoAr(iso)}
    </time>
  );
}

function statusColor(status: string): string {
  return status === "published"
    ? "var(--salma-teal)"
    : status === "pending"
      ? "var(--salma-blue)"
      : status === "rejected"
        ? "var(--salma-coral)"
        : "var(--salma-gray)";
}

function StatusChip({ status }: { status: string }) {
  return (
    <span
      className="whitespace-nowrap rounded px-1.5 py-0.5 font-sans text-[10px] font-semibold text-white"
      style={{ background: statusColor(status) }}
    >
      {STATUS_LABEL_AR[status] ?? status}
    </span>
  );
}

function CategoryChip({ row, accent }: { row: ContentSearchRow; accent?: string }) {
  if (!row.category_slug) {
    return (
      <span className="whitespace-nowrap rounded border border-coral/50 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-coral">
        {NEEDS_REVIEW}
      </span>
    );
  }
  return (
    <span
      className="whitespace-nowrap rounded px-1.5 py-0.5 font-sans text-[10px] font-semibold text-white"
      style={{ background: accent ?? "var(--salma-gray)" }}
    >
      {row.category_name_ar ?? row.category_slug}
    </span>
  );
}

type Toast = { text: string; republishId?: string };

/**
 * Server-driven content table (every tab except قيد المراجعة, which keeps the
 * ContentInbox triage). First page arrives from the server component; «تحميل
 * المزيد» appends keyset pages via a server action. Mounted with a key derived
 * from the URL query, so any filter/tab/search change starts fresh.
 */
export default function ContentTable({
  initialRows,
  initialHasMore,
  error,
  params,
  tab,
  showCategory,
  showStatusChip,
  accents,
  emptyText,
}: {
  initialRows: ContentSearchRow[];
  initialHasMore: boolean;
  error: string | null;
  params: SearchContentParams;
  tab: ContentTab;
  showCategory: boolean;
  showStatusChip: boolean;
  accents: Record<string, string>;
  emptyText: string;
}) {
  const router = useRouter();
  const [extra, setExtra] = useState<ContentSearchRow[]>([]);
  const [moreHasMore, setMoreHasMore] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [acting, startActing] = useTransition();
  // Local per-row overrides after an action: null = left this view.
  const [overrides, setOverrides] = useState<Record<string, Partial<ContentSearchRow> | null>>({});
  const [toast, setToast] = useState<Toast | null>(null);

  const isTrash = tab === "trash";
  // Rows stay visible after a status change only in the unfiltered الكل list.
  const keepOnStatusChange = params.status === "all";

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 9000);
    return () => clearTimeout(t);
  }, [toast]);

  const rows = useMemo(() => {
    const seen = new Set(initialRows.map((r) => r.id));
    const merged = [...initialRows, ...extra.filter((r) => !seen.has(r.id))];
    const out: ContentSearchRow[] = [];
    for (const r of merged) {
      if (r.id in overrides) {
        const o = overrides[r.id];
        if (o) out.push({ ...r, ...o });
      } else out.push(r);
    }
    return out;
  }, [initialRows, extra, overrides]);

  const hasMore = moreHasMore ?? initialHasMore;

  function loadMore() {
    const last = extra.length > 0 ? extra[extra.length - 1] : initialRows[initialRows.length - 1];
    if (!last) return;
    const cur = cursorOf(last, params.status, params.sort);
    setLoadError(null);
    startLoading(async () => {
      const res = await loadMoreContent({ ...params, cursorTs: cur.ts, cursorId: cur.id });
      if (res.error) {
        setLoadError("تعذّر تحميل المزيد.");
        return;
      }
      setExtra((prev) => [...prev, ...res.rows]);
      setMoreHasMore(res.hasMore);
    });
  }

  function changeStatus(row: ContentSearchRow, status: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    startActing(async () => {
      const fd = new FormData();
      fd.set("id", row.id);
      fd.set("status", status);
      const res = await setStatus(fd);
      if ("error" in res) {
        window.alert(res.error);
        return;
      }
      setOverrides((o) => ({ ...o, [row.id]: keepOnStatusChange ? { status } : null }));
      router.refresh();
    });
  }

  function moveToTrash(row: ContentSearchRow) {
    if (!window.confirm(confirmTrash(row.title))) return;
    startActing(async () => {
      const fd = new FormData();
      fd.set("id", row.id);
      await softDeleteContent(fd);
      setOverrides((o) => ({ ...o, [row.id]: null }));
      router.refresh();
    });
  }

  function restore(row: ContentSearchRow) {
    startActing(async () => {
      const res = await restoreContent(row.id);
      if ("error" in res) {
        window.alert(res.error);
        return;
      }
      setOverrides((o) => ({ ...o, [row.id]: null }));
      setToast(
        res.status === "unpublished"
          ? {
              text: `استُعيدت «${res.title}» بحالة غير منشور.`,
              republishId: row.id,
            }
          : { text: `استُعيدت «${res.title}» (${STATUS_LABEL_AR[res.status] ?? res.status}).` },
      );
      router.refresh();
    });
  }

  function republishFromToast(id: string) {
    if (!window.confirm(CONFIRM_REPUBLISH)) return;
    startActing(async () => {
      const fd = new FormData();
      fd.set("id", id);
      fd.set("status", "published");
      const res = await setStatus(fd);
      if ("error" in res) {
        window.alert(res.error);
        return;
      }
      setToast({ text: "أُعيد نشر المادة." });
      router.refresh();
    });
  }

  function actionsFor(row: ContentSearchRow): { visible: Action[]; menu: Action[] } {
    const edit: Action = { key: "edit", label: "تحرير", href: `/admin/content/${row.id}` };
    const preview = (label: string): Action => ({
      key: "preview",
      label,
      href: `/admin/preview/${row.id}`,
      newTab: true,
    });
    const trash: Action = {
      key: "trash",
      label: "نقل إلى المحذوفات",
      danger: true,
      onClick: () => moveToTrash(row),
    };
    if (row.deleted_at) {
      return {
        visible: [
          { key: "restore", label: "استعادة", primary: true, onClick: () => restore(row) },
          preview("عرض"),
        ],
        menu: [],
      };
    }
    switch (row.status) {
      case "published":
        return {
          visible: [
            { key: "open", label: "فتح", href: `/article/${row.slug}`, newTab: true },
            edit,
          ],
          menu: [
            {
              key: "unpublish",
              label: "إلغاء النشر",
              onClick: () => changeStatus(row, "unpublished", CONFIRM_UNPUBLISH),
            },
            trash,
          ],
        };
      case "unpublished":
        return {
          visible: [
            preview("فتح معاينة"),
            edit,
            {
              key: "republish",
              label: "إعادة النشر",
              primary: true,
              onClick: () => changeStatus(row, "published", CONFIRM_REPUBLISH),
            },
          ],
          menu: [trash],
        };
      case "draft":
        return {
          visible: [edit],
          menu: [
            { key: "submit", label: "إرسال للمراجعة", onClick: () => changeStatus(row, "pending") },
            trash,
          ],
        };
      case "rejected":
        return {
          visible: [preview("فتح")],
          menu: [
            { key: "todraft", label: "إعادة إلى مسودة", onClick: () => changeStatus(row, "draft") },
            trash,
          ],
        };
      default:
        // pending (seen in الكل / search results): triage happens in its tab.
        return { visible: [preview("فتح معاينة"), edit], menu: [trash] };
    }
  }

  const th = "px-3 py-2 text-start text-[11.5px] font-bold text-gray whitespace-nowrap";
  const td = "px-3 py-2.5 align-middle font-sans text-[12px] text-gray whitespace-nowrap";

  return (
    <div>
      <div className="rounded-2xl border border-line bg-white">
        {error ? (
          <div className="p-6 text-[14px] text-coral">تعذّر تحميل القائمة. حاول مرة أخرى.</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-[14px] text-gray">{emptyText}</div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="hidden md:table-header-group">
              <tr className="border-b border-line">
                <th className={th}>العنوان</th>
                {showCategory ? <th className={`${th} hidden lg:table-cell`}>القسم</th> : null}
                <th className={th}>{isTrash ? "تاريخ النقل" : "تاريخ النشر"}</th>
                <th className={`${th} hidden lg:table-cell`}>آخر تعديل</th>
                <th className={th}>الكاتب</th>
                {showStatusChip ? <th className={th}>الحالة</th> : null}
                <th className={`${th} text-end`}>إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => {
                const { visible, menu } = actionsFor(row);
                const author = row.author_name || SYSTEM_AUTHOR_LABEL;
                const dateCell = isTrash ? (
                  <span>
                    نُقلت{row.deleted_by_name ? `: ${row.deleted_by_name} · ` : " "}
                    <RelTime iso={row.deleted_at} />
                  </span>
                ) : (
                  <RelTime iso={row.published_at} />
                );
                return (
                  <tr key={row.id} className="hover:bg-cream/40">
                    <td className="w-full max-w-0 px-3 py-2.5 align-middle">
                      <div className="flex min-w-0 items-start gap-2">
                        <span className="mt-0.5 shrink-0 rounded bg-cream px-1.5 py-0.5 font-sans text-[10px] font-semibold text-teal">
                          {TYPE_LABEL_AR[row.type] ?? row.type}
                        </span>
                        <Link
                          href={row.deleted_at ? `/admin/preview/${row.id}` : `/admin/content/${row.id}`}
                          className="line-clamp-2 text-[14px] font-semibold leading-snug text-ink hover:text-teal"
                          title={row.title}
                        >
                          {row.title}
                        </Link>
                      </div>
                      {/* Second line: below lg carries القسم/آخر تعديل; below md also date/author/chip. */}
                      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-sans text-[11px] text-gray lg:hidden">
                        {showCategory ? <CategoryChip row={row} accent={accents[row.category_slug ?? ""]} /> : null}
                        <span className="md:hidden">{dateCell}</span>
                        <span className="md:hidden">· {author}</span>
                        <span className="hidden md:inline">
                          آخر تعديل <RelTime iso={row.last_edited_at} />
                        </span>
                        {showStatusChip ? (
                          <span className="md:hidden">
                            <StatusChip status={row.status} />
                          </span>
                        ) : null}
                      </div>
                    </td>
                    {showCategory ? (
                      <td className={`${td} hidden lg:table-cell`}>
                        <CategoryChip row={row} accent={accents[row.category_slug ?? ""]} />
                      </td>
                    ) : null}
                    <td className={`${td} hidden md:table-cell`}>{dateCell}</td>
                    <td className={`${td} hidden lg:table-cell`}>
                      <RelTime iso={row.last_edited_at} />
                    </td>
                    <td className={`${td} hidden md:table-cell`}>{author}</td>
                    {showStatusChip ? (
                      <td className={`${td} hidden md:table-cell`}>
                        <StatusChip status={row.status} />
                      </td>
                    ) : null}
                    <td className="px-3 py-2.5 align-middle">
                      <div className="flex items-center justify-end gap-1.5">
                        {visible.map((a) =>
                          a.href ? (
                            <Link
                              key={a.key}
                              href={a.href}
                              target={a.newTab ? "_blank" : undefined}
                              className={`${btn} hidden whitespace-nowrap md:inline-flex`}
                            >
                              {a.label}
                            </Link>
                          ) : (
                            <button
                              key={a.key}
                              type="button"
                              disabled={acting}
                              onClick={a.onClick}
                              className={`${a.primary ? btnPrimary : btn} hidden whitespace-nowrap md:inline-flex`}
                            >
                              {a.label}
                            </button>
                          ),
                        )}
                        <RowMenu visible={visible} menu={menu} disabled={acting} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {!error && rows.length > 0 ? (
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
          <div className="font-sans text-[11px] text-gray">معروض: {rows.length}</div>
        </div>
      ) : null}

      {toast ? (
        <div className="fixed inset-x-0 bottom-4 z-30 mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center gap-3 rounded-xl border border-line bg-white px-4 py-2.5 text-[13px] shadow-lg">
          <span>{toast.text}</span>
          {toast.republishId ? (
            <button
              type="button"
              disabled={acting}
              onClick={() => republishFromToast(toast.republishId!)}
              className="font-semibold text-teal underline disabled:opacity-50"
            >
              إعادة النشر
            </button>
          ) : null}
          <button type="button" onClick={() => setToast(null)} className="text-[12px] text-gray" aria-label="إغلاق">
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}

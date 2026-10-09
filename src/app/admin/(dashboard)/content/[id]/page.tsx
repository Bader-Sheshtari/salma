import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCategories } from "@/lib/queries";
import {
  getContentAuditLog,
  getContentForEdit,
  getContentVersion,
  getContentVersions,
  getEvidenceForContent,
  getProfileNames,
} from "@/lib/admin-queries";
import { formatDateTimeAr } from "@/lib/format";
import {
  SYSTEM_ACTOR_LABEL,
  absAr,
  changedRestorableFields,
  fieldLabels,
  sameDayKw,
} from "@/lib/content-history";
import type { Content } from "@/lib/queries";
import { contentHref } from "@/lib/content-search";
import Breadcrumbs, { truncateCrumb, type Crumb } from "../../Breadcrumbs";
import ActivityTimeline from "../ActivityTimeline";
import { ContentForm } from "../ContentForm";
import RejectButton from "../RejectButton";
import { EvidencePanel } from "../EvidencePanel";
import VersionView from "../VersionView";
import VersionsPanel from "../VersionsPanel";
import { requireStaff } from "@/lib/auth";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  published: "منشور",
  pending: "بانتظار المراجعة",
  draft: "مسودّة",
  rejected: "مرفوض",
  unpublished: "غير منشور",
};

function statusColor(status: string): string {
  if (status === "published") return "var(--salma-teal)";
  if (status === "pending") return "var(--salma-blue)";
  if (status === "rejected") return "var(--salma-coral)";
  return "var(--salma-gray)";
}

type View = "content" | "activity" | "versions";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
function posInt(v: string | undefined): number | null {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 ? n : null;
}

/**
 * Compact accountability strip (owner adjustment 1): at most two lines on
 * desktop (stacked on mobile) plus an optional red trash line. Segments whose
 * value is NULL are omitted — never an empty label.
 */
function MetaStrip({ content, names }: { content: Content; names: Map<string, string> }) {
  const who = (id: string | null) => (id && names.get(id)) || SYSTEM_ACTOR_LABEL;
  const line1: string[] = [`أنشأها ${who(content.created_by)} · ${absAr(content.created_at)}`];
  if (content.last_edited_at) {
    line1.push(`آخر تعديل: ${who(content.last_edited_by)} · ${absAr(content.last_edited_at)}`);
  }
  const line2: string[] = [];
  if (content.first_published_at) {
    const by = content.published_by ? names.get(content.published_by) : null;
    line2.push(
      by
        ? `نُشرت بواسطة ${by} · التاريخ الأصلي: ${absAr(content.first_published_at)}`
        : `التاريخ الأصلي للنشر: ${absAr(content.first_published_at)}`,
    );
  }
  if (content.reviewed_at) {
    const by = content.reviewed_by ? names.get(content.reviewed_by) : null;
    line2.push(
      by
        ? `روجعت بواسطة ${by} · ${absAr(content.reviewed_at)}`
        : `روجعت: ${absAr(content.reviewed_at)}`,
    );
  }
  if (
    content.last_published_at &&
    content.first_published_at &&
    !sameDayKw(content.last_published_at, content.first_published_at)
  ) {
    line2.push(`آخر نشر: ${absAr(content.last_published_at)}`);
  }

  const line = (parts: string[]) => (
    <div className="flex flex-col gap-0.5 md:flex-row md:flex-wrap md:gap-x-4">
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </div>
  );

  return (
    <div className="mb-4 flex flex-col gap-1 font-sans text-[11.5px] leading-relaxed text-gray">
      {line(line1)}
      {line2.length ? line(line2) : null}
      {content.deleted_at ? (
        <div className="font-semibold text-coral">
          في المحذوفات — نقلها {who(content.deleted_by)} · {absAr(content.deleted_at)}
        </div>
      ) : null}
    </div>
  );
}

export default async function EditContent({ params, searchParams }: Props) {
  // Content area: any staff role (editor and above).
  await requireStaff();
  const { id } = await params;
  const sp = await searchParams;
  const rawView = first(sp.view);
  const view: View = rawView === "activity" || rawView === "versions" ? rawView : "content";
  const versionNo = view === "versions" ? posInt(first(sp.v)) : null;

  const [categories, data, evidence] = await Promise.all([
    getCategories(),
    getContentForEdit(id),
    view === "content" ? getEvidenceForContent(id) : Promise.resolve(null),
  ]);
  if (!data) notFound();

  const { content } = data;
  const isAi = content.origin === "ai";
  const base = `/admin/content/${content.id}`;
  const isSnapshot = versionNo != null && versionNo < content.version;

  const [names, activity, versions, single] = await Promise.all([
    getProfileNames([
      content.created_by,
      content.last_edited_by,
      content.published_by,
      content.reviewed_by,
      content.deleted_by,
    ]),
    view === "activity" ? getContentAuditLog(content.id) : Promise.resolve(null),
    view === "versions" && versionNo == null ? getContentVersions(content.id) : Promise.resolve(null),
    isSnapshot && versionNo != null ? getContentVersion(content.id, versionNo) : Promise.resolve(null),
  ]);

  const tabs: { key: View; label: string; href: string }[] = [
    { key: "content", label: "المحتوى", href: base },
    { key: "activity", label: "سجل النشاط", href: `${base}?view=activity` },
    { key: "versions", label: `الإصدارات (${content.version})`, href: `${base}?view=versions` },
  ];

  const restoredFrom = view === "versions" && versionNo == null ? posInt(first(sp.restored)) : null;
  const newVersion = posInt(first(sp.nv)) ?? content.version;
  const restoredNotice = restoredFrom
    ? `استُعيد محتوى الإصدار ${restoredFrom} — النسخة الحالية الآن هي الإصدار ${newVersion}.`
    : null;

  // Breadcrumb trail: المحتوى ← (المحذوفات | كل الأقسام ← القسم) ← العنوان ← (view).
  const statusParam = content.status === "published" ? "" : content.status;
  // The pending inbox ignores `cat`, so pending articles link to the all-status list instead.
  const catStatusParam = content.status === "pending" ? "all" : statusParam;
  const articleCat = content.category_slug ? categories.find((c) => c.slug === content.category_slug) : undefined;
  const crumbs: Crumb[] = [{ label: "المحتوى", href: "/admin/content" }];
  if (content.deleted_at) {
    crumbs.push({ label: "المحذوفات", href: contentHref({ status: "trash" }) });
  } else if (content.category_slug) {
    crumbs.push(
      { label: "كل الأقسام", href: contentHref({ status: statusParam }) },
      {
        label: articleCat?.name_ar ?? content.category_slug,
        href: contentHref({ status: catStatusParam, cat: content.category_slug }),
      },
    );
  }
  const titleCrumb = truncateCrumb(content.title);
  if (view === "content") {
    crumbs.push({ label: titleCrumb });
  } else if (view === "activity") {
    crumbs.push({ label: titleCrumb, href: base }, { label: "سجل النشاط" });
  } else if (versionNo == null) {
    crumbs.push({ label: titleCrumb, href: base }, { label: "الإصدارات" });
  } else {
    crumbs.push(
      { label: titleCrumb, href: base },
      { label: "الإصدارات", href: `${base}?view=versions` },
      { label: `الإصدار ${versionNo}` },
    );
  }

  const header = (
    <>
      <Breadcrumbs items={crumbs} />
      <h1 className="mb-1.5 text-2xl font-bold">تحرير المحتوى</h1>
      {view !== "content" ? (
        <div className="mb-1.5 line-clamp-2 text-[14.5px] font-semibold text-ink">{content.title}</div>
      ) : null}
      <MetaStrip content={content} names={names} />
      <nav className="salma-scroll mb-5 flex gap-2 overflow-x-auto" aria-label="أقسام المادة">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={view === t.key ? "page" : undefined}
            className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${
              view === t.key ? "bg-teal text-white" : "border border-line bg-white text-gray hover:bg-cream"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </>
  );

  if (view === "activity") {
    return (
      <div>
        {header}
        <div className="max-w-3xl">
          <ActivityTimeline
            contentId={content.id}
            currentVersion={content.version}
            initialEvents={activity?.events ?? []}
            initialHasMore={activity?.hasMore ?? false}
            error={activity?.error ?? null}
          />
        </div>
      </div>
    );
  }

  if (view === "versions") {
    let body: ReactNode;
    if (versionNo == null) {
      body = (
        <VersionsPanel
          contentId={content.id}
          current={{
            version: content.version,
            editorName: (content.last_edited_by && names.get(content.last_edited_by)) || SYSTEM_ACTOR_LABEL,
            editedAt: content.last_edited_at,
          }}
          initialVersions={versions?.versions ?? []}
          initialHasMore={versions?.hasMore ?? false}
          error={versions?.error ?? null}
          restoredNotice={restoredNotice}
        />
      );
    } else if (!isSnapshot || !single) {
      body = (
        <div className="rounded-2xl border border-line bg-white p-6 text-[14px] text-gray">
          {versionNo === content.version ? (
            <>
              الإصدار {versionNo} هو النسخة الحالية.{" "}
              <Link href={base} className="font-semibold text-teal">
                فتح المحتوى
              </Link>
            </>
          ) : (
            "هذا الإصدار غير موجود."
          )}{" "}
          <Link href={`${base}?view=versions`} className="font-semibold text-teal">
            رجوع إلى الإصدارات
          </Link>
        </div>
      );
    } else {
      const cat = categories.find((c) => c.slug === single.version.category_slug) ?? null;
      body = (
        <VersionView
          contentId={content.id}
          version={single.version}
          meta={single.meta}
          categoryName={cat?.name_ar ?? null}
          categoryAccent={cat?.accent ?? null}
          changedFields={fieldLabels(
            changedRestorableFields(
              content as unknown as Record<string, unknown>,
              single.version as unknown as Record<string, unknown>,
            ),
          )}
          isPublished={content.status === "published" && !content.deleted_at}
          isTrashed={!!content.deleted_at}
        />
      );
    }
    return (
      <div>
        {header}
        <div className="max-w-3xl">{body}</div>
      </div>
    );
  }

  return (
    <div>
      {header}

      {/* Source-first review panel: the key provenance an editor needs BEFORE
          publishing, surfaced above the long edit form. Source fields remain
          editable in the form below. */}
      <div className="mb-5 max-w-2xl rounded-2xl border border-line bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          {isAi ? (
            <span className="rounded-md bg-teal/10 px-2 py-0.5 text-[11px] font-bold text-teal">
              مولّد بالذكاء الاصطناعي
            </span>
          ) : null}
          <span
            className="rounded-md px-2 py-0.5 text-[11px] font-bold text-white"
            style={{ background: statusColor(content.status) }}
          >
            {STATUS_LABEL[content.status] ?? content.status}
          </span>
          <span className="font-sans text-[11.5px] text-gray">
            أُضيف {formatDateTimeAr(content.created_at)}
          </span>
        </div>

        {isAi && (content.source_name || content.source_url) ? (
          <div className="mt-2.5 text-[12.5px] text-ink">
            <span className="font-semibold">المصدر:</span> {content.source_name ?? "—"}
            {content.source_url ? (
              <a
                href={content.source_url}
                target="_blank"
                rel="noopener noreferrer"
                dir="ltr"
                className="mr-2 font-semibold text-teal underline underline-offset-2"
              >
                فتح المصدر ↗
              </a>
            ) : null}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link
            href={`/admin/preview/${content.id}`}
            target="_blank"
            className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-cream"
          >
            معاينة قبل النشر ↗
          </Link>
          {content.status === "pending" ? (
            <RejectButton id={content.id} title={content.title} />
          ) : null}
        </div>
      </div>

      {/* Evidence Intelligence card (read-only, admin-only): what kind of
          evidence this story rests on and what it can/can't support. Rendered
          only when the ESL pipeline produced an analysis row. */}
      <EvidencePanel evidence={evidence} />

      <ContentForm content={data.content} sources={data.sources} media={data.media} categories={categories} />
    </div>
  );
}

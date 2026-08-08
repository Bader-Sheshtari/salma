import Link from "next/link";
import { notFound } from "next/navigation";
import { getCategories } from "@/lib/queries";
import { getContentForEdit } from "@/lib/admin-queries";
import { formatDateTimeAr } from "@/lib/format";
import { rejectContent } from "../../../actions";
import { ContentForm } from "../ContentForm";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  published: "منشور",
  pending: "بانتظار المراجعة",
  draft: "مسودّة",
  rejected: "مرفوض",
};

function statusColor(status: string): string {
  if (status === "published") return "var(--salma-teal)";
  if (status === "pending") return "var(--salma-blue)";
  if (status === "rejected") return "var(--salma-coral)";
  return "var(--salma-gray)";
}

type Props = { params: Promise<{ id: string }> };

export default async function EditContent({ params }: Props) {
  const { id } = await params;
  const [categories, data] = await Promise.all([getCategories(), getContentForEdit(id)]);
  if (!data) notFound();

  const { content } = data;
  const isAi = content.origin === "ai";

  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">تحرير المحتوى</h1>

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
            <form action={rejectContent}>
              <input type="hidden" name="id" value={content.id} />
              <button className="rounded-lg border border-coral/50 px-3 py-1.5 text-[12.5px] font-semibold text-coral hover:bg-cream">
                رفض
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <ContentForm content={data.content} sources={data.sources} media={data.media} categories={categories} />
    </div>
  );
}

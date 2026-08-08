import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { ArticleView } from "@/components/site/ArticleView";
import { getCategories, getRelated, type ContentDetail } from "@/lib/queries";
import { getContentForEdit } from "@/lib/admin-queries";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// A preview can render unpublished (pending/draft/rejected) content, so it must
// never be indexed or followed by search engines.
export const metadata: Metadata = { robots: { index: false, follow: false } };

const STATUS_LABEL: Record<string, string> = {
  published: "منشور",
  pending: "بانتظار المراجعة",
  draft: "مسودّة",
  rejected: "مرفوض",
};

type Props = { params: Promise<{ id: string }> };

/**
 * Admin-only preview of a single content item rendered with the real public
 * article layout (Header + ArticleView + Footer), so an editor sees exactly how
 * a pending article will look before publishing. Authorization: `requireAdmin`
 * gates the page (redirects non-admins to the login screen), and the content is
 * read through the admin session client under the same RLS as the edit screen —
 * so unpublished statuses are visible here without changing the public
 * `/article/[slug]` route, which still serves published content only.
 */
export default async function ContentPreview({ params }: Props) {
  await requireAdmin();
  const { id } = await params;
  const data = await getContentForEdit(id);
  if (!data) notFound();

  const [categories, related] = await Promise.all([
    getCategories(),
    getRelated(data.content),
  ]);

  const detail: ContentDetail = {
    content: data.content,
    sources: data.sources,
    media: data.media,
    comments: [],
  };
  const statusLabel = STATUS_LABEL[data.content.status] ?? data.content.status;

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <div className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-2 bg-coral px-4 py-2 text-white">
        <span className="text-[13px] font-bold">
          معاينة — هذه ليست نسخة منشورة (الحالة: {statusLabel})
        </span>
        <Link
          href={`/admin/content/${id}`}
          className="rounded-lg bg-white/20 px-3 py-1 text-[12.5px] font-semibold hover:bg-white/30"
        >
          العودة إلى التحرير
        </Link>
      </div>
      <Header categories={categories} active={data.content.category_slug ?? undefined} />
      <main>
        <ArticleView detail={detail} categories={categories} related={related} />
      </main>
      <Footer categories={categories} />
    </div>
  );
}

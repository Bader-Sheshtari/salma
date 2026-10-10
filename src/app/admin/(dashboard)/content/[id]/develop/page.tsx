import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getDevelopmentState } from "@/app/admin/develop-actions";
import { formatDateTimeAr } from "@/lib/format";
import { DevelopFlow } from "./DevelopFlow";

export const dynamic = "force-dynamic";
// The start/draft actions proxy long AI phases; give the route headroom where
// the platform allows it (the edge function owns terminal state regardless).
export const maxDuration = 300;

type Props = { params: Promise<{ id: string }> };

export default async function DevelopStoryPage({ params }: Props) {
  await requireStaff();
  const { id } = await params;

  // The ssr client's row inference is unreliable project-wide; explicit row
  // shapes + casts are the house pattern (see admin-queries.ts).
  type Row = {
    id: string;
    title: string;
    excerpt: string | null;
    status: string;
    category_slug: string | null;
    source_name: string | null;
    source_url: string | null;
    original_url: string | null;
    published_at: string | null;
    deleted_at: string | null;
  };
  const supabase = await createClient();
  const { data } = await supabase
    .from("content")
    .select("id,title,excerpt,status,category_slug,source_name,source_url,original_url,published_at,deleted_at")
    .eq("id", id)
    .maybeSingle();
  const content = data as Row | null;
  if (!content || content.deleted_at) notFound();

  const developable = ["published", "pending", "unpublished"].includes(content.status);
  const initial = await getDevelopmentState(id);

  const { data: categoryData } = content.category_slug
    ? await supabase.from("categories").select("name_ar").eq("slug", content.category_slug).maybeSingle()
    : { data: null };
  const category = categoryData as { name_ar: string } | null;

  const sourceUrl = content.original_url || content.source_url;

  return (
    <div className="max-w-3xl">
      <div className="mb-1 font-sans text-[12px] text-gray">
        <Link href={`/admin/content/${id}`} className="hover:text-ink">
          ← العودة إلى المقال
        </Link>
      </div>
      <h1 className="mb-4 text-2xl font-bold">طوّر القصة</h1>

      {/* Original article context (§4): what is being developed. */}
      <div className="mb-5 rounded-2xl border border-line bg-white p-4">
        <div className="text-[15px] font-bold leading-snug">{content.title}</div>
        {content.excerpt ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-gray">{content.excerpt}</p>
        ) : null}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-gray">
          {category?.name_ar ? <span>القسم: {category.name_ar}</span> : null}
          {content.source_name ? <span>المصدر: {content.source_name}</span> : null}
          {content.published_at ? (
            <span className="font-sans">نُشر {formatDateTimeAr(content.published_at)}</span>
          ) : null}
          {sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              dir="ltr"
              className="font-semibold text-teal underline underline-offset-2"
            >
              رابط المصدر الأصلي ↗
            </a>
          ) : null}
        </div>
      </div>

      {developable ? (
        <DevelopFlow
          contentId={id}
          initialJob={initial.job}
          initialHistory={initial.history}
          initialResultTitle={initial.resultTitle}
        />
      ) : (
        <div className="rounded-2xl border border-line bg-white p-5 text-[13.5px] text-gray">
          لا يمكن تطوير هذا المقال في حالته الحالية — التطوير متاح للمقالات المنشورة أو بانتظار
          المراجعة أو غير المنشورة.
        </div>
      )}
    </div>
  );
}

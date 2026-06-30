import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { ArticleView } from "@/components/site/ArticleView";
import { getContentBySlug, getCategories, getRelated } from "@/lib/queries";
import { contentMetadata } from "@/lib/seo";

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const detail = await getContentBySlug(slug);
  if (!detail) return { title: "غير موجود" };
  return contentMetadata(detail);
}

export default async function VideoPage({ params }: Props) {
  const { slug } = await params;
  const [detail, categories] = await Promise.all([getContentBySlug(slug), getCategories()]);
  if (!detail) notFound();

  const related = await getRelated(detail.content);

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} active={detail.content.category_slug ?? undefined} />
      <main>
        <ArticleView detail={detail} categories={categories} related={related} />
      </main>
      <Footer categories={categories} />
    </div>
  );
}

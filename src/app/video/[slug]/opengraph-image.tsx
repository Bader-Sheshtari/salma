import { getContentBySlug, getCategories } from "@/lib/queries";
import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from "@/lib/og";

export const alt = "سلمى — أخبار صحية موثوقة";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [detail, categories] = await Promise.all([getContentBySlug(slug), getCategories()]);
  const content = detail?.content;
  const category = categories.find((c) => c.slug === content?.category_slug);

  return ogCard({
    title: content?.title ?? "سلمى",
    categoryName: category?.name_ar,
    accent: category?.accent,
    isVideo: true,
  });
}

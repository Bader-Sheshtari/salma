import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { ContentCard } from "@/components/site/cards";
import { SearchBox } from "@/components/site/SearchBox";
import { getCategories, getContentByCategory } from "@/lib/queries";

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

/** Old category slugs that were renamed. Old shared links permanently redirect
 * to their new slug so they keep working. */
const LEGACY_SLUG_REDIRECTS: Record<string, string> = {
  "شصاير-في-داوي": "dawi-news",
};

/** Route params arrive percent-encoded for non-ASCII (Arabic) slugs; decode
 * before matching the raw value stored in the DB. */
function decodeSlug(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const slug = decodeSlug((await params).slug);
  const categories = await getCategories();
  const cat = categories.find((c) => c.slug === slug);
  return { title: cat ? `${cat.name_ar} · سلمى` : "سلمى" };
}

export default async function CategoryPage({ params }: Props) {
  const slug = decodeSlug((await params).slug);
  const redirectTo = LEGACY_SLUG_REDIRECTS[slug];
  if (redirectTo) permanentRedirect(`/category/${redirectTo}`);
  const [categories, items] = await Promise.all([
    getCategories(),
    getContentByCategory(slug),
  ]);
  const cat = categories.find((c) => c.slug === slug);
  if (!cat) notFound();

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} active={cat.slug} />
      <main className="px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="h-7 w-1.5 rounded-sm" style={{ background: cat.accent }} />
          <h1 className="text-2xl font-bold sm:text-3xl">{cat.name_ar}</h1>
        </div>
        <div className="mb-6">
          <SearchBox />
        </div>
        {items.length === 0 ? (
          <p className="text-[14px] text-gray">لا يوجد محتوى منشور في هذا القسم بعد.</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((c) => (
              <div key={c.id} className="border border-line">
                <ContentCard c={c} />
              </div>
            ))}
          </div>
        )}
      </main>
      <Footer categories={categories} />
    </div>
  );
}

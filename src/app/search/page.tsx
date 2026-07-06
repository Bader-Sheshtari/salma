import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { SearchResultRow } from "@/components/site/cards";
import { SearchBox } from "@/components/site/SearchBox";
import { getCategories, searchAll } from "@/lib/queries";

export const metadata: Metadata = { title: "بحث · سلمى" };

type Props = { searchParams: Promise<{ q?: string }> };

export default async function SearchPage({ searchParams }: Props) {
  const { q = "" } = await searchParams;
  const query = q.trim();
  const [categories, results] = await Promise.all([
    getCategories(),
    query ? searchAll(query) : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} />
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <h1 className="mb-4 text-2xl font-bold">البحث</h1>
        <div className="mb-6">
          <SearchBox defaultValue={query} variant="hero" autoFocus />
        </div>

        {query ? (
          results.length === 0 ? (
            <p className="text-[14px] text-gray">لا توجد نتائج لـ «{query}».</p>
          ) : (
            <>
              <p className="mb-2 text-[12.5px] text-gray">
                {results.length} نتيجة لـ «{query}»
              </p>
              <div className="flex flex-col divide-y divide-line">
                {results.map((r) => (
                  <SearchResultRow key={`${r.kind}:${r.id}`} r={r} />
                ))}
              </div>
            </>
          )
        ) : (
          <p className="text-[14px] text-gray">
            اكتب كلمة للبحث في الأخبار والمقالات والدراسات والفيديو والأطباء والأقسام.
          </p>
        )}
      </main>
      <Footer categories={categories} />
    </div>
  );
}

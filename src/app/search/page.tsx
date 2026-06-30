import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { ListRow } from "@/components/site/cards";
import { getCategories, searchContent } from "@/lib/queries";

export const metadata: Metadata = { title: "بحث · سلمى" };

type Props = { searchParams: Promise<{ q?: string }> };

export default async function SearchPage({ searchParams }: Props) {
  const { q = "" } = await searchParams;
  const query = q.trim();
  const [categories, results] = await Promise.all([
    getCategories(),
    query ? searchContent(query) : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} />
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <h1 className="mb-4 text-2xl font-bold">البحث</h1>
        <form action="/search" className="mb-6 flex gap-2">
          <input
            name="q"
            defaultValue={query}
            placeholder="ابحث في سلمى…"
            dir="rtl"
            className="flex-1 rounded-lg border border-gray/40 px-3.5 py-3 text-sm outline-none focus:border-teal"
          />
          <button type="submit" className="rounded-lg bg-teal px-5 py-3 text-sm font-bold text-white">
            بحث
          </button>
        </form>

        {query ? (
          results.length === 0 ? (
            <p className="text-[14px] text-gray">لا توجد نتائج لـ «{query}».</p>
          ) : (
            <>
              <p className="mb-2 text-[12.5px] text-gray">{results.length} نتيجة لـ «{query}»</p>
              <div className="flex flex-col divide-y divide-line">
                {results.map((c) => (
                  <ListRow key={c.id} c={c} />
                ))}
              </div>
            </>
          )
        ) : (
          <p className="text-[14px] text-gray">اكتب كلمة للبحث في الأخبار والمقالات والفيديو.</p>
        )}
      </main>
      <Footer categories={categories} />
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { SearchResultRow } from "@/components/site/cards";
import { SearchBox } from "@/components/site/SearchBox";
import { getCategories, searchPublic } from "@/lib/queries";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalize } from "@/lib/search";
import { absoluteUrl } from "@/lib/site";

// Search-result pages are query-parameterized, effectively infinite and thin —
// noindex keeps crawlers out of them while follow lets link equity flow to the
// article pages. Article/canonical URLs are untouched.
export const metadata: Metadata = {
  title: "بحث · سلمى",
  alternates: { canonical: "/search" },
  openGraph: { title: "بحث · سلمى", url: absoluteUrl("/search") },
  robots: { index: false, follow: true },
};

type Props = { searchParams: Promise<{ q?: string; page?: string }> };

/** Privacy-respecting search-analytics foundation: the NORMALIZED query, the
 *  result count and a timestamp — nothing else (no IPs, no identifiers).
 *  Best-effort: a logging failure never affects the reader. */
async function logSearch(query: string, resultCount: number): Promise<void> {
  try {
    const norm = normalize(query).slice(0, 120);
    if (norm.length < 2) return;
    // `search_queries` lands in the generated types on the next regen; loose
    // cast until then (house pattern).
    const db = createAdminClient() as unknown as {
      from: (t: string) => { insert: (v: unknown) => Promise<{ error: unknown }> };
    };
    await db.from("search_queries").insert({ query_norm: norm, result_count: resultCount });
  } catch {
    // analytics must never break search
  }
}

export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const query = (sp.q ?? "").trim();
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  const [categories, result] = await Promise.all([
    getCategories(),
    query
      ? searchPublic(query, page)
      : Promise.resolve({ results: [], total: 0, page: 1, pageSize: 20, hasMore: false }),
  ]);

  if (query && page === 1) await logSearch(query, result.total);

  const pageLink = (p: number) =>
    `/search?q=${encodeURIComponent(query)}${p > 1 ? `&page=${p}` : ""}`;

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} />
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <h1 className="mb-4 text-2xl font-bold">البحث</h1>
        <div className="mb-6">
          <SearchBox defaultValue={query} variant="hero" autoFocus />
        </div>

        {query ? (
          result.results.length === 0 ? (
            <div className="rounded-2xl bg-cream/60 px-5 py-6 text-center">
              <p className="text-[15px] font-semibold text-ink">
                ما لقينا نتائج مطابقة لـ «{query}».
              </p>
              <p className="mt-1 text-[13px] text-gray">جرّب كلمة أو موضوعاً آخر.</p>
            </div>
          ) : (
            <>
              <p className="mb-2 font-sans text-[12.5px] text-gray">
                {result.total} نتيجة لـ «{query}»
                {result.page > 1 ? ` — صفحة ${result.page}` : ""}
              </p>
              <div className="flex flex-col divide-y divide-line">
                {result.results.map((r) => (
                  <SearchResultRow key={`${r.kind}:${r.id}`} r={r} />
                ))}
              </div>
              {result.page > 1 || result.hasMore ? (
                <div className="mt-6 flex items-center justify-center gap-3 text-[13.5px]">
                  {result.page > 1 ? (
                    <Link
                      href={pageLink(result.page - 1)}
                      className="rounded-lg border border-line px-4 py-2 font-semibold text-gray hover:bg-cream"
                    >
                      → السابق
                    </Link>
                  ) : null}
                  {result.hasMore ? (
                    <Link
                      href={pageLink(result.page + 1)}
                      className="rounded-lg bg-teal px-4 py-2 font-bold text-white"
                    >
                      نتائج أكثر ←
                    </Link>
                  ) : null}
                </div>
              ) : null}
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

import Link from "next/link";
import {
  getContentCounts,
  listAdminProfiles,
  listCategories,
  listContent,
  searchContent,
} from "@/lib/admin-queries";
import {
  CONTENT_TABS,
  contentHref,
  parseContentQuery,
  queryToParams,
  resolveSort,
  sortOptions,
  toSearchParams,
  type ContentSort,
} from "@/lib/content-search";
import ContentInbox from "./ContentInbox";
import ContentTable from "./ContentTable";
import FilterBar from "./FilterBar";
import SearchBox from "./SearchBox";

export const dynamic = "force-dynamic";

/** Tabs that show the category strip (archive views). */
const STRIP_TABS = new Set(["published", "unpublished", "all"]);

const EMPTY_TEXT: Record<string, string> = {
  all: "لا يوجد محتوى.",
  published: "لا توجد مواد منشورة.",
  draft: "لا توجد مسودات.",
  unpublished: "لا توجد مواد غير منشورة.",
  rejected: "لا توجد مواد مرفوضة.",
  trash: "المحذوفات فارغة.",
};

/** «N مادة منشورة» suffix in the category header. */
const CAT_COUNT_NOUN: Record<string, string> = {
  published: "مادة منشورة",
  unpublished: "مادة غير منشورة",
  all: "مادة",
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ContentList({ searchParams }: Props) {
  const query = parseContentQuery(await searchParams);
  const { tab } = query;
  const isPending = tab === "pending";

  // Pending keeps the existing triage inbox and its data path unchanged.
  const [counts, categories, profiles, pendingItems, result] = await Promise.all([
    getContentCounts(),
    listCategories(),
    isPending ? Promise.resolve([]) : listAdminProfiles(),
    isPending ? listContent("pending") : Promise.resolve(null),
    isPending ? Promise.resolve(null) : searchContent(toSearchParams(query)),
  ]);

  const params = queryToParams(query); // current URL state (no cursor)
  const searchMode = tab === "all" && !!query.q && !query.cat;
  const inCategory = !!query.cat && STRIP_TABS.has(tab);
  const showStrip = STRIP_TABS.has(tab) && !query.cat && !searchMode;
  const catCounts = counts.byStatusCat[(tab === "all" && query.st) || tab] ?? {};
  const catName = new Map(categories.map((c) => [c.slug, c.name_ar]));
  const accents = Object.fromEntries(categories.map((c) => [c.slug, c.accent]));
  // Strip: nav categories plus any other category that has rows in this tab.
  const stripCats = categories.filter((c) => c.show_in_nav || (catCounts[c.slug] ?? 0) > 0);
  const tabTotal = counts.byStatus[tab] ?? 0;
  const sort = resolveSort((tab === "all" && query.st) || tab, (query.sort as ContentSort) || null);

  // Scoped search (inside a category, or in المحذوفات) keeps the view and swaps q.
  const scopedSearch = inCategory
    ? `ابحث داخل ${catName.get(query.cat) ?? query.cat}…`
    : tab === "trash"
      ? "ابحث في المحذوفات…"
      : null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">المحتوى</h1>
        <Link href="/admin/content/new" className="rounded-lg bg-teal px-4 py-2.5 text-[13px] font-bold text-white">
          + إضافة
        </Link>
      </div>

      {/* Global search: every status + category. */}
      <div className="mb-3">
        <SearchBox
          mode="global"
          value={searchMode ? query.q : ""}
          baseParams={{}}
          placeholder="ابحث في كل المحتوى (العنوان والنص)…"
        />
      </div>

      {/* Tabs with live counts */}
      <div className="salma-scroll mb-3 flex gap-2 overflow-x-auto">
        {CONTENT_TABS.map((t) => {
          const active = tab === t.key;
          const n = counts.byStatus[t.key];
          return (
            <Link
              key={t.key}
              href={contentHref({ status: t.key === "published" ? "" : t.key })}
              className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${
                active ? "bg-teal text-white" : "border border-line bg-white text-gray"
              }`}
            >
              {t.label}
              {n != null ? <span className="ms-1 font-sans text-[11px] opacity-80">({n})</span> : null}
            </Link>
          );
        })}
      </div>

      {isPending ? (
        <ContentInbox items={pendingItems ?? []} categories={categories} />
      ) : (
        <>
          {searchMode ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-semibold">نتائج البحث عن «{query.q}»</span>
              <Link href={contentHref({ status: "all" })} className="text-[12.5px] font-semibold text-coral">
                مسح البحث
              </Link>
            </div>
          ) : null}

          {showStrip ? (
            <div className="salma-scroll mb-3 flex gap-2 overflow-x-auto">
              <span className="whitespace-nowrap rounded-full bg-teal px-3 py-1.5 text-[12.5px] font-semibold text-white">
                كل الأقسام ({tabTotal})
              </span>
              {stripCats.map((c) => (
                <Link
                  key={c.slug}
                  href={contentHref({ ...params, cat: c.slug, q: "" })}
                  className="whitespace-nowrap rounded-full border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray hover:bg-cream"
                >
                  {c.name_ar} ({catCounts[c.slug] ?? 0})
                </Link>
              ))}
            </div>
          ) : null}

          {inCategory ? (
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
              <Link
                href={contentHref({ ...params, cat: "", q: "" })}
                className="text-[13px] font-semibold text-teal"
              >
                ‹ كل الأقسام
              </Link>
              <span className="flex items-center gap-2 text-[15px] font-bold">
                <span className="size-2.5 rounded-full" style={{ background: accents[query.cat] }} />
                {catName.get(query.cat) ?? query.cat}
                <span className="font-sans text-[12.5px] font-semibold text-gray">
                  — {catCounts[query.cat] ?? 0} {CAT_COUNT_NOUN[tab] ?? "مادة"}
                </span>
              </span>
            </div>
          ) : null}

          {scopedSearch ? (
            <div className="mb-3 md:max-w-md">
              <SearchBox mode="scoped" value={query.q} baseParams={params} placeholder={scopedSearch} />
            </div>
          ) : null}

          <FilterBar
            params={params}
            showStatus={tab === "all"}
            categoryOptions={STRIP_TABS.has(tab) ? null : categories}
            sortOptions={sortOptions(tab)}
            sort={sort}
            profiles={profiles}
          />

          <ContentTable
            key={JSON.stringify(params)}
            initialRows={result?.rows ?? []}
            initialHasMore={result?.hasMore ?? false}
            error={result?.error ?? null}
            params={toSearchParams(query)}
            tab={tab}
            showCategory={!inCategory}
            showStatusChip={tab === "all"}
            accents={accents}
            emptyText={query.q ? "لا توجد نتائج مطابقة." : EMPTY_TEXT[tab] ?? "لا يوجد محتوى."}
          />
        </>
      )}
    </div>
  );
}

import Link from "next/link";
import type { Category } from "@/lib/queries";

const NAV_ORDER = ["kuwait", "gulf", "world", "health-economy", "lifestyle", "investigations"];

export function Header({ categories, active }: { categories: Category[]; active?: string }) {
  const bySlug = new Map(categories.map((c) => [c.slug, c]));
  const nav = NAV_ORDER.map((s) => bySlug.get(s)).filter(Boolean) as Category[];

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-2.5 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal text-xl font-bold text-white sm:h-10 sm:w-10">
            س
          </span>
          <span className="leading-none">
            <span className="block text-xl font-bold tracking-tight text-teal sm:text-2xl">سلمى</span>
            <span className="mt-0.5 block font-sans text-[10px] font-medium tracking-[1.5px] text-green">
              SALMA · HEALTH
            </span>
          </span>
        </Link>
        <div className="flex items-center gap-3 sm:gap-4">
          <Link
            href="/search"
            aria-label="بحث"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-gray/40 text-gray"
          >
            ⌕
          </Link>
          <Link
            href="#newsletter"
            className="rounded-lg bg-teal px-3 py-2 text-xs font-semibold text-white"
          >
            اشتراك
          </Link>
        </div>
      </div>
      <nav className="salma-scroll mx-auto flex max-w-6xl gap-5 overflow-x-auto whitespace-nowrap px-4 pb-2.5 text-[13.5px] font-semibold sm:px-6">
        <Link
          href="/"
          className={
            !active
              ? "border-b-[2.5px] border-teal pb-1.5 text-teal"
              : "pb-1.5 text-gray hover:text-teal"
          }
        >
          الرئيسية
        </Link>
        {nav.map((c) => {
          const on = active === c.slug;
          return (
            <Link
              key={c.slug}
              href={`/category/${c.slug}`}
              className={on ? "border-b-[2.5px] pb-1.5" : "pb-1.5 hover:opacity-80"}
              style={{ color: c.accent, borderColor: on ? c.accent : "transparent" }}
            >
              {c.name_ar}
            </Link>
          );
        })}
        <Link
          href="/doctors"
          className={
            active === "doctors"
              ? "border-b-[2.5px] border-teal pb-1.5 text-teal"
              : "pb-1.5 text-gray hover:text-teal"
          }
        >
          الأطباء
        </Link>
        <Link
          href="/transfers"
          className={
            active === "transfers"
              ? "border-b-[2.5px] border-teal pb-1.5 text-teal"
              : "pb-1.5 text-gray hover:text-teal"
          }
        >
          انتقال الأطباء
        </Link>
      </nav>
    </header>
  );
}

import Link from "next/link";
import type { Category } from "@/lib/queries";

export function Header({ categories, active }: { categories: Category[]; active?: string }) {
  // `categories` arrives ordered by sort_order; the nav shows only the ones
  // an admin has flagged `show_in_nav` (managed from /admin/categories).
  const nav = categories.filter((c) => c.show_in_nav);

  // Nav links are ~26px tall visually; the invisible ::before extends each
  // one to ~44px (apple-design §10). The rail's `-mt-2 pt-2` keeps that
  // upward reach inside its own padding box, since `overflow-x-auto` clips
  // there — the header's height and the underline position don't move.
  const navLink = "relative pb-1.5 before:absolute before:-inset-x-2 before:-top-2 before:-bottom-2.5";

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-2.5 sm:px-6">
        {/* py-1/-my-1: 44px tall tap area on mobile, row height unchanged */}
        <Link href="/" className="-my-1 flex items-center gap-2.5 py-1">
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
          {/* 32px visual circle, 44px hit area via ::before */}
          <Link
            href="/search"
            aria-label="بحث"
            className="relative flex h-8 w-8 items-center justify-center rounded-full border border-gray/40 text-gray before:absolute before:-inset-1.5"
          >
            ⌕
          </Link>
          {/* 32px tall pill, 44px hit area via ::before */}
          <Link
            href="#newsletter"
            className="relative rounded-lg bg-teal px-3 py-2 text-xs font-semibold text-white before:absolute before:inset-x-0 before:-inset-y-1.5"
          >
            اشتراك
          </Link>
        </div>
      </div>
      <nav className="salma-scroll mx-auto -mt-2 flex max-w-6xl gap-5 overflow-x-auto whitespace-nowrap px-4 pb-2.5 pt-2 text-[13.5px] font-semibold sm:px-6">
        <Link
          href="/"
          className={`${navLink} ${
            !active ? "border-b-[2.5px] border-teal text-teal" : "text-gray hover:text-teal"
          }`}
        >
          الرئيسية
        </Link>
        {nav.map((c) => {
          const on = active === c.slug;
          return (
            <Link
              key={c.slug}
              href={`/category/${c.slug}`}
              className={`${navLink} ${on ? "border-b-[2.5px]" : "hover:opacity-80"}`}
              style={{ color: c.accent, borderColor: on ? c.accent : "transparent" }}
            >
              {c.name_ar}
            </Link>
          );
        })}
        <Link
          href="/doctors"
          className={`${navLink} ${
            active === "doctors" ? "border-b-[2.5px] border-teal text-teal" : "text-gray hover:text-teal"
          }`}
        >
          الأطباء
        </Link>
        <Link
          href="/transfers"
          className={`${navLink} ${
            active === "transfers"
              ? "border-b-[2.5px] border-teal text-teal"
              : "text-gray hover:text-teal"
          }`}
        >
          انتقال الأطباء
        </Link>
      </nav>
    </header>
  );
}

import Link from "next/link";
import Form from "next/form";
import type { Category } from "@/lib/queries";

// Same copy as SearchBox — the masthead field replaces the old homepage hero box.
const SEARCH_PLACEHOLDER = "ابحث في سلمى عن خبر، دراسة، طبيب، أو موضوع صحي...";

// On the Amethyst masthead the default teal focus ring disappears; mirror the
// mockup's mauve ring. `!` is needed because the global :focus-visible rule is
// unlayered and would otherwise win over utilities.
const focusMauve = "focus-visible:outline-mauve!";

/**
 * Direction E masthead (design/mockups/direction-e.html §A):
 *   row 1 — wordmark · search · «اشتراك»   (≤767px: wordmark + اشتراك, search wraps full-width below)
 *   row 2 — pill nav rail, horizontally scrollable, hidden scrollbar (no hamburger)
 */
export function Header({ categories, active }: { categories: Category[]; active?: string }) {
  // `categories` arrives ordered by sort_order; the nav shows only the ones
  // an admin has flagged `show_in_nav` (managed from /admin/categories).
  const nav = categories.filter((c) => c.show_in_nav);

  const pill = (on: boolean) =>
    `flex min-h-11 shrink-0 items-center rounded-full px-3.5 text-[15px] transition-colors ${focusMauve} ${
      on ? "bg-mauve font-bold text-amethyst" : "font-medium text-white hover:bg-amethyst-800"
    }`;

  return (
    <header className="sticky top-0 z-40 bg-amethyst text-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-4 sm:px-6 md:flex-nowrap md:gap-6">
        <Link
          href="/"
          aria-label="سلمى — الصفحة الرئيسية"
          className={`block shrink-0 rounded ${focusMauve}`}
        >
          {/* Official wordmark (viewBox 443×125). width/height reserve space (no CLS). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/wordmark-white.svg"
            alt="سلمى"
            width={208}
            height={59}
            className="h-auto w-[170px] md:w-[208px]"
          />
        </Link>

        {/* Search: GET /search?q=… — same route as SearchBox; next/form adds
            client-side navigation and still works without JS. */}
        <Form
          action="/search"
          role="search"
          className="order-3 flex h-12 basis-full items-center gap-2 rounded-full border border-transparent bg-amethyst-800 pe-1 ps-4 transition-colors focus-within:border-mauve md:order-none md:mx-auto md:max-w-[480px] md:flex-1 md:basis-auto"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            aria-hidden="true"
            className="h-[18px] w-[18px] shrink-0 text-mauve"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4.2-4.2" />
          </svg>
          <label htmlFor="site-search" className="sr-only">
            بحث في سلمى
          </label>
          <input
            id="site-search"
            name="q"
            type="search"
            required
            dir="rtl"
            placeholder={SEARCH_PLACEHOLDER}
            className="min-w-0 flex-1 self-stretch bg-transparent text-sm text-white outline-none placeholder:text-amethyst-200 focus-visible:outline-none!"
          />
          <button
            type="submit"
            className={`h-11 shrink-0 rounded-full px-3.5 text-sm font-bold text-mauve hover:bg-amethyst ${focusMauve}`}
          >
            بحث
          </button>
        </Form>

        <Link
          href="#newsletter"
          className={`ms-auto inline-flex min-h-11 shrink-0 items-center rounded-full bg-mauve px-4 text-sm font-bold text-amethyst transition-colors hover:bg-[color-mix(in_srgb,var(--brand-mauve)_80%,white)] md:ms-0 md:px-5 ${focusMauve}`}
        >
          اشتراك
        </Link>
      </div>

      <nav aria-label="الأقسام" className="border-t border-amethyst-800">
        <div className="salma-scroll mx-auto flex max-w-6xl gap-1 overflow-x-auto whitespace-nowrap px-4 py-2 sm:px-6">
          <Link href="/" aria-current={!active ? "page" : undefined} className={pill(!active)}>
            الرئيسية
          </Link>
          {nav.map((c) => {
            const on = active === c.slug;
            return (
              <Link
                key={c.slug}
                href={`/category/${c.slug}`}
                aria-current={on ? "page" : undefined}
                className={pill(on)}
              >
                {c.name_ar}
              </Link>
            );
          })}
          {/* Launch Hardening V1: the doctors directory has no production data
              yet (0 rows), so its public entry point is hidden — the /doctors
              route and all admin capability remain intact. Restore this link
              when real doctor profiles exist. */}
          <Link
            href="/transfers"
            aria-current={active === "transfers" ? "page" : undefined}
            className={pill(active === "transfers")}
          >
            انتقال الأطباء
          </Link>
        </div>
      </nav>
    </header>
  );
}

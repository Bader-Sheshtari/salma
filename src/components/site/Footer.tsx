import Link from "next/link";
import type { Category } from "@/lib/queries";

// Mauve ring on the Amethyst footer (global teal ring is unlayered, hence `!`).
const link =
  "inline-flex min-h-11 items-center text-sm text-amethyst-100 hover:text-white hover:underline hover:underline-offset-4 focus-visible:outline-mauve!";

/**
 * Direction E footer (design/mockups/direction-e.html): wordmark · الأقسام ·
 * عن سلمى, then the sources/trust line and copyright. Links and routes are
 * unchanged from the previous footer — restyle only.
 */
export function Footer({ categories }: { categories: Category[] }) {
  return (
    <footer className="bg-amethyst px-4 pb-6 pt-8 text-white sm:px-6 md:pb-16">
      <div className="mx-auto max-w-6xl">
        <div className="grid grid-cols-1 gap-6 border-b border-amethyst-800 pb-6 min-[401px]:grid-cols-2 md:grid-cols-[1.2fr_1.2fr_1fr] md:gap-8">
          <div className="min-[401px]:col-span-2 md:col-span-1">
            <Link href="/" aria-label="سلمى — الصفحة الرئيسية" className="inline-flex min-h-11 items-center rounded focus-visible:outline-mauve!">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/wordmark-white.svg"
                alt="سلمى"
                width={150}
                height={42}
                className="h-auto w-[150px]"
              />
            </Link>
          </div>

          <div>
            <h3 className="mb-2 text-[13px] font-semibold tracking-[.04em] text-mauve md:text-xs">الأقسام</h3>
            <ul className="columns-2 gap-x-6">
              {categories.map((c) => (
                <li key={c.slug} className="break-inside-avoid">
                  <Link href={`/category/${c.slug}`} className={link}>
                    {c.name_ar}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="mb-2 text-[13px] font-semibold tracking-[.04em] text-mauve md:text-xs">عن سلمى</h3>
            <ul>
              <li>
                <Link href="/about" className={link}>
                  من نحن
                </Link>
              </li>
              <li>
                <Link href="/contact" className={link}>
                  اتصل بنا
                </Link>
              </li>
              <li>
                <Link href="/editorial-policy" className={link}>
                  المعايير التحريرية
                </Link>
              </li>
              <li>
                <Link href="/corrections" className={link}>
                  سياسة التصحيح
                </Link>
              </li>
              <li>
                <Link href="/privacy" className={link}>
                  سياسة الخصوصية
                </Link>
              </li>
              <li>
                <Link href="/terms" className={link}>
                  شروط الاستخدام
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 pt-4 text-[13px] text-amethyst-200">
          <p className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/symbol-tile-mauve.svg" alt="" aria-hidden="true" width={24} height={24} className="h-6 w-6" />
            مصادرنا: <b className="font-sans font-medium text-white">WHO · CDC · Mayo Clinic</b>
          </p>
          <p>© 2026 سلمى — جميع الحقوق محفوظة</p>
        </div>
      </div>
    </footer>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { getCategories } from "@/lib/queries";

// Served with HTTP 404 by Next; noindex keeps any linked variant out of
// search engines entirely.
export const metadata: Metadata = {
  title: "الصفحة غير موجودة · سلمى",
  robots: { index: false, follow: false },
};

export default async function NotFound() {
  // Best-effort: the 404 must render even if the categories query fails.
  let categories: Awaited<ReturnType<typeof getCategories>> = [];
  try {
    categories = await getCategories();
  } catch {
    categories = [];
  }

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} />
      <main className="mx-auto flex max-w-xl flex-col items-center px-4 py-20 text-center sm:px-6">
        <div className="font-mono text-5xl font-bold text-teal/30">404</div>
        <h1 className="mt-4 text-2xl font-bold">الصفحة غير موجودة</h1>
        <p className="mt-2 text-[14.5px] leading-relaxed text-gray">
          يبدو أن الرابط الذي فتحته غير صحيح أو أن الصفحة لم تعد متاحة.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="rounded-lg bg-teal px-5 py-2.5 text-sm font-bold text-white"
          >
            العودة إلى الرئيسية
          </Link>
          <Link
            href="/search"
            className="rounded-lg border border-line px-5 py-2.5 text-sm font-semibold text-ink hover:bg-cream"
          >
            البحث في سلمى
          </Link>
        </div>
      </main>
      <Footer categories={categories} />
    </div>
  );
}

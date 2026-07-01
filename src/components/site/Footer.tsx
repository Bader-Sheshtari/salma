import Link from "next/link";
import type { Category } from "@/lib/queries";

export function Footer({ categories }: { categories: Category[] }) {
  return (
    <footer className="bg-ink px-4 pb-10 pt-6 text-white sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal text-lg font-bold">
            س
          </span>
          <span className="text-lg font-bold">سلمى</span>
        </div>
        <div className="mb-5 flex flex-wrap gap-x-6 gap-y-3.5 text-[13px] text-white/75">
          {categories.map((c) => (
            <Link key={c.slug} href={`/category/${c.slug}`} className="hover:text-white">
              {c.name_ar}
            </Link>
          ))}
          <Link href="/about" className="hover:text-white">
            من نحن
          </Link>
          <Link href="/contact" className="hover:text-white">
            اتصل بنا
          </Link>
        </div>
        <div className="border-t border-white/15 pt-3.5 font-sans text-[11px] leading-relaxed text-white/50">
          المعايير التحريرية · مصادرنا: WHO · CDC · Mayo Clinic
          <br />© 2026 سلمى — جميع الحقوق محفوظة
        </div>
      </div>
    </footer>
  );
}

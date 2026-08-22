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
        {/* py/-my: taller tap boxes that exactly fill the 14px row gap, no layout shift */}
        <div className="mb-5 flex flex-wrap gap-x-6 gap-y-3.5 text-[13px] text-white/75">
          {categories.map((c) => (
            <Link
              key={c.slug}
              href={`/category/${c.slug}`}
              className="-my-[7px] py-[7px] hover:text-white"
            >
              {c.name_ar}
            </Link>
          ))}
          <Link href="/about" className="-my-[7px] py-[7px] hover:text-white">
            من نحن
          </Link>
          <Link href="/contact" className="-my-[7px] py-[7px] hover:text-white">
            اتصل بنا
          </Link>
        </div>
        <div className="border-t border-white/15 pt-3.5 font-sans text-[11px] leading-relaxed text-white/50">
          <Link href="/editorial-policy" className="-my-[7px] inline-block py-[7px] hover:text-white/75">
            المعايير التحريرية
          </Link>{" "}
          · مصادرنا: WHO · CDC · Mayo Clinic
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            <Link href="/corrections" className="-my-[7px] py-[7px] hover:text-white/75">
              سياسة التصحيح
            </Link>
            <Link href="/privacy" className="-my-[7px] py-[7px] hover:text-white/75">
              سياسة الخصوصية
            </Link>
            <Link href="/terms" className="-my-[7px] py-[7px] hover:text-white/75">
              شروط الاستخدام
            </Link>
          </div>
          <div className="mt-1.5">© 2026 سلمى — جميع الحقوق محفوظة</div>
        </div>
      </div>
    </footer>
  );
}

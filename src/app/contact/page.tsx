import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { getCategories } from "@/lib/queries";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "اتصل بنا · سلمى",
  description: "تواصل مع فريق سلمى — نستقبل ملاحظاتكم واقتراحاتكم وأخبار القطاع الصحي.",
};

const CONTACT_EMAIL = "info@salma.news";

export default async function ContactPage() {
  const categories = await getCategories();

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} />
      <main className="px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="h-7 w-1.5 rounded-sm bg-teal" />
          <h1 className="text-2xl font-bold sm:text-3xl">اتصل بنا</h1>
        </div>

        <div className="max-w-2xl space-y-5 text-[15px] leading-loose text-ink">
          <p>
            يسعدنا تواصلكم مع فريق <span className="font-bold">سلمى</span>. سواء كان لديكم ملاحظة أو
            اقتراح، أو خبرٌ صحيٌّ ترون أنه يستحقّ التغطية، أو استفسار عن مصادرنا — نحن هنا.
          </p>

          <div className="rounded-2xl border border-line bg-cream/40 p-5">
            <h2 className="mb-1 text-[15px] font-bold">البريد الإلكتروني</h2>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              dir="ltr"
              className="font-sans text-[15px] font-semibold text-teal hover:underline"
            >
              {CONTACT_EMAIL}
            </a>
            <p className="mt-3 text-[13px] leading-loose text-gray">
              نسعى للردّ على جميع الرسائل خلال أيام العمل. لا تُعدّ سلمى جهة استشارة طبية؛ للحالات
              الطارئة يُرجى مراجعة الطبيب أو أقرب مركز صحي.
            </p>
          </div>
        </div>
      </main>
      <Footer categories={categories} />
    </div>
  );
}

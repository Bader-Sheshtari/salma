import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { getCategories } from "@/lib/queries";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "من نحن · سلمى",
  description:
    "سلمى منصّة عربية موثوقة للأخبار الصحية في الكويت ودول الخليج، تبسّط المعلومة الطبية وتحافظ على مصادرها.",
};

export default async function AboutPage() {
  const categories = await getCategories();

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} />
      <main className="px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="h-7 w-1.5 rounded-sm bg-teal" />
          <h1 className="text-2xl font-bold sm:text-3xl">من نحن</h1>
        </div>

        <div className="max-w-2xl space-y-5 text-[15px] leading-loose text-ink">
          <p>
            <span className="font-bold">سلمى</span> منصّة عربية متخصّصة في الأخبار الصحية، تخاطب
            القارئ في الكويت ودول الخليج بلغةٍ واضحةٍ ومبسّطة. نؤمن أن المعلومة الطبية الصحيحة حقٌّ
            للجميع، وأن الوصول إليها يجب أن يكون سهلاً وموثوقاً.
          </p>
          <p>
            نجمع أحدث المستجدّات الصحية من مصادر عالمية معتمدة — مثل منظمة الصحة العالمية، ومراكز
            مكافحة الأمراض، والدوريات الطبية المحكّمة — ثم نترجمها ونبسّطها للقارئ العربي مع الحفاظ
            على رابط المصدر الأصلي لكل خبر.
          </p>
          <p>
            كل ما يُنشر على سلمى يمرّ عبر مراجعة تحريرية بشرية قبل ظهوره، لضمان الدقّة والمصداقية
            ومناسبة المحتوى لقيم المجتمع الخليجي.
          </p>

          <div className="rounded-2xl border border-line bg-cream/40 p-5">
            <h2 className="mb-2 text-[15px] font-bold">رسالتنا</h2>
            <p className="text-[14px] leading-loose text-gray">
              أن نكون المرجع العربي الأول للأخبار الصحية الموثوقة في الكويت والخليج — نبسّط، ونوثّق،
              ولا نُلفّق.
            </p>
          </div>
        </div>
      </main>
      <Footer categories={categories} />
    </div>
  );
}

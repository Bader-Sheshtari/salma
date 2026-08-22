import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { getCategories } from "@/lib/queries";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "سياسة التصحيح · سلمى",
  description:
    "كيف تُبلّغ سلمى عن خطأ في مادة منشورة، وكيف يتحقّق المحرّرون منه، ومتى تُصحَّح المادة أو تُحدَّث أو تُسحَب.",
  alternates: { canonical: "/corrections" },
};

const CONTACT_EMAIL = "info@salma.news";

export default async function CorrectionsPage() {
  const categories = await getCategories();

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} />
      <main className="px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="h-7 w-1.5 rounded-sm bg-teal" />
          <h1 className="text-2xl font-bold sm:text-3xl">سياسة التصحيح</h1>
        </div>

        <div className="max-w-2xl space-y-6 text-[15px] leading-loose text-ink">
          <p>
            الدقّة أهم ما نملكه. حين نُخطئ نصحّح، وحين تتغيّر المعلومة نُحدّث. هذه الصفحة تشرح كيف
            يحدث ذلك عملياً على <span className="font-bold">سلمى</span>.
          </p>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">كيف تُبلّغ عن خطأ</h2>
            <p className="text-[14.5px]">
              إن لاحظت معلومة تبدو خاطئة أو مصدراً غير دقيق، راسلنا عبر{" "}
              <Link href="/contact" className="font-semibold text-teal hover:underline">
                صفحة الاتصال
              </Link>{" "}
              أو مباشرةً على البريد أدناه. يساعدنا أن تُرفق رابط المادة، والجملة أو الرقم محلّ
              الملاحظة، وما تراه الصواب مع مصدره إن توفّر.
            </p>
            <div className="rounded-2xl border border-line bg-cream/40 p-5">
              <h3 className="mb-1 text-[15px] font-bold">للتبليغ عن خطأ</h3>
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                dir="ltr"
                className="-my-[11px] inline-block py-[11px] font-sans text-[15px] font-semibold text-teal hover:underline"
              >
                {CONTACT_EMAIL}
              </a>
              {/* OWNER / LEGAL REVIEW: confirm info@salma.news + domain */}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">ماذا يحدث بعد التبليغ</h2>
            <p className="text-[14.5px]">
              يراجع محرّر البلاغ ويعود إلى المصدر الأصلي للمادة — الدراسة أو بيان الجهة الصحية أو
              الخبر المنقول عنه — ويقارن ما نُشر بما يقوله المصدر فعلاً. النتيجة إحدى الحالات
              التالية:
            </p>
            <ul className="list-disc space-y-2 ps-5 text-[14.5px]">
              <li>
                <span className="font-semibold">خطأ وقائعي</span> — يُصحَّح في نصّ المادة مباشرة
                (رقم، اسم، تاريخ، نسبة مئوية، أو نسبة قولٍ إلى غير قائله).
              </li>
              <li>
                <span className="font-semibold">تحديث جوهري</span> — إن تغيّرت المعلومة أو صدر جديد
                يغيّر معنى المادة، نُعدّلها ونحرص على أن يظهر تاريخ «آخر تحديث» عليها.
              </li>
              <li>
                <span className="font-semibold">تعديل شكلي</span> — أخطاء إملائية أو صياغة لا تمسّ
                المعنى، تُعالَج دون إجراء إضافي.
              </li>
              <li>
                <span className="font-semibold">لا خطأ</span> — إن تبيّن أن المنشور مطابق للمصدر،
                نُوضّح ذلك في الردّ على المُبلِّغ.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">سحب المادة</h2>
            <p className="text-[14.5px]">
              إذا تبيّن أن مادة لم تعد تستوفي معاييرنا — كأن يُسحب البحث الذي بُنيت عليه، أو يتّضح أن
              أساسها غير صحيح ولا يكفي تصحيحه جزئياً — فقد نسحبها من النشر بدل تركها مضلِّلة. السحب
              قرار نادر ولا نلجأ إليه هرباً من التصحيح.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">علامات الشفافية على المادة</h2>
            <p className="text-[14.5px]">
              كل مادة تعرض مصدرها وتاريخ نشرها، وقد يظهر تاريخ «آخر تحديث» عند إجراء تعديل جوهري. هذا
              أوضح للقارئ من سجلٍّ منفصل قد لا يفتحه أحد. لا يوجد لدينا سجلّ تصحيحات عام ولا مكتب
              مظالم مستقلّ في الوقت الحالي، ونفضّل قول ذلك بدل الادّعاء بخلافه.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">التعليقات والتقييمات</h2>
            <p className="text-[14.5px]">
              هذه السياسة تخصّ ما ينشره فريق التحرير. لطلب حذف تعليقك أو تقييمك أو تصحيح الاسم الظاهر
              فيه، راجع{" "}
              <Link href="/privacy" className="font-semibold text-teal hover:underline">
                سياسة الخصوصية
              </Link>
              .
            </p>
          </section>

          <p className="text-[14.5px]">
            المبادئ التي تحكم اختيار المحتوى وتقييم الأدلّة موضّحة في{" "}
            <Link href="/editorial-policy" className="font-semibold text-teal hover:underline">
              السياسة التحريرية
            </Link>
            .
          </p>

          <p className="border-t border-line pt-4 font-sans text-[13px] text-gray">
            آخر تحديث: 22 أغسطس 2026
          </p>
        </div>
      </main>
      <Footer categories={categories} />
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { getCategories } from "@/lib/queries";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "السياسة التحريرية · سلمى",
  description:
    "كيف تختار سلمى أخبارها، وكيف تميّز بين الادّعاء والدليل، وكيف تستخدم الذكاء الاصطناعي تحت إشراف تحريري بشري.",
  alternates: { canonical: "/editorial-policy" },
};

export default async function EditorialPolicyPage() {
  const categories = await getCategories();

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} />
      <main className="px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="h-7 w-1.5 rounded-sm bg-teal" />
          <h1 className="text-2xl font-bold sm:text-3xl">السياسة التحريرية</h1>
        </div>

        <div className="max-w-2xl space-y-6 text-[15px] leading-loose text-ink">
          <p>
            <span className="font-bold">سلمى</span> منصّة تحريرية للأخبار والمعلومات الصحية. مهمّتنا
            أن نوصل للقارئ العربي ما تقوله الأدلّة فعلاً، بلغةٍ واضحة، ومع ذكر المصدر دائماً. هذه
            الصفحة تشرح المبادئ التي نعمل بها.
          </p>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">كيف نختار ما ننشره</h2>
            <p className="text-[14.5px]">
              معيارنا الأول هو مصداقية المصدر وجودة الدليل، لا سرعة الانتشار. نُعطي الأولوية للجهات
              الصحية الرسمية والدوريات المحكّمة والمؤسسات البحثية المعروفة، ونسأل قبل النشر: من قال
              هذا؟ وعلى أي دراسة يستند؟ وما حجم عيّنتها ومنهجها؟ وهل يخدم القارئ في الكويت والخليج
              فعلاً؟ الخبر الضعيف السند لا يُنشر حتى لو كان رائجاً.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">الادّعاء ليس دليلاً</h2>
            <p className="text-[14.5px]">
              نفرّق بوضوح بين مستويات المعرفة ولا نعرضها وكأنها متساوية:
            </p>
            <ul className="list-disc space-y-2 ps-5 text-[14.5px]">
              <li>
                <span className="font-semibold">تصريحات الشركات والجهات المستفيدة</span> — تُنسب
                لأصحابها ولا تُقدَّم كحقيقة علمية.
              </li>
              <li>
                <span className="font-semibold">النتائج الأوّلية</span> — دراسات صغيرة أو مخبرية أو
                على الحيوانات أو غير محكّمة، نصفها كما هي: مبكّرة وتحتاج تأكيداً.
              </li>
              <li>
                <span className="font-semibold">الارتباط الإحصائي</span> — الارتباط لا يعني السببية،
                ونقولها صراحة حين يقتضي الأمر.
              </li>
              <li>
                <span className="font-semibold">الدليل السريري الراسخ</span> — ما تدعمه تجارب واسعة
                وإرشادات معتمدة، وهو وحده ما نتحدّث عنه بلغة الثقة.
              </li>
            </ul>
            <p className="text-[14.5px]">
              ونتجنّب العناوين المضخَّمة: لا «علاج نهائي» ولا «اكتشاف يقلب الموازين» ما لم يكن ذلك ما
              يقوله الدليل حرفياً.
            </p>
          </section>

          <section id="ai" className="scroll-mt-24 space-y-3">
            <h2 className="text-[17px] font-bold">كيف تستخدم سلمى الذكاء الاصطناعي</h2>
            <p className="text-[14.5px]">
              نستخدم الذكاء الاصطناعي أداةً مساعدة في العمل التحريري، ونفضّل أن يعرف القارئ ذلك
              بوضوح بدل أن يخمّنه. يساعدنا في:
            </p>
            <ul className="list-disc space-y-2 ps-5 text-[14.5px]">
              <li>رصد المستجدّات الصحية ومتابعة المصادر ومقارنة ما تنشره.</li>
              <li>تحليل المصادر وتقدير جودة الدليل ونوع الدراسة تمهيداً لمراجعة المحرّر.</li>
              <li>الترجمة من الإنجليزية والتلخيص وصياغة المسوّدات بالعربية.</li>
              <li>تنظيم سير العمل التحريري وترتيب أولويات المراجعة.</li>
            </ul>
            <div className="rounded-2xl border border-teal/30 bg-teal/[.06] p-5 text-[14.5px] leading-loose">
              <p className="font-bold">القاعدة التي لا نتنازل عنها</p>
              <p className="mt-2">
                الذكاء الاصطناعي لا ينشر بشكل مستقل. قرار النشر يتخذه فريق التحرير البشري، والمراجعة
                البشرية جزء أساسي من عملية النشر. المحرّر البشري هو من يتحقّق من المصادر، ويقرّر ما
                يُنشر وما يُرفض، ويتحمّل مسؤولية النصّ النهائي.
              </p>
            </div>
            <p className="text-[14.5px] text-gray">
              نلتزم بالشفافية في المبدأ لا في التفاصيل التشغيلية: لا ننشر تعليماتنا الداخلية ولا
              معايير الترجيح ولا تفاصيل أدواتنا التقنية، لأن ذلك يفتح الباب للتلاعب بالتغطية أكثر
              مما يفيد القارئ.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">المعلومة الطبية ومسؤوليتها</h2>
            <p className="text-[14.5px]">
              ما ننشره معلومات صحية عامة للتوعية، وليس تشخيصاً ولا استشارة طبية فردية ولا وصفة دواء.
              نتجنّب تقديم جرعات أو بروتوكولات علاجية للقارئ، ونذكّر بمراجعة الطبيب عند أي قرار صحي.
              وعند تغطية موضوعات حسّاسة — كالأمراض المزمنة والصحة النفسية وصحة الأطفال والحمل — نتحرّى
              لغةً دقيقة غير مثيرة للقلق، ونتجنّب ما قد يدفع القارئ إلى إيقاف علاجه أو تأجيل مراجعة
              المختصّ. التفاصيل الكاملة في{" "}
              <Link href="/terms" className="font-semibold text-teal hover:underline">
                شروط الاستخدام
              </Link>
              .
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">المصادر والنسبة</h2>
            <p className="text-[14.5px]">
              نذكر مصدر كل مادة وتاريخ نشرها متى توفّر ذلك. نُحيل إلى المرجع الأصلي كلّما أمكن — الدراسة
              أو بيان الجهة الصحية — لا إلى خبرٍ ناقلٍ عنه. وإن كان الخبر منقولاً عن وسيلة أخرى،
              نقول ذلك.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">الاستقلالية</h2>
            <p className="text-[14.5px]">
              قرار النشر تحريري بحت. لا توجد شبكات إعلانية على الموقع، ولا يشتري أحد تغطيةً فيه. أي
              محتوى مموّل أو شراكة — إن وُجدت مستقبلاً — ستكون موسومة بوضوح للقارئ.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">الأخطاء والتحديثات</h2>
            <p className="text-[14.5px]">
              نُخطئ أحياناً، والمعيار هو كيف نتعامل مع الخطأ. نصحّح الأخطاء الوقائعية في المادة
              نفسها، وعند إجراء تحديث جوهري نحرص على أن يظهر تاريخ «آخر تحديث» على المادة. التفاصيل
              في{" "}
              <Link href="/corrections" className="font-semibold text-teal hover:underline">
                سياسة التصحيح
              </Link>
              ، ويمكنك التبليغ عن خطأ عبر{" "}
              <Link href="/contact" className="font-semibold text-teal hover:underline">
                صفحة الاتصال
              </Link>
              .
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">تعليقات القرّاء</h2>
            <p className="text-[14.5px]">
              نرحّب بالنقاش، وكل تعليق يمرّ بمراجعة تحريرية قبل ظهوره. نحذف الادّعاءات الطبية
              المضلّلة والإساءة، لأن تعليقاً خاطئاً تحت مقال صحي قد يضرّ قارئاً آخر.
            </p>
          </section>

          <p className="border-t border-line pt-4 font-sans text-[13px] text-gray">
            آخر تحديث: 22 أغسطس 2026
          </p>
        </div>
      </main>
      <Footer categories={categories} />
    </div>
  );
}

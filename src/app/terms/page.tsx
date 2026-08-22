import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { getCategories } from "@/lib/queries";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "شروط الاستخدام · سلمى",
  description:
    "شروط استخدام منصّة سلمى: طبيعة الخدمة، وإخلاء المسؤولية الطبية، وقواعد التعليقات، وحقوق الملكية الفكرية.",
  alternates: { canonical: "/terms" },
};

export default async function TermsPage() {
  const categories = await getCategories();

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} />
      <main className="px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="h-7 w-1.5 rounded-sm bg-teal" />
          <h1 className="text-2xl font-bold sm:text-3xl">شروط الاستخدام</h1>
        </div>

        <div className="max-w-2xl space-y-6 text-[15px] leading-loose text-ink">
          <p>
            باستخدامك موقع <span className="font-bold">سلمى</span> فإنك توافق على الشروط الموضّحة في
            هذه الصفحة. كُتبت بلغة واضحة قدر الإمكان، ونرجو قراءتها قبل الاعتماد على أي محتوى في
            الموقع.
          </p>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">طبيعة الخدمة</h2>
            <p className="text-[14.5px]">
              سلمى منصّة أخبار ومعلومات صحية موجَّهة للقارئ العربي في الكويت ودول الخليج. نُغطّي
              المستجدّات الصحية ونشرحها ونوثّق مصادرها. الموقع مصدر معلومات عام، وليس جهة رعاية صحية
              ولا عيادة ولا صيدلية ولا جهة استشارات طبية.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">المحتوى لا يُعد استشارة طبية</h2>
            <div className="rounded-2xl border border-teal/30 bg-teal/[.06] p-5 text-[14.5px] leading-loose">
              <p>
                كل ما يُنشر على سلمى — من أخبار ومقالات وفيديوهات وملخّصات دراسات — هو معلومات عامة
                لأغراض التوعية. وتحديداً:
              </p>
              <ul className="mt-3 list-disc space-y-2 ps-5">
                <li>لا يُستخدم لتشخيص أي مرض أو حالة صحية.</li>
                <li>لا يُعد استشارة طبية فردية مبنية على حالتك أنت.</li>
                <li>لا يُعد وصفة دواء ولا توصية بجرعة أو ببدء علاج أو إيقافه.</li>
                <li>لا يُغني عن مراجعة طبيب مؤهّل أو مختصّ رعاية صحية.</li>
                <li>لا يصلح للتعامل مع الحالات الطارئة.</li>
              </ul>
              <p className="mt-3">
                استشر طبيبك قبل اتخاذ أي قرار صحي، ولا تؤخّر طلب المشورة الطبية بسبب شيء قرأته هنا.
                في حالات الطوارئ اتصل فوراً بخدمات الإسعاف أو توجّه إلى أقرب قسم طوارئ.
              </p>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">دقّة المحتوى وتحديثه</h2>
            <p className="text-[14.5px]">
              نجتهد في التحقّق من كل ما ننشره ونذكر مصدر كل خبر وتاريخ نشره، وعند إجراء تعديل جوهري
              نحرص على أن يظهر تاريخ «آخر تحديث» على المقال. مع ذلك، المعرفة الطبية تتغيّر، وقد يصبح
              خبرٌ صحيحٌ
              اليوم متجاوَزاً لاحقاً. راجع{" "}
              <Link href="/editorial-policy" className="font-semibold text-teal hover:underline">
                السياسة التحريرية
              </Link>{" "}
              و
              <Link href="/corrections" className="font-semibold text-teal hover:underline">
                سياسة التصحيح
              </Link>
              .
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">التعليقات والمشاركات</h2>
            <p className="text-[14.5px]">
              يمكن للقارئ إرسال تعليق أو تقييم باسمٍ ظاهر يختاره، دون حساب ودون بريد إلكتروني. كل
              مشاركة تُحفظ «قيد المراجعة» ولا تظهر قبل موافقة محرّر. بإرسالك مشاركة تقرّ بأنها من
              كتابتك وتمنحنا الحق في عرضها على الموقع، ويُمنع فيها:
            </p>
            <ul className="list-disc space-y-2 ps-5 text-[14.5px]">
              <li>الإساءة أو التجريح أو خطاب الكراهية أو التشهير بأشخاص أو جهات.</li>
              <li>الادّعاءات الطبية غير الصحيحة أو المضلّلة، أو الترويج لعلاجات غير مثبتة.</li>
              <li>الإعلانات والرسائل التجارية المكرّرة.</li>
              <li>نشر بيانات شخصية تخصّك أو تخصّ غيرك.</li>
              <li>ما يخالف حقوق ملكية الآخرين.</li>
            </ul>
            <p className="text-[14.5px]">
              لفريق التحرير أن يرفض أي مشاركة أو يحذفها أو يختصرها دون إبداء أسباب تفصيلية. المشاركات
              تعبّر عن أصحابها ولا تمثّل رأي سلمى.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">الملكية الفكرية</h2>
            <p className="text-[14.5px]">
              النصوص والتصاميم والعناصر التي تنتجها سلمى مملوكة لها. يجوز الاقتباس المحدود مع ذكر
              «سلمى» ووضع رابط للمادة الأصلية، ولا يجوز إعادة النشر الكامل أو الاستخدام التجاري دون
              إذن مسبق. أما المواد المنسوبة إلى مصادر خارجية — دراسات ومنظمات صحية ووسائل إعلام —
              فحقوقها لأصحابها، ونذكرها للإحالة والتوثيق لا للاستحواذ عليها.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">حدود المسؤولية</h2>
            <p className="text-[14.5px]">
              يُقدَّم المحتوى «كما هو» دون ضمانٍ بخلوّه التام من الأخطاء أو باستمرار توفّر الموقع دون
              انقطاع. لا تتحمّل سلمى مسؤولية أي قرار صحي أو مالي أو غيره يُتّخذ اعتماداً على المحتوى،
              ولا مسؤولية عن محتوى المواقع الخارجية التي نُحيل إليها. هذا الحدّ لا يشمل ما لا يجوز
              استبعاده قانوناً.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">تعديل الشروط</h2>
            <p className="text-[14.5px]">
              قد نُعدّل هذه الشروط عند تطوّر الخدمة، ويظهر تاريخ آخر تحديث أسفل الصفحة. استمرارك في
              استخدام الموقع بعد التعديل يعني قبولك بالنسخة المحدّثة. راجع أيضاً{" "}
              <Link href="/privacy" className="font-semibold text-teal hover:underline">
                سياسة الخصوصية
              </Link>
              .
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">الجهة المشغِّلة والقانون الواجب التطبيق</h2>
            <div className="space-y-2 rounded-2xl border border-teal/30 bg-teal/[.06] p-4 text-[14px] leading-loose">
              <p>الجهة القانونية المشغِّلة: [OWNER / LEGAL REVIEW — يُحدَّد اسم الكيان القانوني]</p>
              <p>القانون الواجب التطبيق: [OWNER / LEGAL REVIEW — يُحدَّد الاختصاص القضائي]</p>
            </div>
          </section>

          <p className="text-[14.5px]">
            للاستفسار عن هذه الشروط، تواصل معنا عبر{" "}
            <Link href="/contact" className="font-semibold text-teal hover:underline">
              صفحة الاتصال
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

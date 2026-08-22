import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { getCategories } from "@/lib/queries";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "سياسة الخصوصية · سلمى",
  description:
    "ما الذي تجمعه سلمى من بيانات، ولماذا، وأين يُخزَّن، وكيف يمكن للقارئ طلب حذف اسمه أو بريده.",
  alternates: { canonical: "/privacy" },
};

const CONTACT_EMAIL = "info@salma.news";

export default async function PrivacyPage() {
  const categories = await getCategories();

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} />
      <main className="px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="h-7 w-1.5 rounded-sm bg-teal" />
          <h1 className="text-2xl font-bold sm:text-3xl">سياسة الخصوصية</h1>
        </div>

        <div className="max-w-2xl space-y-6 text-[15px] leading-loose text-ink">
          <p>
            تشرح هذه الصفحة بلغةٍ مباشرة ما الذي تجمعه <span className="font-bold">سلمى</span> من
            بيانات، ولماذا نجمعه، وأين يُحفظ، وكيف يمكنك طلب حذفه. قراءة الموقع لا تتطلّب حساباً ولا
            تسجيلاً؛ لا توجد حسابات للقرّاء ولا تسجيل دخول عام.
          </p>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">ما الذي نجمعه</h2>
            <ul className="list-disc space-y-2 ps-5 text-[14.5px]">
              <li>
                <span className="font-semibold">التعليقات والتقييمات:</span> الاسم الظاهر الذي تكتبه
                بنفسك ونصّ التعليق (أو التقييم وعدد النجوم). لا نطلب بريداً إلكترونياً ولا رقم هاتف
                ولا أي مُعرِّف شخصي آخر لإرسال تعليق.
              </li>
              <li>
                <span className="font-semibold">البريد الإلكتروني للنشرة:</span> إن أدخلت بريدك في
                نموذج النشرة البريدية، نحفظه في قاعدة بيانات الموقع.
              </li>
              <li>
                <span className="font-semibold">سجلّات الخوادم المعتادة:</span> يحتفظ مزوّدو
                الاستضافة بسجلّات تقنية تلقائية (مثل عنوان IP ونوع المتصفح ووقت الطلب) لتشغيل الموقع
                وحمايته من إساءة الاستخدام. هذه السجلّات لدى المزوّدين ولا نستخدمها لبناء ملفات
                تعريف عن القرّاء.
              </li>
              <li>
                <span className="font-semibold">حسابات الفريق:</span> بيانات دخول داخلية تخصّ فريق
                التحرير فقط، ولا علاقة لها بالقرّاء.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">لماذا نجمعها</h2>
            <p className="text-[14.5px]">
              الاسم ونصّ التعليق يُستخدمان لعرض التعليق بعد مراجعته تحريرياً. جميع التعليقات
              والتقييمات تُحفظ بحالة «قيد المراجعة» ولا تظهر للعموم قبل موافقة محرّر. البريد
              الإلكتروني يُستخدم لغرضٍ واحد فقط: مراسلتك بمحتوى النشرة عند إطلاقها.
            </p>
            <p className="rounded-2xl border border-line bg-cream/40 p-4 text-[14px] leading-loose text-gray">
              النشرة البريدية لم تُطلق بعد. البريد الذي تُدخله اليوم يُحفظ ليُستخدم عند إطلاقها، ولا
              نرسل عبره رسائل ترويجية لجهات أخرى.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">أين تُخزَّن البيانات</h2>
            <p className="text-[14.5px]">
              يعمل الموقع على خدمة الاستضافة Vercel، وتُحفظ البيانات في قاعدة بيانات لدى Supabase في
              منطقة الاتحاد الأوروبي (eu-central-1). قد يعني ذلك أن بياناتك تُعالَج خارج بلد إقامتك.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">ما لا نفعله</h2>
            <ul className="list-disc space-y-2 ps-5 text-[14.5px]">
              <li>لا نبيع بياناتك ولا نؤجّرها ولا نتاجر بها.</li>
              <li>لا توجد شبكات إعلانية على الموقع ولا تتبّع إعلاني.</li>
              <li>لا نستخدم أدوات تحليلات خارجية لتتبّع القرّاء.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">ملفات تعريف الارتباط (Cookies)</h2>
            <p className="text-[14.5px]">
              تصفّح الموقع كقارئ لا يتطلّب ملفات تعريف ارتباط لأغراض التتبّع أو الإعلان. ملفات
              الارتباط الوحيدة المستخدمة هي ملفات الجلسة الخاصة بتسجيل دخول فريق التحرير إلى لوحة
              الإدارة الداخلية، ولا تُنشأ للزوّار العاديين.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">مدة الاحتفاظ</h2>
            <p className="text-[14.5px]">
              التعليقات والتقييمات المنشورة تبقى ما دام المحتوى المرتبط بها منشوراً. ما يُرفض في
              المراجعة لا يُنشر، ويُزال يدوياً أو عند الطلب عبر قناة التواصل. عناوين البريد
              الإلكتروني للنشرة تبقى محفوظة حتى تطلب إزالتها. سجلّات الخوادم تخضع لسياسات الاحتفاظ
              لدى مزوّدي الاستضافة.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">حقوقك</h2>
            <p className="text-[14.5px]">
              يمكنك في أي وقت مراسلتنا لطلب حذف تعليقك أو تقييمك، أو تصحيح الاسم الظاهر فيه، أو حذف
              بريدك الإلكتروني من قائمة النشرة. اذكر في رسالتك ما يكفي للتعرّف على المُدخَل (الاسم
              الظاهر ورابط المقال، أو البريد نفسه).
            </p>
            <div className="rounded-2xl border border-line bg-cream/40 p-5">
              <h3 className="mb-1 text-[15px] font-bold">قناة التواصل</h3>
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
            <h2 className="text-[17px] font-bold">الأطفال</h2>
            <p className="text-[14.5px]">
              محتوى سلمى أخبارٌ صحية موجَّهة للجمهور العام، ولا يستهدف الأطفال. لا توجد حسابات
              للقرّاء، ولا نطلب من أحد بياناتٍ تكشف عمره. إن وصل إلينا اسم أو بريد يخصّ طفلاً، نزيله
              عند إبلاغنا.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">الجهة المشغِّلة</h2>
            <p className="rounded-2xl border border-teal/30 bg-teal/[.06] p-4 text-[14px] leading-loose">
              الجهة القانونية المشغِّلة: [OWNER / LEGAL REVIEW — يُحدَّد اسم الكيان القانوني]
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-bold">تعديلات هذه السياسة</h2>
            <p className="text-[14.5px]">
              قد نُحدِّث هذه السياسة عند تغيّر طريقة عمل الموقع. يظهر تاريخ آخر تحديث في أسفل
              الصفحة، والتعديلات الجوهرية نوضّحها في نصّ السياسة نفسه. راجع أيضاً{" "}
              <Link href="/terms" className="font-semibold text-teal hover:underline">
                شروط الاستخدام
              </Link>{" "}
              و
              <Link href="/editorial-policy" className="font-semibold text-teal hover:underline">
                السياسة التحريرية
              </Link>
              .
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

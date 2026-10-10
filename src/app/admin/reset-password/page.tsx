import type { Metadata } from "next";
import Link from "next/link";
import { LINK_FAIL_MESSAGE, consumeLink, maskEmail, resetBlocker } from "@/lib/admin-links";
import { AuthCard, AuthNotice } from "../AuthCard";
import { ResetPasswordForm } from "./ResetPasswordForm";

// The token lives in the URL: never cache, never index, never leak it via Referer.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "تعيين كلمة المرور · سلمى",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ResetPasswordPage({ searchParams }: Props) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";

  // Non-destructive peek (consume_admin_link never burns the link).
  const link = await consumeLink(token, "reset");
  const blocked = link.ok ? await resetBlocker(link) : LINK_FAIL_MESSAGE[link.reason];

  return (
    <AuthCard>
      <h1 className="mb-1 text-[18px] font-bold text-ink">تعيين كلمة مرور جديدة</h1>
      {!link.ok || blocked ? (
        <>
          <p className="mb-4 text-[13px] text-gray">لا يمكن استخدام هذا الرابط.</p>
          <AuthNotice
            title={!link.ok && link.reason === "expired" ? "انتهت صلاحية الرابط" : "الرابط غير صالح"}
            body={blocked ?? LINK_FAIL_MESSAGE.not_found}
          />
          <Link
            href="/admin/login"
            className="mt-4 inline-block text-[13px] font-semibold text-teal hover:underline"
          >
            الذهاب إلى صفحة الدخول
          </Link>
        </>
      ) : (
        <>
          <p className="mb-4 text-[13px] leading-6 text-gray">
            اختر كلمة مرور جديدة للحساب{" "}
            <span dir="ltr" className="font-sans font-semibold text-ink">
              {maskEmail(link.email)}
            </span>
            . ستُنهى جلساتك المفتوحة على كل الأجهزة.
          </p>
          <ResetPasswordForm token={token} />
        </>
      )}
    </AuthCard>
  );
}

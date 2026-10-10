import type { Metadata } from "next";
import Link from "next/link";
import { ROLE_LABEL } from "@/lib/roles";
import { LINK_FAIL_MESSAGE, consumeLink, inviteBlocker } from "@/lib/admin-links";
import { AuthCard, AuthNotice } from "../AuthCard";
import { AcceptInviteForm } from "./AcceptInviteForm";

// The token lives in the URL: never cache, never index, never leak it via Referer.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "قبول الدعوة · سلمى",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AcceptInvitePage({ searchParams }: Props) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";

  // Non-destructive peek (consume_admin_link never burns the link).
  const link = await consumeLink(token, "invite");
  const blocked = link.ok ? await inviteBlocker(link) : LINK_FAIL_MESSAGE[link.reason];

  return (
    <AuthCard wide>
      <h1 className="mb-1 text-[18px] font-bold text-ink">
        {!link.ok || blocked ? "قبول الدعوة" : "إنشاء حسابك في سلمى"}
      </h1>
      {!link.ok || blocked ? (
        <>
          <p className="mb-4 text-[13px] text-gray">لا يمكن استخدام هذا الرابط.</p>
          <AuthNotice
            title={!link.ok && link.reason === "expired" ? "انتهت صلاحية الدعوة" : "تعذّر قبول الدعوة"}
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
            أكمل بياناتك واختر كلمة مرور لتفعيل حسابك في لوحة إدارة سلمى.
          </p>
          <dl className="mb-5 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 rounded-xl border border-line bg-cream/50 p-3.5 text-[13px]">
            <dt className="font-semibold text-gray">البريد الإلكتروني</dt>
            <dd dir="ltr" className="min-w-0 break-all text-right font-sans text-ink">
              {link.email}
            </dd>
            <dt className="font-semibold text-gray">الدور</dt>
            <dd>
              <span className="rounded bg-white px-2 py-0.5 font-sans text-[11.5px] font-semibold text-teal">
                {ROLE_LABEL[link.role ?? ""] ?? link.role}
              </span>
            </dd>
          </dl>
          <AcceptInviteForm token={token} email={link.email} />
        </>
      )}
    </AuthCard>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaffForMfaSetup, staffHome } from "@/lib/auth";
import { AuthCard } from "../AuthCard";
import { MFA_INTRO, MfaEnroll } from "../MfaEnroll";
import { logout } from "../auth-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "إعداد المصادقة الثنائية · سلمى" };

/**
 * Standalone, VOLUNTARY TOTP enrollment (login-style shell) — MFA is optional
 * for every role. Uses requireStaffForMfaSetup (skips R1); an enrolled aal1
 * session is sent to the code step first, so factors cannot be added unverified.
 */
export default async function MfaSetupPage() {
  const { profile, mfa } = await requireStaffForMfaSetup();
  const enrolled = mfa.verifiedFactorIds.length > 0;
  const home = staffHome(profile.role);

  // Already enrolled but this session hasn't passed the code step: verify the
  // existing factor first (an aal1 session must not add factors).
  if (enrolled && !mfa.degraded && mfa.aal !== "aal2") {
    redirect(`/admin/login?step=mfa&dest=${encodeURIComponent("/admin/mfa-setup")}`);
  }

  return (
    <AuthCard wide>
      <h1 className="text-[17px] font-bold text-ink">إعداد المصادقة الثنائية</h1>
      <p className="mt-1.5 text-[13px] leading-6 text-gray">{MFA_INTRO}</p>

      <div className="mt-5">
        {enrolled ? (
          <div className="flex flex-col gap-3">
            <div role="status" className="rounded-xl border border-teal/30 bg-teal/10 p-4">
              <div className="text-[14px] font-bold text-teal">المصادقة الثنائية مفعّلة</div>
              <p className="mt-1 text-[12.5px] leading-6 text-gray">
                لإعادة التهيئة: ألغِ التفعيل من «حسابي ← الأمان» ثم فعّلها من جديد.
              </p>
            </div>
            <Link href={home} className="rounded-lg bg-teal py-2.5 text-center text-sm font-bold text-white">
              متابعة
            </Link>
          </div>
        ) : (
          <MfaEnroll continueHref={home} />
        )}
      </div>

      <form action={logout} className="mt-5 text-center">
        <button className="text-[12.5px] font-semibold text-gray hover:text-ink hover:underline">
          تسجيل الخروج
        </button>
      </form>
    </AuthCard>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isMfaMandatory, requireStaffForMfaSetup, staffHome } from "@/lib/auth";
import { AuthCard } from "../AuthCard";
import { MFA_INTRO, MfaEnroll } from "../MfaEnroll";
import { logout } from "../auth-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "إعداد المصادقة الثنائية · سلمى" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Standalone TOTP enrollment (login-style shell). Reached by the R2 redirect
 * (owner/super_admin without a factor) or after disabling MFA (?re=1). Uses
 * requireStaffForMfaSetup (skips R1/R2) so it is ALWAYS reachable → no lockout.
 */
export default async function MfaSetupPage({ searchParams }: Props) {
  const { profile, mfa } = await requireStaffForMfaSetup();
  const sp = await searchParams;
  const reconfigured = sp.re === "1";
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
      {isMfaMandatory(profile.role) ? (
        <div className="mt-3 rounded-lg border border-gold bg-gold/25 px-3 py-2 text-[12.5px] font-semibold text-ink">
          إلزامية لدورك — لا يمكن استخدام لوحة الإدارة قبل إكمال الإعداد.
        </div>
      ) : null}

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
          <MfaEnroll reconfigured={reconfigured} continueHref={home} />
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

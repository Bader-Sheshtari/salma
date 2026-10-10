import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getStaffSession, mfaRedirectFor, safeAdminDest, staffHome } from "@/lib/auth";
import { AuthCard, AuthNotice } from "../AuthCard";
import { LoginForm } from "./LoginForm";
import { MfaStep } from "./MfaStep";

export const metadata: Metadata = { title: "دخول الإدارة · سلمى" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function LoginPage({ searchParams }: Props) {
  const sp = await searchParams;

  // Already signed in as staff (editor and above)?
  const session = await getStaffSession();
  if (session) {
    const dest = safeAdminDest(first(sp.dest)) ?? staffHome(session.profile.role);
    const pending = mfaRedirectFor(session);
    // MFA satisfied → straight to the dashboard.
    if (!pending) redirect(dest);
    // Mandatory role without a factor → forced enrollment.
    if (pending === "/admin/mfa-setup") redirect(pending);
    // Enrolled but this session is not aal2 yet → the TOTP step (?step=mfa).
    return (
      <AuthCard>
        <MfaStep dest={dest} />
      </AuthCard>
    );
  }

  const banner =
    sp.accepted === "1"
      ? { title: "تم تفعيل حسابك", body: "سجّل الدخول بالبريد وكلمة المرور التي اخترتها." }
      : sp.reset === "1"
        ? { title: "تم تعيين كلمة المرور", body: "سجّل الدخول بكلمة المرور الجديدة." }
        : null;

  return (
    <AuthCard>
      {banner ? (
        <div className="mb-4">
          <AuthNotice tone="success" title={banner.title} body={banner.body} />
        </div>
      ) : null}
      <LoginForm />
    </AuthCard>
  );
}

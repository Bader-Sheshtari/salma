import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getStaffProfile } from "@/lib/auth";
import { AuthCard, AuthNotice } from "../AuthCard";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "دخول الإدارة · سلمى" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function LoginPage({ searchParams }: Props) {
  // Already signed in as staff (editor and above)? Skip straight to the dashboard.
  if (await getStaffProfile()) redirect("/admin");

  const sp = await searchParams;
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

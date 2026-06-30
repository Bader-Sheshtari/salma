import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAdminProfile } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "دخول الإدارة · سلمى" };

export default async function LoginPage() {
  // Already signed in as admin? Skip straight to the dashboard.
  if (await getAdminProfile()) redirect("/admin");

  return (
    <div className="flex min-h-screen items-center justify-center bg-sand px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-[0_10px_40px_rgba(46,46,45,.12)] sm:p-8">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal text-xl font-bold text-white">
            س
          </span>
          <div className="leading-tight">
            <div className="text-lg font-bold text-teal">سلمى</div>
            <div className="font-sans text-[11px] tracking-wide text-gray">لوحة الإدارة</div>
          </div>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}

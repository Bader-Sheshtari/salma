import type { Metadata } from "next";
import { requireStaff, type Profile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLE_LABEL } from "@/lib/roles";
import { formatStampAr } from "@/lib/format";
import { ProfileForm } from "./ProfileForm";
import { OwnPasswordForm } from "./OwnPasswordForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "حسابي · سلمى" };

export default async function AccountPage() {
  const me = (await requireStaff()) as Profile & { phone?: string | null };

  // Inviter's display name (own record only; service read of one name).
  let invitedBy = "—";
  if (me.created_by) {
    const { data } = await createAdminClient()
      .from("profiles")
      .select("full_name, email")
      .eq("id", me.created_by)
      .maybeSingle();
    const p = data as { full_name: string | null; email: string | null } | null;
    invitedBy = p?.full_name?.trim() || p?.email || "—";
  }

  const facts: { label: string; value: React.ReactNode }[] = [
    {
      label: "البريد الإلكتروني",
      value: (
        <span dir="ltr" className="font-sans">
          {me.email ?? "—"}
        </span>
      ),
    },
    {
      label: "الدور",
      value: (
        <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[11px] font-semibold text-teal">
          {ROLE_LABEL[me.role] ?? me.role}
        </span>
      ),
    },
    {
      label: "الحالة",
      value: (
        <span className="rounded bg-teal/10 px-1.5 py-0.5 font-sans text-[11px] font-semibold text-teal">
          نشط
        </span>
      ),
    },
    { label: "تاريخ الانضمام", value: formatStampAr(me.created_at, false) },
    { label: "دُعي بواسطة", value: invitedBy },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">حسابي</h1>
        <p className="mt-1 text-[13px] text-gray">
          بياناتك في لوحة الإدارة. الدور والحالة والبريد يديرها المسؤول.
        </p>
      </div>

      <section className="rounded-2xl border border-line bg-white p-4 sm:p-5">
        <h2 className="mb-3 text-[15px] font-bold">معلومات الحساب</h2>
        <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2">
          {facts.map((f) => (
            <div key={f.label} className="flex flex-col gap-0.5">
              <dt className="text-[12px] font-semibold text-gray">{f.label}</dt>
              <dd className="text-ink">{f.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rounded-2xl border border-line bg-white p-4 sm:p-5">
        <h2 className="mb-3 text-[15px] font-bold">البيانات الشخصية</h2>
        <ProfileForm fullName={me.full_name ?? ""} phone={me.phone ?? ""} />
      </section>

      <section className="rounded-2xl border border-line bg-white p-4 sm:p-5">
        <h2 className="mb-1 text-[15px] font-bold">تغيير كلمة المرور</h2>
        <p className="mb-3 text-[12.5px] text-gray">
          بعد التغيير تُنهى جلساتك على الأجهزة الأخرى، وتبقى هذه الجلسة مفتوحة.
        </p>
        <OwnPasswordForm email={me.email ?? ""} />
      </section>
    </div>
  );
}

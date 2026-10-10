import type { Metadata } from "next";
import { requireStaff, type Profile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLE_LABEL } from "@/lib/roles";
import { formatStampAr } from "@/lib/format";
import { StatusChip } from "../users/ui";
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

  const roleChip = (
    <span className="rounded bg-cream px-2 py-0.5 font-sans text-[11.5px] font-semibold text-teal">
      {ROLE_LABEL[me.role] ?? me.role}
    </span>
  );
  const statusChip = <StatusChip status="active" />;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">حسابي</h1>
        <p className="mt-1 text-[13px] text-gray">بياناتك الشخصية وكلمة مرورك في لوحة إدارة سلمى.</p>
      </div>

      <section aria-labelledby="acc-personal" className="rounded-2xl border border-line bg-white p-4 sm:p-5">
        <h2 id="acc-personal" className="text-[15px] font-bold">
          المعلومات الشخصية
        </h2>
        <p className="mb-4 mt-0.5 text-[12px] text-gray">
          انضممت في {formatStampAr(me.created_at, false)}
          {me.created_by ? ` · دُعيت بواسطة ${invitedBy}` : ""}
        </p>
        <ProfileForm
          fullName={me.full_name ?? ""}
          phone={me.phone ?? ""}
          email={me.email ?? ""}
          role={roleChip}
          status={statusChip}
        />
      </section>

      <section aria-labelledby="acc-password" className="rounded-2xl border border-line bg-white p-4 sm:p-5">
        <h2 id="acc-password" className="text-[15px] font-bold">
          كلمة المرور
        </h2>
        <p className="mb-4 mt-0.5 text-[12px] text-gray">
          بعد التغيير تُنهى جلساتك على الأجهزة الأخرى، وتبقى هذه الجلسة مفتوحة.
        </p>
        <OwnPasswordForm email={me.email ?? ""} />
      </section>
    </div>
  );
}

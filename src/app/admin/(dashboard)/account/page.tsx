import type { Metadata } from "next";
import Link from "next/link";
import { requireStaff, getStaffSession, isMfaMandatory, type Profile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { listMySecurityEvents } from "@/lib/admin-queries";
import { auditActionLabel } from "@/lib/audit-labels";
import { ROLE_LABEL } from "@/lib/roles";
import { formatStampAr } from "@/lib/format";
import { StatusChip } from "../users/ui";
import { RelTime } from "../content/history-ui";
import { ReauthProvider } from "../ReauthProvider";
import { ProfileForm } from "./ProfileForm";
import { OwnPasswordForm } from "./OwnPasswordForm";
import { MfaCard } from "./MfaCard";
import { SignOutOthers } from "./SignOutOthers";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "حسابي · سلمى" };

type Tab = "profile" | "password" | "security";
const TABS: { key: Tab; label: string }[] = [
  { key: "profile", label: "المعلومات الشخصية" },
  { key: "password", label: "كلمة المرور" },
  { key: "security", label: "الأمان" },
];

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

type Me = Profile & { phone?: string | null; password_changed_at?: string | null };

export default async function AccountPage({ searchParams }: Props) {
  const me = (await requireStaff()) as Me;
  const sp = await searchParams;
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: Tab = rawTab === "password" || rawTab === "security" ? rawTab : "profile";

  const roleChip = (
    <span className="rounded bg-cream px-2 py-0.5 font-sans text-[11.5px] font-semibold text-teal">
      {ROLE_LABEL[me.role] ?? me.role}
    </span>
  );
  const statusChip = <StatusChip status="active" />;

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold">حسابي</h1>
        <p className="mt-1 text-[13px] text-gray">بياناتك الشخصية وكلمة مرورك وأمان حسابك في لوحة إدارة سلمى.</p>
      </div>

      <nav className="salma-scroll flex gap-2 overflow-x-auto" aria-label="أقسام الحساب">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "profile" ? "/admin/account" : `/admin/account?tab=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${
              tab === t.key ? "bg-teal text-white" : "border border-line bg-white text-gray hover:bg-cream"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "profile" ? <ProfileTab me={me} roleChip={roleChip} statusChip={statusChip} /> : null}

      {tab === "password" ? (
        <section aria-labelledby="acc-password" className="rounded-2xl border border-line bg-white p-4 sm:p-5">
          <h2 id="acc-password" className="text-[15px] font-bold">
            كلمة المرور
          </h2>
          <p className="mb-4 mt-0.5 text-[12px] text-gray">
            بعد التغيير تُنهى جلساتك على الأجهزة الأخرى، وتبقى هذه الجلسة مفتوحة.
          </p>
          <OwnPasswordForm email={me.email ?? ""} />
        </section>
      ) : null}

      {tab === "security" ? <SecurityTab me={me} roleChip={roleChip} statusChip={statusChip} /> : null}
    </div>
  );
}

async function ProfileTab({
  me,
  roleChip,
  statusChip,
}: {
  me: Me;
  roleChip: React.ReactNode;
  statusChip: React.ReactNode;
}) {
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

  return (
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
  );
}

async function SecurityTab({
  me,
  roleChip,
  statusChip,
}: {
  me: Me;
  roleChip: React.ReactNode;
  statusChip: React.ReactNode;
}) {
  const [session, events] = await Promise.all([getStaffSession(), listMySecurityEvents(10)]);
  const hasFactors = (session?.mfa.verifiedFactorIds.length ?? 0) > 0;
  const mandatory = isMfaMandatory(me.role);

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "الدور", value: roleChip },
    { label: "حالة الحساب", value: statusChip },
    { label: "آخر دخول", value: me.last_login_at ? formatStampAr(me.last_login_at) : "غير معروف" },
    {
      label: "آخر تغيير لكلمة المرور",
      value: me.password_changed_at ? formatStampAr(me.password_changed_at) : "غير معروف",
    },
  ];

  return (
    <ReauthProvider hasFactors={hasFactors}>
      <div className="flex flex-col gap-5">
        <MfaCard enabled={hasFactors} mandatory={mandatory} />

        <section aria-labelledby="sec-info" className="rounded-2xl border border-line bg-white p-4 sm:p-5">
          <h2 id="sec-info" className="text-[15px] font-bold">
            معلومات الحساب والجلسات
          </h2>
          <dl className="mt-3 divide-y divide-line">
            {rows.map((r) => (
              <div key={r.label} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <dt className="text-[12.5px] font-semibold text-gray">{r.label}</dt>
                <dd className="text-[13px] text-ink">{r.value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 border-t border-line pt-4">
            <SignOutOthers />
          </div>
        </section>

        <section aria-labelledby="sec-activity" className="rounded-2xl border border-line bg-white p-4 sm:p-5">
          <h2 id="sec-activity" className="text-[15px] font-bold">
            نشاط الأمان الأخير
          </h2>
          {events.length ? (
            <ul className="mt-3 divide-y divide-line">
              {events.map((ev) => {
                const byOther = ev.actor_id && ev.actor_id !== me.id;
                return (
                  <li key={ev.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2.5">
                    <span className="text-[13px] text-ink">
                      {auditActionLabel(ev.action)}
                      {byOther ? (
                        <span className="text-[12px] text-gray"> · بواسطة {ev.actor_name || "—"}</span>
                      ) : !ev.actor_id ? (
                        <span className="text-[12px] text-gray"> · النظام</span>
                      ) : null}
                    </span>
                    <span className="font-sans text-[11.5px] text-gray">
                      <RelTime iso={ev.created_at} />
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 text-[12.5px] text-gray">لا يوجد نشاط أمني مسجّل بعد.</p>
          )}
        </section>
      </div>
    </ReauthProvider>
  );
}

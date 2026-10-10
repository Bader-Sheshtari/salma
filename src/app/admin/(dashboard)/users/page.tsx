import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAdmin, isManagerRole } from "@/lib/auth";
import { listAdmins, listOpenInvitations, profileNames } from "@/lib/admin-queries";
import { assignableRoles } from "@/lib/roles";
import { AdminRow } from "./AdminRow";
import { InvitationRow, type InvitationView } from "./InvitationRow";
import { InviteButton } from "./InviteButton";
import { IssuedLinkProvider } from "./LinkModal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "المستخدمون والصلاحيات · سلمى" };

const HEADERS = [
  "الاسم",
  "البريد",
  "الدور",
  "الحالة",
  "آخر دخول",
  "تاريخ الانضمام أو الدعوة",
  "دُعي بواسطة",
  "الإجراءات",
];

export default async function AdminUsersPage() {
  const actor = await requireAdmin();
  // Account management: owner + super_admin only (scoped per row by canManageTarget).
  if (!isManagerRole(actor.role)) redirect("/admin");

  const [admins, invitations] = await Promise.all([listAdmins(), listOpenInvitations()]);

  // «دُعي بواسطة» for accounts = created_by's name (resolve ids not in the staff list).
  const names: Record<string, string> = {};
  for (const a of admins) names[a.id] = a.full_name?.trim() || a.email || "—";
  const missing = admins.map((a) => a.created_by).filter((id): id is string => !!id && !names[id]);
  Object.assign(names, await profileNames(missing));

  const invites: InvitationView[] = invitations.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role ?? "",
    createdAt: i.created_at,
    expiresAt: i.expires_at,
    expired: i.expired,
    invitedBy: i.invited_by_name || (i.invited_by ? names[i.invited_by] : "") || "—",
  }));

  return (
    <IssuedLinkProvider>
      <div className="flex flex-col gap-6">
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold">المستخدمون والصلاحيات</h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-6 text-gray">
              إدارة حسابات فريق سلمى، الأدوار والصلاحيات وحالة الوصول.
            </p>
          </div>
          <InviteButton roles={[...assignableRoles(actor.role)]} />
        </header>

        <section aria-labelledby="users-heading">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="users-heading" className="text-[15px] font-bold">
              الحسابات <span className="font-sans text-[12.5px] font-normal text-gray">({admins.length})</span>
              {invites.length ? (
                <span className="mr-2 font-sans text-[12px] font-normal text-gray">
                  + {invites.length} {invites.length === 1 ? "دعوة مفتوحة" : "دعوات مفتوحة"}
                </span>
              ) : null}
            </h2>
            <p className="text-[11.5px] text-gray">
              {actor.role === "owner"
                ? "يختار كل مستخدم كلمة مروره بنفسه عبر رابط لمرة واحدة."
                : "حسابات المالك والمشرفين العامّين يديرها المالك."}
            </p>
          </div>
          <div className="overflow-hidden rounded-2xl border border-line bg-white md:overflow-x-auto">
            <table className="block w-full text-right md:table md:min-w-[860px]">
              <thead className="hidden md:table-header-group">
                <tr className="bg-cream/50">
                  {HEADERS.map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="px-3 py-2.5 text-[12px] font-semibold whitespace-nowrap text-gray"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="block md:table-row-group [&>tr:first-child]:border-t-0 md:[&>tr:first-child]:border-t">
                {invites.map((inv) => (
                  <InvitationRow key={inv.id} inv={inv} actorRole={actor.role} />
                ))}
                {admins.map((u) => (
                  <AdminRow
                    key={u.id}
                    user={u}
                    actorRole={actor.role}
                    actorId={actor.id}
                    invitedBy={(u.created_by && names[u.created_by]) || "—"}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </IssuedLinkProvider>
  );
}

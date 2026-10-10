import { redirect } from "next/navigation";
import { requireAdmin, isManagerRole } from "@/lib/auth";
import { listAdmins, listOpenInvitations, profileNames } from "@/lib/admin-queries";
import { assignableRoles } from "@/lib/roles";
import { AdminRow } from "./AdminRow";
import { InvitationRow, type InvitationView } from "./InvitationRow";
import { InviteButton } from "./InviteButton";
import { IssuedLinkProvider } from "./LinkModal";

export const dynamic = "force-dynamic";

const HEADERS = ["الاسم", "البريد", "الدور", "الحالة", "تاريخ الدعوة/الانضمام", "دُعي بواسطة", "إجراءات"];

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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">إدارة الأدمن</h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-6 text-gray">
              {actor.role === "owner"
                ? "ادعُ الحسابات وعدّل أدوارها وأوقفها عند الحاجة."
                : "ادعُ المسؤولين والمحررين وعدّل أدوارهم وأوقفهم عند الحاجة. حسابات المالك والمشرفين العامّين يديرها المالك."}{" "}
              يختار كل مستخدم كلمة مروره بنفسه عبر رابط يظهر لك مرة واحدة فقط؛ إن ضاع، أعد إصدار
              رابط جديد.
            </p>
          </div>
          <InviteButton roles={[...assignableRoles(actor.role)]} />
        </div>

        <section>
          <h2 className="mb-3 text-[15px] font-bold">
            الحسابات ({admins.length})
            {invites.length ? (
              <span className="mr-2 font-sans text-[12px] font-normal text-gray">
                + {invites.length} دعوة مفتوحة
              </span>
            ) : null}
          </h2>
          <div className="overflow-x-auto rounded-2xl border border-line bg-white">
            <table className="w-full min-w-[860px] text-right">
              <thead>
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
              <tbody>
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

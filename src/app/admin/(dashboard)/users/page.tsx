import { redirect } from "next/navigation";
import { requireAdmin, isManagerRole } from "@/lib/auth";
import { listAdmins } from "@/lib/admin-queries";
import { assignableRoles } from "@/lib/roles";
import { OwnPasswordForm } from "./OwnPasswordForm";
import { CreateAdminForm } from "./CreateAdminForm";
import { AdminRow } from "./AdminRow";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const actor = await requireAdmin();
  // Account management: owner + super_admin only (scoped per row by canManageTarget).
  if (!isManagerRole(actor.role)) redirect("/admin");
  const admins = await listAdmins();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">إدارة الأدمن</h1>
        <p className="mt-1 text-[13px] text-gray">
          {actor.role === "owner"
            ? "أضف الحسابات وعدّل أدوارها وأوقفها عند الحاجة. لا تُعرض كلمات المرور بعد إنشائها."
            : "أضف حسابات المسؤولين والمحررين وعدّل أدوارهم وأوقفهم عند الحاجة. حسابات المالك والمشرفين العامّين يديرها المالك."}
        </p>
      </div>

      <section className="rounded-2xl border border-line bg-white p-4 sm:p-5">
        <h2 className="mb-3 text-[15px] font-bold">تغيير كلمة مروري</h2>
        <OwnPasswordForm />
      </section>

      <section className="rounded-2xl border border-line bg-white p-4 sm:p-5">
        <h2 className="mb-3 text-[15px] font-bold">إضافة حساب جديد</h2>
        <CreateAdminForm roles={[...assignableRoles(actor.role)]} />
      </section>

      <section>
        <h2 className="mb-3 text-[15px] font-bold">الحسابات ({admins.length})</h2>
        <ul className="flex flex-col gap-3">
          {admins.map((u) => (
            <AdminRow key={u.id} user={u} actorRole={actor.role} actorId={actor.id} />
          ))}
        </ul>
      </section>
    </div>
  );
}

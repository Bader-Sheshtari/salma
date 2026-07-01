import { redirect } from "next/navigation";
import { requireAdmin, isManagerRole } from "@/lib/auth";
import { listAdmins } from "@/lib/admin-queries";
import { OwnPasswordForm } from "./OwnPasswordForm";
import { CreateAdminForm } from "./CreateAdminForm";
import { AdminRow } from "./AdminRow";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const actor = await requireAdmin();
  // Admin management is owner-only; other admins are bounced back to the dashboard.
  if (actor.role !== "owner") redirect("/admin");
  const canManage = isManagerRole(actor.role);
  const admins = canManage ? await listAdmins() : [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">إدارة الأدمن</h1>
        <p className="mt-1 text-[13px] text-gray">
          {canManage
            ? "أضف حسابات المدراء وعدّل أدوارهم، وأوقفهم أو احذفهم. لا تُعرض كلمات المرور بعد إنشائها."
            : "يمكنك تغيير كلمة مرورك من هنا."}
        </p>
      </div>

      <section className="rounded-2xl border border-line bg-white p-4 sm:p-5">
        <h2 className="mb-3 text-[15px] font-bold">تغيير كلمة مروري</h2>
        <OwnPasswordForm />
      </section>

      {canManage ? (
        <>
          <section className="rounded-2xl border border-line bg-white p-4 sm:p-5">
            <h2 className="mb-3 text-[15px] font-bold">إضافة حساب جديد</h2>
            <CreateAdminForm canAssignSuperAdmin={actor.role === "owner"} />
          </section>

          <section>
            <h2 className="mb-3 text-[15px] font-bold">الحسابات ({admins.length})</h2>
            <ul className="flex flex-col gap-3">
              {admins.map((u) => (
                <AdminRow key={u.id} user={u} actorRole={actor.role} actorId={actor.id} />
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}

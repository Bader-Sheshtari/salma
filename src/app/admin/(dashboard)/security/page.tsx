import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin, isManagerRole } from "@/lib/auth";
import { listAdmins, listSecurityEvents, type SecurityEventFilters } from "@/lib/admin-queries";
import { AUDIT_ACTIONS, auditActionLabel } from "@/lib/audit-labels";
import { UUID_RE } from "@/lib/admin-links";
import { ROLE_LABEL } from "@/lib/roles";
import { SecurityLog } from "./SecurityLog";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "سجل الأمان · سلمى" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

const field =
  "mt-1 block w-full rounded-lg border border-gray/40 bg-white px-2.5 py-1.5 text-[12.5px] outline-none focus:border-teal";
const label = "block text-[11.5px] font-semibold text-gray";

/**
 * «سجل الأمان» — admin_audit_log for managers (owner: everything; super_admin:
 * scoped by list_security_events). Filters are URL-driven (GET form).
 */
export default async function SecurityLogPage({ searchParams }: Props) {
  const actor = await requireAdmin();
  if (!isManagerRole(actor.role)) redirect("/admin");

  const sp = await searchParams;
  const filters: SecurityEventFilters = {
    from: DATE_RE.test(first(sp.from)) ? first(sp.from) : null,
    to: DATE_RE.test(first(sp.to)) ? first(sp.to) : null,
    actor: UUID_RE.test(first(sp.actor)) ? first(sp.actor) : null,
    target: UUID_RE.test(first(sp.target)) ? first(sp.target) : null,
    action: AUDIT_ACTIONS.includes(first(sp.action)) ? first(sp.action) : null,
  };
  const filtered = Object.values(filters).some(Boolean);

  const [staff, page] = await Promise.all([listAdmins(), listSecurityEvents(filters)]);
  const people = staff.map((p) => ({
    id: p.id,
    name: `${p.full_name?.trim() || p.email || "—"} (${ROLE_LABEL[p.role] ?? p.role})`,
  }));

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold">سجل الأمان</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-6 text-gray">
          أحداث الحسابات والصلاحيات والمصادقة: من فعل ماذا، بحق من، ومتى.
          {actor.role === "super_admin" ? " أحداث حسابات المالك والمشرفين العامّين لا تظهر هنا إلا ما يخصّك." : ""}
        </p>
      </header>

      <form method="get" className="grid grid-cols-2 gap-3 rounded-2xl border border-line bg-white p-4 md:grid-cols-6">
        <label className={label}>
          من تاريخ
          <input type="date" name="from" defaultValue={filters.from ?? ""} dir="ltr" className={field} />
        </label>
        <label className={label}>
          إلى تاريخ
          <input type="date" name="to" defaultValue={filters.to ?? ""} dir="ltr" className={field} />
        </label>
        <label className={label}>
          المنفّذ
          <select name="actor" defaultValue={filters.actor ?? ""} className={field}>
            <option value="">الكل</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          الإجراء
          <select name="action" defaultValue={filters.action ?? ""} className={field}>
            <option value="">الكل</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {auditActionLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          الحساب المستهدف
          <select name="target" defaultValue={filters.target ?? ""} className={field}>
            <option value="">الكل</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="col-span-2 flex items-end gap-2 md:col-span-1">
          <button className="flex-1 rounded-lg bg-teal px-3 py-2 text-[12.5px] font-bold text-white hover:bg-teal/90">
            تطبيق
          </button>
          {filtered ? (
            <Link
              href="/admin/security"
              className="rounded-lg border border-line px-3 py-2 text-[12.5px] font-semibold text-gray hover:bg-cream"
            >
              مسح
            </Link>
          ) : null}
        </div>
      </form>

      <div className="max-w-4xl">
        <SecurityLog
          // Remount when filters change so appended pages never mix filter sets.
          key={JSON.stringify(filters)}
          filters={filters}
          initialEvents={page.events}
          initialHasMore={page.hasMore}
          error={page.error}
        />
      </div>
    </div>
  );
}

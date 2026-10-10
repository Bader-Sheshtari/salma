import Link from "next/link";
import { requireStaff, isAdminRole, isManagerRole } from "@/lib/auth";
import { logout } from "../auth-actions";

/**
 * Minimum tier per nav item: `staff` = editor and above (content area only),
 * `admin` = admin and above (operational pages), `manager` = super_admin/owner
 * (account management). Each page ALSO hard-gates itself server-side — hiding a
 * link is never the only protection.
 */
type Tier = "staff" | "admin" | "manager";

const NAV: { href: string; label: string; tier: Tier }[] = [
  { href: "/admin", label: "لوحة التحكم", tier: "admin" },
  { href: "/admin/homepage", label: "الصفحة الرئيسية", tier: "admin" },
  { href: "/admin/content", label: "المحتوى", tier: "staff" },
  { href: "/admin/radar", label: "رادار الأخبار", tier: "admin" },
  { href: "/admin/editorial-feedback", label: "التعلّم التحريري", tier: "admin" },
  { href: "/admin/content/new", label: "إضافة محتوى", tier: "staff" },
  { href: "/admin/categories", label: "الأقسام والصفحات", tier: "admin" },
  { href: "/admin/ingest", label: "جلب بالذكاء الاصطناعي", tier: "admin" },
  { href: "/admin/ingest/runs", label: "سجلّ الجلب", tier: "admin" },
  { href: "/admin/ingest/policy", label: "السياسة التحريرية", tier: "admin" },
  { href: "/admin/ingest/sources", label: "سِجِلّ المصادر", tier: "admin" },
  { href: "/admin/synthesize", label: "تحويل رابط لمقال", tier: "admin" },
  { href: "/admin/comments", label: "التعليقات", tier: "admin" },
  { href: "/admin/departments", label: "الأقسام", tier: "admin" },
  { href: "/admin/doctors", label: "الأطباء", tier: "admin" },
  { href: "/admin/transfers", label: "انتقال الأطباء", tier: "admin" },
  { href: "/admin/users", label: "المستخدمون والصلاحيات", tier: "manager" },
  { href: "/admin/security", label: "سجل الأمان", tier: "manager" },
  { href: "/admin/account", label: "حسابي", tier: "staff" },
];

function allowed(tier: Tier, role: string): boolean {
  if (tier === "manager") return isManagerRole(role);
  if (tier === "admin") return isAdminRole(role);
  return true; // staff — requireStaff already admitted this role
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireStaff();
  const nav = NAV.filter((n) => allowed(n.tier, admin.role));
  // Editors have no dashboard home (its stats are admin-scope); brand links to content.
  const home = isAdminRole(admin.role) ? "/admin" : "/admin/content";

  return (
    <div className="min-h-screen bg-sand">
      <div className="mx-auto flex max-w-6xl flex-col md:flex-row">
        <aside className="md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0">
          <div className="flex h-full flex-col border-line bg-white p-4 md:border-l">
            <Link href={home} className="mb-5 flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal text-lg font-bold text-white">
                س
              </span>
              <span className="leading-tight">
                <span className="block font-bold text-teal">سلمى</span>
                <span className="block font-sans text-[10px] tracking-wide text-gray">إدارة</span>
              </span>
            </Link>
            <nav className="salma-scroll flex gap-2 overflow-x-auto md:flex-col md:gap-1">
              {nav.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="whitespace-nowrap rounded-lg px-3 py-2 text-[13.5px] font-semibold text-ink hover:bg-cream"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
            <div className="mt-auto hidden pt-5 md:block">
              <div className="mb-2 font-sans text-[11px] text-gray">{admin.email}</div>
              <form action={logout}>
                <button className="w-full rounded-lg border border-line py-2 text-[13px] font-semibold text-gray hover:bg-cream">
                  تسجيل الخروج
                </button>
              </form>
            </div>
          </div>
        </aside>
        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

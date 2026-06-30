import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { logout } from "../auth-actions";

const NAV = [
  { href: "/admin", label: "لوحة التحكم" },
  { href: "/admin/content", label: "المحتوى" },
  { href: "/admin/content/new", label: "إضافة محتوى" },
  { href: "/admin/ingest", label: "جلب بالذكاء الاصطناعي" },
  { href: "/admin/ingest/runs", label: "سجلّ الجلب" },
  { href: "/admin/ingest/policy", label: "السياسة التحريرية" },
  { href: "/admin/comments", label: "التعليقات" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();

  return (
    <div className="min-h-screen bg-sand">
      <div className="mx-auto flex max-w-6xl flex-col md:flex-row">
        <aside className="md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0">
          <div className="flex h-full flex-col border-line bg-white p-4 md:border-l">
            <Link href="/admin" className="mb-5 flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal text-lg font-bold text-white">
                س
              </span>
              <span className="leading-tight">
                <span className="block font-bold text-teal">سلمى</span>
                <span className="block font-sans text-[10px] tracking-wide text-gray">إدارة</span>
              </span>
            </Link>
            <nav className="salma-scroll flex gap-2 overflow-x-auto md:flex-col md:gap-1">
              {NAV.map((n) => (
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

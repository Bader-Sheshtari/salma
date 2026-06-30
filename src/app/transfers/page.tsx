import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { getCategories, getTransfers } from "@/lib/queries";
import { timeAgoAr } from "@/lib/format";

export const revalidate = 60;

export const metadata: Metadata = { title: "انتقال الأطباء · سلمى" };

function fmtDate(d: string | null): string | null {
  if (!d) return null;
  return new Intl.DateTimeFormat("ar", { dateStyle: "medium" }).format(new Date(d));
}

export default async function TransfersPage() {
  const [categories, transfers] = await Promise.all([getCategories(), getTransfers()]);

  return (
    <div className="mx-auto min-h-screen max-w-3xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} active="transfers" />
      <main className="px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="h-7 w-1.5 rounded-sm bg-teal" />
          <h1 className="text-2xl font-bold sm:text-3xl">انتقال الأطباء</h1>
        </div>

        {transfers.length === 0 ? (
          <p className="text-[14px] text-gray">لا توجد انتقالات بعد.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {transfers.map((t) => (
              <li key={t.id} className="rounded-2xl border border-line bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[15px] font-bold">{t.doctor_name}</span>
                  <span className="font-sans text-[11px] text-gray">
                    {fmtDate(t.transfer_date) ?? timeAgoAr(t.created_at)}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13.5px] text-ink">
                  {t.from_hospital ? <span className="text-gray">{t.from_hospital}</span> : null}
                  <span className="text-teal">←</span>
                  <span className="font-semibold">{t.to_hospital ?? "—"}</span>
                  {t.department_name ? (
                    <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[11px] font-semibold text-teal">
                      {t.department_name}
                    </span>
                  ) : null}
                </div>
                {t.note ? <p className="mt-1.5 text-[13.5px] leading-relaxed text-gray">{t.note}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </main>
      <Footer categories={categories} />
    </div>
  );
}

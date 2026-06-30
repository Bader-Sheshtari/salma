import Link from "next/link";
import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { getCategories, getDepartments, getDoctors } from "@/lib/queries";

export const revalidate = 60;

export const metadata: Metadata = { title: "الأطباء · سلمى" };

function stars(n: number): string {
  const r = Math.round(n);
  return "★".repeat(r) + "☆".repeat(5 - r);
}

type Props = { searchParams: Promise<{ dept?: string }> };

export default async function DoctorsPage({ searchParams }: Props) {
  const { dept } = await searchParams;
  const [categories, departments] = await Promise.all([getCategories(), getDepartments()]);
  const activeDept = dept ? departments.find((d) => d.slug === dept) : undefined;
  const doctors = await getDoctors(activeDept?.id);

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} active="doctors" />
      <main className="px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="h-7 w-1.5 rounded-sm bg-teal" />
          <h1 className="text-2xl font-bold sm:text-3xl">الأطباء</h1>
        </div>

        <div className="salma-scroll mb-5 flex gap-2 overflow-x-auto">
          <Link
            href="/doctors"
            className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${
              !activeDept ? "bg-teal text-white" : "border border-line bg-white text-gray"
            }`}
          >
            الكل
          </Link>
          {departments.map((d) => (
            <Link
              key={d.id}
              href={`/doctors?dept=${d.slug}`}
              className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${
                activeDept?.id === d.id ? "bg-teal text-white" : "border border-line bg-white text-gray"
              }`}
            >
              {d.name_ar}
            </Link>
          ))}
        </div>

        {doctors.length === 0 ? (
          <p className="text-[14px] text-gray">لا يوجد أطباء بعد.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {doctors.map((d) => (
              <Link
                key={d.id}
                href={`/doctors/${d.slug}`}
                className="flex items-center gap-3.5 rounded-2xl border border-line bg-white p-4 hover:bg-cream"
              >
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-full border border-line bg-cream">
                  {d.photo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={d.photo_url} alt={d.name_ar} className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-xl text-gray">🩺</span>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-bold">{d.name_ar}</div>
                  {d.title_ar ? <div className="truncate text-[12.5px] text-gray">{d.title_ar}</div> : null}
                  <div className="mt-1 flex items-center gap-1.5 text-[13px]">
                    <span className="text-amber-500">{stars(Number(d.rating_avg))}</span>
                    <span className="font-sans text-[11px] text-gray">
                      {Number(d.rating_avg).toFixed(1)} ({d.rating_count})
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
      <Footer categories={categories} />
    </div>
  );
}

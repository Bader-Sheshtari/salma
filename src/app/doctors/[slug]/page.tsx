import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { RatingForm } from "@/components/site/RatingForm";
import { getCategories, getDoctorBySlug } from "@/lib/queries";
import { timeAgoAr } from "@/lib/format";

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const detail = await getDoctorBySlug(slug);
  return { title: detail ? `${detail.doctor.name_ar} · سلمى` : "سلمى" };
}

function stars(n: number): string {
  const r = Math.round(n);
  return "★".repeat(r) + "☆".repeat(5 - r);
}

export default async function DoctorPage({ params }: Props) {
  const { slug } = await params;
  const [categories, detail] = await Promise.all([getCategories(), getDoctorBySlug(slug)]);
  if (!detail) notFound();
  const { doctor, department, ratings } = detail;

  return (
    <div className="mx-auto min-h-screen max-w-3xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} active="doctors" />
      <main className="px-4 py-6 sm:px-6">
        <div className="flex items-center gap-4">
          <div className="h-24 w-24 shrink-0 overflow-hidden rounded-full border border-line bg-cream">
            {doctor.photo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={doctor.photo_url} alt={doctor.name_ar} className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-3xl text-gray">🩺</span>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold">{doctor.name_ar}</h1>
            {doctor.title_ar ? <div className="text-[14px] text-gray">{doctor.title_ar}</div> : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-amber-500">{stars(Number(doctor.rating_avg))}</span>
              <span className="font-sans text-[12px] text-gray">
                {Number(doctor.rating_avg).toFixed(1)} ({doctor.rating_count} تقييم)
              </span>
              {department ? (
                <span className="rounded bg-cream px-1.5 py-0.5 font-sans text-[11px] font-semibold text-teal">
                  {department.name_ar}
                </span>
              ) : null}
            </div>
            {doctor.hospital ? <div className="mt-1 text-[12.5px] text-gray">{doctor.hospital}</div> : null}
          </div>
        </div>

        {doctor.bio ? (
          <p className="mt-5 text-[14px] leading-relaxed text-ink">{doctor.bio}</p>
        ) : null}

        <section className="mt-8">
          <div className="mb-3.5 flex items-center gap-2.5">
            <span className="h-[22px] w-1 rounded-sm bg-teal" />
            <h2 className="text-[17px] font-bold">قيّم الطبيب</h2>
          </div>
          <RatingForm doctorId={doctor.id} />
        </section>

        <section className="mt-8">
          <div className="mb-3.5 flex items-center gap-2.5">
            <span className="h-[22px] w-1 rounded-sm bg-teal" />
            <h2 className="text-[17px] font-bold">التقييمات ({ratings.length})</h2>
          </div>
          <div className="flex flex-col gap-3">
            {ratings.length === 0 ? (
              <div className="text-[13px] text-gray">كن أول من يقيّم هذا الطبيب.</div>
            ) : (
              ratings.map((r) => (
                <div key={r.id} className="rounded-xl border border-line p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[13.5px] font-bold">{r.author_name}</span>
                    <span className="font-sans text-[11px] text-gray">{timeAgoAr(r.created_at)}</span>
                  </div>
                  <div className="mt-1 text-[14px] text-amber-500">{stars(r.stars)}</div>
                  {r.body ? <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink">{r.body}</p> : null}
                </div>
              ))
            )}
          </div>
        </section>
      </main>
      <Footer categories={categories} />
    </div>
  );
}

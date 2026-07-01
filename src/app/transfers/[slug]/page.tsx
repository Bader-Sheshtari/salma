import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { ShareBar } from "@/components/site/ShareBar";
import { getCategories, getTransferBySlug } from "@/lib/queries";
import { formatDateTimeAr } from "@/lib/format";

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTransferBySlug(slug);
  return { title: t ? `${t.doctor_name} · انتقال الأطباء · سلمى` : "سلمى" };
}

export default async function TransferDetailPage({ params }: Props) {
  const { slug } = await params;
  const [categories, transfer] = await Promise.all([getCategories(), getTransferBySlug(slug)]);
  if (!transfer) notFound();

  const published = formatDateTimeAr(transfer.published_at ?? transfer.created_at);

  return (
    <div className="mx-auto min-h-screen max-w-3xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} active="transfers" />
      <main className="px-4 py-6 sm:px-6">
        <div className="flex items-center gap-4">
          <div className="h-24 w-24 shrink-0 overflow-hidden rounded-full border border-line bg-cream">
            {transfer.doctor_photo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={transfer.doctor_photo_url} alt={transfer.doctor_name} className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-3xl text-gray">🩺</span>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold">{transfer.doctor_name}</h1>
            {transfer.specialty ? (
              <span className="mt-1.5 inline-block rounded bg-cream px-2 py-0.5 font-sans text-[12px] font-semibold text-teal">
                {transfer.specialty}
              </span>
            ) : null}
            {published ? <div className="mt-1.5 font-sans text-[12px] text-gray">{published}</div> : null}
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-line bg-cream/40 p-4">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-center">
            <div>
              <div className="font-sans text-[11px] font-semibold text-gray">انتقل من</div>
              <div className="mt-1 text-[14px] font-bold text-ink">{transfer.from_hospital ?? "—"}</div>
            </div>
            <span className="text-2xl text-teal">←</span>
            <div>
              <div className="font-sans text-[11px] font-semibold text-gray">انتقل إلى</div>
              <div className="mt-1 text-[14px] font-bold text-ink">{transfer.to_hospital ?? "—"}</div>
            </div>
          </div>
        </div>

        {transfer.summary ? (
          <p className="mt-5 text-[15px] font-semibold leading-relaxed text-ink">{transfer.summary}</p>
        ) : null}

        {transfer.body ? (
          <div className="mt-4 whitespace-pre-line text-[14.5px] leading-loose text-ink">{transfer.body}</div>
        ) : null}

        {transfer.source_name || transfer.source_url ? (
          <div className="mt-6 text-[13px] text-gray">
            المصدر:{" "}
            {transfer.source_url ? (
              <a
                href={transfer.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-teal hover:underline"
              >
                {transfer.source_name || transfer.source_url}
              </a>
            ) : (
              <span className="font-semibold text-ink">{transfer.source_name}</span>
            )}
          </div>
        ) : null}

        <div className="mt-6 border-t border-line pt-4">
          <ShareBar title={`انتقال ${transfer.doctor_name}`} />
        </div>
      </main>
      <Footer categories={categories} />
    </div>
  );
}

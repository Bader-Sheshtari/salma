import Link from "next/link";
import type { DoctorTransfer } from "@/lib/queries";
import { timeAgoAr } from "@/lib/format";

/** Premium doctor-transfer card used on the /transfers grid and the homepage
 * carousel. Links to the detail page when a slug exists. */
export function TransferCard({ t }: { t: DoctorTransfer }) {
  const href = t.slug ? `/transfers/${t.slug}` : null;
  const when = timeAgoAr(t.published_at ?? t.created_at);

  const inner = (
    <div className="flex h-full flex-col rounded-2xl border border-line bg-white p-4 transition hover:border-teal/50 hover:shadow-[0_4px_20px_rgba(46,46,45,.08)]">
      <div className="flex items-start gap-3">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-full border border-line bg-cream">
          {t.doctor_photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={t.doctor_photo_url} alt={t.doctor_name} className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-2xl text-gray">🩺</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-bold text-ink">{t.doctor_name}</div>
          {t.specialty ? (
            <span className="mt-1 inline-block rounded bg-cream px-1.5 py-0.5 font-sans text-[11px] font-semibold text-teal">
              {t.specialty}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        {t.from_hospital ? (
          <span className="text-gray">{t.from_hospital}</span>
        ) : (
          <span className="text-gray">—</span>
        )}
        <span className="text-teal">←</span>
        <span className="font-semibold text-ink">{t.to_hospital ?? "—"}</span>
      </div>

      {t.summary ? (
        <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-gray">{t.summary}</p>
      ) : null}

      <div className="mt-auto pt-3 font-sans text-[11px] text-gray">{when}</div>
    </div>
  );

  return href ? (
    <Link href={href} className="block h-full">
      {inner}
    </Link>
  ) : (
    inner
  );
}

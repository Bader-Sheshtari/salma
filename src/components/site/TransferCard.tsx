import Link from "next/link";
import type { DoctorTransfer } from "@/lib/queries";
import { timeAgoAr } from "@/lib/format";

/** Premium doctor-transfer card used on the /transfers grid and the homepage
 * carousel. Links to the detail page when a slug exists. */
export function TransferCard({ t }: { t: DoctorTransfer }) {
  const href = t.slug ? `/transfers/${t.slug}` : null;
  const when = timeAgoAr(t.published_at ?? t.created_at);

  const inner = (
    <div className="flex h-full overflow-hidden rounded-2xl border border-line bg-white transition hover:border-teal/50 hover:shadow-[0_4px_20px_rgba(46,46,45,.08)]">
      {/* Photo — leading (right in RTL), ~half the card */}
      <div className="w-1/2 shrink-0 self-stretch overflow-hidden bg-cream">
        {t.doctor_photo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={t.doctor_photo_url}
            alt={t.doctor_name}
            className="h-full min-h-40 w-full object-cover"
          />
        ) : (
          <span className="flex h-full min-h-40 w-full items-center justify-center text-5xl text-gray">
            🩺
          </span>
        )}
      </div>

      {/* Details — trailing (left in RTL) */}
      <div className="flex min-w-0 flex-1 flex-col p-4">
        <div className="line-clamp-2 text-[15px] font-bold text-ink">{t.doctor_name}</div>
        {t.specialty ? (
          <span className="mt-1 inline-block self-start rounded bg-cream px-1.5 py-0.5 font-sans text-[11px] font-semibold text-teal">
            {t.specialty}
          </span>
        ) : null}

        <div className="mt-2.5 rounded-xl border border-line bg-cream/50 p-2.5">
          <div className="flex items-center gap-1.5">
            <span className="font-sans text-[10px] font-bold text-gray">من</span>
            <span className="truncate text-[15px] font-bold text-ink">{t.from_hospital ?? "—"}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="font-sans text-[10px] font-bold text-teal">إلى</span>
            <span className="truncate text-[15px] font-bold text-teal">{t.to_hospital ?? "—"}</span>
          </div>
        </div>

        {t.summary ? (
          <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-gray">{t.summary}</p>
        ) : null}

        <div className="mt-auto pt-3 font-sans text-[11px] text-gray">{when}</div>
      </div>
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

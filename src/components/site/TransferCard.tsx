import type { PublicDoctorTransfer } from "@/lib/queries";
import { formatDateAr } from "@/lib/format";

/** First-name initial for the no-photo fallback monogram (honorific dropped). */
function monogram(name: string): string {
  const cleaned = name.replace(/^د\.?\s*/u, "").trim();
  return cleaned.charAt(0) || name.charAt(0) || "؟";
}

/** Premium, non-interactive doctor-transfer card used on the /transfers grid
 * and the homepage rail. A lightweight factual news item: large portrait,
 * name, optional specialty, a prominent "من ← إلى" movement row, and a subtle
 * platform publication date. It is intentionally NOT a link. */
export function TransferCard({ t }: { t: PublicDoctorTransfer }) {
  const when = formatDateAr(t.published_at ?? t.created_at);

  return (
    <article className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_3px_rgba(46,46,45,.05)]">
      {/* Large editorial portrait — dominant, consistent 4:5 area */}
      <div className="aspect-[4/5] w-full overflow-hidden bg-cream">
        {t.doctor_photo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={t.doctor_photo_url}
            alt={t.doctor_name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_50%_35%,#fff,var(--salma-cream))]">
            <span className="font-serif text-6xl font-bold text-teal/70">
              {monogram(t.doctor_name)}
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col p-4">
        <h3 className="line-clamp-2 text-[17px] font-bold leading-snug text-ink">
          {t.doctor_name}
        </h3>
        {t.specialty ? (
          <p className="mt-1 text-[12.5px] leading-tight text-gray">{t.specialty}</p>
        ) : null}

        {/* THE NEWS: من (physical right) ← إلى (physical left). Explicit grid
            columns + dir=rtl guarantee the physical placement regardless of
            flex auto-ordering. */}
        <div
          dir="rtl"
          className="mt-3 grid items-center gap-1.5 rounded-xl border border-line bg-cream/40 p-3"
          style={{ gridTemplateColumns: "minmax(0,1fr) auto minmax(0,1fr)" }}
        >
          <div style={{ gridColumn: 1 }} className="min-w-0 text-right">
            <span className="block font-sans text-[12.5px] font-semibold text-gray">
              من
            </span>
            <span className="mt-0.5 block break-words text-[14.5px] font-bold leading-snug text-ink">
              {t.from_hospital ?? "غير محدد"}
            </span>
          </div>

          <span
            style={{ gridColumn: 2 }}
            aria-hidden
            className="px-1 text-xl font-bold text-teal"
          >
            ←
          </span>

          <div style={{ gridColumn: 3 }} className="min-w-0 text-left">
            <span className="block font-sans text-[12.5px] font-semibold text-teal">
              إلى
            </span>
            <span className="mt-0.5 block break-words text-[14.5px] font-bold leading-snug text-teal">
              {t.to_hospital ?? "غير محدد"}
            </span>
          </div>
        </div>

        <div className="mt-auto pt-3 font-sans text-[11px] text-gray">{when}</div>
      </div>
    </article>
  );
}

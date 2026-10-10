/** Shared bits for the users table (server- and client-safe). */

export const cell = "px-3 py-3 text-[13px]";
export const actionBtn =
  "rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12px] font-semibold whitespace-nowrap hover:bg-cream disabled:opacity-50";

/**
 * Responsive table parts: below md each row is a stacked card (main cell +
 * actions); md+ is a normal table. Mirrors the content table's approach.
 */
export const row = "flex flex-col gap-2 border-t border-line px-3 py-3 md:table-row md:p-0";
export const mainCell = "block md:table-cell md:px-3 md:py-3 md:align-top";
export const desktopCell = "hidden md:table-cell px-3 py-3 align-top text-[12px] text-gray";
export const actionsCell = "block md:table-cell md:px-3 md:py-3 md:align-top";

export type RowStatus = "active" | "suspended" | "pending" | "expired";

const STATUS: Record<RowStatus, { label: string; cls: string; dot: string }> = {
  active: { label: "نشط", cls: "bg-green/15 text-teal", dot: "bg-green" },
  pending: { label: "دعوة معلّقة", cls: "bg-gold/45 text-ink", dot: "bg-[color-mix(in_srgb,var(--salma-gold)_65%,var(--salma-ink))]" },
  expired: { label: "دعوة منتهية", cls: "bg-sand/70 text-gray", dot: "bg-gray/60" },
  suspended: { label: "موقوف", cls: "bg-coral/20 text-ink", dot: "bg-coral" },
};

export function StatusChip({ status }: { status: RowStatus }) {
  const s = STATUS[status];
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 font-sans text-[11px] font-semibold ${s.cls}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export function RoleChip({ label }: { label: string }) {
  return (
    <span className="whitespace-nowrap rounded bg-cream px-1.5 py-0.5 font-sans text-[11px] font-semibold text-teal">
      {label}
    </span>
  );
}

/** Owner row: protected, no actions. */
export function ProtectedChip() {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-line bg-cream/60 px-2 py-0.5 font-sans text-[11px] font-semibold text-gray">
      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
        <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" opacity=".8" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      محمي
    </span>
  );
}

/** Shared bits for the users table (server- and client-safe). */

export const cell = "px-3 py-3 text-[13px]";
export const actionBtn =
  "rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold hover:bg-cream disabled:opacity-50";

export type RowStatus = "active" | "suspended" | "pending" | "expired";

const STATUS: Record<RowStatus, { label: string; cls: string }> = {
  active: { label: "نشط", cls: "bg-teal/10 text-teal" },
  suspended: { label: "موقوف", cls: "bg-coral/15 text-ink" },
  pending: { label: "دعوة معلّقة", cls: "bg-gold/40 text-ink" },
  expired: { label: "دعوة منتهية", cls: "bg-sand/70 text-gray" },
};

export function StatusChip({ status }: { status: RowStatus }) {
  const s = STATUS[status];
  return (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 font-sans text-[10.5px] font-semibold ${s.cls}`}>
      {s.label}
    </span>
  );
}

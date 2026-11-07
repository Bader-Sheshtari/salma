/**
 * «تحرير جمال» — admin-only provenance chip for articles written by the Jamal
 * editorial agent. Presence is derived from a jamal_runs row linked to the
 * content id (persistent provenance), so the badge survives human edits,
 * approval and publication. Rendered ONLY in the admin dashboard — no public
 * component imports it.
 */
export default function JamalBadge({ className }: { className?: string }) {
  return (
    <span
      className={`shrink-0 rounded-md bg-blue/10 px-2 py-0.5 font-sans text-[11px] font-bold text-blue ${className ?? ""}`}
    >
      تحرير جمال
    </span>
  );
}

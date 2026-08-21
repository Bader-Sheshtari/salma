// radar-rank bounded-work helpers — pure, unit-tested (reliability fix 2026-08-21).

/**
 * Resolve the number of rows a single run may pull.
 *
 * A caller-supplied `limit` may only LOWER the per-run maximum; it can never
 * request an unbounded (or larger) batch. Non-integer / non-positive input
 * falls back to the server maximum. This is what prevents a caller (or a bug)
 * from re-introducing the oversized run that caused the 504 storm.
 */
export function resolveRowCap(requested: unknown, maxPerRun: number): number {
  const n = Number(requested);
  return Number.isInteger(n) && n > 0 ? Math.min(n, maxPerRun) : maxPerRun;
}

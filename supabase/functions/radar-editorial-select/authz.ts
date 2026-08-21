// ESL authorization + cap safety — pure helpers (P0 security fix, 2026-08-21).
//
// The ESL is an INTERNAL operational function, not a public API. It is invoked
// only by the pg_cron wrapper run_esl() (which sends the internal cron secret)
// — never by browsers. verify_jwt=true at the gateway is satisfied by ANY
// valid project JWT including the public anon key, so real authorization is
// this in-code shared-secret check, the same x-ingest-secret / INGEST_SECRET
// pattern ingest-news has enforced since launch.

/** True only when a non-empty server secret exists and the caller presented it. */
export function isAuthorizedInternal(provided: string | null, secret: string): boolean {
  return secret.length > 0 && provided !== null && provided === secret;
}

/**
 * Resolve the effective daily cap for a run.
 *
 * SERVER-SIDE HARD MAXIMUM = `dailyCap` (env ESL_DAILY_CAP, default 8).
 * A caller-provided cap may only LOWER the cap (bounded test/shadow runs);
 * it can never raise it above the server-configured daily cap. Anything
 * non-integer or non-positive falls back to the daily cap.
 */
export function resolveCap(requested: unknown, dailyCap: number): number {
  const n = Number(requested);
  return Number.isInteger(n) && n > 0 ? Math.min(n, dailyCap) : dailyCap;
}

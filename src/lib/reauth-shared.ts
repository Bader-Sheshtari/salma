/**
 * Sensitive-action re-auth protocol (U3) — client-safe half. A gated server
 * action returns NEEDS_REAUTH instead of acting; the client shows the re-auth
 * modal, calls performReauth, then retries the original action once.
 */
export type NeedsReauth = { needsReauth: true };

export const NEEDS_REAUTH: NeedsReauth = { needsReauth: true };

export function isNeedsReauth(v: unknown): v is NeedsReauth {
  return !!v && typeof v === "object" && (v as { needsReauth?: unknown }).needsReauth === true;
}

/** Recent-auth window (server-enforced in lib/reauth.ts). */
export const REAUTH_WINDOW_MINUTES = 15;

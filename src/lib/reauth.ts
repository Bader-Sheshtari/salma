import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { UUID_RE, serviceDb } from "@/lib/admin-links";
import { NEEDS_REAUTH, REAUTH_WINDOW_MINUTES, type NeedsReauth } from "@/lib/reauth-shared";

/**
 * Sensitive-action re-auth (U3), server half. A successful performReauth
 * records (session_id, user_id, verified_at) in public.session_reauth (service
 * only, via record_reauth). Gated actions call requireRecentAuth: no row for
 * THIS session within the window → NEEDS_REAUTH. Keyed by the verified JWT's
 * session_id, so another device / a new login always re-verifies.
 */

/**
 * The current session id from the verified JWT claims (same pattern as
 * changeOwnPassword): only when `sub` matches the expected user and the id is a
 * UUID; otherwise null.
 */
export async function getSessionId(
  userId: string,
  supabase?: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  try {
    const client = supabase ?? (await createClient());
    const { data } = await client.auth.getClaims();
    const claims = data?.claims as { sub?: string; session_id?: string } | undefined;
    const sessionId = claims?.sub === userId ? claims.session_id : undefined;
    return sessionId && UUID_RE.test(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

/** True when this session completed re-auth within the last 15 minutes. */
export async function hasRecentAuth(userId: string): Promise<boolean> {
  const sessionId = await getSessionId(userId);
  if (!sessionId) return false;
  const since = new Date(Date.now() - REAUTH_WINDOW_MINUTES * 60_000).toISOString();
  const { data, error } = await (serviceDb() as SupabaseClient)
    .from("session_reauth")
    .select("session_id")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .gt("verified_at", since)
    .maybeSingle();
  if (error) {
    console.error("[reauth] session_reauth read failed:", error.message);
    return false; // fail closed: the user is asked to re-verify
  }
  return !!data;
}

/** Gate for sensitive actions: null = proceed; NEEDS_REAUTH = early-return it. */
export async function requireRecentAuth(profile: { id: string }): Promise<NeedsReauth | null> {
  return (await hasRecentAuth(profile.id)) ? null : NEEDS_REAUTH;
}

/** Record a completed re-auth for this session (service-only RPC). */
export async function recordReauth(userId: string, sessionId: string): Promise<boolean> {
  const { error } = await serviceDb().rpc("record_reauth", { p_user: userId, p_session: sessionId });
  if (error) console.error("[reauth] record_reauth failed:", error.message);
  return !error;
}

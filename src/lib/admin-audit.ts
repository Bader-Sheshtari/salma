import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { UUID_RE, serviceDb } from "@/lib/admin-links";

/**
 * admin_audit_log writers for U3 security events (same RPC + semantics as the
 * private helpers in user-actions.ts). Best-effort: never throw, never block.
 * NEVER pass secrets, codes, passwords or tokens in any field.
 */
export type AuditArgs = {
  action: string;
  target?: string | null;
  targetEmail?: string | null;
  before?: string | null;
  after?: string | null;
  details?: Record<string, unknown> | null;
};

function auditParams(a: AuditArgs) {
  return {
    p_action: a.action,
    p_target: a.target ?? null,
    p_target_email: a.targetEmail ?? null,
    p_before: a.before ?? null,
    p_after: a.after ?? null,
    p_details: a.details ?? null,
  };
}

/** Audit as the signed-in actor (auth.uid()). */
export async function auditAsUser(a: AuditArgs): Promise<void> {
  try {
    const db = (await createClient()) as unknown as SupabaseClient;
    const { error } = await db.rpc("log_admin_event", auditParams(a));
    if (error) console.error(`[security] log_admin_event(${a.action}) failed:`, error.message);
  } catch (e) {
    console.error(`[security] log_admin_event(${a.action}) threw:`, e);
  }
}

/** Audit via the service client, attributed to `actor`. */
export async function auditAsService(a: AuditArgs, actor: string | null): Promise<void> {
  try {
    const { error } = await serviceDb().rpc("log_admin_event", { ...auditParams(a), p_actor: actor });
    if (error) console.error(`[security] log_admin_event(${a.action}) failed:`, error.message);
  } catch (e) {
    console.error(`[security] log_admin_event(${a.action}) threw:`, e);
  }
}

/** Record a refused management attempt (log_admin_denied). */
export async function auditDenied(action: string, targetId: string | null, detail: string): Promise<void> {
  try {
    const db = (await createClient()) as unknown as SupabaseClient;
    const { error } = await db.rpc("log_admin_denied", {
      p_action: action,
      p_target: targetId && UUID_RE.test(targetId) ? targetId : null,
      p_detail: detail,
    });
    if (error) console.error("[security] log_admin_denied failed:", error.message);
  } catch (e) {
    console.error("[security] log_admin_denied threw:", e);
  }
}

/**
 * Revoke a user's sessions (optionally keeping one) via the service-only RPC.
 * Returns the number of refresh tokens revoked, or null on failure.
 */
export async function revokeSessions(userId: string, keepSessionId: string | null): Promise<number | null> {
  try {
    const { data, error } = await serviceDb().rpc("revoke_user_sessions", {
      p_user_id: userId,
      p_keep_session_id: keepSessionId,
    });
    if (error) {
      console.error("[security] revoke_user_sessions failed:", error.message);
      return null;
    }
    return typeof data === "number" ? data : Number(data ?? 0) || 0;
  } catch (e) {
    console.error("[security] revoke_user_sessions threw:", e);
    return null;
  }
}

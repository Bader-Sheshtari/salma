import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { canAssignRole, canManageTarget } from "@/lib/roles";

/**
 * U2 one-time links (staff invitations + password resets).
 *
 * The plain token (32 random bytes, base64url) exists only in the URL handed to
 * the authorized manager — once, in the create/reissue/reset action response.
 * The DB (admin_invitations) stores only its sha256 hex. Validation is done by
 * the service-role-only RPC consume_admin_link (non-destructive: it never burns
 * the link; finalize_admin_link does). GoTrue stays the only authority for
 * accounts, passwords and sessions. Never log a token.
 *
 * The RPCs / table are not in the generated Database types until regenerated →
 * narrow local types + an untyped client cast (prior-phase pattern).
 */

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const RESET_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (tighter secret)

export type LinkKind = "invite" | "reset";
export type LinkFailReason = "expired" | "used" | "cancelled" | "not_found";

export type ConsumedLink = {
  ok: true;
  id: string;
  kind: LinkKind;
  email: string;
  role: string | null;
  target_user_id: string | null;
  invited_by: string | null;
};
export type ConsumeResult = ConsumedLink | { ok: false; reason: LinkFailReason };

/** Row shape returned by list_invitations() (every column except token_hash). */
export type InvitationRow = {
  id: string;
  kind: LinkKind;
  email: string;
  role: string | null;
  target_user_id: string | null;
  invited_by: string | null;
  invited_by_name: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  cancelled_at: string | null;
  superseded_by: string | null;
  accepted_user_id: string | null;
};

/** Untyped service-role client (admin_invitations + U2 RPCs are not in the generated types yet). */
export function serviceDb(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient;
}

/** 32 random bytes → base64url (43 chars, no padding). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 hex — must match the RPC's encode(digest(p_token_plain, 'sha256'), 'hex'). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Cheap shape check before touching the DB (generated tokens are exactly 43 base64url chars). */
export function isTokenShape(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LINK_FAIL_MESSAGE: Record<LinkFailReason, string> = {
  expired: "انتهت صلاحية هذا الرابط. اطلب من المسؤول رابطاً جديداً.",
  used: "تم استخدام هذا الرابط من قبل. إن كان لديك حساب فسجّل الدخول.",
  cancelled: "أُلغي هذا الرابط أو استُبدل برابط أحدث. اطلب من المسؤول رابطاً جديداً.",
  not_found: "الرابط غير صالح. تأكّد من نسخه كاملاً أو اطلب رابطاً جديداً.",
};

/**
 * Validate a plain token via consume_admin_link (service role). Non-destructive:
 * safe for page "peeks". Any malformed token / RPC error → not_found.
 */
export async function consumeLink(token: unknown, kind: LinkKind): Promise<ConsumeResult> {
  if (!isTokenShape(token)) return { ok: false, reason: "not_found" };
  const { data, error } = await serviceDb().rpc("consume_admin_link", { p_token_plain: token });
  if (error || !data || typeof data !== "object") {
    if (error) console.error("[links] consume_admin_link failed:", error.message);
    return { ok: false, reason: "not_found" };
  }
  const r = data as Partial<ConsumedLink> & { ok?: boolean; reason?: string };
  if (!r.ok) {
    const reason = (["expired", "used", "cancelled"] as const).find((x) => x === r.reason);
    return { ok: false, reason: reason ?? "not_found" };
  }
  // A token of the other kind is reported as simply invalid on this route.
  if (r.kind !== kind || !r.id || !r.email) return { ok: false, reason: "not_found" };
  return {
    ok: true,
    id: String(r.id),
    kind,
    email: String(r.email).toLowerCase(),
    role: r.role ? String(r.role) : null,
    target_user_id: r.target_user_id ? String(r.target_user_id) : null,
    invited_by: r.invited_by ? String(r.invited_by) : null,
  };
}

/** b***@dawi.com — enough for the holder to recognise their account. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local[0]}***@${domain}`;
}

/**
 * Why a (valid) invite link can't be accepted right now, or null when it can.
 * Shared by the accept page (peek) and acceptInvitation (authoritative):
 *  - the role must be an invitable staff role;
 *  - the inviter must still be an active manager allowed to grant that role
 *    (a suspended/demoted manager's open invites stop working);
 *  - the email must not belong to any account (suspended → refused: suspension
 *    authority; active → sign in instead).
 */
export async function inviteBlocker(link: ConsumedLink): Promise<string | null> {
  const role = link.role ?? "";
  if (!["editor", "admin", "super_admin"].includes(role)) return LINK_FAIL_MESSAGE.not_found;
  const db = serviceDb();

  // Fail closed: a link whose issuer is gone (invited_by nulled by ON DELETE
  // SET NULL) is treated as cancelled — never skip the issuer re-check.
  if (!link.invited_by) return LINK_FAIL_MESSAGE.cancelled;
  {
    const { data } = await db
      .from("profiles")
      .select("role, disabled")
      .eq("id", link.invited_by)
      .maybeSingle();
    const inviter = data as { role: string; disabled: boolean } | null;
    if (!inviter || inviter.disabled || !canAssignRole(inviter.role, role)) {
      return LINK_FAIL_MESSAGE.cancelled;
    }
  }

  const { data: existing } = await db
    .from("profiles")
    .select("id, disabled")
    .ilike("email", likeExact(link.email))
    .limit(1)
    .maybeSingle();
  const p = existing as { id: string; disabled: boolean } | null;
  if (p) {
    return p.disabled
      ? "الحساب موقوف — تواصل مع المسؤول."
      : "يوجد حساب بهذا البريد بالفعل — سجّل الدخول.";
  }
  return null;
}

/** Escape LIKE wildcards so an email containing "_" or "%" matches only itself. */
export function likeExact(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Why a (valid) reset link can't be completed, or null when it can. Shared by
 * the reset page (peek) and completeReset (authoritative): the target must
 * exist and never be the owner (owner wall), and the manager who issued the
 * link must still be active and still allowed to manage the target (e.g. not
 * after the target was promoted beyond their reach). `disabled` is NOT checked
 * here on purpose — a suspended account may set a password but stays locked.
 */
export async function resetBlocker(link: ConsumedLink): Promise<string | null> {
  if (!link.target_user_id) return LINK_FAIL_MESSAGE.not_found;
  const db = serviceDb();
  const { data } = await db
    .from("profiles")
    .select("id, role")
    .eq("id", link.target_user_id)
    .maybeSingle();
  const target = data as { id: string; role: string } | null;
  if (!target || target.role === "owner") return LINK_FAIL_MESSAGE.not_found;

  if (!link.invited_by) return LINK_FAIL_MESSAGE.cancelled; // fail closed (issuer deleted)
  {
    const { data: m } = await db
      .from("profiles")
      .select("id, role, disabled")
      .eq("id", link.invited_by)
      .maybeSingle();
    const issuer = m as { id: string; role: string; disabled: boolean } | null;
    if (!issuer || issuer.disabled || !canManageTarget(issuer, target)) {
      return LINK_FAIL_MESSAGE.cancelled;
    }
  }
  return null;
}

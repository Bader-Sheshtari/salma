"use server";

/**
 * U2 account flows: invitations, one-time reset links, invite acceptance,
 * reset completion, and the «حسابي» self-service (profile + password).
 *
 * Security model:
 *  - Manager actions (invite / reissue / cancel / reset-link) re-check
 *    requireAdmin + isManagerRole + assignableRoles / canManageTarget server-side.
 *  - The plain token is generated here and returned ONLY in the create/reissue/
 *    reset-link response to the authorized manager. It is never stored (DB keeps
 *    sha256), never logged, never put in the audit log.
 *  - acceptInvitation / completeReset are PUBLIC (no session): every input is
 *    validated here; the link is checked by the service-only RPC
 *    consume_admin_link and burned by finalize_admin_link only after success.
 *  - Suspension authority: acceptance refuses emails of suspended profiles;
 *    reset never touches `disabled` / the auth ban, so a suspended account stays
 *    locked out (login + requireStaff refuse it).
 *  - Audit: manager/self events go through the user-session RPC log_admin_event
 *    (actor = auth.uid()); public flows use the service client with p_actor.
 *
 * U2 tables/RPCs are not in the generated Database types yet → untyped casts.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient as createBareClient, type SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin, requireStaff, isManagerRole, type Profile } from "@/lib/auth";
import { canAssignRole, canManageTarget } from "@/lib/roles";
import { absoluteUrl } from "@/lib/site";
import { passwordError } from "@/lib/passwords";
import {
  INVITE_TTL_MS,
  RESET_TTL_MS,
  LINK_FAIL_MESSAGE,
  UUID_RE,
  consumeLink,
  generateToken,
  hashToken,
  inviteBlocker,
  resetBlocker,
  likeExact,
  serviceDb,
  type InvitationRow,
} from "@/lib/admin-links";

export type LinkResult =
  | { ok: true; link: string; expiresAt: string; email: string; kind: "invite" | "reset" }
  | { error: string };

export type FlowResult = { ok: string } | { error: string } | null;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* ─────────────────────────────── helpers ─────────────────────────────── */

async function userDb(): Promise<SupabaseClient> {
  return (await createClient()) as unknown as SupabaseClient;
}

function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

type AuditArgs = {
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

/** Audit as the signed-in actor (auth.uid()). Best-effort; never throws. */
async function logAsUser(a: AuditArgs): Promise<void> {
  try {
    const { error } = await (await userDb()).rpc("log_admin_event", auditParams(a));
    if (error) console.error(`[users] log_admin_event(${a.action}) failed:`, error.message);
  } catch (e) {
    console.error(`[users] log_admin_event(${a.action}) threw:`, e);
  }
}

/** Audit from a public (session-less) flow, attributed to `actor`. Best-effort. */
async function logAsService(a: AuditArgs, actor: string | null): Promise<void> {
  try {
    const { error } = await serviceDb().rpc("log_admin_event", { ...auditParams(a), p_actor: actor });
    if (error) console.error(`[users] log_admin_event(${a.action}) failed:`, error.message);
  } catch (e) {
    console.error(`[users] log_admin_event(${a.action}) threw:`, e);
  }
}

/** Record a refused management attempt (same RPC as actions.ts). Best-effort. */
async function logDenied(action: string, targetId: string | null, detail: string): Promise<void> {
  try {
    const { error } = await (await userDb()).rpc("log_admin_denied", {
      p_action: action,
      p_target: targetId && UUID_RE.test(targetId) ? targetId : null,
      p_detail: detail,
    });
    if (error) console.error("[users] log_admin_denied failed:", error.message);
  } catch (e) {
    console.error("[users] log_admin_denied threw:", e);
  }
}

async function requireManager(action: string, targetId: string | null): Promise<Profile | null> {
  const actor = await requireAdmin();
  if (!isManagerRole(actor.role)) {
    await logDenied(action, targetId, "actor is not a manager");
    return null;
  }
  return actor;
}

type ProfileLite = { id: string; role: string; email: string | null; disabled: boolean };

async function findProfileByEmail(email: string): Promise<ProfileLite | null> {
  const { data } = await serviceDb()
    .from("profiles")
    .select("id, role, email, disabled")
    .ilike("email", likeExact(email))
    .limit(1)
    .maybeSingle();
  return (data as ProfileLite | null) ?? null;
}

/** Message when an email already belongs to an account (or null when free). */
function existingAccountError(p: ProfileLite | null): string | null {
  if (!p) return null;
  return p.disabled
    ? "هذا البريد لحساب موقوف — أعد تفعيله من قائمة الحسابات بدلاً من دعوته."
    : "يوجد حساب بهذا البريد.";
}

/** Open invites (not accepted / cancelled / superseded) for an email. */
async function openInvitesFor(email: string): Promise<InvitationRow[]> {
  const { data } = await serviceDb()
    .from("admin_invitations")
    .select(
      "id, kind, email, role, target_user_id, invited_by, invited_by_name, created_at, expires_at, accepted_at, cancelled_at, superseded_by, accepted_user_id",
    )
    .eq("kind", "invite")
    .eq("email", email)
    .is("accepted_at", null)
    .is("cancelled_at", null)
    .is("superseded_by", null);
  return (data as InvitationRow[] | null) ?? [];
}

async function getInvitation(id: string): Promise<InvitationRow | null> {
  if (!UUID_RE.test(id)) return null;
  const { data } = await serviceDb()
    .from("admin_invitations")
    .select(
      "id, kind, email, role, target_user_id, invited_by, invited_by_name, created_at, expires_at, accepted_at, cancelled_at, superseded_by, accepted_user_id",
    )
    .eq("id", id)
    .maybeSingle();
  return (data as InvitationRow | null) ?? null;
}

/** Insert a link row (hash only) and return its id + the plain token. */
async function insertLink(row: {
  kind: "invite" | "reset";
  email: string;
  role: string | null;
  target_user_id: string | null;
  actor: Profile;
  ttlMs: number;
}): Promise<
  { ok: true; id: string; token: string; expiresAt: string } | { ok: false; conflict: boolean }
> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + row.ttlMs).toISOString();
  const { data, error } = await serviceDb()
    .from("admin_invitations")
    .insert({
      kind: row.kind,
      email: row.email,
      role: row.role,
      target_user_id: row.target_user_id,
      token_hash: hashToken(token),
      invited_by: row.actor.id,
      invited_by_name: row.actor.full_name?.trim() || row.actor.email,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error || !data) {
    // 23505 = unique violation on the one-open-link partial indexes.
    const conflict = (error as { code?: string } | null)?.code === "23505";
    if (!conflict) console.error("[users] admin_invitations insert failed:", error?.message ?? "no row");
    return { ok: false, conflict };
  }
  return { ok: true, id: String((data as { id: string }).id), token, expiresAt };
}

/**
 * Cancel still-open rows BEFORE inserting their replacement (the one-open-link
 * partial unique indexes ignore cancelled rows). Returns the ids actually
 * cancelled by this call.
 */
async function cancelOpenRows(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { data, error } = await serviceDb()
    .from("admin_invitations")
    .update({ cancelled_at: new Date().toISOString() })
    .in("id", ids)
    .is("accepted_at", null)
    .is("cancelled_at", null)
    .select("id");
  if (error) console.error("[users] cancelOpenRows failed:", error.message);
  return ((data as { id: string }[] | null) ?? []).map((r) => r.id);
}

/** The replacement insert failed: re-open the rows we just cancelled. */
async function restoreRows(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await serviceDb()
    .from("admin_invitations")
    .update({ cancelled_at: null })
    .in("id", ids)
    .is("accepted_at", null)
    .is("superseded_by", null);
  if (error) console.error("[users] restoreRows failed:", error.message);
}

/** Point cancelled rows at the row that replaced them (history only). */
async function linkSuperseded(ids: string[], newId: string): Promise<void> {
  if (!ids.length) return;
  const { error } = await serviceDb()
    .from("admin_invitations")
    .update({ superseded_by: newId })
    .in("id", ids);
  if (error) console.error("[users] linkSuperseded failed:", error.message);
}

const PENDING_INVITE_MSG = "توجد دعوة قيد الانتظار لهذا البريد — أعد إصدارها بدلًا من ذلك";

const inviteLink = (token: string) => absoluteUrl(`/admin/accept-invite?token=${token}`);
const resetLink = (token: string) => absoluteUrl(`/admin/reset-password?token=${token}`);

/* ──────────────────────────── manager actions ──────────────────────────── */

/** Invite a new staff member. Returns the one-time link (shown once). */
export async function createInvitation(emailIn: unknown, roleIn: unknown): Promise<LinkResult> {
  const role = str(roleIn, 40);
  const actor = await requireManager("invite_user", null);
  if (!actor) return { error: "لا تملك صلاحية دعوة مستخدمين." };

  const email = str(emailIn, 320).trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: "أدخل بريداً إلكترونياً صحيحاً." };
  if (!canAssignRole(actor.role, role)) {
    await logDenied("invite_user", null, `role=${role}`);
    return { error: "لا تملك صلاحية تعيين هذا الدور." };
  }

  const existing = existingAccountError(await findProfileByEmail(email));
  if (existing) return { error: existing };

  // Any open invite for this email is replaced — but only if the actor could
  // manage it (a super_admin can't silently cancel the owner's super_admin invite).
  const open = await openInvitesFor(email);
  if (open.some((i) => !canAssignRole(actor.role, i.role ?? ""))) {
    await logDenied("invite_user", null, "open invite outside actor's scope");
    return { error: "توجد دعوة قائمة لهذا البريد بإدارة المالك." };
  }

  // Order matters: cancel the old open rows first (the unique index allows one
  // open invite per email), then insert, then link superseded_by.
  const cancelled = await cancelOpenRows(open.map((i) => i.id));
  const created = await insertLink({
    kind: "invite",
    email,
    role,
    target_user_id: null,
    actor,
    ttlMs: INVITE_TTL_MS,
  });
  if (!created.ok) {
    await restoreRows(cancelled);
    return { error: created.conflict ? PENDING_INVITE_MSG : "تعذّر إنشاء الدعوة." };
  }
  await linkSuperseded(cancelled, created.id);
  const replaced = cancelled.length;

  await logAsUser({
    action: "invitation_created",
    targetEmail: email,
    after: role,
    details: { invitation_id: created.id, expires_at: created.expiresAt, replaced: replaced || undefined },
  });

  revalidatePath("/admin/users");
  return { ok: true, link: inviteLink(created.token), expiresAt: created.expiresAt, email, kind: "invite" };
}

/** Replace an open (pending or expired) invitation with a fresh link. */
export async function reissueInvitation(invitationIdIn: unknown): Promise<LinkResult> {
  const invitationId = str(invitationIdIn, 64);
  const actor = await requireManager("reissue_invitation", null);
  if (!actor) return { error: "لا تملك صلاحية." };

  const inv = await getInvitation(invitationId);
  if (!inv || inv.kind !== "invite") return { error: "الدعوة غير موجودة." };
  if (inv.accepted_at) return { error: "قُبلت هذه الدعوة بالفعل." };
  if (inv.cancelled_at || inv.superseded_by) return { error: "أُلغيت هذه الدعوة." };
  if (!canAssignRole(actor.role, inv.role ?? "")) {
    await logDenied("reissue_invitation", null, `role=${inv.role}`);
    return { error: "لا تملك صلاحية على هذه الدعوة." };
  }
  const existing = existingAccountError(await findProfileByEmail(inv.email));
  if (existing) return { error: existing };

  // Cancel the old row first (frees the one-open-invite slot); a 0-row result
  // means it was accepted/cancelled concurrently.
  const cancelled = await cancelOpenRows([inv.id]);
  if (!cancelled.length) return { error: "تغيّرت حالة الدعوة — حدّث الصفحة." };
  const created = await insertLink({
    kind: "invite",
    email: inv.email,
    role: inv.role,
    target_user_id: null,
    actor,
    ttlMs: INVITE_TTL_MS,
  });
  if (!created.ok) {
    await restoreRows(cancelled);
    return { error: created.conflict ? PENDING_INVITE_MSG : "تعذّر إعادة إصدار الدعوة." };
  }
  await linkSuperseded(cancelled, created.id);

  await logAsUser({
    action: "invitation_reissued",
    targetEmail: inv.email,
    after: inv.role,
    details: { invitation_id: created.id, replaced_id: inv.id, expires_at: created.expiresAt },
  });

  revalidatePath("/admin/users");
  return {
    ok: true,
    link: inviteLink(created.token),
    expiresAt: created.expiresAt,
    email: inv.email,
    kind: "invite",
  };
}

/** Cancel an open invitation (its link stops working immediately). */
export async function cancelInvitation(invitationIdIn: unknown): Promise<FlowResult> {
  const invitationId = str(invitationIdIn, 64);
  const actor = await requireManager("cancel_invitation", null);
  if (!actor) return { error: "لا تملك صلاحية." };

  const inv = await getInvitation(invitationId);
  if (!inv || inv.kind !== "invite") return { error: "الدعوة غير موجودة." };
  if (inv.accepted_at) return { error: "قُبلت هذه الدعوة بالفعل." };
  if (inv.cancelled_at || inv.superseded_by) return { ok: "الدعوة ملغاة بالفعل." };
  if (!canAssignRole(actor.role, inv.role ?? "")) {
    await logDenied("cancel_invitation", null, `role=${inv.role}`);
    return { error: "لا تملك صلاحية على هذه الدعوة." };
  }

  const { data, error } = await serviceDb()
    .from("admin_invitations")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("id", inv.id)
    .is("accepted_at", null)
    .is("cancelled_at", null)
    .select("id");
  if (error || !(data as unknown[] | null)?.length) return { error: "تعذّر إلغاء الدعوة." };

  await logAsUser({
    action: "invitation_cancelled",
    targetEmail: inv.email,
    before: inv.role,
    details: { invitation_id: inv.id },
  });

  revalidatePath("/admin/users");
  return { ok: "أُلغيت الدعوة." };
}

/**
 * One-time password-reset link (24h) for a manageable account — active or
 * suspended (completing it never reactivates). Supersedes older open reset
 * links for the same account. Replaces the retired manager-typed password.
 */
export async function createResetLink(userIdIn: unknown): Promise<LinkResult> {
  const userId = str(userIdIn, 64);
  const actor = await requireManager("reset_password", userId);
  if (!actor) return { error: "لا تملك صلاحية." };
  if (!UUID_RE.test(userId)) return { error: "الحساب غير موجود." };

  const { data } = await serviceDb()
    .from("profiles")
    .select("id, role, email, disabled")
    .eq("id", userId)
    .maybeSingle();
  const target = data as ProfileLite | null;
  if (!target || !target.email) return { error: "الحساب غير موجود." };
  if (!canManageTarget(actor, target)) {
    await logDenied("reset_password", userId, `target_role=${target.role}`);
    return { error: "لا تملك صلاحية على هذا الحساب." };
  }

  const { data: openRows } = await serviceDb()
    .from("admin_invitations")
    .select("id")
    .eq("kind", "reset")
    .eq("target_user_id", target.id)
    .is("accepted_at", null)
    .is("cancelled_at", null)
    .is("superseded_by", null);

  const email = target.email.toLowerCase();
  const cancelled = await cancelOpenRows(((openRows as { id: string }[] | null) ?? []).map((r) => r.id));
  const created = await insertLink({
    kind: "reset",
    email,
    role: null,
    target_user_id: target.id,
    actor,
    ttlMs: RESET_TTL_MS,
  });
  if (!created.ok) {
    await restoreRows(cancelled);
    return {
      error: created.conflict
        ? "يوجد رابط إعادة تعيين قيد الإنشاء لهذا الحساب — حاول مرة أخرى."
        : "تعذّر إنشاء رابط إعادة التعيين.",
    };
  }
  await linkSuperseded(cancelled, created.id);

  await logAsUser({
    action: "password_reset_link_created",
    target: target.id,
    targetEmail: email,
    details: {
      invitation_id: created.id,
      expires_at: created.expiresAt,
      target_disabled: target.disabled || undefined,
    },
  });

  revalidatePath("/admin/users");
  return { ok: true, link: resetLink(created.token), expiresAt: created.expiresAt, email, kind: "reset" };
}

/* ───────────────────────────── public flows ───────────────────────────── */

const NAME_MAX = 80;

function cleanName(v: unknown): string {
  return str(v, 400).replace(/\s+/g, " ").trim();
}

/** Arabic-Indic → Latin digits, keep + digits spaces dashes. "" → null. */
function cleanPhone(v: unknown): { phone: string | null } | { error: string } {
  const raw = str(v, 100)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return { phone: null };
  if (!/^\+?[0-9][0-9 -]{5,22}$/.test(raw)) return { error: "رقم الهاتف غير صالح." };
  return { phone: raw };
}

/**
 * Undo a just-created account. If deleting it fails, make sure it cannot be
 * used: demote the profile to role=user + disabled and ban the auth user.
 */
async function rollbackNewUser(db: SupabaseClient, userId: string): Promise<void> {
  const { error: delErr } = await db.auth.admin.deleteUser(userId);
  if (!delErr) return;
  console.warn("[users] rollback deleteUser failed; locking account instead:", delErr.message);
  const { error: profErr } = await db
    .from("profiles")
    .update({ role: "user", disabled: true })
    .eq("id", userId);
  if (profErr) console.error("[users] rollback profile lock failed:", profErr.message);
  const { error: banErr } = await db.auth.admin.updateUserById(userId, { ban_duration: "87600h" });
  if (banErr) console.error("[users] rollback ban failed:", banErr.message);
}

/**
 * PUBLIC — accept an invitation: create the auth user (GoTrue) with the chosen
 * password, burn the link, then set role/name/phone on the profile and send the
 * user to the login page to sign in with the password they just chose (no
 * server-side session minting).
 */
export async function acceptInvitation(
  tokenIn: unknown,
  fullNameIn: unknown,
  phoneIn: unknown,
  passwordIn: unknown,
  confirmIn: unknown,
): Promise<FlowResult> {
  const fullName = cleanName(fullNameIn);
  if (fullName.length < 2 || fullName.length > NAME_MAX) {
    return { error: `أدخل اسمك الكامل (2–${NAME_MAX} حرفاً).` };
  }
  const phone = cleanPhone(phoneIn);
  if ("error" in phone) return phone;

  const link = await consumeLink(tokenIn, "invite");
  if (!link.ok) return { error: LINK_FAIL_MESSAGE[link.reason] };
  const blocked = await inviteBlocker(link);
  if (blocked) return { error: blocked };
  const role = link.role as string;

  const pwErr = passwordError(passwordIn, confirmIn, { email: link.email });
  if (pwErr) return { error: pwErr };
  const password = passwordIn as string;

  const db = serviceDb();
  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email: link.email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (createErr || !created?.user) {
    // Link stays usable (not finalized).
    if (/registered|already|exists/i.test(createErr?.message ?? "")) {
      return { error: "يوجد حساب بهذا البريد بالفعل — سجّل الدخول." };
    }
    if (/weak|password/i.test(createErr?.message ?? "")) {
      return { error: "رفض النظام كلمة المرور — اختر كلمة أقوى." };
    }
    console.error("[users] acceptInvitation createUser failed:", createErr?.message ?? "no user");
    return { error: "تعذّر إنشاء الحساب. حاول مرة أخرى." };
  }
  const userId = created.user.id;

  // Burn the link FIRST, while the new account is still a plain role=user
  // profile (from handle_new_user). Only a successful finalize may lead to
  // elevation, so a cancelled/superseded/raced link can never yield staff access.
  const { data: finalized, error: finErr } = await db.rpc("finalize_admin_link", {
    p_id: link.id,
    p_accepted_user: userId,
  });
  if (finErr || finalized !== true) {
    console.error("[users] finalize_admin_link refused:", finErr?.message ?? "not pending");
    await rollbackNewUser(db, userId);
    return { error: LINK_FAIL_MESSAGE.cancelled };
  }

  // Now elevate (service write — the guard allows it; the audit trigger
  // attributes it via created_by).
  const { error: updErr } = await db
    .from("profiles")
    .update({ role, full_name: fullName, phone: phone.phone, created_by: link.invited_by })
    .eq("id", userId);
  if (updErr) {
    console.error("[users] acceptInvitation profile update failed:", updErr.message);
    await rollbackNewUser(db, userId);
    return { error: "تعذّر إعداد الحساب. حاول مرة أخرى." };
  }

  await logAsService(
    {
      action: "invitation_accepted",
      target: userId,
      targetEmail: link.email,
      after: role,
      details: { invitation_id: link.id },
    },
    userId,
  );

  revalidatePath("/admin/users");
  redirect("/admin/login?accepted=1");
}

/**
 * PUBLIC — complete a password reset. Sets the password via GoTrue admin API,
 * burns the link, signs the account out everywhere. Never touches `disabled`
 * or the auth ban: a suspended account gets a new password but stays locked.
 */
export async function completeReset(
  tokenIn: unknown,
  passwordIn: unknown,
  confirmIn: unknown,
): Promise<FlowResult> {
  const link = await consumeLink(tokenIn, "reset");
  if (!link.ok) return { error: LINK_FAIL_MESSAGE[link.reason] };
  if (!link.target_user_id) return { error: LINK_FAIL_MESSAGE.not_found };

  const pwErr = passwordError(passwordIn, confirmIn, { email: link.email });
  if (pwErr) return { error: pwErr };
  const password = passwordIn as string;

  const blocked = await resetBlocker(link);
  if (blocked) return { error: blocked };
  const target = { id: link.target_user_id };

  const db = serviceDb();
  // Burn the link FIRST; only the caller that wins finalize may set the password.
  const { data: finalized, error: finErr } = await db.rpc("finalize_admin_link", {
    p_id: link.id,
    p_accepted_user: target.id,
  });
  if (finErr || finalized !== true) {
    console.error("[users] finalize_admin_link (reset) refused:", finErr?.message ?? "not pending");
    return { error: "الرابط لم يعد صالحًا — اطلب رابطًا جديدًا" };
  }

  const { error: pwSetErr } = await db.auth.admin.updateUserById(target.id, { password });
  if (pwSetErr) {
    // The link is already burned; the manager must issue a new one.
    console.error("[users] completeReset updateUserById failed:", pwSetErr.message);
    if (/weak|password/i.test(pwSetErr.message)) {
      return { error: "رفض النظام كلمة المرور — اطلب رابطًا جديدًا ثم اختر كلمة أقوى." };
    }
    return { error: "تعذّر تعيين كلمة المرور — اطلب رابطًا جديدًا." };
  }

  const { error: revErr } = await db.rpc("revoke_user_sessions", {
    p_user_id: target.id,
    p_keep_session_id: null,
  });
  if (revErr) console.error("[users] revoke_user_sessions (reset) failed:", revErr.message);

  await logAsService(
    {
      action: "password_reset_completed",
      target: target.id,
      targetEmail: link.email,
      details: { invitation_id: link.id },
    },
    target.id,
  );

  redirect("/admin/login?reset=1");
}

/* ───────────────────────────── «حسابي» ───────────────────────────── */

/** Edit own name + phone (role / status / email are not self-editable). */
export async function updateOwnProfile(fullNameIn: unknown, phoneIn: unknown): Promise<FlowResult> {
  const actor = await requireStaff();
  const fullName = cleanName(fullNameIn);
  if (fullName.length < 2 || fullName.length > NAME_MAX) {
    return { error: `أدخل الاسم (2–${NAME_MAX} حرفاً).` };
  }
  const phone = cleanPhone(phoneIn);
  if ("error" in phone) return phone;

  const prevPhone = (actor as Profile & { phone?: string | null }).phone ?? null;
  const nameChanged = fullName !== (actor.full_name ?? "");
  const phoneChanged = phone.phone !== prevPhone;
  if (!nameChanged && !phoneChanged) return { ok: "لا تغييرات." };

  // Own-row write through the user's session (RLS own-update; the guard
  // ignores name/phone; the audit trigger records full_name changes).
  const { data, error } = await (await userDb())
    .from("profiles")
    .update({ full_name: fullName, phone: phone.phone })
    .eq("id", actor.id)
    .select("id");
  if (error || !(data as unknown[] | null)?.length) {
    console.error("[users] updateOwnProfile failed:", error?.message ?? "no row updated (RLS)");
    return { error: "تعذّر حفظ البيانات." };
  }

  // The trigger audits full_name only; log every phone change app-side (no PII in the log).
  if (phoneChanged) {
    await logAsUser({
      action: "profile_updated",
      target: actor.id,
      targetEmail: actor.email,
      details: { fields: nameChanged ? ["full_name", "phone"] : ["phone"] },
    });
  }

  revalidatePath("/admin/account");
  return { ok: "تم حفظ بياناتك." };
}

/**
 * Change own password. Requires the CURRENT password, verified with a bare,
 * non-persisting anon client (so the cookie session is untouched). Then
 * updateUser via the user's session and revoke every other session (keeping
 * the current one, identified by the verified JWT's session_id).
 */
export async function changeOwnPassword(
  currentIn: unknown,
  nextIn: unknown,
  confirmIn: unknown,
): Promise<FlowResult> {
  const actor = await requireStaff();
  const current = str(currentIn, 1000);
  if (!current) return { error: "أدخل كلمة المرور الحالية." };
  const pwErr = passwordError(nextIn, confirmIn, { email: actor.email });
  if (pwErr) return { error: pwErr };
  const next = nextIn as string;
  if (next === current) return { error: "كلمة المرور الجديدة مطابقة للحالية." };
  if (!actor.email) return { error: "تعذّر التحقق من الحساب." };

  // Identify the current session BEFORE anything changes (verified claims).
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const claims = claimsData?.claims as { sub?: string; session_id?: string } | undefined;
  const sessionId = claims?.sub === actor.id ? claims.session_id : undefined;
  if (!sessionId || !UUID_RE.test(sessionId)) {
    return { error: "تعذّر التحقق من الجلسة — سجّل الدخول من جديد." };
  }

  // Verify the current password on a throwaway client (no cookies, no persistence).
  const bare = createBareClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
  const { data: verify, error: verifyErr } = await bare.auth.signInWithPassword({
    email: actor.email,
    password: current,
  });
  if (verifyErr || verify.user?.id !== actor.id) {
    return { error: "كلمة المرور الحالية غير صحيحة." };
  }
  // Drop the verification session right away (also covered by the revoke below).
  await bare.auth.signOut({ scope: "local" }).catch(() => undefined);

  const { error: updErr } = await supabase.auth.updateUser({ password: next });
  if (updErr) {
    const code = (updErr as { code?: string }).code ?? "";
    if (code === "same_password") return { error: "كلمة المرور الجديدة مطابقة للحالية." };
    if (code === "weak_password") return { error: "رفض النظام كلمة المرور — اختر كلمة أقوى." };
    if (code === "reauthentication_needed") {
      return { error: "انتهت مدة الأمان للجلسة — سجّل الخروج ثم الدخول وأعد المحاولة." };
    }
    console.error("[users] changeOwnPassword updateUser failed:", updErr.message);
    return { error: "تعذّر تغيير كلمة المرور." };
  }

  const { error: revErr } = await serviceDb().rpc("revoke_user_sessions", {
    p_user_id: actor.id,
    p_keep_session_id: sessionId,
  });
  if (revErr) console.error("[users] revoke_user_sessions failed:", revErr.message);

  await logAsUser({
    action: "password_changed",
    target: actor.id,
    targetEmail: actor.email,
    details: { other_sessions_revoked: !revErr },
  });

  return {
    ok: revErr
      ? "تم تغيير كلمة مرورك."
      : "تم تغيير كلمة مرورك، وأُنهيت جلساتك على الأجهزة الأخرى.",
  };
}

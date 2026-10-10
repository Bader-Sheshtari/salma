"use server";

/**
 * U3 security actions: sensitive-action re-auth, MFA enrollment audit /
 * self-disable, manager MFA removal, sign-out-everywhere-else, security-log paging.
 *
 * Security model:
 *  - MFA itself is enforced in lib/auth.ts (requireStaff R1) — every action
 *    here inherits it, except recordMfaEnabled (setup flow, requireStaffForMfaSetup).
 *  - Sensitive actions return NEEDS_REAUTH unless THIS session completed
 *    performReauth (password + current TOTP when enrolled) within 15 minutes.
 *  - MFA secrets / codes / passwords are never logged, stored or audited.
 *  - Auth failures return one generic message (no factor / account leaks).
 *
 * U3 tables/RPCs are not in the generated Database types yet → untyped casts.
 */

import { revalidatePath } from "next/cache";
import { createClient as createBareClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  isManagerRole,
  requireAdmin,
  requireStaff,
  requireStaffForMfaSetup,
  getStaffSession,
} from "@/lib/auth";
import { canManageTarget } from "@/lib/roles";
import { UUID_RE, serviceDb } from "@/lib/admin-links";
import { getSessionId, recordReauth, requireRecentAuth } from "@/lib/reauth";
import type { NeedsReauth } from "@/lib/reauth-shared";
import { auditAsUser, auditDenied, revokeSessions } from "@/lib/admin-audit";
import { AUDIT_ACTIONS } from "@/lib/audit-labels";
import {
  listSecurityEvents,
  type SecurityCursor,
  type SecurityEvent,
  type SecurityEventFilters,
} from "@/lib/admin-queries";

export type SecurityResult = { ok: string } | { error: string };

const REAUTH_FAIL = "بيانات التحقق غير صحيحة.";
const CODE_RE = /^[0-9]{6}$/;

/** Arabic-Indic → Latin digits; strip spaces. */
function normalizeCode(v: unknown): string {
  return (typeof v === "string" ? v : "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, "")
    .slice(0, 12);
}

const failDelay = () => new Promise((r) => setTimeout(r, 400));

/* ───────────────────────────── re-auth ───────────────────────────── */

/**
 * Confirm identity for sensitive actions: current password (verified on a
 * bare, non-persisting client — same pattern as changeOwnPassword) and, when
 * the user has a verified TOTP factor, a fresh code verified server-side on
 * the cookie session (re-asserts aal2; @supabase/ssr persists rotated tokens).
 * Success → record_reauth(user, session) + audit; valid ~15 minutes.
 */
export async function performReauth(passwordIn: unknown, codeIn?: unknown): Promise<SecurityResult> {
  const actor = await requireStaff(); // MFA rules (R1) applies
  const session = await getStaffSession(); // memoized — same request read
  const password = typeof passwordIn === "string" ? passwordIn.slice(0, 1000) : "";
  if (!password || !actor.email) return { error: "أدخل كلمة المرور الحالية." };
  const factorIds = session?.mfa.verifiedFactorIds ?? [];
  const code = normalizeCode(codeIn);
  if (factorIds.length && !CODE_RE.test(code)) return { error: "أدخل رمز المصادقة المكوّن من 6 أرقام." };

  const supabase = await createClient();
  const sessionId = await getSessionId(actor.id, supabase);
  if (!sessionId) return { error: "تعذّر التحقق من الجلسة — سجّل الدخول من جديد." };

  // 1. Password (throwaway client: no cookies, no persistence).
  const bare = createBareClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
  const { data: verify, error: verifyErr } = await bare.auth.signInWithPassword({
    email: actor.email,
    password,
  });
  if (verifyErr || verify.user?.id !== actor.id) {
    await failDelay();
    return { error: REAUTH_FAIL };
  }
  await bare.auth.signOut({ scope: "local" }).catch(() => undefined);

  // 2. TOTP on the current (cookie) session, when enrolled.
  if (factorIds.length) {
    let ok = false;
    for (const factorId of factorIds) {
      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
      if (chErr || !ch) continue;
      const { error: vErr } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code });
      if (!vErr) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      await failDelay();
      return { error: REAUTH_FAIL };
    }
  }

  if (!(await recordReauth(actor.id, sessionId))) {
    return { error: "تعذّر تأكيد الهوية — حاول مرة أخرى." };
  }
  await auditAsUser({
    action: "sensitive_reauth_completed",
    target: actor.id,
    targetEmail: actor.email,
    details: { mfa: factorIds.length > 0 },
  });
  return { ok: "تم تأكيد الهوية." };
}

/* ───────────────────────────── own MFA ───────────────────────────── */

/**
 * Post-enrollment hook (the enrollment itself runs in the browser against
 * GoTrue). Verified server-side: the user must now own a verified factor.
 * 'mfa_enabled' / 'mfa_disabled' are owned by the DB trigger on
 * auth.mfa_factors (source of truth) — nothing is audited app-side here.
 */
export async function recordMfaEnabled(): Promise<SecurityResult> {
  const session = await requireStaffForMfaSetup();
  if (!session.mfa.verifiedFactorIds.length) return { error: "لم يكتمل تفعيل المصادقة الثنائية." };
  revalidatePath("/admin/account");
  return { ok: "المصادقة الثنائية مفعّلة" };
}

/**
 * Disable own MFA (re-auth gated: password + current code). Factors are
 * removed server-side (service) only after the gate passes. MFA is optional for
 * every role, so afterwards the user simply has full access without a code.
 */
export async function disableOwnMfa(): Promise<SecurityResult | NeedsReauth> {
  const actor = await requireStaff();
  const gate = await requireRecentAuth(actor);
  if (gate) return gate;

  const db = serviceDb();
  const { data, error } = await db.auth.admin.mfa.listFactors({ userId: actor.id });
  if (error) {
    console.error("[security] disableOwnMfa listFactors failed:", error.message);
    return { error: "تعذّر إلغاء المصادقة الثنائية." };
  }
  const totp = (data?.factors ?? []).filter((f) => f.factor_type === "totp");
  if (!totp.length) return { ok: "المصادقة الثنائية غير مفعّلة." };

  let removed = 0;
  for (const f of totp) {
    const { error: delErr } = await db.auth.admin.mfa.deleteFactor({ id: f.id, userId: actor.id });
    if (delErr) console.error("[security] disableOwnMfa deleteFactor failed:", delErr.message);
    else removed++;
  }
  if (!removed) return { error: "تعذّر إلغاء المصادقة الثنائية." };

  // 'mfa_disabled' is recorded by the DB trigger on auth.mfa_factors (one row
  // per removed verified factor) — no app-side event, to avoid duplicates.
  revalidatePath("/admin/account");
  return { ok: "أُلغيت المصادقة الثنائية." };
}

/* ─────────────────────────── manager: MFA removal ─────────────────────────── */

/**
 * Recovery for a managed user who lost their authenticator: remove every MFA
 * factor of the target (manager + hierarchy + re-auth gated), revoke all their
 * sessions, audit security_setting_changed. No factors → clear no-op message.
 */
export async function removeUserMfa(userIdIn: unknown): Promise<SecurityResult | NeedsReauth> {
  const actor = await requireAdmin();
  const userId = typeof userIdIn === "string" ? userIdIn.slice(0, 64) : "";
  if (!isManagerRole(actor.role)) {
    await auditDenied("remove_user_mfa", userId, "actor is not a manager");
    return { error: "لا تملك صلاحية." };
  }
  if (!UUID_RE.test(userId)) return { error: "الحساب غير موجود." };

  const db = serviceDb();
  const { data: row } = await db.from("profiles").select("id, role, email").eq("id", userId).maybeSingle();
  const target = row as { id: string; role: string; email: string | null } | null;
  if (!target) return { error: "الحساب غير موجود." };
  if (!canManageTarget(actor, target)) {
    await auditDenied("remove_user_mfa", userId, `target_role=${target.role}`);
    return { error: "لا تملك صلاحية على هذا الحساب." };
  }
  const gate = await requireRecentAuth(actor);
  if (gate) return gate;

  const { data, error } = await db.auth.admin.mfa.listFactors({ userId: target.id });
  if (error) {
    console.error("[security] removeUserMfa listFactors failed:", error.message);
    return { error: "تعذّر قراءة إعدادات المصادقة لهذا الحساب." };
  }
  const factors = data?.factors ?? [];
  if (!factors.length) return { ok: "لا توجد مصادقة ثنائية مفعّلة لهذا الحساب — لا شيء لإزالته." };

  let removed = 0;
  for (const f of factors) {
    const { error: delErr } = await db.auth.admin.mfa.deleteFactor({ id: f.id, userId: target.id });
    if (delErr) console.error("[security] removeUserMfa deleteFactor failed:", delErr.message);
    else removed++;
  }
  if (!removed) return { error: "تعذّر إزالة المصادقة الثنائية." };

  const revoked = await revokeSessions(target.id, null);
  await auditAsUser({
    action: "security_setting_changed",
    target: target.id,
    targetEmail: target.email,
    details: { mfa_factors_removed: removed, sessions_revoked: revoked != null },
  });
  revalidatePath("/admin/users");
  return { ok: "أُزيلت المصادقة الثنائية لهذا الحساب وأُنهيت جلساته." };
}

/* ─────────────────────────── sessions ─────────────────────────── */

/** Sign out every OTHER session of the caller (current one kept). Re-auth gated. */
export async function signOutAllDevices(): Promise<SecurityResult | NeedsReauth> {
  const actor = await requireStaff();
  const gate = await requireRecentAuth(actor);
  if (gate) return gate;

  const sessionId = await getSessionId(actor.id);
  if (!sessionId) return { error: "تعذّر التحقق من الجلسة — سجّل الدخول من جديد." };

  const revoked = await revokeSessions(actor.id, sessionId);
  if (revoked == null) return { error: "تعذّر إنهاء الجلسات الأخرى." };

  await auditAsUser({
    action: "sessions_revoked",
    target: actor.id,
    targetEmail: actor.email,
    details: { reason: "user_initiated", revoked },
  });
  revalidatePath("/admin/account");
  return { ok: "تم تسجيل الخروج من جميع الأجهزة الأخرى — بقيت هذه الجلسة مفتوحة." };
}

/* ─────────────────────────── security log paging ─────────────────────────── */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate filter inputs coming from the client (RPC re-validates + scopes). */
function cleanFilters(f: SecurityEventFilters | null | undefined): SecurityEventFilters {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    from: DATE_RE.test(s(f?.from)) ? s(f?.from) : null,
    to: DATE_RE.test(s(f?.to)) ? s(f?.to) : null,
    actor: UUID_RE.test(s(f?.actor)) ? s(f?.actor) : null,
    target: UUID_RE.test(s(f?.target)) ? s(f?.target) : null,
    action: AUDIT_ACTIONS.includes(s(f?.action)) ? s(f?.action) : null,
  };
}

export async function loadMoreSecurityEvents(
  filters: SecurityEventFilters,
  cursor: SecurityCursor,
): Promise<{ events: SecurityEvent[]; hasMore: boolean; error: string | null }> {
  const actor = await requireAdmin();
  if (!isManagerRole(actor.role)) return { events: [], hasMore: false, error: "forbidden" };
  const ts = String(cursor?.ts ?? "");
  const id = Number(cursor?.id);
  if (!ts || Number.isNaN(Date.parse(ts)) || !Number.isInteger(id)) {
    return { events: [], hasMore: false, error: "invalid cursor" };
  }
  return listSecurityEvents(cleanFilters(filters), { ts, id });
}

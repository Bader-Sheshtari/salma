import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/database.types";

/** Known profile roles (owner > super_admin > admin > editor; 'user' = legacy/non-staff). */
export type Role = "user" | "editor" | "admin" | "super_admin" | "owner";

export type Profile = Omit<Tables<"profiles">, "role"> & { role: Role | (string & {}) };

/** Roles that may access the admin dashboard's operational (admin-only) areas. */
export const ADMIN_ROLES = ["admin", "super_admin", "owner"] as const;

/** Roles that may sign in to the dashboard at all (editors: content area only). */
export const STAFF_ROLES = ["editor", ...ADMIN_ROLES] as const;

/** Roles that may manage other accounts (the «المستخدمون والصلاحيات» page). */
export const MANAGER_ROLES = ["super_admin", "owner"] as const;

/** True when the role grants admin-dashboard (admin-tier) access. */
export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && (ADMIN_ROLES as readonly string[]).includes(role);
}

/** True when the role may sign in to the dashboard (editor or above). */
export function isStaffRole(role: string | null | undefined): boolean {
  return !!role && (STAFF_ROLES as readonly string[]).includes(role);
}

/** True when the role may add/manage other accounts. */
export function isManagerRole(role: string | null | undefined): boolean {
  return !!role && (MANAGER_ROLES as readonly string[]).includes(role);
}

/** The signed-in user's MFA posture, read server-side on every request. */
export type MfaState = {
  /** Verified TOTP factor ids (empty = MFA not enrolled). */
  verifiedFactorIds: string[];
  /** Session assurance level from the verified JWT ('aal1' | 'aal2'), null when not needed. */
  aal: string | null;
  /**
   * FAIL-OPEN valve tripped: reading the factors / assurance level failed on an
   * infrastructure error. MFA rules are skipped for this request (never on user
   * choice) so the sole owner is not stranded by an Auth API outage.
   */
  degraded: boolean;
};

export type StaffSession = { profile: Profile; mfa: MfaState };

type ServerClient = Awaited<ReturnType<typeof createClient>>;
type AuthUser = { id: string; factors?: { id: string; status: string; factor_type: string }[] };

async function readMfaState(supabase: ServerClient, user: AuthUser): Promise<MfaState> {
  try {
    const verifiedFactorIds = (user.factors ?? [])
      .filter((f) => f.status === "verified" && f.factor_type === "totp")
      .map((f) => f.id);
    // No enrolled factor → the session's AAL is irrelevant (R1 cannot apply).
    if (!verifiedFactorIds.length) return { verifiedFactorIds, aal: null, degraded: false };

    let aal: string | null = null;
    const { data, error } = await supabase.auth.getClaims();
    const claims = data?.claims as { sub?: string; aal?: string } | undefined;
    if (!error && claims?.sub === user.id) {
      aal = claims.aal ?? null;
    } else {
      // Fallback: the AAL of the access token getUser() just verified (local decode).
      const { data: lvl, error: lvlErr } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (lvlErr || !lvl) throw new Error(lvlErr?.message ?? error?.message ?? "assurance level unavailable");
      aal = lvl.currentLevel ?? null;
    }
    return { verifiedFactorIds, aal, degraded: false };
  } catch (e) {
    console.warn(
      "[auth] MFA state read failed — FAIL-OPEN valve: MFA rules skipped for this request:",
      e instanceof Error ? e.message : String(e),
    );
    return { verifiedFactorIds: [], aal: null, degraded: true };
  }
}

/**
 * The signed-in, non-suspended staff profile + its MFA state, or null. NO MFA
 * redirects here (login page / setup page / guards decide). Memoized per request.
 */
export const getStaffSession = cache(async (): Promise<StaffSession | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  const profile = data as Profile | null;
  if (!profile || !isStaffRole(profile.role) || profile.disabled) return null;
  return { profile, mfa: await readMfaState(supabase, user as AuthUser) };
});

/**
 * Where an otherwise-valid staff session must go before using the dashboard.
 * MFA is OPTIONAL for every role; the only rule is R1: a user who HAS a verified
 * factor (any role) must be aal2 → otherwise finish the code step at login.
 * null = allowed. The fail-open valve (degraded) always allows.
 */
export function mfaRedirectFor(session: StaffSession): string | null {
  const { mfa } = session;
  if (mfa.degraded) return null;
  if (mfa.verifiedFactorIds.length > 0 && mfa.aal !== "aal2") return "/admin/login?step=mfa";
  return null;
}

/** Default landing page per role (editors: content area). */
export function staffHome(role: string): string {
  return isAdminRole(role) ? "/admin" : "/admin/content";
}

/** Same-origin dashboard path only (open-redirect safe), else null. */
export function safeAdminDest(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 200) return null;
  if (!/^\/admin(?:[/?#][^\s\\]*)?$/.test(v) || v.includes("//")) return null;
  return v;
}

/** Signed-in staff profile with MFA satisfied (R1 clear), or null. */
export async function getStaffProfile(): Promise<Profile | null> {
  const session = await getStaffSession();
  return session && !mfaRedirectFor(session) ? session.profile : null;
}

/** Returns the signed-in admin profile (admin or above), or null. */
export async function getAdminProfile(): Promise<Profile | null> {
  const profile = await getStaffProfile();
  return profile && isAdminRole(profile.role) ? profile : null;
}

/**
 * Guard for admin-only pages/actions (admin, super_admin, owner). Anonymous /
 * non-staff visitors go to the login screen; a signed-in editor is sent to the
 * content area (their whole dashboard) instead of a confusing login loop.
 * Inherits the MFA rules from requireStaff.
 */
export async function requireAdmin(): Promise<Profile> {
  const profile = await requireStaff();
  if (!isAdminRole(profile.role)) redirect("/admin/content");
  return profile;
}

/**
 * Guard for content-scope pages/actions — any staff role (editor and above).
 * THE chokepoint for MFA enforcement (R1, see mfaRedirectFor); every
 * dashboard page and server action inherits it.
 */
export async function requireStaff(): Promise<Profile> {
  const session = await getStaffSession();
  if (!session) redirect("/admin/login");
  const to = mfaRedirectFor(session);
  if (to) redirect(to);
  return session.profile;
}

/**
 * Like requireStaff but SKIPS R1 — used ONLY by the voluntary /admin/mfa-setup
 * page (and the enrollment audit action), which handles the aal1 case itself.
 */
export async function requireStaffForMfaSetup(): Promise<StaffSession> {
  const session = await getStaffSession();
  if (!session) redirect("/admin/login");
  return session;
}

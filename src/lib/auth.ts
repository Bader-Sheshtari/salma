import "server-only";
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

/** Returns the signed-in, non-suspended staff profile (editor or above), or null. */
export async function getStaffProfile(): Promise<Profile | null> {
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
  return profile;
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
 */
export async function requireAdmin(): Promise<Profile> {
  const profile = await getStaffProfile();
  if (!profile) redirect("/admin/login");
  if (!isAdminRole(profile.role)) redirect("/admin/content");
  return profile;
}

/** Guard for content-scope pages/actions — any staff role (editor and above). */
export async function requireStaff(): Promise<Profile> {
  const profile = await getStaffProfile();
  if (!profile) redirect("/admin/login");
  return profile;
}

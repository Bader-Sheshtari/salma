import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/database.types";

export type Profile = Tables<"profiles">;

/** Roles that may access the admin dashboard. */
export const ADMIN_ROLES = ["admin", "super_admin", "owner"] as const;

/** Roles that may manage other admins (the "إدارة الأدمن" page). */
export const MANAGER_ROLES = ["super_admin", "owner"] as const;

/** True when the role grants admin-dashboard access. */
export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && (ADMIN_ROLES as readonly string[]).includes(role);
}

/** True when the role may add/manage other admins. */
export function isManagerRole(role: string | null | undefined): boolean {
  return !!role && (MANAGER_ROLES as readonly string[]).includes(role);
}

/** Returns the signed-in admin profile, or null if not authenticated as an admin. */
export async function getAdminProfile(): Promise<Profile | null> {
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
  if (!profile || !isAdminRole(profile.role) || profile.disabled) return null;
  return profile;
}

/** Guard for admin pages — redirects to the login screen when not an admin. */
export async function requireAdmin(): Promise<Profile> {
  const profile = await getAdminProfile();
  if (!profile) redirect("/admin/login");
  return profile;
}

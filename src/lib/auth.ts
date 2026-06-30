import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/database.types";

export type Profile = Tables<"profiles">;

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
  if (!profile || profile.role !== "admin" || profile.disabled) return null;
  return profile;
}

/** Guard for admin pages — redirects to the login screen when not an admin. */
export async function requireAdmin(): Promise<Profile> {
  const profile = await getAdminProfile();
  if (!profile) redirect("/admin/login");
  return profile;
}

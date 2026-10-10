"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole, staffHome } from "@/lib/auth";

export type LoginResult = { error: string } | null;

export async function login(_prev: LoginResult, formData: FormData): Promise<LoginResult> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "أدخل البريد وكلمة المرور." };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return { error: "بيانات الدخول غير صحيحة." };

  // Only staff (editor and above) may access the dashboard; reject and sign out
  // everyone else. Suspended accounts are refused regardless of role.
  const { data: profileRow } = await supabase
    .from("profiles")
    .select("role, disabled")
    .eq("id", data.user.id)
    .maybeSingle();
  const profile = profileRow as { role: string; disabled: boolean } | null;

  if (!profile || !isStaffRole(profile.role) || profile.disabled) {
    await supabase.auth.signOut();
    return { error: "هذا الحساب لا يملك صلاحية الإدارة." };
  }

  // Record the sign-in time (self-update, allowed by RLS).
  await supabase
    .from("profiles")
    .update({ last_login_at: new Date().toISOString() } as never)
    .eq("id", data.user.id);

  // Editors land straight on the content area (their whole dashboard).
  const dest = staffHome(profile.role);

  // U3: an enrolled account (any role) must finish the TOTP step first. The
  // dashboard guard (requireStaff R1) backstops this for deep links.
  const hasTotp = (data.user.factors ?? []).some(
    (f) => f.status === "verified" && f.factor_type === "totp",
  );
  if (hasTotp) redirect(`/admin/login?step=mfa&dest=${encodeURIComponent(dest)}`);
  redirect(dest);
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}

"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdminRole } from "@/lib/auth";

export type LoginResult = { error: string } | null;

export async function login(_prev: LoginResult, formData: FormData): Promise<LoginResult> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "أدخل البريد وكلمة المرور." };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return { error: "بيانات الدخول غير صحيحة." };

  // Only admins may access the dashboard; reject and sign out everyone else.
  const { data: profileRow } = await supabase
    .from("profiles")
    .select("role, disabled")
    .eq("id", data.user.id)
    .maybeSingle();
  const profile = profileRow as { role: string; disabled: boolean } | null;

  if (!profile || !isAdminRole(profile.role) || profile.disabled) {
    await supabase.auth.signOut();
    return { error: "هذا الحساب لا يملك صلاحية الإدارة." };
  }

  redirect("/admin");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}

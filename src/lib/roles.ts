/**
 * Account-management rules shared by the server actions (authoritative) and the
 * users-page UI (display only). Pure functions — safe in client components.
 *
 * Hierarchy: owner > super_admin > admin > editor ('user' = legacy/non-staff).
 *  - owner: manages every non-owner account; the only one who grants super_admin.
 *  - super_admin: manages admin/editor (and legacy user) accounts only — never
 *    the owner, never another super_admin; assigns only admin/editor.
 *  - nobody (incl. owner) can grant 'owner'; the owner account is always protected.
 * The DB trigger guard_profile_changes enforces the same rules.
 */

export const ROLE_LABEL: Record<string, string> = {
  owner: "المالك",
  super_admin: "مشرف عام",
  admin: "مدير",
  editor: "محرر",
  user: "مستخدم",
};

/** Roles each manager role may assign (create with / change to). */
const ASSIGNABLE_BY: Record<string, readonly string[]> = {
  owner: ["super_admin", "admin", "editor"],
  super_admin: ["admin", "editor"],
};

/** Target roles a super_admin may act on. */
const SUPER_ADMIN_TARGETS: readonly string[] = ["admin", "editor", "user"];

export function assignableRoles(actorRole: string): readonly string[] {
  return ASSIGNABLE_BY[actorRole] ?? [];
}

export function canAssignRole(actorRole: string, role: string): boolean {
  return assignableRoles(actorRole).includes(role);
}

/**
 * Whether `actor` may act on `target` (role change / suspend / reset password).
 * Self is excluded (self-service password form instead); owner is untouchable.
 */
export function canManageTarget(
  actor: { id: string; role: string },
  target: { id: string; role: string },
): boolean {
  if (target.id === actor.id) return false;
  if (target.role === "owner") return false;
  if (actor.role === "owner") return true;
  if (actor.role === "super_admin") return SUPER_ADMIN_TARGETS.includes(target.role);
  return false;
}

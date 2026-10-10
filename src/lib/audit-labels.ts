/**
 * Arabic labels for admin_audit_log actions — the SINGLE source for the
 * security log (/admin/security) and the account «نشاط الأمان الأخير» list.
 * Covers every value in the admin_audit_log action CHECK (15 U1/U2 + 6 U3).
 * Pure module — safe in client components.
 */
import { ROLE_LABEL } from "@/lib/roles";

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  role_changed: "تغيير الصلاحية",
  user_suspended: "إيقاف مستخدم",
  user_reactivated: "إعادة تفعيل مستخدم",
  invitation_created: "إنشاء دعوة",
  invitation_reissued: "إعادة إصدار دعوة",
  invitation_cancelled: "إلغاء دعوة",
  invitation_accepted: "قبول دعوة",
  password_changed: "تغيير كلمة المرور",
  password_reset_link_created: "إنشاء رابط إعادة تعيين",
  password_reset_completed: "إعادة تعيين كلمة المرور",
  profile_updated: "تحديث الملف الشخصي",
  email_changed: "تغيير البريد",
  user_created: "إنشاء مستخدم",
  denied_attempt: "محاولة مرفوضة",
  ownership_transfer: "نقل الملكية",
  mfa_enabled: "تفعيل المصادقة الثنائية",
  mfa_disabled: "إلغاء المصادقة الثنائية",
  mfa_reconfigured: "إعادة تهيئة المصادقة",
  sensitive_reauth_completed: "تأكيد هوية",
  sessions_revoked: "تسجيل الخروج من الأجهزة",
  security_setting_changed: "تغيير إعداد أمني",
};

/** Every valid action, in display order (filter select). */
export const AUDIT_ACTIONS = Object.keys(AUDIT_ACTION_LABEL);

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABEL[action] ?? action;
}

const REASON_LABEL: Record<string, string> = {
  role_changed: "بسبب تغيير الصلاحية",
  suspended: "بسبب إيقاف الحساب",
  user_initiated: "بطلب صاحب الحساب",
};

const FIELD_LABEL: Record<string, string> = {
  full_name: "الاسم",
  phone: "الهاتف",
  email: "البريد",
};

function roleLabel(v: unknown): string {
  return typeof v === "string" ? (ROLE_LABEL[v] ?? v) : "";
}

/** Keys never rendered (internal ids / timestamps / noise). */
const SKIP_KEYS = new Set(["invitation_id", "replaced_id", "expires_at", "via"]);

const FACTOR_TYPE_LABEL: Record<string, string> = {
  totp: "تطبيق مصادقة",
  phone: "الهاتف",
  webauthn: "مفتاح أمان",
};

const SOURCE_LABEL: Record<string, string> = {
  auth_factors: "سجل نظام المصادقة",
};

/**
 * Concise, human-readable Arabic summary bits for one event. Reads only known,
 * non-secret keys (rows never contain tokens/secrets anyway).
 */
export function describeAuditDetails(ev: {
  action: string;
  before_value: string | null;
  after_value: string | null;
  details: unknown;
}): string[] {
  const out: string[] = [];
  const d = (ev.details && typeof ev.details === "object" && !Array.isArray(ev.details)
    ? ev.details
    : {}) as Record<string, unknown>;

  if (ev.action === "role_changed" && (ev.before_value || ev.after_value)) {
    out.push(`من ${roleLabel(ev.before_value) || "—"} إلى ${roleLabel(ev.after_value) || "—"}`);
  } else if (
    ["invitation_created", "invitation_reissued", "invitation_accepted", "user_created"].includes(ev.action) &&
    ev.after_value
  ) {
    out.push(`الدور: ${roleLabel(ev.after_value)}`);
  } else if (ev.action === "invitation_cancelled" && ev.before_value) {
    out.push(`الدور: ${roleLabel(ev.before_value)}`);
  }

  for (const [k, v] of Object.entries(d)) {
    if (SKIP_KEYS.has(k) || v == null || v === "") continue;
    switch (k) {
      case "reason":
        out.push(REASON_LABEL[String(v)] ?? `السبب: ${String(v)}`);
        break;
      case "revoked":
        out.push(`جلسات أُنهيت: ${Number(v) || 0}`);
        break;
      case "fields":
        if (Array.isArray(v)) out.push(`الحقول: ${v.map((f) => FIELD_LABEL[String(f)] ?? String(f)).join("، ")}`);
        break;
      case "mfa_factors_removed":
        out.push(`عوامل مصادقة أُزيلت: ${Number(v) || 0}`);
        break;
      case "sessions_revoked":
        if (v === true) out.push("أُنهيت جلساته");
        break;
      case "other_sessions_revoked":
        if (v === true) out.push("أُنهيت الجلسات الأخرى");
        break;
      case "replaced":
        out.push(`استبدلت ${Number(v) || 0} دعوة سابقة`);
        break;
      case "target_disabled":
        if (v === true) out.push("الحساب موقوف");
        break;
      case "mfa":
        out.push(v === true ? "بكلمة المرور ورمز المصادقة" : "بكلمة المرور");
        break;
      case "factor_type":
        out.push(`النوع: ${FACTOR_TYPE_LABEL[String(v)] ?? String(v).slice(0, 40)}`);
        break;
      case "source":
        out.push(`المصدر: ${SOURCE_LABEL[String(v)] ?? String(v).slice(0, 40)}`);
        break;
      case "attempted":
        out.push(`المحاولة: ${String(v)}`);
        break;
      case "detail":
        out.push(String(v).slice(0, 120));
        break;
      case "role":
      case "target_role":
        out.push(`الدور: ${roleLabel(v)}`);
        break;
      default:
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          out.push(`${k}: ${String(v).slice(0, 80)}`);
        }
    }
  }
  return out;
}

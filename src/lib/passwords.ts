/**
 * Password rules for staff accounts (invite acceptance, reset completion,
 * self-service change). SINGLE SOURCE: the server actions (authoritative)
 * call `passwordError` → `validatePassword`; the client forms use the same
 * functions only for live hints / disabling submit.
 * Pure — safe in client components. Passwords are never logged or echoed back.
 *
 * Policy (2026-10-10):
 *  - length 8–128
 *  - ≥ 1 uppercase English letter  [A-Z]
 *  - ≥ 1 digit                     [0-9]
 *  - ≥ 1 special character = any printable non-alphanumeric ASCII
 *    (0x21–0x2F, 0x3A–0x40, 0x5B–0x60, 0x7B–0x7E), i.e. exactly:
 *    ! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~
 *    (space does not count)
 *  - not a common / easily guessed password (blocklist + base words with
 *    digits/symbols glued on + single repeated character), regardless of the
 *    rules above
 *  - must not be the account's own email (or its local part)
 */

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/** Printable ASCII punctuation — the documented special-character set. */
export const SPECIAL_CHARS = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const SPECIAL_RE = /[!-/:-@[-`{-~]/;

/** The four composition rules shown in the live checklist (in display order). */
export type PasswordRule = "length" | "uppercase" | "digit" | "special";
/** Every reason `validatePassword` can refuse a password. */
export type PasswordFailure = PasswordRule | "common" | "email";

export type PasswordCheck = { ok: boolean; failures: PasswordFailure[] };

export const PASSWORD_RULES: { key: PasswordRule; label: string }[] = [
  { key: "length", label: "٨ أحرف على الأقل" },
  { key: "uppercase", label: "حرف إنجليزي كبير واحد على الأقل" },
  { key: "digit", label: "رقم واحد على الأقل" },
  { key: "special", label: "رمز خاص واحد على الأقل" },
];

/** ~100 of the most common leaked passwords that are ≥ 8 chars (shorter ones fail the length rule anyway). */
const COMMON = new Set<string>([
  "password", "password1", "password12", "password123", "password1234", "password12345",
  "password!", "password1!", "passw0rd", "p@ssw0rd", "p@ssword", "p@ssword1", "p@ssw0rd1",
  "12345678", "123456789", "1234567890", "12345678910", "0123456789", "0987654321",
  "1q2w3e4r", "1q2w3e4r5t", "1q2w3e4r5t6y", "q1w2e3r4t5", "1qaz2wsx", "1qaz2wsx3edc",
  "zaq12wsx", "zaq1zaq1", "qwertyuiop", "qwerty123", "qwerty1234", "qwerty12345",
  "qwertyui", "asdfghjkl", "asdfghjk", "zxcvbnm123", "qazwsxedc", "abcd1234", "abc12345",
  "abcdefgh", "abcdefghij", "a1b2c3d4", "a1b2c3d4e5", "aa123456", "aa12345678",
  "11111111", "1111111111", "00000000", "0000000000", "88888888", "99999999",
  "12341234", "11223344", "112233445566", "123123123", "123321123", "147258369",
  "987654321", "123456789a", "123456789q", "1234567890q", "iloveyou", "iloveyou1",
  "sunshine", "princess", "football", "baseball", "superman", "starwars", "whatever",
  "trustno1", "letmein1", "welcome1", "welcome123", "changeme", "changeme1",
  "computer", "internet", "michelle", "jennifer", "corvette", "mercedes", "samsung1",
  "liverpool", "chelsea1", "arsenal1", "barcelona", "realmadrid", "pokemon1",
  "qwer1234", "asdf1234", "zxcv1234", "admin123", "admin1234", "administrator",
  "adminadmin", "root1234", "test1234", "testtest", "secret123", "default1",
  "master123", "dragon123", "monkey123", "shadow123", "football1", "baseball1",
  "kuwait123", "kuwait2024", "kuwait2025", "kuwait2026", "q8q8q8q8", "pass1234",
  "passpass", "login123", "user1234", "guest123", "hello123", "helloworld",
]);

/**
 * Base words that are refused even with digits/symbols glued to either end
 * (e.g. "Salma2026!", "@Password123"). Project-specific names included.
 */
const BASE_WORDS = new Set<string>([
  "salma", "salmanews", "salmaadmin", "salma.news", "سلمى", "سلمي", "dawi",
  "password", "passw0rd", "p@ssw0rd", "p@ssword", "pass", "admin", "administrator",
  "qwerty", "qwertyuiop", "welcome", "letmein", "iloveyou", "kuwait", "q8",
  "changeme", "secret", "login", "editor", "owner", "superadmin", "test",
]);

function stripEdges(s: string): string {
  return s.replace(/^[\d\s!@#$%^&*()_+\-=.,?~`'"|\\/<>:;[\]{}]+/, "").replace(/[\d\s!@#$%^&*()_+\-=.,?~`'"|\\/<>:;[\]{}]+$/, "");
}

/**
 * Structured check of a NEW password (confirmation is checked by
 * `passwordError`). Returns every failed rule so the UI can show per-rule state.
 * `context.email` adds the "don't reuse your email" rule.
 */
export function validatePassword(
  password: unknown,
  context: { email?: string | null } = {},
): PasswordCheck {
  const pw = typeof password === "string" ? password : "";
  const failures: PasswordFailure[] = [];

  if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) failures.push("length");
  if (!/[A-Z]/.test(pw)) failures.push("uppercase");
  if (!/[0-9]/.test(pw)) failures.push("digit");
  if (!SPECIAL_RE.test(pw)) failures.push("special");

  const lower = pw.toLowerCase();
  const base = stripEdges(lower);
  // base === "" → only digits/symbols (e.g. "1029384756"): refused unless long.
  if (
    pw.length > 0 &&
    (COMMON.has(lower) ||
      BASE_WORDS.has(base) ||
      (base.length === 0 && pw.length < 16) ||
      /^(.)\1+$/u.test(pw))
  ) {
    failures.push("common");
  }

  const email = context.email?.trim().toLowerCase();
  if (email && pw.length > 0) {
    const local = email.split("@")[0] ?? "";
    if (lower === email || (local.length >= 4 && base === local)) failures.push("email");
  }

  return { ok: failures.length === 0, failures };
}

const RULE_MESSAGE: Record<PasswordRule, string> = {
  length: `${PASSWORD_MIN} أحرف على الأقل`,
  uppercase: "حرف إنجليزي كبير (A-Z)",
  digit: "رقم",
  special: "رمز خاص مثل ! @ # $",
};

export const PASSWORD_MISMATCH = "كلمتا المرور غير متطابقتين";
export const PASSWORD_COMMON_MSG = "كلمة المرور شائعة أو سهلة التخمين — اختر كلمة أقوى.";
export const PASSWORD_EMAIL_MSG = "لا تستخدم بريدك الإلكتروني ككلمة مرور.";

/**
 * Returns one Arabic error for an unacceptable new password + confirmation,
 * or null when it passes. Thin wrapper over `validatePassword` (single source).
 */
export function passwordError(
  password: unknown,
  confirm: unknown,
  context: { email?: string | null } = {},
): string | null {
  if (typeof password !== "string" || typeof confirm !== "string" || !password) {
    return "أدخل كلمة المرور وتأكيدها.";
  }
  if (password.length > PASSWORD_MAX) {
    return `كلمة المرور يجب ألا تزيد عن ${PASSWORD_MAX} حرفاً.`;
  }
  const { failures } = validatePassword(password, context);
  const missing = PASSWORD_RULES.filter((r) => failures.includes(r.key)).map((r) => RULE_MESSAGE[r.key]);
  if (missing.length) return `كلمة المرور يجب أن تحتوي على: ${missing.join("، ")}.`;
  if (password !== confirm) return `${PASSWORD_MISMATCH}.`;
  if (failures.includes("common")) return PASSWORD_COMMON_MSG;
  if (failures.includes("email")) return PASSWORD_EMAIL_MSG;
  return null;
}

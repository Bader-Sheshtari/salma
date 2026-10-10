/**
 * Password rules for staff accounts (invite acceptance, reset completion,
 * self-service change). Pure — safe in client components for hints; the
 * server actions are the authority and always re-run `passwordError`.
 * Passwords are never logged or echoed back.
 */

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export const PASSWORD_HINT = `${PASSWORD_MIN} أحرف على الأقل، وتجنّب الكلمات الشائعة أو اسم «سلمى».`;

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
 * (e.g. "Salma2026!", "@password123"). Project-specific names included.
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
 * Returns an Arabic error for an unacceptable new password, or null when it
 * passes. `context.email` adds a "don't reuse your email" rule.
 */
export function passwordError(
  password: unknown,
  confirm: unknown,
  context: { email?: string | null } = {},
): string | null {
  if (typeof password !== "string" || typeof confirm !== "string") {
    return "أدخل كلمة المرور وتأكيدها.";
  }
  if (password.length < PASSWORD_MIN) {
    return `كلمة المرور يجب ألا تقل عن ${PASSWORD_MIN} أحرف.`;
  }
  if (password.length > PASSWORD_MAX) {
    return `كلمة المرور يجب ألا تزيد عن ${PASSWORD_MAX} حرفاً.`;
  }
  if (password !== confirm) return "كلمتا المرور غير متطابقتين.";

  const lower = password.toLowerCase();
  const base = stripEdges(lower);
  // base === "" → only digits/symbols (e.g. "1029384756"): refused unless long.
  if (COMMON.has(lower) || BASE_WORDS.has(base) || (base.length === 0 && password.length < 16)) {
    return "كلمة المرور شائعة أو سهلة التخمين — اختر كلمة أقوى.";
  }
  if (/^(.)\1+$/u.test(password)) return "كلمة المرور سهلة التخمين — اختر كلمة أقوى.";

  const email = context.email?.trim().toLowerCase();
  if (email) {
    const local = email.split("@")[0] ?? "";
    if (lower === email || (local.length >= 4 && base === local)) {
      return "لا تستخدم بريدك الإلكتروني ككلمة مرور.";
    }
  }
  return null;
}

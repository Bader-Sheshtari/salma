// Client-safe slug suggestion. Unlike `@/lib/slug` (which is server-only and
// keeps Arabic letters verbatim), this transliterates Arabic to Latin so the
// category form can suggest clean, URL-friendly slugs like "dawi-news".

const ARABIC_MAP: Record<string, string> = {
  ا: "a", أ: "a", إ: "i", آ: "a", ٱ: "a", ء: "", ئ: "y", ؤ: "w", ى: "a", ة: "h",
  ب: "b", ت: "t", ث: "th", ج: "j", ح: "h", خ: "kh", د: "d", ذ: "dh", ر: "r",
  ز: "z", س: "s", ش: "sh", ص: "s", ض: "d", ط: "t", ظ: "z", ع: "a", غ: "gh",
  ف: "f", ق: "q", ك: "k", ل: "l", م: "m", ن: "n", ه: "h", و: "w", ي: "y",
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

/** Transliterate an Arabic string into Latin letters (best-effort). */
function transliterate(input: string): string {
  return input
    .replace(/[\u064B-\u065F\u0610-\u061A\u0670]/g, "") // strip Arabic diacritics
    .split("")
    .map((ch) => (ch in ARABIC_MAP ? ARABIC_MAP[ch] : ch))
    .join("");
}

/**
 * Suggest a clean Latin slug from a category's names. Prefers the English name
 * when present (it slugifies to clean ASCII directly); otherwise transliterates
 * the Arabic name. Returns "" when there's nothing usable yet.
 */
export function suggestSlug(nameAr: string, nameEn?: string): string {
  const source = nameEn && nameEn.trim() ? nameEn : transliterate(nameAr);
  return source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

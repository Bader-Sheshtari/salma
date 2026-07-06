/** Arabic relative-time formatter for ISO timestamps. */
export function timeAgoAr(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (Number.isNaN(then) || diff < 0) return "";

  const min = Math.floor(diff / 60000);
  if (min < 1) return "الآن";
  if (min < 60) return `قبل ${min} دقيقة`;

  const hr = Math.floor(min / 60);
  if (hr < 24) return `قبل ${hr} ${hr === 1 ? "ساعة" : "ساعات"}`;

  const day = Math.floor(hr / 24);
  if (day < 7) return `قبل ${day} ${day === 1 ? "يوم" : "أيام"}`;

  const wk = Math.floor(day / 7);
  if (wk < 5) return `قبل ${wk} ${wk === 1 ? "أسبوع" : "أسابيع"}`;

  const mo = Math.floor(day / 30);
  if (mo < 12) return `قبل ${mo} ${mo === 1 ? "شهر" : "أشهر"}`;

  return new Date(iso).toLocaleDateString("ar-KW", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Absolute Arabic publish date + time, e.g. "نُشر في 1 يوليو 2026 - 3:45 مساءً".
 * Western digits are used for readability; the 12-hour period is spelled out
 * as صباحًا/مساءً to match the site's RTL Arabic voice.
 */
export function formatDateTimeAr(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const date = new Intl.DateTimeFormat("ar-KW", {
    day: "numeric",
    month: "long",
    year: "numeric",
    numberingSystem: "latn",
  }).format(d);

  const h24 = d.getHours();
  const period = h24 < 12 ? "صباحًا" : "مساءً";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getMinutes()).padStart(2, "0");

  return `نُشر في ${date} - ${h12}:${mm} ${period}`;
}

/** Repeating diagonal hatch used as an image placeholder. */
export function hatch(a: string, b: string, px = 8): string {
  return `repeating-linear-gradient(45deg,${a},${a} ${px}px,${b} ${px}px,${b} ${px * 2}px)`;
}

/**
 * Normalize a YouTube/Vimeo watch URL to its embeddable form so it can be
 * dropped into an <iframe src>. Returns the input unchanged if it is already an
 * embed URL or from an unrecognized host.
 */
export function embedUrl(url: string): string {
  const raw = url.trim();
  if (!raw) return raw;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }

  const host = u.hostname.replace(/^www\./, "");

  // youtu.be/<id>
  if (host === "youtu.be") {
    const id = u.pathname.slice(1);
    return id ? `https://www.youtube.com/embed/${id}` : raw;
  }

  // youtube.com/watch?v=<id>  |  /shorts/<id>  |  /embed/<id>
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") {
      const id = u.searchParams.get("v");
      return id ? `https://www.youtube.com/embed/${id}` : raw;
    }
    const m = u.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/);
    if (m) return `https://www.youtube.com/embed/${m[1]}`;
    return raw;
  }

  // vimeo.com/<id>  |  player.vimeo.com/video/<id>
  if (host === "vimeo.com") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    return id && /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : raw;
  }
  if (host === "player.vimeo.com") return raw;

  return raw;
}

/**
 * Best-effort poster image for a video URL, used as an automatic cover fallback
 * when no cover image has been uploaded. YouTube exposes a static thumbnail
 * (img.youtube.com/vi/<id>/hqdefault.jpg); Vimeo does not (its thumbnails need
 * an authenticated oEmbed call), so we return null and let the caller fall back
 * to the placeholder or a manually uploaded cover.
 */
export function videoThumbnail(url: string | null): string | null {
  if (!url) return null;
  const raw = url.trim();
  if (!raw) return null;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  const host = u.hostname.replace(/^www\./, "");

  if (host === "youtu.be") {
    const id = u.pathname.slice(1);
    return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
  }

  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") {
      const id = u.searchParams.get("v");
      return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
    }
    const m = u.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/);
    if (m) return `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
    return null;
  }

  // Vimeo and everything else: no static thumbnail available.
  return null;
}

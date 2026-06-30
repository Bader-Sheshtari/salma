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

import Link from "next/link";
import Image from "next/image";
import type { Content } from "@/lib/queries";
import { hatch, timeAgoAr } from "@/lib/format";

/** True for images served from our Supabase Storage (optimizable by next/image). */
export function isStorageImage(src: string): boolean {
  return src.includes(".supabase.co/storage/v1/object/public/");
}

/** Route for a content item based on its type. */
export function hrefFor(c: Pick<Content, "type" | "slug">): string {
  return c.type === "video" ? `/video/${c.slug}` : `/article/${c.slug}`;
}

/** Cover image with a diagonal-hatch placeholder fallback. */
export function Cover({
  src,
  alt,
  className,
  dark,
  sizes = "(max-width: 768px) 100vw, 768px",
}: {
  src: string | null;
  alt: string;
  className?: string;
  dark?: boolean;
  sizes?: string;
}) {
  // next/image `fill` needs a positioned ancestor; the wrapper provides it
  // unless the caller already supplies an absolute position.
  const wrap = className?.includes("absolute")
    ? className
    : `relative h-full w-full ${className ?? ""}`;

  if (src) {
    if (isStorageImage(src)) {
      return (
        <div className={wrap}>
          <Image src={src} alt={alt} fill sizes={sizes} className="object-cover" />
        </div>
      );
    }
    return (
      <div className={wrap}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div
      aria-hidden
      className={`flex h-full w-full items-center justify-center font-mono text-[11px] ${dark ? "text-white/40" : "text-[#b39b78]"} ${className ?? ""}`}
      style={{ background: dark ? hatch("#2E2E2D", "#3a3a39", 9) : hatch("#F7EFE6", "#eadfcb", 9) }}
    >
      [ {alt} ]
    </div>
  );
}

/** Large lead/hero card. */
export function HeroCard({ c }: { c: Content }) {
  return (
    <Link href={hrefFor(c)} className="group block overflow-hidden rounded-2xl border border-line">
      <div className="relative flex aspect-[16/10] items-end">
        <Cover src={c.cover_image_url} alt="صورة رئيسية" className="absolute inset-0" />
        <span className="absolute right-3 top-3 rounded-md bg-teal px-2.5 py-1 text-[11px] font-semibold text-white">
          عاجل
        </span>
        <div className="relative w-full bg-gradient-to-t from-ink/90 to-transparent p-4 pt-12 sm:p-6 sm:pt-16">
          <h1 className="m-0 text-lg font-bold leading-snug text-white sm:text-2xl">{c.title}</h1>
          <div className="mt-2 font-sans text-[11.5px] font-medium text-gold">
            {timeAgoAr(c.published_at)}
          </div>
        </div>
      </div>
    </Link>
  );
}

/** Horizontal list row: thumbnail + title + meta. */
export function ListRow({
  c,
  accent = "var(--salma-green)",
  meta,
}: {
  c: Content;
  accent?: string;
  meta?: string;
}) {
  return (
    <Link href={hrefFor(c)} className="flex items-center gap-3 py-3">
      <div className="h-14 w-20 shrink-0 overflow-hidden rounded-lg sm:h-16 sm:w-24">
        <Cover src={c.cover_image_url} alt="صورة" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold leading-relaxed sm:text-[15px]">{c.title}</div>
        <div className="mt-1.5 text-[11px]" style={{ color: accent }}>
          {meta ?? timeAgoAr(c.published_at)}
        </div>
      </div>
    </Link>
  );
}

/** Vertical card with image on top — used in scroll rails and grids. */
export function ContentCard({ c }: { c: Content }) {
  return (
    <Link href={hrefFor(c)} className="block overflow-hidden rounded-2xl bg-white">
      <div className="aspect-[16/10] w-full overflow-hidden">
        <Cover src={c.cover_image_url} alt="صورة" />
      </div>
      <div className="px-3 py-3">
        <div className="text-[13.5px] font-semibold leading-relaxed sm:text-sm">{c.title}</div>
        {c.read_minutes ? (
          <div className="mt-1.5 text-[11px] text-green">{c.read_minutes} دقائق قراءة</div>
        ) : null}
      </div>
    </Link>
  );
}

/** Video card with play badge + duration. */
export function VideoCard({ c }: { c: Content }) {
  return (
    <Link href={hrefFor(c)} className="block">
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl">
        <Cover src={c.cover_image_url} alt="فيديو" dark className="absolute inset-0" />
        <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-white/90 pr-0.5 text-teal">
          ▶
        </span>
        {c.video_duration ? (
          <span className="absolute bottom-2 left-2 rounded bg-ink/80 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-white">
            {c.video_duration}
          </span>
        ) : null}
      </div>
      <div className="mt-2 text-sm font-semibold leading-relaxed">{c.title}</div>
    </Link>
  );
}

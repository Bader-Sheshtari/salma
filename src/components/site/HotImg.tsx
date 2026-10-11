"use client";

import { useState } from "react";

/**
 * Hotlinked <img> that unmounts itself if the remote file fails to load,
 * revealing whatever fallback the parent stacked beneath it. Article cover
 * images are hotlinked from source-news domains by design, so a dead remote
 * image must degrade to the branded placeholder instead of a broken icon.
 */
export function HotImg({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className={className} onError={() => setFailed(true)} />
  );
}

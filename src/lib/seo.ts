import type { Metadata } from "next";
import type { ContentDetail, Content } from "@/lib/queries";
import { absoluteUrl, SITE_URL, SITE_NAME } from "@/lib/site";
import { embedUrl } from "@/lib/format";

function pathForContent(c: Pick<Content, "type" | "slug">): string {
  return c.type === "video" ? `/video/${c.slug}` : `/article/${c.slug}`;
}

function leadImage(detail: ContentDetail): string | undefined {
  return (
    detail.content.cover_image_url ??
    detail.media.find((m) => m.type === "image")?.url ??
    undefined
  );
}

/** OpenGraph/Twitter metadata for a single article or video page. */
export function contentMetadata(detail: ContentDetail): Metadata {
  const c = detail.content;
  const path = pathForContent(c);
  const url = absoluteUrl(path);
  const description = c.excerpt ?? undefined;
  const image = leadImage(detail);
  const images = image ? [image] : undefined;
  const isVideo = c.type === "video";

  return {
    title: c.title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: isVideo ? "video.other" : "article",
      title: c.title,
      description,
      url,
      images,
      ...(c.published_at ? { publishedTime: c.published_at } : {}),
      ...(c.updated_at ? { modifiedTime: c.updated_at } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: c.title,
      description,
      images,
    },
  };
}

/** schema.org JSON-LD for an article or video, including its cited sources. */
export function contentJsonLd(
  detail: ContentDetail,
  sectionName?: string,
): Record<string, unknown> {
  const c = detail.content;
  const isVideo = c.type === "video";
  const url = absoluteUrl(pathForContent(c));
  const image = leadImage(detail);
  const citations = detail.sources.map((s) => s.url ?? s.label).filter(Boolean);

  const publisher = { "@type": "Organization", name: SITE_NAME, url: SITE_URL };

  const base: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": isVideo ? "VideoObject" : "NewsArticle",
    inLanguage: "ar",
    url,
    mainEntityOfPage: url,
    description: c.excerpt ?? undefined,
    image: image ? [image] : undefined,
    datePublished: c.published_at ?? undefined,
    dateModified: c.updated_at ?? c.published_at ?? undefined,
    publisher,
    author: publisher,
    ...(sectionName ? { articleSection: sectionName } : {}),
    ...(citations.length ? { citation: citations } : {}),
  };

  if (isVideo) {
    base.name = c.title;
    base.thumbnailUrl = image ? [image] : undefined;
    base.uploadDate = c.published_at ?? undefined;
    if (c.video_url) {
      base.contentUrl = c.video_url;
      base.embedUrl = embedUrl(c.video_url);
    }
  } else {
    base.headline = c.title;
  }

  return base;
}

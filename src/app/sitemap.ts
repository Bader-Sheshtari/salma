import type { MetadataRoute } from "next";
import { getCategories, getSitemapEntries } from "@/lib/queries";
import { absoluteUrl } from "@/lib/site";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [categories, entries] = await Promise.all([getCategories(), getSitemapEntries()]);

  const staticPages: MetadataRoute.Sitemap = [
    { url: absoluteUrl("/"), lastModified: new Date(), changeFrequency: "hourly", priority: 1 },
  ];

  const categoryPages: MetadataRoute.Sitemap = categories.map((c) => ({
    url: absoluteUrl(`/category/${c.slug}`),
    lastModified: new Date(),
    changeFrequency: "daily",
    priority: 0.7,
  }));

  const contentPages: MetadataRoute.Sitemap = entries.map((e) => ({
    url: absoluteUrl(e.type === "video" ? `/video/${e.slug}` : `/article/${e.slug}`),
    lastModified: new Date(e.updated_at ?? e.published_at ?? Date.now()),
    changeFrequency: "weekly",
    priority: 0.6,
  }));

  return [...staticPages, ...categoryPages, ...contentPages];
}

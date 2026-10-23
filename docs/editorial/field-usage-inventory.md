# Content field usage inventory — title / excerpt / summary

Read-only research, 2026-10-23. `summary` = DB column `ai_summary` (the "باختصار" box). Scope: `src/` plus one read-only check of `supabase/functions/newsletter-curate`.

## Public rendering and metadata
- `src/lib/seo.ts:33,38,46` — `title`: meta, og:title, twitter:title (article and video via `contentMetadata`).
- `src/lib/seo.ts:26-28` — description fallback: `excerpt` → `ai_summary` → first 160 chars of `body`. Feeds meta, og:description, twitter:description.
- `src/lib/seo.ts:71` — `excerpt` only, no fallback: JSON-LD `description`.
- `src/app/article/[slug]/page.tsx:14-18`, `src/app/video/[slug]/page.tsx:18` — call `contentMetadata`.
- `src/app/article/[slug]/opengraph-image.tsx:15`, `src/lib/og.tsx:37-66` — `title` only, rendered into the OG image. No excerpt/summary.
- `src/components/site/ArticleView.tsx:94-100` — `ai_summary` in the "باختصار" box; hidden when null.
- `src/components/site/ArticleView.tsx:130-132` — `excerpt` as lead paragraph; hidden when null.
- `src/components/site/HomeSection.tsx:76-77` — `excerpt` under lead card title; hidden when null.
- `src/components/site/cards.tsx:128,147,206` — `title` on cards (no excerpt).
- `src/lib/queries.ts:31` — list query selects `title,excerpt`.

## Search
- `src/lib/queries.ts:270` — search `summary` = `ai_summary || excerpt || null`.
- `src/components/site/cards.tsx:175-178` — renders `title` and `summary` (line-clamp-2); line omitted when null.
- `src/lib/queries.ts:237` (comment) — ranking order: title > excerpt > body.

## Feeds, sitemap, newsletter
- RSS/Atom output: none. No feed route in `src/app`. RSS appears only as an ingestion source URL (`src/app/admin/actions.ts:828-846`).
- `src/app/sitemap.ts`: no content title/excerpt/summary.
- `src/lib/newsletter-issues.ts`, `src/app/admin/newsletter-issue-actions.ts`: no content excerpt/summary. Line 270 uses the issue title only.
- `supabase/functions/newsletter-curate/index.ts:296-347` (outside src, read-only): selects `excerpt, ai_summary`; uses `summary: a.excerpt ?? a.ai_summary`.

## Admin and write paths (optional fields)
- `src/app/admin/actions.ts:101-102,159-160` — read and written as `null` when empty.
- `ContentForm.tsx:192-193,210-211,419,425-426`; `VersionView.tsx:125-131,165-167`; `content/[id]/develop/page.tsx:37,65-66`; `src/lib/content-history.ts:58-95`.

## Conclusion
1. Missing `ai_summary` more often breaks nothing. The "باختصار" box is hidden, search rows drop to `excerpt` and then blank, and the meta/OG description falls back to a raw body slice (`seo.ts:27-28`), which is weaker. It is not an editorial summary and its body format was not verified.
2. `excerpt` does feed SEO: it is the first choice for meta, OG and Twitter description (`seo.ts:26`), and the only source for JSON-LD `description` (`seo.ts:71`, no fallback). With no excerpt, JSON-LD omits the description.

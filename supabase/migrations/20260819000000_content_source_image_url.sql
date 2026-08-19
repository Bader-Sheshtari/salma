-- Separate, persistent field for the ORIGINAL source (publisher) image.
--
-- content.cover_image_url = the image CURRENTLY selected as the Salma cover
--   (may be the original, an AI-generated image, an upload, or a media pick).
-- content.source_image_url = the ORIGINAL publisher/source image, obtained at
--   ingest. It is semantically distinct and must remain independent: changing
--   cover_image_url (to AI/upload/media) must NEVER modify source_image_url, so
--   the editor can always return to «الصورة الأصلية».
--
-- Nullable — many rows legitimately have no source image (manual content, or a
-- source that provided none).

alter table public.content
  add column if not exists source_image_url text;

-- Safe, deterministic backfill of EXISTING rows.
--   Original source images are EXTERNAL publisher URLs. AI-generated and
--   uploaded covers live in the Supabase media bucket
--   (…/storage/v1/object/public/media/…). We backfill source_image_url from the
--   current cover ONLY when the cover is an external URL AND carries source
--   attribution (cover_credit_url, which ingest sets to the source article URL).
--   That combination deterministically identifies an ingest-set original source
--   image. Rows whose current cover is an AI/uploaded (media-bucket) image, or
--   that lack attribution, are LEFT NULL rather than risk mislabeling a cover
--   that is no longer the original. Never overwrite an already-set value.
update public.content
set source_image_url = cover_image_url
where source_image_url is null
  and cover_image_url is not null
  and cover_image_url not like '%/storage/v1/object/public/media/%'
  and cover_credit_url is not null;

-- ESL cross-language event canonicalization cache.
--
-- Event Registry event ids are language-scoped, so the same real-world
-- development appears under different event_uris per language and never
-- clusters. The ESL resolves these with a bounded LLM confirmation over an
-- ambiguous candidate set (gathered deterministically from the Arabic-translated
-- headline tokens). The decision is cached here so re-runs reuse it and never
-- re-pay the LLM cost, and so cross-run/day dedup keys on the merged event.
alter table public.radar_shadow_articles
  add column if not exists esl_canonical_key text,          -- canon:<min provider_uri of the merged development>
  add column if not exists esl_canonicalized_at timestamptz;

create index if not exists radar_shadow_articles_canonical_idx
  on public.radar_shadow_articles (esl_canonical_key)
  where esl_canonical_key is not null;

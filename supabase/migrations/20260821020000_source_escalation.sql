-- Primary Source Escalation V1 — audit + per-cluster cache.
--
-- One row per canonical ESL cluster that went through escalation. Answers:
-- what source DISCOVERED the story, what source Salma FINALLY used, was it
-- upgraded, why, and by which method. Unique on cluster_key so a successful
-- escalation is CACHED and never re-searched for the same development.
create table if not exists public.radar_source_escalation (
  id                 bigint generated always as identity primary key,
  cluster_key        text not null unique,          -- canonical ESL cluster (cache key)
  story_type         text,
  status             text not null,                 -- existing_best | upgraded | no_upgrade_found | escalation_failed
  method             text,                          -- cluster | linked | search | none
  discovery_url      text,
  discovery_domain   text,
  discovery_role     text,
  discovery_tier     int,
  editorial_url      text,
  editorial_domain   text,
  editorial_role     text,
  editorial_tier     int,
  supporting_url     text,                           -- independent context (multi-source), if any
  upgrade_reason     text,                           -- short, structured
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists radar_source_escalation_status_idx
  on public.radar_source_escalation (status);

-- Minimal escalation summary on the selection audit sidecar (quick joins).
alter table public.radar_editorial_selection
  add column if not exists esc_status text,
  add column if not exists esc_method text,
  add column if not exists esc_editorial_domain text,
  add column if not exists esc_editorial_tier int;

alter table public.ingestion_runs add column if not exists duration_ms int;
alter table public.ingestion_runs add column if not exists sources text[] not null default '{}';
alter table public.ingestion_runs add column if not exists created_ids uuid[] not null default '{}';
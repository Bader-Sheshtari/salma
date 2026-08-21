-- P0 SECURITY FIX — radar/ESL cron callers now authenticate with the internal
-- cron secret (launch-readiness audit 2026-08-21).
--
-- The radar-shadow / radar-rank / radar-editorial-select edge functions were
-- callable with the public anon key alone (verify_jwt=true is satisfied by
-- any valid project JWT, including anon). They now require the same
-- `x-ingest-secret` header that ingest-news already enforces, compared against
-- the INGEST_SECRET function secret. This migration teaches the four pg_cron
-- SQL wrappers to send that header, read from app_config.cron_secret — the
-- exact pattern run_news_ingestion() has used since launch.
--
-- Ordering note: this migration is applied BEFORE the hardened functions are
-- deployed. The extra header is ignored by the old function code, so no
-- scheduled run breaks during the rollout.
--
-- The anon Bearer stays: it satisfies the Supabase gateway's verify_jwt=true;
-- real authorization is the secret check inside each function.
--
-- Cron schedules, bodies, timeouts, and the salma-esl 'live' mode are UNCHANGED.
-- This migration also records the production reality that salma-esl runs
-- run_esl('live') (flipped 2026-08-21; the function default was already 'live').

create or replace function public.run_radar_shadow()
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_secret text;
begin
  select value into v_secret from public.app_config where key = 'cron_secret';
  if v_secret is null or v_secret = '' then
    return; -- never call the collector unauthenticated
  end if;
  perform net.http_post(
    url := 'https://ukraltlejlfkqbcifgcq.supabase.co/functions/v1/radar-shadow',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrcmFsdGxlamxma3FiY2lmZ2NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3Mzk1MDAsImV4cCI6MjA5ODMxNTUwMH0.dgTWGjHELu8BML_pNWdtCb0bmagD2KKBr97Rwv4yFl8',
      'x-ingest-secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

create or replace function public.run_radar_healthlife()
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_secret text;
begin
  select value into v_secret from public.app_config where key = 'cron_secret';
  if v_secret is null or v_secret = '' then
    return;
  end if;
  perform net.http_post(
    url := 'https://ukraltlejlfkqbcifgcq.supabase.co/functions/v1/radar-shadow',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrcmFsdGxlamxma3FiY2lmZ2NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3Mzk1MDAsImV4cCI6MjA5ODMxNTUwMH0.dgTWGjHELu8BML_pNWdtCb0bmagD2KKBr97Rwv4yFl8',
      'x-ingest-secret', v_secret
    ),
    body := '{"profile":"healthy_life"}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

create or replace function public.run_radar_rank()
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_secret text;
begin
  select value into v_secret from public.app_config where key = 'cron_secret';
  if v_secret is null or v_secret = '' then
    return;
  end if;
  perform net.http_post(
    url := 'https://ukraltlejlfkqbcifgcq.supabase.co/functions/v1/radar-rank',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrcmFsdGxlamxma3FiY2lmZ2NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3Mzk1MDAsImV4cCI6MjA5ODMxNTUwMH0.dgTWGjHELu8BML_pNWdtCb0bmagD2KKBr97Rwv4yFl8',
      'x-ingest-secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

create or replace function public.run_esl(p_mode text default 'live')
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_secret text;
begin
  select value into v_secret from public.app_config where key = 'cron_secret';
  if v_secret is null or v_secret = '' then
    return;
  end if;
  perform net.http_post(
    url := 'https://ukraltlejlfkqbcifgcq.supabase.co/functions/v1/radar-editorial-select',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrcmFsdGxlamxma3FiY2lmZ2NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3Mzk1MDAsImV4cCI6MjA5ODMxNTUwMH0.dgTWGjHELu8BML_pNWdtCb0bmagD2KKBr97Rwv4yFl8',
      'x-ingest-secret', v_secret
    ),
    body := jsonb_build_object('mode', coalesce(nullif(trim(p_mode), ''), 'live')),
    timeout_milliseconds := 150000
  );
end;
$$;

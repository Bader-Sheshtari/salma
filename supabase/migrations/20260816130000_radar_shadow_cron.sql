-- Fast News Radar — SHADOW MODE: schedule every 2 hours + result-cap flag.
--
-- STILL SHADOW MODE ONLY. This schedule invokes the radar-shadow edge
-- function, which writes exclusively to the radar_shadow_* tables. It does
-- NOT touch the Writer, Editorial Director, Fidelity, content, publishing,
-- ingest-news, or news_sources. No relevance tuning; no pagination.

-- Small diagnostic: flag when a run saturates the provider result cap.
-- Generated column so it applies to every run (incl. the first) with no
-- function redeploy. articlesCount is 100, so returned_count >= 100 == capped.
alter table public.radar_shadow_runs
  add column if not exists hit_result_cap boolean
  generated always as (returned_count >= 100) stored;

-- Cron entrypoint: POST to the radar-shadow function with the (public) anon
-- key as bearer, which satisfies verify_jwt = true. Security definer so the
-- cron job can call net.http_post; not granted to public/anon/authenticated.
create or replace function public.run_radar_shadow()
returns void
language plpgsql
security definer
set search_path = public, net
as $$
begin
  perform net.http_post(
    url := 'https://ukraltlejlfkqbcifgcq.supabase.co/functions/v1/radar-shadow',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrcmFsdGxlamxma3FiY2lmZ2NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3Mzk1MDAsImV4cCI6MjA5ODMxNTUwMH0.dgTWGjHELu8BML_pNWdtCb0bmagD2KKBr97Rwv4yFl8'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.run_radar_shadow() from public, anon, authenticated;

-- Every 2 hours (at minute 0 of even hours, UTC). Unschedule any prior job
-- of the same name first so this migration is idempotent.
select cron.unschedule('salma-radar-shadow')
where exists (select 1 from cron.job where jobname = 'salma-radar-shadow');

select cron.schedule('salma-radar-shadow', '0 */2 * * *', $$ select public.run_radar_shadow(); $$);

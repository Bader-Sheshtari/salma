-- Fast News Radar — RANKING: schedule every 2 hours, offset +10min.
--
-- Invokes the radar-rank edge function, which evaluates ONLY radar_shadow_*
-- rows needing ranking and writes the ranking fields back onto
-- radar_shadow_articles + one diagnostics row in radar_rank_runs. It does NOT
-- touch the Writer, Editorial Director, Fidelity, content, publishing,
-- ingest-news, or news_sources, and never publishes.
--
-- Runs at minute 10 of even hours (UTC) — ~10 minutes AFTER the collector's
-- `0 */2 * * *`, so each cycle ranks what was just collected. Ranking and
-- collection are independent: a failed rank never blocks the next collection,
-- and unresolved rows stay retryable on later rank cycles (ranked_at IS NULL).

-- Cron entrypoint: POST to the radar-rank function with the (public) anon key
-- as bearer, which satisfies verify_jwt = true. Security definer so the cron
-- job can call net.http_post; not granted to public/anon/authenticated.
create or replace function public.run_radar_rank()
returns void
language plpgsql
security definer
set search_path = public, net
as $$
begin
  perform net.http_post(
    url := 'https://ukraltlejlfkqbcifgcq.supabase.co/functions/v1/radar-rank',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrcmFsdGxlamxma3FiY2lmZ2NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3Mzk1MDAsImV4cCI6MjA5ODMxNTUwMH0.dgTWGjHELu8BML_pNWdtCb0bmagD2KKBr97Rwv4yFl8'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.run_radar_rank() from public, anon, authenticated;

-- Every 2 hours at minute 10 (UTC). Unschedule any prior job of the same name
-- first so this migration is idempotent.
select cron.unschedule('salma-radar-rank')
where exists (select 1 from cron.job where jobname = 'salma-radar-rank');

select cron.schedule('salma-radar-rank', '10 */2 * * *', $$ select public.run_radar_rank(); $$);

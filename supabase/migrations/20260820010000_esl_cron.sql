-- Editorial Selection Layer (ESL) — scheduled trigger.
--
-- Mirrors run_radar_shadow(): a SECURITY DEFINER function that fires the ESL edge
-- function via net.http_post with the project anon key (the edge function is
-- deployed with verify_jwt=true, exactly like radar-shadow / radar-rank).
--
-- The ESL is STATEFUL across the day, so running it a few times daily fills the
-- remaining daily capacity rather than multiplying it. p_mode selects 'shadow'
-- (record decisions only, create NO Content — used for validation) vs 'live'
-- (also promote selections to Content PENDING via the existing prepare pipeline).
--
-- NOTE: this migration creates the function and a 3×/day cron job that is
-- SCHEDULED IN SHADOW MODE. It is flipped to 'live' only AFTER the shadow run is
-- validated (a one-line cron.alter_job / re-schedule), so applying this migration
-- can never start creating real Content on its own.

create or replace function public.run_esl(p_mode text default 'live')
returns void
language plpgsql
security definer
set search_path = 'public', 'net'
as $function$
begin
  perform net.http_post(
    url := 'https://ukraltlejlfkqbcifgcq.supabase.co/functions/v1/radar-editorial-select',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrcmFsdGxlamxma3FiY2lmZ2NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3Mzk1MDAsImV4cCI6MjA5ODMxNTUwMH0.dgTWGjHELu8BML_pNWdtCb0bmagD2KKBr97Rwv4yFl8'
    ),
    body := jsonb_build_object('mode', coalesce(nullif(trim(p_mode), ''), 'live')),
    timeout_milliseconds := 150000
  );
end;
$function$;

revoke execute on function public.run_esl(text) from public, anon, authenticated;

-- 3×/day schedule (06:00, 12:00, 18:00 UTC). Idempotent: drop any prior job of
-- the same name first. Starts in SHADOW mode; flipping to live is a one-liner
-- re-schedule once the shadow output is validated:
--   select cron.schedule('salma-esl', '0 6,12,18 * * *', $$ select public.run_esl('live'); $$);
select cron.unschedule('salma-esl')
where exists (select 1 from cron.job where jobname = 'salma-esl');

select cron.schedule('salma-esl', '0 6,12,18 * * *', $$ select public.run_esl('shadow'); $$);

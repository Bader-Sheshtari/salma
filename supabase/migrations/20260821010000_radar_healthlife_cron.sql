-- Healthy-Life / Quality-of-Life Radar intake (ESL V1.1).
--
-- Fires the SAME radar-shadow edge function with {"profile":"healthy_life"}, which
-- runs a bounded lifestyle-health topic-page (sleep, activity, nutrition,
-- prevention, wellbeing…) on its own longer freshness window + checkpoint. Rows
-- land in the same radar_shadow_articles table, get ranked by radar-rank, and are
-- selected by the ESL — no parallel Content path. This does NOT lower editorial
-- standards; it only improves the SUPPLY of credible Healthy-Life candidates.
--
-- Cost: one billable getArticlesForTopicPage call per run × 3 runs/day (bounded,
-- documented). The default 'medical' every-2h intake is unchanged.

create or replace function public.run_radar_healthlife()
returns void
language plpgsql
security definer
set search_path = 'public', 'net'
as $function$
begin
  perform net.http_post(
    url := 'https://ukraltlejlfkqbcifgcq.supabase.co/functions/v1/radar-shadow',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrcmFsdGxlamxma3FiY2lmZ2NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3Mzk1MDAsImV4cCI6MjA5ODMxNTUwMH0.dgTWGjHELu8BML_pNWdtCb0bmagD2KKBr97Rwv4yFl8'
    ),
    body := '{"profile":"healthy_life"}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$function$;

revoke all on function public.run_radar_healthlife() from public, anon, authenticated;

-- 3×/day (01:30, 09:30, 17:30 UTC), offset from the medical intake and the ESL
-- runs. Idempotent re-schedule.
select cron.unschedule('salma-radar-healthlife')
where exists (select 1 from cron.job where jobname = 'salma-radar-healthlife');

select cron.schedule('salma-radar-healthlife', '30 1,9,17 * * *', $$ select public.run_radar_healthlife(); $$);

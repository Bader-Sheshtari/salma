create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Admin-only config holding the deployed ingestion URL + shared cron secret.
create table if not exists public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;
drop policy if exists app_config_admin_all on public.app_config;
create policy app_config_admin_all on public.app_config
  for all using (public.is_admin()) with check (public.is_admin());

-- Placeholders the user fills in AFTER deploying to Vercel.
insert into public.app_config (key, value) values
  ('ingest_url', ''),
  ('cron_secret', '')
on conflict (key) do nothing;

-- Cron entrypoint: POST to the Vercel /api/ingest route with the bearer secret.
-- No-ops until both config values are set, so it is safe to schedule now.
create or replace function public.run_news_ingestion()
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_url text;
  v_secret text;
begin
  select value into v_url from public.app_config where key = 'ingest_url';
  select value into v_secret from public.app_config where key = 'cron_secret';
  if v_url is null or v_url = '' or v_secret is null or v_secret = '' then
    return;
  end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 290000
  );
end;
$$;

revoke all on function public.run_news_ingestion() from public, anon, authenticated;

-- Run every 6 hours. Unschedule any prior job of the same name first.
select cron.unschedule('salma-news-ingest')
where exists (select 1 from cron.job where jobname = 'salma-news-ingest');

select cron.schedule('salma-news-ingest', '0 */6 * * *', $$ select public.run_news_ingestion(); $$);
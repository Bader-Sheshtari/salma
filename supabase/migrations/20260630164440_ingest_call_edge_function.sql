create or replace function public.run_news_ingestion()
returns void
language plpgsql
security definer
set search_path to 'public', 'net'
as $function$
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
      'x-ingest-secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 290000
  );
end;
$function$;
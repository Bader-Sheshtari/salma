-- Migration: ai_image_usage_rate_limits
-- Purpose: atomic, DB-enforced rate limiting + credit-abuse protection for the
-- AI cover-image generator (generate-image Edge Function).
--
-- Everything below is idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP ...
-- IF EXISTS) because the remote migration history has no down-migrations.
--
-- Security model:
--   * RLS is ENABLED with NO policies, and all grants are REVOKED from anon /
--     authenticated. No browser-side client can read, insert, or update usage.
--   * Only service_role (used by the Edge Function via SERVICE_ROLE_KEY) can
--     touch the table, and only service_role may EXECUTE the two RPCs.
--   * The RPCs are SECURITY INVOKER (not DEFINER): the only caller is
--     service_role, which already bypasses RLS and holds the table grants, so
--     DEFINER would add privilege-escalation surface for zero benefit. Each
--     function pins `search_path = ''` and schema-qualifies every object, and
--     uses no dynamic SQL — so there is no search_path / injection vector.

-- ---------------------------------------------------------------------------
-- 1. Usage / reservation ledger
-- ---------------------------------------------------------------------------
create table if not exists public.ai_image_usage (
  id                  bigint generated always as identity primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  quality             text not null check (quality in ('fast','premium')),
  requested_image_count int  not null check (requested_image_count between 1 and 3),
  actual_image_count  int  not null default 0 check (actual_image_count between 0 and 3),
  status              text not null default 'reserved'
                        check (status in ('reserved','succeeded','failed')),
  failure_reason      text,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);

-- Rolling-window lookups: per-user recent activity, and global recent activity.
create index if not exists ai_image_usage_user_created_idx
  on public.ai_image_usage (user_id, created_at desc);
create index if not exists ai_image_usage_status_created_idx
  on public.ai_image_usage (status, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Lock the table down: RLS on, no policies, no client grants
-- ---------------------------------------------------------------------------
alter table public.ai_image_usage enable row level security;
-- (No CREATE POLICY: with RLS on and no policy, non-superusers get nothing.)

revoke all on table public.ai_image_usage from anon, authenticated;

grant select, insert, update on table public.ai_image_usage to service_role;

-- The identity column has an IMPLICIT sequence. Resolve its real name at
-- migration time (never assume 'ai_image_usage_id_seq') and lock it down too,
-- so no browser-side role can read or advance it. %I would double-quote an
-- already-qualified name, so we use %s on the schema-qualified text that
-- pg_get_serial_sequence returns (lowercase, unquoted, safe here).
--   Verify afterwards with:
--     select pg_get_serial_sequence('public.ai_image_usage', 'id');
do $$
declare
  v_seq text := pg_get_serial_sequence('public.ai_image_usage', 'id');
begin
  if v_seq is null then
    raise exception 'could not resolve identity sequence for public.ai_image_usage.id';
  end if;
  execute format('revoke all on sequence %s from public, anon, authenticated;', v_seq);
  execute format('grant usage, select on sequence %s to service_role;', v_seq);
end $$;

-- ---------------------------------------------------------------------------
-- 3. Atomic reservation RPC
-- ---------------------------------------------------------------------------
-- In ONE transaction: expire stale reservations, check per-user + global
-- limits, and (if allowed) insert a 'reserved' row. A transaction-scoped
-- advisory lock serializes concurrent callers so two simultaneous requests
-- cannot both pass a limit before either has inserted its usage row.
--
-- Reserved rows count toward the limits (in-flight spend), so parallel
-- tabs / browsers / admins all draw from the same metered pool.
create or replace function public.reserve_ai_image(
  p_user_id                 uuid,
  p_quality                 text,
  p_requested               int,
  p_max_req_per_min         int,
  p_max_images_user_24h     int,
  p_max_images_global_24h   int,
  p_max_premium_global_24h  int,
  p_stale_seconds           int
)
returns table (allowed boolean, reservation_id bigint, reason text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_req_last_min      int;
  v_user_images_24h   int;
  v_global_images_24h int;
  v_premium_24h       int;
  v_new_id            bigint;
begin
  -- Defensive argument validation (fail closed on nonsense input).
  if p_user_id is null
     or p_quality not in ('fast','premium')
     or p_requested is null or p_requested < 1 or p_requested > 3
     or coalesce(p_max_req_per_min, 0)        < 1
     or coalesce(p_max_images_user_24h, 0)    < 1
     or coalesce(p_max_images_global_24h, 0)  < 1
     or coalesce(p_max_premium_global_24h, 0) < 1
     or coalesce(p_stale_seconds, 0)          < 1 then
    return query select false, null::bigint, 'bad_request'::text;
    return;
  end if;

  -- Serialize the check+insert. Transaction-scoped: auto-released at commit.
  perform pg_advisory_xact_lock(hashtext('salma:ai_image_reservation'));

  -- Expire stale 'reserved' rows (function crashed / edge timed out before
  -- completing) so they stop counting against the caps.
  update public.ai_image_usage
     set status = 'failed',
         failure_reason = 'expired',
         completed_at = now()
   where status = 'reserved'
     and created_at < now() - make_interval(secs => p_stale_seconds);

  -- Per-user request rate: count EVERY reservation attempt in the last minute
  -- regardless of outcome (reserved, succeeded, failed, expired). This measures
  -- request attempts, so repeated provider failures / abuse are throttled too.
  select count(*) into v_req_last_min
    from public.ai_image_usage
   where user_id = p_user_id
     and created_at >= now() - interval '60 seconds';
  if v_req_last_min >= p_max_req_per_min then
    return query select false, null::bigint, 'rate_user_minute'::text;
    return;
  end if;

  -- Per-user images in the last 24h. Succeeded rows count their ACTUAL output;
  -- still-reserved rows count their REQUESTED amount (worst case, in-flight).
  select coalesce(sum(
           case when status = 'succeeded' then actual_image_count
                when status = 'reserved'  then requested_image_count
                else 0 end), 0)
    into v_user_images_24h
    from public.ai_image_usage
   where user_id = p_user_id
     and created_at >= now() - interval '24 hours';
  if v_user_images_24h + p_requested > p_max_images_user_24h then
    return query select false, null::bigint, 'rate_user_daily'::text;
    return;
  end if;

  -- Global images in the last 24h (all users) — protects the credit balance
  -- even if an admin account is compromised or many admins run in parallel.
  select coalesce(sum(
           case when status = 'succeeded' then actual_image_count
                when status = 'reserved'  then requested_image_count
                else 0 end), 0)
    into v_global_images_24h
    from public.ai_image_usage
   where created_at >= now() - interval '24 hours';
  if v_global_images_24h + p_requested > p_max_images_global_24h then
    return query select false, null::bigint, 'rate_global_daily'::text;
    return;
  end if;

  -- Global PREMIUM images in the last 24h (premium requests only).
  if p_quality = 'premium' then
    select coalesce(sum(
             case when status = 'succeeded' then actual_image_count
                  when status = 'reserved'  then requested_image_count
                  else 0 end), 0)
      into v_premium_24h
      from public.ai_image_usage
     where quality = 'premium'
       and created_at >= now() - interval '24 hours';
    if v_premium_24h + p_requested > p_max_premium_global_24h then
      return query select false, null::bigint, 'rate_premium_global_daily'::text;
      return;
    end if;
  end if;

  -- All checks passed under the lock: reserve.
  insert into public.ai_image_usage (user_id, quality, requested_image_count, status)
  values (p_user_id, p_quality, p_requested, 'reserved')
  returning id into v_new_id;

  return query select true, v_new_id, null::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Completion RPC — settle a reservation as succeeded / failed
-- ---------------------------------------------------------------------------
create or replace function public.complete_ai_image(
  p_reservation_id  bigint,
  p_user_id         uuid,
  p_status          text,
  p_actual          int,
  p_failure_reason  text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_status not in ('succeeded','failed') then
    return; -- ignore invalid settlement calls
  end if;

  update public.ai_image_usage
     set status         = p_status,
         actual_image_count = case
                                when p_status = 'succeeded'
                                  then least(3, greatest(0, coalesce(p_actual, 0)))
                                else 0
                              end,
         failure_reason = case
                            when p_failure_reason is null then null
                            else left(p_failure_reason, 200)
                          end,
         completed_at   = now()
   where id = p_reservation_id
     and user_id = p_user_id
     and status = 'reserved';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Function execution: service_role only
-- ---------------------------------------------------------------------------
revoke all on function public.reserve_ai_image(uuid, text, int, int, int, int, int, int) from public, anon, authenticated;
revoke all on function public.complete_ai_image(bigint, uuid, text, int, text) from public, anon, authenticated;

grant execute on function public.reserve_ai_image(uuid, text, int, int, int, int, int, int) to service_role;
grant execute on function public.complete_ai_image(bigint, uuid, text, int, text) to service_role;

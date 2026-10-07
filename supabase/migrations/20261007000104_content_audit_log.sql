-- CMS lifecycle Phase 1 (4/6) — immutable per-article audit trail.
--
-- One row per lifecycle event (created / edited / submitted / returned /
-- reviewed / published / unpublished / republished / rejected / deleted /
-- restored / version_restored / category_changed / flag_changed / imported).
--
-- Design:
--   * content_id has NO foreign key on purpose: the history must outlive the
--     article (a hard delete must never erase or cascade the audit trail).
--   * details carries changed field NAMES and flags only — never content values.
--   * Writes happen ONLY from the content lifecycle triggers (SECURITY DEFINER
--     function owned by postgres, migration 106). No client role (anon,
--     authenticated, service_role) holds INSERT/UPDATE/DELETE/TRUNCATE.
--   * Append-only even for admins and the service role: a BEFORE UPDATE/DELETE
--     row trigger and a BEFORE TRUNCATE statement trigger raise. The single
--     exception is the anonymisation performed by the actor_id foreign key
--     (profiles ON DELETE SET NULL): without it, deleting a user account would
--     fail. That update may ONLY null actor_id; every other column must be
--     unchanged.
--   * INSERTs are never blocked (the immutability trigger is not an INSERT
--     trigger), so the content triggers can always append.
--   * Admins can read (same is_admin() pattern as the other admin-read tables).
--
-- Relationship to editorial_feedback_events: that table is the AI-learning
-- signal (written app-side, best-effort). This table is the authoritative,
-- DB-enforced lifecycle history. Existing publish/unpublish/reject feedback
-- events are converted below so the history starts complete.

create table if not exists public.content_audit_log (
  id          bigint generated always as identity primary key,
  content_id  uuid not null,
  event       text not null check (event in (
                'created','edited','submitted','returned','reviewed','published',
                'unpublished','republished','rejected','deleted','restored',
                'version_restored','category_changed','flag_changed','imported')),
  from_status text,
  to_status   text,
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_kind  text not null check (actor_kind in ('user','system')),
  version_no  integer,
  details     jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists content_audit_log_content_idx
  on public.content_audit_log (content_id, created_at desc);
create index if not exists content_audit_log_actor_idx
  on public.content_audit_log (actor_id, created_at desc)
  where actor_id is not null;

-- ---- Access: admin read-only, no client writes ---------------------------
alter table public.content_audit_log enable row level security;
drop policy if exists content_audit_log_admin_select on public.content_audit_log;
create policy content_audit_log_admin_select on public.content_audit_log
  for select using (public.is_admin());
-- Deliberately NO insert/update/delete policies.

revoke all on table public.content_audit_log from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.content_audit_log from authenticated, service_role;

-- ---- Immutability ---------------------------------------------------------
create or replace function public.content_audit_log_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    -- Only the FK anonymisation (profiles ON DELETE SET NULL) is permitted.
    if old.actor_id is not null and new.actor_id is null
       and (to_jsonb(new) - 'actor_id') = (to_jsonb(old) - 'actor_id') then
      return new;
    end if;
  end if;
  raise exception 'content_audit_log is append-only (% not allowed)', tg_op;
end;
$$;

revoke execute on function public.content_audit_log_immutable() from public, anon, authenticated;

drop trigger if exists content_audit_log_immutable on public.content_audit_log;
create trigger content_audit_log_immutable
  before update or delete on public.content_audit_log
  for each row execute function public.content_audit_log_immutable();

drop trigger if exists content_audit_log_no_truncate on public.content_audit_log;
create trigger content_audit_log_no_truncate
  before truncate on public.content_audit_log
  for each statement execute function public.content_audit_log_immutable();

-- ---- Seed (idempotent) ----------------------------------------------------
-- (a) One 'imported' event per existing content row: marks the point where
--     DB-enforced history begins. System actor, current status, now().
insert into public.content_audit_log
  (content_id, event, from_status, to_status, actor_id, actor_kind, version_no, details)
select c.id, 'imported', null, c.status, null, 'system', c.version,
       jsonb_build_object('seed', true)
  from public.content c
 where not exists (
   select 1 from public.content_audit_log a
    where a.content_id = c.id and a.event = 'imported');

-- (b) Convert the existing human publish/unpublish/reject decisions recorded by
--     the editorial feedback loop, keeping their original timestamps/actors.
--     before_value/after_value hold statuses for these three actions; anything
--     that is not a known status is dropped rather than copied.
insert into public.content_audit_log
  (content_id, event, from_status, to_status, actor_id, actor_kind, version_no, details, created_at)
select e.content_id,
       case e.action when 'publish'   then 'published'
                     when 'unpublish' then 'unpublished'
                     else 'rejected' end,
       case when e.before_value in ('draft','pending','published','rejected','unpublished')
            then e.before_value end,
       case e.action when 'publish' then 'published'
                     when 'reject'  then 'rejected'
                     else case when e.after_value in ('draft','pending','published','rejected','unpublished')
                               then e.after_value end end,
       e.actor_id,
       case when e.actor_id is not null then 'user' else 'system' end,
       null,
       jsonb_strip_nulls(jsonb_build_object(
         'seed', true,
         'source', 'editorial_feedback_events',
         'feedback_event_id', e.id,
         'reason', e.reason)),
       e.created_at
  from public.editorial_feedback_events e
 where e.action in ('publish','unpublish','reject')
   and not exists (
     select 1 from public.content_audit_log a
      where a.content_id = e.content_id
        and a.details ->> 'feedback_event_id' = e.id::text);

-- ROLLBACK (drops the whole history — only before go-live):
-- drop table if exists public.content_audit_log;
-- drop function if exists public.content_audit_log_immutable();

-- U1 — Users & Access Foundation + Owner Protection (approved 2026-10-09).
--
-- DATABASE side only. One migration, applied as a unit:
--   1. profiles.role CHECK widened with 'editor'.
--   2. public.is_staff() — editor | admin | super_admin | owner, not disabled.
--   3. CONTENT-SCOPE RLS policies flipped from is_admin() to is_staff()
--      (content, content_sources, content_media, content_versions,
--      content_audit_log, storage.objects media bucket) plus two READ-ONLY
--      editor-review parity policies: profiles_select_own_or_admin (SELECT
--      only, so editors resolve colleagues' names) and
--      radar_evidence_intelligence_admin_select (Evidence Card panel). Same
--      names, same commands, same USING / WITH CHECK shape — only the helper
--      changes (profiles: own-row OR is_staff()).
--      Every other ADMIN-SCOPE policy (app_config, other radar_*, ingestion_*,
--      news_sources, editorial_*, categories write, homepage, comments,
--      doctors/departments/transfers, social_*, newsletter, profiles UPDATE,
--      ...) is NOT touched.
--   4. search_content / content_counts / restore_content_version re-created
--      with the is_staff() guard. Bodies are copied verbatim from
--      20261007100100_content_search.sql and 20261008000100_version_restore.sql;
--      the ONLY change in each is the single guard line.
--   5. guard_profile_changes v3 — OWNER WALL evaluated before the service_role
--      bypass; trigger now fires BEFORE INSERT OR UPDATE; super_admin's
--      manageable set gains 'editor'. Every v2 rule (20260821120000) is kept.
--   6. guard_profile_delete v2 — the owner row can never be deleted.
--   7. public.admin_audit_log — append-only (content_audit_log pattern).
--   8. profiles AFTER INSERT/UPDATE audit trigger (never raises).
--   9. public.log_admin_denied(...) RPC — app-side logging of refused attempts
--      (a DB-refused write rolls back, so it cannot audit itself).
--
-- No profiles row is modified by this migration; no role is assigned.

-- ===========================================================================
-- 1. Role CHECK: + 'editor'  (pure widening; every existing value stays valid)
-- ===========================================================================
do $$ begin
  alter table public.profiles drop constraint if exists profiles_role_check;
  alter table public.profiles
    add constraint profiles_role_check
    check (role in ('user','editor','admin','super_admin','owner'));
end $$;

-- ===========================================================================
-- 2. is_staff() — content-area access (editor and above, active accounts)
-- ===========================================================================
-- SECURITY DEFINER so RLS checks don't recurse into profiles RLS (same as
-- is_admin()). Granted to anon too: it is evaluated inside permissive RLS
-- policies (e.g. content SELECT is OR'ed with content_public_read), so an
-- anonymous reader must be able to execute it (it returns false for them).
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('editor','admin','super_admin','owner')
      and disabled = false
  );
$$;

grant execute on function public.is_staff() to anon, authenticated, service_role;

-- ===========================================================================
-- 3. CONTENT-SCOPE policies → is_staff()
-- ===========================================================================
-- content  (20260629153004)
drop policy if exists "content_admin_read" on public.content;
create policy "content_admin_read" on public.content
  for select using (public.is_staff());
-- Split by command: editors may read/create/edit content but only admin+ may
-- hard-DELETE a content row. (content_sources / content_media below keep
-- is_staff FOR ALL: editors legitimately delete/replace those rows while editing.)
drop policy if exists "content_admin_write" on public.content;
drop policy if exists "content_staff_insert" on public.content;
create policy "content_staff_insert" on public.content
  for insert with check (public.is_staff());
drop policy if exists "content_staff_update" on public.content;
create policy "content_staff_update" on public.content
  for update using (public.is_staff()) with check (public.is_staff());
drop policy if exists "content_admin_delete" on public.content;
create policy "content_admin_delete" on public.content
  for delete using (public.is_admin());

-- content_sources  (20260629153004)
drop policy if exists "sources_admin_read" on public.content_sources;
create policy "sources_admin_read" on public.content_sources
  for select using (public.is_staff());
drop policy if exists "sources_admin_write" on public.content_sources;
create policy "sources_admin_write" on public.content_sources
  for all using (public.is_staff()) with check (public.is_staff());

-- content_media  (20260630142738)
drop policy if exists media_admin_read on public.content_media;
create policy media_admin_read on public.content_media
  for select using (public.is_staff());
drop policy if exists media_admin_write on public.content_media;
create policy media_admin_write on public.content_media
  for all using (public.is_staff()) with check (public.is_staff());

-- content_versions  (20261007000105)
drop policy if exists content_versions_admin_select on public.content_versions;
create policy content_versions_admin_select on public.content_versions
  for select using (public.is_staff());

-- content_audit_log  (20261007000104)
drop policy if exists content_audit_log_admin_select on public.content_audit_log;
create policy content_audit_log_admin_select on public.content_audit_log
  for select using (public.is_staff());

-- storage.objects, media bucket  (20260630142753; media_public_read stays
-- dropped per 20260731113326)
drop policy if exists "media_admin_insert" on storage.objects;
create policy "media_admin_insert" on storage.objects
  for insert with check (bucket_id = 'media' and public.is_staff());
drop policy if exists "media_admin_update" on storage.objects;
create policy "media_admin_update" on storage.objects
  for update using (bucket_id = 'media' and public.is_staff())
  with check (bucket_id = 'media' and public.is_staff());
drop policy if exists "media_admin_delete" on storage.objects;
create policy "media_admin_delete" on storage.objects
  for delete using (bucket_id = 'media' and public.is_admin());

-- profiles read  (20260629145507) — editor content-review parity: editors must
-- resolve colleagues' display names for timelines / author columns. SELECT
-- only; the profiles UPDATE policy and guard triggers are untouched.
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (id = auth.uid() or public.is_staff());

-- radar_evidence_intelligence read  (20260821040000) — editor content-review
-- parity: editors reviewing content need the Evidence Card panel. This is the
-- ONLY radar_* table that flips; every other radar policy stays is_admin().
drop policy if exists radar_evidence_intelligence_admin_select on public.radar_evidence_intelligence;
create policy radar_evidence_intelligence_admin_select on public.radar_evidence_intelligence
  for select using (public.is_admin() or (content_id is not null and public.is_staff()));

-- ===========================================================================
-- 4. Content RPCs → is_staff() guard (bodies verbatim; ONE line changed each)
-- ===========================================================================
-- 4a. search_content  (from 20261007100100 §5)
create or replace function public.search_content(
  p_q             text        default null,
  p_status        text        default 'published',
  p_category      text        default null,
  p_from          date        default null,
  p_to            date        default null,
  p_author        uuid        default null,
  p_author_system boolean     default false,
  p_reviewer      uuid        default null,
  p_publisher     uuid        default null,
  p_sort          text        default null,
  p_cursor_ts     timestamptz default null,
  p_cursor_id     uuid        default null,
  p_limit         integer     default 50
)
returns table (
  id               uuid,
  title            text,
  slug             text,
  type             text,
  status           text,
  category_slug    text,
  category_name_ar text,
  published_at     timestamptz,
  last_edited_at   timestamptz,
  deleted_at       timestamptz,
  author_name      text,
  deleted_by_name  text,
  version          integer
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_status text    := pg_catalog.lower(coalesce(nullif(btrim(p_status), ''), 'published'));
  v_sort   text    := pg_catalog.lower(nullif(btrim(p_sort), ''));
  v_q      text    := nullif(public.ar_normalize(p_q), '');
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 101);
  v_col    text;
  v_dir    text;
  v_cmp    text;
  v_from   timestamptz;
  v_to     timestamptz;
  v_where  text[]  := array[]::text[];
  v_sql    text;
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_status not in ('all','draft','pending','published','rejected','unpublished','trash') then
    raise exception 'search_content: invalid p_status %', quote_literal(p_status)
      using errcode = '22023';
  end if;
  if v_sort is not null
     and v_sort not in ('published_desc','published_asc','edited_desc','deleted_desc') then
    raise exception 'search_content: invalid p_sort %', quote_literal(p_sort)
      using errcode = '22023';
  end if;

  -- Sort resolution (whitelist only — v_col/v_dir are the only identifiers
  -- interpolated into the dynamic SQL; every value goes through USING).
  if v_sort = 'deleted_desc' and v_status <> 'trash' then
    v_sort := null;
  end if;
  if v_sort is null then
    v_sort := case v_status
                when 'trash'     then 'deleted_desc'
                when 'published' then 'published_desc'
                else 'edited_desc'
              end;
  end if;
  v_col := case v_sort
             when 'edited_desc'  then 'c.last_edited_at'
             when 'deleted_desc' then 'c.deleted_at'
             else 'c.published_at'
           end;
  v_dir := case when v_sort = 'published_asc' then 'asc'  else 'desc' end;
  v_cmp := case when v_sort = 'published_asc' then '>'    else '<'    end;

  -- Status / trash scope.
  if v_status = 'trash' then
    v_where := array_append(v_where, 'c.deleted_at is not null');
  else
    v_where := array_append(v_where, 'c.deleted_at is null');
    if v_status <> 'all' then
      v_where := array_append(v_where, 'c.status = $2');
    end if;
  end if;

  if p_category is not null then
    v_where := array_append(v_where, 'c.category_slug = $3');
  end if;

  -- Date range on the active sort column, Kuwait calendar days, inclusive.
  if p_from is not null then
    v_from  := p_from::timestamp at time zone 'Asia/Kuwait';
    v_where := array_append(v_where, format('%s >= $4', v_col));
  end if;
  if p_to is not null then
    v_to    := (p_to + 1)::timestamp at time zone 'Asia/Kuwait';
    v_where := array_append(v_where, format('%s < $5', v_col));
  end if;

  if coalesce(p_author_system, false) then
    v_where := array_append(v_where, 'c.created_by is null');
  elsif p_author is not null then
    v_where := array_append(v_where, 'c.created_by = $6');
  end if;
  if p_reviewer is not null then
    v_where := array_append(v_where, 'c.reviewed_by = $7');
  end if;
  if p_publisher is not null then
    v_where := array_append(v_where, 'c.published_by = $8');
  end if;

  if v_q is not null then
    v_where := array_append(v_where,
      '(c.search_norm like (''%'' || $1 || ''%'')'
      || ' or c.body_tsv @@ plainto_tsquery(''simple''::regconfig, $1))');
  end if;

  -- Keyset cursor (NULLS LAST aware).
  if p_cursor_id is not null then
    if p_cursor_ts is not null then
      v_where := array_append(v_where,
        format('((%1$s, c.id) %2$s ($9, $10) or %1$s is null)', v_col, v_cmp));
    else
      v_where := array_append(v_where,
        format('(%1$s is null and c.id %2$s $10)', v_col, v_cmp));
    end if;
  end if;

  v_sql := format($q$
    select c.id, c.title, c.slug, c.type, c.status, c.category_slug, cat.name_ar,
           c.published_at, c.last_edited_at, c.deleted_at,
           case when c.created_by is null then null
                else coalesce(nullif(btrim(pa.full_name), ''), pa.email) end,
           case when c.deleted_by is null then null
                else coalesce(nullif(btrim(pd.full_name), ''), pd.email) end,
           c.version
      from public.content c
      left join public.categories cat on cat.slug = c.category_slug
      left join public.profiles   pa  on pa.id    = c.created_by
      left join public.profiles   pd  on pd.id    = c.deleted_by
     where %1$s
     order by %2$s %3$s nulls last, c.id %3$s
     limit $11
  $q$, array_to_string(v_where, ' and '), v_col, v_dir);

  return query execute v_sql
    using v_q, v_status, p_category, v_from, v_to,
          p_author, p_reviewer, p_publisher,
          p_cursor_ts, p_cursor_id, v_limit;
end;
$$;

comment on function public.search_content(text, text, text, date, date, uuid, boolean, uuid, uuid, text, timestamptz, uuid, integer) is
  'CMS Phase 2: content list/search with keyset pagination. Staff-only (editor and above, U1); never returns body.';

revoke all on function public.search_content(text, text, text, date, date, uuid, boolean, uuid, uuid, text, timestamptz, uuid, integer)
  from public, anon;
grant execute on function public.search_content(text, text, text, date, date, uuid, boolean, uuid, uuid, text, timestamptz, uuid, integer)
  to authenticated, service_role;

-- 4b. content_counts  (from 20261007100100 §6)
create or replace function public.content_counts()
returns table (scope text, status text, category_slug text, n bigint)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select (case when grouping(g.cat) = 1 then 'status' else 'category' end)::text,
         (case when grouping(g.st)  = 1 then 'all'    else g.st       end)::text,
         (case when grouping(g.cat) = 1 then null     else g.cat      end)::text,
         case when grouping(g.st) = 1
              then count(*) filter (where g.st <> 'trash')
              else count(*)
         end
    from (select case when c.deleted_at is not null then 'trash' else c.status end as st,
                 c.category_slug as cat
            from public.content c) g
   group by grouping sets ((g.st), (g.st, g.cat), (), (g.cat))
  having not (grouping(g.st) = 0 and grouping(g.cat) = 0 and g.st = 'trash')
     and (grouping(g.st) = 0 or count(*) filter (where g.st <> 'trash') > 0)
   order by 1, 2, 3;
end;
$$;

comment on function public.content_counts() is
  'CMS Phase 2: tab counts (scope=status, incl. all/trash) and category-strip counts (scope=category). Staff-only (editor and above, U1).';

revoke all on function public.content_counts() from public, anon;
grant execute on function public.content_counts() to authenticated, service_role;

-- 4c. restore_content_version  (from 20261008000100)
create or replace function public.restore_content_version(
  p_content_id uuid,
  p_version_no integer
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_live        public.content;
  v_snap        public.content_versions;
  v_new_version integer;
  v_category    text;
  v_cat_kept    boolean := false;
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Lock the live row so a concurrent edit cannot interleave between the
  -- comparison and the UPDATE.
  select c.* into v_live
    from public.content c
   where c.id = p_content_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'المادة غير موجودة.');
  end if;
  if v_live.deleted_at is not null then
    return jsonb_build_object('ok', false, 'reason',
      'المادة في المحذوفات — استعِدها من المحذوفات أولًا ثم استعد الإصدار.');
  end if;

  select v.* into v_snap
    from public.content_versions v
   where v.content_id = p_content_id
     and v.version_no = p_version_no;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'الإصدار المطلوب غير موجود.');
  end if;

  -- Nothing to restore (slug deliberately excluded — see header).
  if (v_snap.title, v_snap.excerpt, v_snap.body, v_snap.ai_summary, v_snap.category_slug,
      v_snap.type, v_snap.cover_image_url, v_snap.cover_credit_name, v_snap.cover_credit_url,
      v_snap.source_name, v_snap.source_url, v_snap.video_url)
     is not distinct from
     (v_live.title, v_live.excerpt, v_live.body, v_live.ai_summary, v_live.category_slug,
      v_live.type, v_live.cover_image_url, v_live.cover_credit_name, v_live.cover_credit_url,
      v_live.source_name, v_live.source_url, v_live.video_url) then
    return jsonb_build_object('ok', true, 'no_change', true);
  end if;

  -- Category: the snapshot's category may have been deleted since (FK to
  -- public.categories(slug)). Rather than failing the whole restore, keep the
  -- LIVE row's current category in that case and report category_kept = true.
  v_category := v_snap.category_slug;
  if v_category is not null
     and not exists (select 1 from public.categories k where k.slug = v_category) then
    v_category := v_live.category_slug;
    v_cat_kept := true;
  end if;

  -- Tell content_lifecycle_after this UPDATE is a version restore.
  perform set_config('salma.restore_from_version', p_version_no::text, true);

  update public.content c
     set title             = v_snap.title,
         -- slug: intentionally NOT restored (public URL stability).
         excerpt           = v_snap.excerpt,
         body              = v_snap.body,
         ai_summary        = v_snap.ai_summary,
         category_slug     = v_category,
         type              = v_snap.type,
         cover_image_url   = v_snap.cover_image_url,
         cover_credit_name = v_snap.cover_credit_name,
         cover_credit_url  = v_snap.cover_credit_url,
         source_name       = v_snap.source_name,
         source_url        = v_snap.source_url,
         video_url         = v_snap.video_url
   where c.id = p_content_id
     and c.deleted_at is null
  returning c.version into v_new_version;

  perform set_config('salma.restore_from_version', '', true);

  if v_new_version is null then
    return jsonb_build_object('ok', false, 'reason',
      'تعذّرت استعادة الإصدار — لم يُحدَّث المحتوى.');
  end if;

  return jsonb_build_object('ok', true,
                            'new_version', v_new_version,
                            'restored_from', p_version_no,
                            'category_kept', v_cat_kept);
end;
$$;

comment on function public.restore_content_version(uuid, integer) is
  'CMS Phase 4: restore an article''s editable content (except slug) from a content_versions snapshot. Staff-only (editor and above, U1). Status/flags/dates unchanged; the superseded content is kept as a new version; audited as version_restored.';

revoke all on function public.restore_content_version(uuid, integer) from public, anon;
grant execute on function public.restore_content_version(uuid, integer) to authenticated, service_role;

-- ===========================================================================
-- 5. guard_profile_changes v3
-- ===========================================================================
-- Order of evaluation (first failing rule raises; the write is aborted):
--
--   (0) OWNER WALL — ALL actors, service_role and table-owner sessions included:
--       (0a) INSERT or UPDATE with NEW.role = 'owner' and OLD.role distinct
--            from 'owner' → 'owner role cannot be granted'. No path creates a
--            second owner, period.
--       (0b) UPDATE of a row whose OLD.role = 'owner':
--            * role change                → always refused;
--            * disabled false → true      → always refused;
--            * ANY change by an actor other than the owner themself
--              (auth.uid() <> OLD.id, incl. service_role / no-auth) → refused.
--              Single carve-out: the profiles.created_by FK anonymisation
--              (ON DELETE SET NULL when the referenced profile is deleted) —
--              that update may ONLY null created_by (updated_at is ignored);
--              every other column must be unchanged. Without it, deleting the
--              account that created the owner row would fail.
--            The owner's own edits of name / email / last_login_at /
--            notification_prefs pass the wall.
--       INSERTs stop here (handle_new_user inserts role 'user' with no
--       auth.uid(); service-role inserts likewise — only 'owner' is refused).
--   (a)/(b) last-owner protections — verbatim from v2 (now also covered by the
--       wall, kept as defence in depth).
--   service_role bypass — unrestricted for everything else (createAdmin's
--       elevation user → editor/admin/super_admin keeps working).
--   (c) role changes: never your own; actor must be an ACTIVE super_admin or
--       owner; any owner transition needs an owner actor (v2 rule, subsumed by
--       0a/0b); a super_admin may only move targets within
--       ('user','admin','editor') — never touches or grants super_admin/owner.
--   (d) disabled changes: never your own; ACTIVE super_admin/owner only; owner
--       targets need an owner actor (v2 rule, subsumed by 0b); a super_admin may
--       only act on ('user','admin','editor') targets.
create or replace function public.guard_profile_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_service  boolean := coalesce(auth.role() = 'service_role', false)
                          or coalesce((auth.jwt() ->> 'role') = 'service_role', false);
  actor_id       uuid := auth.uid();
  actor_role     text;
  actor_disabled boolean;
begin
  -- (0a) OWNER WALL — the owner role can never be granted, by anyone.
  if tg_op = 'INSERT' then
    if new.role = 'owner' then
      raise exception 'owner role cannot be granted';
    end if;
    return new;
  end if;

  if new.role = 'owner' and old.role is distinct from 'owner' then
    raise exception 'owner role cannot be granted';
  end if;

  -- (0b) OWNER WALL — the owner row is untouchable by anyone but the owner.
  if old.role = 'owner' then
    if new.role is distinct from old.role then
      raise exception 'the owner role cannot be changed';
    end if;
    if new.disabled = true and old.disabled = false then
      raise exception 'the owner account cannot be suspended';
    end if;
    if actor_id is distinct from old.id
       and not (old.created_by is not null and new.created_by is null
                and (to_jsonb(new) - 'created_by' - 'updated_at')
                    = (to_jsonb(old) - 'created_by' - 'updated_at')
                and pg_trigger_depth() > 1) then
      raise exception 'the owner account is protected: only the owner may modify it';
    end if;
  end if;

  -- (a)/(b) never demote or disable the last active owner — applies to ALL
  -- callers, service role included.
  if old.role = 'owner' and new.role is distinct from 'owner'
     and (select count(*) from public.profiles
          where role = 'owner' and disabled = false and id <> old.id) = 0 then
    raise exception 'cannot demote the last owner';
  end if;
  if old.role = 'owner' and new.disabled = true and old.disabled = false
     and (select count(*) from public.profiles
          where role = 'owner' and disabled = false and id <> old.id) = 0 then
    raise exception 'cannot disable the last owner';
  end if;

  if is_service then
    return new;
  end if;

  select p.role, p.disabled into actor_role, actor_disabled
  from public.profiles p where p.id = actor_id;

  -- (b2) a super_admin may only modify user/admin/editor rows (any field):
  -- peer super_admins and above are off-limits. Own-row self-edits fall
  -- through to the per-field rules below (role/status self-changes are refused).
  if actor_role = 'super_admin' and not coalesce(actor_disabled, true)
     and actor_id is distinct from old.id
     and old.role not in ('user', 'admin', 'editor') then
    raise exception 'super admins cannot modify peer or higher accounts';
  end if;

  -- (c) role changes
  if new.role is distinct from old.role then
    if actor_id is not distinct from new.id then
      raise exception 'cannot change your own role';
    end if;
    if actor_role is null or coalesce(actor_disabled, true)
       or actor_role not in ('super_admin', 'owner') then
      raise exception 'not authorized to change roles';
    end if;
    if (old.role = 'owner' or new.role = 'owner') and actor_role <> 'owner' then
      raise exception 'only an owner may grant or change the owner role';
    end if;
    if actor_role = 'super_admin'
       and (old.role not in ('user', 'admin', 'editor')
            or new.role not in ('user', 'admin', 'editor')) then
      raise exception 'super_admin may only manage user/admin/editor roles';
    end if;
  end if;

  -- (d) disabled changes
  if new.disabled is distinct from old.disabled then
    if actor_id is not distinct from new.id then
      raise exception 'cannot change your own account status';
    end if;
    if actor_role is null or coalesce(actor_disabled, true)
       or actor_role not in ('super_admin', 'owner') then
      raise exception 'not authorized to change account status';
    end if;
    if old.role = 'owner' and actor_role <> 'owner' then
      raise exception 'only an owner may change an owner account';
    end if;
    if actor_role = 'super_admin' and old.role not in ('user', 'admin', 'editor') then
      raise exception 'super_admin may only manage user/admin/editor accounts';
    end if;
  end if;

  return new;
end;
$$;

-- Trigger-only function: must not be RPC-callable.
revoke execute on function public.guard_profile_changes() from public, anon, authenticated;

-- Was BEFORE UPDATE only (20260629145519); now also guards INSERT (0a).
drop trigger if exists guard_profile_changes_trg on public.profiles;
create trigger guard_profile_changes_trg
  before insert or update on public.profiles
  for each row execute function public.guard_profile_changes();

-- ===========================================================================
-- 6. guard_profile_delete v2 — the owner row can never be deleted
-- ===========================================================================
-- Supersedes the last-owner-only rule (20260701153625): ANY row with
-- role = 'owner' is refused, for every actor (service_role, table owner, and
-- the auth.users ON DELETE CASCADE path alike).
create or replace function public.guard_profile_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.role = 'owner' then
    raise exception 'the owner account cannot be deleted';
  end if;
  return old;
end;
$function$;

revoke execute on function public.guard_profile_delete() from public, anon, authenticated;

drop trigger if exists guard_profile_delete_trg on public.profiles;
create trigger guard_profile_delete_trg
  before delete on public.profiles
  for each row execute function public.guard_profile_delete();

-- ===========================================================================
-- 7. admin_audit_log — append-only user/access audit trail
-- ===========================================================================
--   * target_id has NO foreign key on purpose (history outlives the account);
--     target_name / target_email are snapshots taken at event time.
--   * actor_id → profiles ON DELETE SET NULL, with actor_name / actor_role
--     snapshots so the row stays readable after anonymisation.
--   * Writes happen ONLY from SECURITY DEFINER code owned by the migration role
--     (the profiles audit trigger, log_admin_denied). No client role (anon,
--     authenticated, service_role) holds INSERT/UPDATE/DELETE/TRUNCATE.
--   * Append-only for everyone: BEFORE UPDATE/DELETE row trigger + BEFORE
--     TRUNCATE statement trigger raise. Single exception: the actor_id FK
--     anonymisation (may ONLY null actor_id; everything else unchanged).
--   * Readable by managers only (owner / super_admin — is_admin_manager()).
create table if not exists public.admin_audit_log (
  id           bigint generated always as identity primary key,
  action       text not null check (action in (
                 'user_created','role_changed','user_suspended','user_reactivated',
                 'profile_updated','email_changed','denied_attempt')),
  actor_id     uuid references public.profiles(id) on delete set null,
  actor_name   text,
  actor_role   text,
  actor_kind   text not null check (actor_kind in ('user','system')),
  target_id    uuid,
  target_name  text,
  target_email text,
  before_value text,
  after_value  text,
  details      jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists admin_audit_log_created_idx
  on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_log_target_idx
  on public.admin_audit_log (target_id, created_at desc);

-- ---- Access: managers read-only, no client writes ------------------------
alter table public.admin_audit_log enable row level security;
drop policy if exists admin_audit_log_manager_select on public.admin_audit_log;
create policy admin_audit_log_manager_select on public.admin_audit_log
  for select using (public.is_admin_manager());
-- Deliberately NO insert/update/delete policies.

revoke all on table public.admin_audit_log from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.admin_audit_log from authenticated, service_role;

-- ---- Immutability (pattern: content_audit_log_immutable, 20261007000104) --
create or replace function public.admin_audit_log_immutable()
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
  raise exception 'admin_audit_log is append-only (% not allowed)', tg_op;
end;
$$;

revoke execute on function public.admin_audit_log_immutable() from public, anon, authenticated;

drop trigger if exists admin_audit_log_immutable on public.admin_audit_log;
create trigger admin_audit_log_immutable
  before update or delete on public.admin_audit_log
  for each row execute function public.admin_audit_log_immutable();

drop trigger if exists admin_audit_log_no_truncate on public.admin_audit_log;
create trigger admin_audit_log_no_truncate
  before truncate on public.admin_audit_log
  for each statement execute function public.admin_audit_log_immutable();

-- ===========================================================================
-- 8. profiles audit trigger — AFTER INSERT OR UPDATE
-- ===========================================================================
-- SAFETY CONTRACT — never blocks a profiles write: no RAISE; the whole body
-- runs in an exception block that emits a WARNING and skips the audit row on
-- any unexpected error (same pattern as content_lifecycle_after).
--
-- Events:
--   INSERT                       → user_created     (after_value = role)
--   UPDATE role changed          → role_changed     (before/after = role)
--   UPDATE disabled false → true → user_suspended   (before/after = 'false'/'true')
--   UPDATE disabled true → false → user_reactivated (before/after = 'true'/'false')
--   UPDATE email changed         → email_changed    (before/after = email)
--   UPDATE full_name changed     → profile_updated  (before/after = full_name,
--                                                    details.fields = ['full_name'])
--   One row per change, in that order. Anything else (updated_at,
--   last_login_at, notification_prefs, created_by) produces no event; the
--   trigger is declared UPDATE OF role, disabled, email, full_name so a pure
--   last_login_at / updated_at update does not even fire it.
--
-- Actor resolution (snapshot of name + role at event time):
--   1. auth.uid() with a profiles row → actor_kind 'user'.
--   2. service_role caller only: request header x-salma-actor-id (PostgREST
--      exposes request headers as the request.headers GUC) naming an existing
--      profile → actor_kind 'user', details.via = 'service_role_header'.
--      Never consulted for anon/authenticated callers, so it cannot be
--      spoofed by a signed-in user (their auth.uid() always wins).
--   3. no auth actor and this UPDATE newly sets created_by (createAdmin's
--      elevation step) → that profile, details.via = 'created_by'.
--   4. otherwise → actor_kind 'system', actor_name 'النظام' (handle_new_user,
--      pipeline, SQL console).
create or replace function public.profiles_admin_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid        uuid;
  v_actor_name text;
  v_actor_role text;
  v_kind       text;
  v_via        text;
  v_hint       uuid;
  v_is_service boolean;
begin
  begin
    -- 1. Signed-in actor.
    v_uid := auth.uid();
    if v_uid is not null then
      select coalesce(nullif(btrim(p.full_name), ''), p.email), p.role
        into v_actor_name, v_actor_role
        from public.profiles p where p.id = v_uid;
      if not found then
        v_uid := null;
      end if;
    end if;

    -- 2. Service-role actor hint (request header), service_role only.
    if v_uid is null then
      v_is_service := coalesce(auth.role() = 'service_role', false)
                      or coalesce((auth.jwt() ->> 'role') = 'service_role', false);
      if v_is_service then
        begin
          v_hint := nullif(btrim(current_setting('request.headers', true)::jsonb
                                 ->> 'x-salma-actor-id'), '')::uuid;
        exception when others then
          v_hint := null;
        end;
        if v_hint is not null then
          select coalesce(nullif(btrim(p.full_name), ''), p.email), p.role
            into v_actor_name, v_actor_role
            from public.profiles p where p.id = v_hint;
          if found then
            v_uid := v_hint;
            v_via := 'service_role_header';
          end if;
        end if;
      end if;
    end if;

    -- 3. createAdmin elevation: created_by newly set by a non-user session.
    --    (nested so the INSERT path never dereferences OLD)
    if v_uid is null and tg_op = 'UPDATE' then
      if old.created_by is null and new.created_by is not null then
        select coalesce(nullif(btrim(p.full_name), ''), p.email), p.role
          into v_actor_name, v_actor_role
          from public.profiles p where p.id = new.created_by;
        if found then
          v_uid := new.created_by;
          v_via := 'created_by';
        end if;
      end if;
    end if;

    -- 4. System.
    if v_uid is null then
      v_kind       := 'system';
      v_actor_name := 'النظام';
      v_actor_role := null;
    else
      v_kind := 'user';
    end if;

    -- ---------------------------------------------------------------- INSERT
    if tg_op = 'INSERT' then
      insert into public.admin_audit_log
        (action, actor_id, actor_name, actor_role, actor_kind,
         target_id, target_name, target_email, before_value, after_value, details)
      values
        ('user_created', v_uid, v_actor_name, v_actor_role, v_kind,
         new.id, new.full_name, new.email, null, new.role,
         jsonb_strip_nulls(jsonb_build_object(
           'role', new.role, 'disabled', new.disabled, 'via', v_via)));
      return null;
    end if;

    -- ---------------------------------------------------------------- UPDATE
    insert into public.admin_audit_log
      (action, actor_id, actor_name, actor_role, actor_kind,
       target_id, target_name, target_email, before_value, after_value, details)
    select e.action, v_uid, v_actor_name, v_actor_role, v_kind,
           new.id, new.full_name, new.email, e.before_value, e.after_value,
           nullif(jsonb_strip_nulls(coalesce(e.details, '{}'::jsonb)
                                    || jsonb_build_object('via', v_via)),
                  '{}'::jsonb)
      from (values
        (1, 'role_changed'::text, old.role::text, new.role::text, null::jsonb,
            (new.role is distinct from old.role)),
        (2, 'user_suspended', old.disabled::text, new.disabled::text, null::jsonb,
            (old.disabled = false and new.disabled = true)),
        (3, 'user_reactivated', old.disabled::text, new.disabled::text, null::jsonb,
            (old.disabled = true and new.disabled = false)),
        (4, 'email_changed', old.email::text, new.email::text, null::jsonb,
            (new.email is distinct from old.email)),
        (5, 'profile_updated', old.full_name::text, new.full_name::text,
            jsonb_build_object('fields', jsonb_build_array('full_name')),
            (new.full_name is distinct from old.full_name))
      ) as e(ord, action, before_value, after_value, details, fire)
     where e.fire
     order by e.ord;

    return null;
  exception when others then
    raise warning 'profiles_admin_audit skipped (profile %): %', new.id, sqlerrm;
    return null;
  end;
end;
$$;

-- Trigger-only function: no direct RPC execution.
revoke execute on function public.profiles_admin_audit() from public, anon, authenticated;

drop trigger if exists profiles_admin_audit on public.profiles;
create trigger profiles_admin_audit
  after insert or update of role, disabled, email, full_name on public.profiles
  for each row execute function public.profiles_admin_audit();

-- ===========================================================================
-- 9. log_admin_denied — app-side record of a refused management attempt
-- ===========================================================================
-- Called (best-effort) by the app when canManage / assignable-role checks
-- refuse an action. Staff only (is_staff()); the actor is always the caller's
-- own auth.uid() — it cannot be supplied. Inputs are length-bounded.
create or replace function public.log_admin_denied(
  p_action text,
  p_target uuid,
  p_detail text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_actor_name  text;
  v_actor_role  text;
  v_t_name      text;
  v_t_email     text;
  v_t_role      text;
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(nullif(btrim(p.full_name), ''), p.email), p.role
    into v_actor_name, v_actor_role
    from public.profiles p where p.id = v_uid;

  if p_target is not null then
    select p.full_name, p.email, p.role
      into v_t_name, v_t_email, v_t_role
      from public.profiles p where p.id = p_target;
  end if;

  insert into public.admin_audit_log
    (action, actor_id, actor_name, actor_role, actor_kind,
     target_id, target_name, target_email, before_value, after_value, details)
  values
    ('denied_attempt', v_uid, v_actor_name, v_actor_role, 'user',
     p_target, v_t_name, v_t_email, null, null,
     jsonb_strip_nulls(jsonb_build_object(
       'attempted',   left(coalesce(nullif(btrim(p_action), ''), 'unknown'), 100),
       'detail',      left(p_detail, 500),
       'target_role', v_t_role)));
end;
$$;

revoke all on function public.log_admin_denied(text, uuid, text) from public, anon;
grant execute on function public.log_admin_denied(text, uuid, text) to authenticated, service_role;

-- ===========================================================================
-- ROLLBACK (manual, in this order):
-- 1. drop function if exists public.log_admin_denied(text, uuid, text);
-- 2. drop trigger if exists profiles_admin_audit on public.profiles;
--    drop function if exists public.profiles_admin_audit();
-- 3. drop table if exists public.admin_audit_log;   -- discards the audit trail
--    drop function if exists public.admin_audit_log_immutable();
-- 4. Re-run the guard_profile_delete() body from 20260701153625 (last-owner only).
-- 5. Re-run 20260821120000_fix_role_escalation_guard.sql, then:
--    drop trigger if exists guard_profile_changes_trg on public.profiles;
--    create trigger guard_profile_changes_trg before update on public.profiles
--      for each row execute function public.guard_profile_changes();
-- 6. Re-run search_content / content_counts from 20261007100100 (§5, §6 only)
--    and restore_content_version from 20261008000100 (RPC only).
-- 7. Re-create the §3 policies with public.is_admin() (definitions in
--    20260629153004, 20260630142738, 20260630142753, 20261007000104/105).
-- 8. drop function if exists public.is_staff();   -- only after step 7
-- 9. Only while no row has role 'editor':
--    do $$ begin
--      alter table public.profiles drop constraint if exists profiles_role_check;
--      alter table public.profiles add constraint profiles_role_check
--        check (role in ('user','admin','super_admin','owner'));
--    end $$;
-- ===========================================================================

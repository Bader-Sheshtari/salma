-- CMS lifecycle Phase 1 (6/6) — lifecycle triggers on public.content.
--
-- Two SECURITY DEFINER trigger functions (owned by the migration role, i.e.
-- the owner of content / content_audit_log / content_versions, so RLS and the
-- revoked client privileges never block the trigger's own writes):
--
--   content_lifecycle_before  BEFORE INSERT OR UPDATE — stamps metadata,
--                             protects publication dates, bumps version.
--   content_lifecycle_after   AFTER  INSERT OR UPDATE — appends audit events
--                             and version snapshots (plain INSERTs, same
--                             transaction as the content write).
--
-- SAFETY CONTRACT — these triggers NEVER block a content write:
--   * No RAISE anywhere. Each body runs inside an exception block; on any
--     unexpected error it emits a WARNING and lets the original write through
--     (BEFORE returns the unmodified row, AFTER skips the audit/version write).
--   * Pipeline writes (ingest-news / ESL / radar via service role) have no
--     auth.uid() → actor_kind = 'system', *_by columns stay NULL. An auth.uid()
--     with no profiles row is treated as system too (so the profiles FKs on the
--     new *_by columns can never fail a write).
--   * The transition matrix is LOG-ONLY in Phase 1 (illegal transitions are
--     recorded in the audit details, never refused). The publish rule
--     (publish only from 'pending' or 'unpublished') is enforced app-side.
--
-- Transition matrix (anything → same status is always allowed):
--   draft       → pending
--   pending     → published | draft | rejected
--   published   → unpublished
--   unpublished → published | draft
--   rejected    → draft
--
-- Publication dates (authoritative here; the app no longer stamps them):
--   * first_published_at is write-once.
--   * Editing an already-published article never changes published_at.
--   * Publish / republish sets published_at = the ORIGINAL first publication
--     date (now() only for a first-ever publish); last_published_at = now().

-- ===========================================================================
-- BEFORE INSERT OR UPDATE
-- ===========================================================================
create or replace function public.content_lifecycle_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid;
  v_orig public.content;
begin
  v_orig := new;

  -- Acting human (NULL = system / pipeline / unknown user).
  v_uid := auth.uid();
  if v_uid is not null
     and not exists (select 1 from public.profiles p where p.id = v_uid) then
    v_uid := null;
  end if;

  begin
    -- ---------------------------------------------------------------- INSERT
    if tg_op = 'INSERT' then
      new.created_by     := coalesce(new.created_by, v_uid);
      new.version        := 1;
      new.last_edited_at := coalesce(new.last_edited_at, now());
      if new.status = 'published' then
        new.published_at       := coalesce(new.published_at, now());
        new.first_published_at := coalesce(new.first_published_at, new.published_at);
        new.last_published_at  := coalesce(new.last_published_at, new.published_at);
        new.published_by       := coalesce(new.published_by, v_uid);
      end if;
      return new;
    end if;

    -- ---------------------------------------------------------------- UPDATE
    -- (c) Soft delete / restore. A restored article never goes live by itself.
    if new.deleted_at is not null and old.deleted_at is null then
      new.deleted_by := coalesce(v_uid, new.deleted_by);
    elsif new.deleted_at is null and old.deleted_at is not null then
      if new.status = 'published' then
        new.status := 'unpublished';
      end if;
    end if;

    -- (a) The original publication date is write-once.
    -- Publication metadata can only be set by a transition INTO 'published':
    -- outside one, the original values are kept (no backdating via plain edits).
    if old.first_published_at is not null then
      new.first_published_at := old.first_published_at;
    elsif not (new.status = 'published' and old.status is distinct from 'published') then
      new.first_published_at := null;
    end if;
    if not (new.status = 'published' and old.status is distinct from 'published') then
      new.published_by      := old.published_by;
      new.last_published_at := old.last_published_at;
    end if;

    if old.status = 'published' and new.status = 'published' then
      -- (a) Editing a live article never moves its publication date.
      new.published_at := coalesce(old.published_at, new.published_at);
    elsif new.status = 'published' then
      -- (b) Publish / republish: restore the original date.
      new.first_published_at := coalesce(old.first_published_at, old.published_at, now());
      new.published_at       := new.first_published_at;
      new.last_published_at  := now();
      new.published_by       := coalesce(v_uid, new.published_by);
    elsif old.status = 'published' then
      -- (b) Taken off the public site (→ unpublished, or any other status).
      new.unpublished_by := v_uid;
      new.unpublished_at := now();
    end if;

    -- The homepage hero must be a live article.
    if new.is_featured and (
         (old.status = 'published' and new.status <> 'published')
      or (new.deleted_at is not null and old.deleted_at is null)) then
      new.is_featured := false;
    end if;

    -- (e) Content edit → new version. Status/flag/date changes are not edits.
    if (new.title, new.slug, new.excerpt, new.body, new.ai_summary, new.category_slug,
        new.type, new.cover_image_url, new.cover_credit_name, new.cover_credit_url,
        new.source_name, new.source_url, new.video_url)
       is distinct from
       (old.title, old.slug, old.excerpt, old.body, old.ai_summary, old.category_slug,
        old.type, old.cover_image_url, old.cover_credit_name, old.cover_credit_url,
        old.source_name, old.source_url, old.video_url) then
      new.last_edited_at := now();
      new.last_edited_by := coalesce(v_uid, new.last_edited_by);
      new.version        := old.version + 1;
    else
      new.version := old.version;   -- version only moves with a real edit
    end if;

    -- (d) slug change after first publication and (f) illegal transitions are
    -- LOG-ONLY: recorded by content_lifecycle_after, never blocked.
    return new;
  exception when others then
    raise warning 'content_lifecycle_before skipped (content %): %', v_orig.id, sqlerrm;
    return v_orig;
  end;
end;
$$;

-- ===========================================================================
-- AFTER INSERT OR UPDATE — audit events + version snapshots
-- ===========================================================================
create or replace function public.content_lifecycle_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid;
  v_kind        text;
  v_fields      text[];
  v_edit_fields text[];
  v_flags       text[] := '{}';
  v_event       text;
  v_allowed     boolean;
  v_illegal     boolean := false;
  v_slug_moved  boolean;
  v_cat         boolean;
  v_details     jsonb;
begin
  v_uid := auth.uid();
  if v_uid is not null
     and not exists (select 1 from public.profiles p where p.id = v_uid) then
    v_uid := null;
  end if;
  v_kind := case when v_uid is null then 'system' else 'user' end;

  begin
    -- ---------------------------------------------------------------- INSERT
    if tg_op = 'INSERT' then
      insert into public.content_audit_log
        (content_id, event, from_status, to_status, actor_id, actor_kind, version_no)
      values (new.id, 'created', null, new.status, v_uid, v_kind, new.version);
      if new.status = 'published' then
        insert into public.content_audit_log
          (content_id, event, from_status, to_status, actor_id, actor_kind, version_no)
        values (new.id, 'published', null, 'published', v_uid, v_kind, new.version);
      end if;
      return null;
    end if;

    -- ---------------------------------------------------------------- UPDATE
    -- Changed editable fields (NAMES only — values are never logged).
    select coalesce(array_agg(n.key order by n.key), '{}')
      into v_fields
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o on o.key = n.key
     where n.key = any (array['title','slug','excerpt','body','ai_summary',
                              'category_slug','type','cover_image_url',
                              'cover_credit_name','cover_credit_url',
                              'source_name','source_url','video_url'])
       and n.value is distinct from o.value;

    -- Version snapshot of the superseded content. Full history, no pruning.
    if cardinality(v_fields) > 0 then
      insert into public.content_versions
        (content_id, version_no, title, slug, excerpt, body, ai_summary,
         category_slug, type, cover_image_url, cover_credit_name, cover_credit_url,
         source_name, source_url, video_url, edited_by, edited_at)
      values
        (old.id, old.version, old.title, old.slug, old.excerpt, old.body, old.ai_summary,
         old.category_slug, old.type, old.cover_image_url, old.cover_credit_name,
         old.cover_credit_url, old.source_name, old.source_url, old.video_url,
         new.last_edited_by, now())
      on conflict (content_id, version_no) do nothing;
    end if;

    v_slug_moved := old.first_published_at is not null and new.slug is distinct from old.slug;
    v_cat        := new.category_slug is distinct from old.category_slug;
    if new.is_breaking is distinct from old.is_breaking then
      v_flags := array_append(v_flags, 'is_breaking');
    end if;
    if new.is_featured is distinct from old.is_featured then
      v_flags := array_append(v_flags, 'is_featured');
    end if;

    -- (f) Transition validity — LOG-ONLY.
    if new.status is distinct from old.status then
      v_allowed := case old.status
        when 'draft'       then new.status = 'pending'
        when 'pending'     then new.status in ('published','draft','rejected')
        when 'published'   then new.status = 'unpublished'
        when 'unpublished' then new.status in ('published','draft')
        when 'rejected'    then new.status = 'draft'
        else false
      end;
      v_illegal := not coalesce(v_allowed, false);
    end if;

    -- Primary lifecycle event (at most one per logical change).
    if new.deleted_at is not null and old.deleted_at is null then
      v_event := 'deleted';
    elsif new.deleted_at is null and old.deleted_at is not null then
      v_event := 'restored';
    elsif new.status is distinct from old.status then
      v_event := case
        when new.status = 'published' then
          case when old.status = 'unpublished' then 'republished' else 'published' end
        when old.status = 'published' and new.status = 'unpublished' then 'unpublished'
        when new.status = 'rejected' then 'rejected'
        when old.status = 'draft' and new.status = 'pending' then 'submitted'
        when old.status in ('pending','rejected') and new.status = 'draft' then 'returned'
        else 'edited'
      end;
    end if;

    if v_event is not null then
      -- The lifecycle event carries every field/flag that changed with it.
      v_details := jsonb_strip_nulls(jsonb_build_object(
        'fields',  case when cardinality(v_fields) > 0 then to_jsonb(v_fields) end,
        'flags',   case when cardinality(v_flags)  > 0 then to_jsonb(v_flags)  end,
        'illegal_transition',         case when v_illegal    then true end,
        'slug_changed_after_publish', case when v_slug_moved then true end));
      insert into public.content_audit_log
        (content_id, event, from_status, to_status, actor_id, actor_kind, version_no, details)
      values (new.id, v_event, old.status, new.status, v_uid, v_kind, new.version,
              nullif(v_details, '{}'::jsonb));
    else
      -- No lifecycle change: plain edit / category / flags, one event each.
      v_edit_fields := array_remove(v_fields, 'category_slug');
      if cardinality(v_edit_fields) > 0 then
        v_details := jsonb_strip_nulls(jsonb_build_object(
          'fields', to_jsonb(v_edit_fields),
          'slug_changed_after_publish', case when v_slug_moved then true end));
        insert into public.content_audit_log
          (content_id, event, from_status, to_status, actor_id, actor_kind, version_no, details)
        values (new.id, 'edited', old.status, new.status, v_uid, v_kind, new.version, v_details);
      end if;
      if v_cat then
        insert into public.content_audit_log
          (content_id, event, from_status, to_status, actor_id, actor_kind, version_no, details)
        values (new.id, 'category_changed', old.status, new.status, v_uid, v_kind, new.version,
                jsonb_build_object('fields', jsonb_build_array('category_slug')));
      end if;
      if cardinality(v_flags) > 0 then
        insert into public.content_audit_log
          (content_id, event, from_status, to_status, actor_id, actor_kind, version_no, details)
        values (new.id, 'flag_changed', old.status, new.status, v_uid, v_kind, new.version,
                jsonb_build_object('flags', to_jsonb(v_flags)));
      end if;
    end if;

    -- Editorial review is its own event, distinct from publishing.
    if new.reviewed_at is not null and new.reviewed_at is distinct from old.reviewed_at then
      insert into public.content_audit_log
        (content_id, event, from_status, to_status, actor_id, actor_kind, version_no)
      values (new.id, 'reviewed', old.status, new.status, v_uid, v_kind, new.version);
    end if;

    return null;
  exception when others then
    raise warning 'content_lifecycle_after skipped (content %): %', new.id, sqlerrm;
    return null;
  end;
end;
$$;

-- Trigger-only functions: no direct RPC execution (see 20260731113326).
revoke execute on function public.content_lifecycle_before() from public, anon, authenticated;
revoke execute on function public.content_lifecycle_after()  from public, anon, authenticated;

-- BEFORE triggers fire in name order: content_lifecycle_before runs before
-- content_set_updated_at (independent; updated_at keeps bumping on every
-- update exactly as today).
drop trigger if exists content_lifecycle_before on public.content;
create trigger content_lifecycle_before
  before insert or update on public.content
  for each row execute function public.content_lifecycle_before();

drop trigger if exists content_lifecycle_after on public.content;
create trigger content_lifecycle_after
  after insert or update on public.content
  for each row execute function public.content_lifecycle_after();

-- ROLLBACK:
-- drop trigger if exists content_lifecycle_after  on public.content;
-- drop trigger if exists content_lifecycle_before on public.content;
-- drop function if exists public.content_lifecycle_after();
-- drop function if exists public.content_lifecycle_before();

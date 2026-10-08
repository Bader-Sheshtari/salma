-- CMS Phase 4 — version restore.
--
-- 1. public.restore_content_version(p_content_id, p_version_no) — admin RPC
--    that copies a stored content_versions snapshot back onto the live row.
-- 2. public.content_lifecycle_after() re-created (base: migration
--    20261007000106) with ONE amendment: an update performed by the restore
--    RPC is logged as a single 'version_restored' audit event instead of the
--    'edited' + 'category_changed' events a plain edit would produce.
--
-- content_lifecycle_before is NOT touched (the live version is the one from
-- 20261007100100_content_search.sql).
--
-- How the RPC and the trigger cooperate:
--   * The RPC sets the TRANSACTION-LOCAL GUC salma.restore_from_version to the
--     restored version number immediately before its UPDATE and clears it
--     immediately after (set_config(..., true) → also discarded at commit /
--     rollback, so it can never leak into a later transaction).
--   * The UPDATE goes through the normal lifecycle triggers: the BEFORE
--     trigger bumps content.version and stamps last_edited_at/_by exactly as
--     for any edit; the AFTER trigger snapshots the superseded content as a new
--     content_versions row (nothing is ever overwritten or deleted) and, seeing
--     the GUC, logs 'version_restored' with details {restored_from, fields}.
--   * Status, flags and publication dates are not part of snapshots and are
--     never touched by a restore: a published article stays published with its
--     original published_at / first_published_at.
--   * 'version_restored' is already allowed by the content_audit_log event
--     CHECK (migration 20261007000104) — no constraint change needed.

-- ===========================================================================
-- RPC: restore_content_version
-- ===========================================================================
-- Returns jsonb:
--   {ok:true, new_version:<content.version after>, restored_from:<p_version_no>}
--   {ok:true, no_change:true}       snapshot identical to the live row — no write
--   {ok:false, reason:'<Arabic>'}   domain error (article missing / in trash,
--                                   version missing, update not applied)
-- Raises ONLY 'forbidden' (SQLSTATE 42501) for non-admin callers.
--
-- SLUG IS NEVER RESTORED. Snapshots do contain the slug, but restoring an older
-- slug of a published article would change (and break) its public URL — links
-- already shared, indexed or sent in a newsletter would 404. The live slug is
-- always kept; the slug is also excluded from the no-change comparison. (The
-- admin UI states this in the version-view footnote.)
--
-- SECURITY INVOKER: the caller's admin RLS (content_admin_read / _write,
-- content_versions_admin_select) authorises the reads and the UPDATE; the
-- explicit is_admin() guard gives a clean 42501 instead of a silent no-op.
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
  if not coalesce(public.is_admin(), false) then
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
  'CMS Phase 4: restore an article''s editable content (except slug) from a content_versions snapshot. Admin-only. Status/flags/dates unchanged; the superseded content is kept as a new version; audited as version_restored.';

revoke all on function public.restore_content_version(uuid, integer) from public, anon;
grant execute on function public.restore_content_version(uuid, integer) to authenticated, service_role;

-- ===========================================================================
-- AFTER INSERT OR UPDATE — audit events + version snapshots
-- (re-created from 20261007000106; ONLY change: the v_restore branch inside
--  the "no lifecycle change" path)
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
  v_restore     text;
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
      -- Phase 4: an UPDATE issued by restore_content_version() (transaction-
      -- local GUC set by the RPC) is ONE 'version_restored' event replacing
      -- the 'edited' + 'category_changed' events of a plain edit.
      v_restore := nullif(current_setting('salma.restore_from_version', true), '');
      if v_restore is not null and cardinality(v_fields) > 0 then
        insert into public.content_audit_log
          (content_id, event, from_status, to_status, actor_id, actor_kind, version_no, details)
        values (new.id, 'version_restored', old.status, new.status, v_uid, v_kind, new.version,
                jsonb_build_object('restored_from', v_restore::int,
                                   'fields',        to_jsonb(v_fields)));
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
      end if;
      -- Flags cannot change in a restore; kept unconditional for safety.
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

-- Trigger-only function: no direct RPC execution (see 20260731113326).
-- (create or replace keeps the trigger binding and existing privileges; the
-- revoke is repeated for clarity.)
revoke execute on function public.content_lifecycle_after() from public, anon, authenticated;

-- ROLLBACK:
-- 1. drop function if exists public.restore_content_version(uuid, integer);
-- 2. Re-create public.content_lifecycle_after() from
--    20261007000106_content_lifecycle_triggers.sql (that function body only —
--    do NOT re-run the whole file: it would also revert content_lifecycle_before
--    to the pre-20261007100100 log-only version).

-- CMS lifecycle Phase 1 (3/6) — backfill lifecycle columns from existing data.
--
-- What is backfilled (only where the target is still NULL → re-runnable):
--   first_published_at = published_at   (rows that have ever been published)
--   last_published_at  = published_at   (same rows)
--   created_by         = author_id      (rows with a human author; all 118
--                                        published rows are pipeline-created,
--                                        author_id NULL → stay NULL = system)
--   last_edited_at     = updated_at     (ALL rows). The public «آخر تحديث» line
--                                        moves from updated_at to last_edited_at;
--                                        seeding it with updated_at makes the
--                                        display byte-identical to today (still
--                                        shown only when > published_at + 24h).
--
-- What is NOT touched: published_at, updated_at, slug, category_slug, status,
-- title/body or any other existing column. version stays at its default 1.
--
-- Data-safety guarantees, enforced below in the same atomic statement:
--   * content_set_updated_at is DISABLED for the duration of the backfill, so
--     updated_at does not move (it is the admin list sort key and the source
--     of last_edited_at). It is re-enabled before the block ends.
--   * The lifecycle triggers (migration 106) are also disabled if they already
--     exist (re-run safety) so the backfill produces no audit/version noise.
--   * Assertion: zero rows with a changed updated_at, zero rows with a changed
--     published_at, and an unchanged row count — otherwise the whole migration
--     raises and rolls back (nothing is written).
--
-- The entire migration is ONE DO block → a single atomic statement regardless
-- of how the runner wraps transactions.

do $$
declare
  v_had_before  boolean;
  v_had_after   boolean;
  v_rows_before bigint;
  v_rows_after  bigint;
  v_upd_drift   bigint;
  v_pub_drift   bigint;
begin
  drop table if exists pg_temp._content_backfill_snapshot;
  create temp table _content_backfill_snapshot on commit drop as
    select id, updated_at, published_at from public.content;
  select count(*) into v_rows_before from _content_backfill_snapshot;

  -- Silence every trigger that would react to the backfill UPDATE.
  alter table public.content disable trigger content_set_updated_at;
  select exists (select 1 from pg_trigger
                 where tgrelid = 'public.content'::regclass
                   and tgname = 'content_lifecycle_before' and not tgisinternal)
    into v_had_before;
  select exists (select 1 from pg_trigger
                 where tgrelid = 'public.content'::regclass
                   and tgname = 'content_lifecycle_after' and not tgisinternal)
    into v_had_after;
  if v_had_before then
    alter table public.content disable trigger content_lifecycle_before;
  end if;
  if v_had_after then
    alter table public.content disable trigger content_lifecycle_after;
  end if;

  -- Single pass: one new row version per affected row.
  update public.content c
     set first_published_at = coalesce(c.first_published_at, c.published_at),
         last_published_at  = coalesce(c.last_published_at,  c.published_at),
         created_by         = coalesce(c.created_by, c.author_id),
         last_edited_at     = coalesce(c.last_edited_at, c.updated_at)
   where (c.published_at is not null
          and (c.first_published_at is null or c.last_published_at is null))
      or (c.author_id is not null and c.created_by is null)
      or c.last_edited_at is null;

  -- Restore triggers exactly as they were.
  alter table public.content enable trigger content_set_updated_at;
  if v_had_before then
    alter table public.content enable trigger content_lifecycle_before;
  end if;
  if v_had_after then
    alter table public.content enable trigger content_lifecycle_after;
  end if;

  -- Assertions: no updated_at drift, no published_at change, no row lost.
  select count(*) into v_rows_after from public.content;
  select count(*) into v_upd_drift
    from public.content c join _content_backfill_snapshot s on s.id = c.id
   where c.updated_at is distinct from s.updated_at;
  select count(*) into v_pub_drift
    from public.content c join _content_backfill_snapshot s on s.id = c.id
   where c.published_at is distinct from s.published_at;

  if v_upd_drift <> 0 or v_pub_drift <> 0 or v_rows_after <> v_rows_before then
    raise exception
      'content lifecycle backfill aborted: updated_at drift=%, published_at drift=%, rows before=% after=%',
      v_upd_drift, v_pub_drift, v_rows_before, v_rows_after;
  end if;

  raise notice 'content lifecycle backfill OK: % rows, 0 updated_at drift, 0 published_at drift',
    v_rows_after;
end $$;

-- ROLLBACK (data only; columns are dropped by rolling back migration 102):
-- alter table public.content disable trigger content_set_updated_at;
-- update public.content set first_published_at = null, last_published_at = null,
--   created_by = null, last_edited_at = null;
-- alter table public.content enable trigger content_set_updated_at;

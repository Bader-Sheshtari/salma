-- ============================================================
-- Security hardening
--   1. Revoke direct EXECUTE on trigger-only functions
--   2. Remove anonymous/public listing from the media bucket
-- is_admin() and is_admin_manager() are intentionally NOT touched.
-- ============================================================

-- ---- 1. Trigger-only functions: revoke direct EXECUTE ----------------
-- force_rating_pending, force_social_answer_pending and
-- guard_profile_delete are SECURITY DEFINER functions that exist ONLY to
-- back BEFORE INSERT/DELETE triggers. PostgreSQL does not check the
-- caller's EXECUTE privilege when firing a trigger, so revoking direct
-- EXECUTE removes their PostgREST RPC callability from anon/authenticated
-- without affecting trigger behavior. service_role and postgres are left
-- untouched (they are not named in the REVOKE).
revoke execute on function public.force_rating_pending()        from public, anon, authenticated;
revoke execute on function public.force_social_answer_pending() from public, anon, authenticated;
revoke execute on function public.guard_profile_delete()        from public, anon, authenticated;

-- ---- 2. Media bucket: remove anonymous/public object listing ---------
-- `media_public_read` (SELECT USING bucket_id='media' for the public role)
-- allowed anyone to enumerate every object in the bucket via the Storage
-- `.list()` API. Public image URLs are served through the bucket's
-- `public = true` flag, NOT through this RLS SELECT policy, so dropping it
-- blocks anonymous enumeration while leaving public image rendering, admin
-- uploads, image-generation uploads, and admin update/delete fully intact.
-- The bucket remains public; media_admin_insert/update/delete are unchanged.
drop policy if exists "media_public_read" on storage.objects;

-- ============================================================
-- ROLLBACK (restores the verified pre-change state):
--
-- grant execute on function public.force_rating_pending()        to anon, authenticated;
-- grant execute on function public.force_social_answer_pending() to anon, authenticated;
-- grant execute on function public.guard_profile_delete()        to anon, authenticated;
--
-- create policy "media_public_read" on storage.objects
--   for select to public
--   using (bucket_id = 'media');
-- ============================================================

-- Trigger-only functions: not meant to be called directly via the REST RPC API.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.guard_profile_changes() from public, anon, authenticated;
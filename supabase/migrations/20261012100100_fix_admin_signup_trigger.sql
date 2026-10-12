-- ============================================================================
-- FIX: invitation acceptance blocked by the anti-signup trigger
--
-- Root cause (first real acceptance, 2026-10-12): guard_auth_signup rejects
-- any auth.users INSERT whose email_confirmed_at is null. The U2 invitation
-- flow creates accounts through GoTrue's ADMIN API with email_confirm:true,
-- but current GoTrue inserts the row first (unconfirmed) and applies the
-- confirmation afterwards — so the trigger aborted every acceptance with
-- "public signup is disabled" (observed three times for mariam@dawi.com).
--
-- Fix: additionally allow an insert that carries the SERVER-ONLY marker
-- raw_app_meta_data->>'salma_admin_created' = 'true'. app_metadata can only
-- be set through the service-role admin API — GoTrue never accepts
-- app_metadata from public signup — so the public-signup block is fully
-- preserved (and remains defense-in-depth behind the GoTrue-level
-- disable_signup=true setting). acceptInvitation now passes the marker.
-- ============================================================================

create or replace function public.guard_auth_signup()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- Server-only path: invitation accounts created via the service-role admin
  -- API. Public signup cannot set app_metadata, so this cannot be spoofed.
  if coalesce(new.raw_app_meta_data ->> 'salma_admin_created', '') = 'true' then
    return new;
  end if;
  if new.email_confirmed_at is null
     and new.phone_confirmed_at is null
     and coalesce(new.is_anonymous, false) = false then
    raise exception 'public signup is disabled';
  end if;
  return new;
end;
$$;

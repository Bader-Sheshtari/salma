-- ============================================================================
-- Newsletter Subscription Infrastructure + Optional Audience Survey
-- Phase: subscription + audience insight ONLY. No sending, SMTP, campaigns,
-- templates, or unsubscribe emails. Builds on the existing
-- newsletter_subscribers table (20260701185010) — no parallel subscriber store.
--
-- Writes now flow EXCLUSIVELY through server actions using the service role:
-- the anon INSERT policy is dropped so anti-spam (honeypot, rate limit,
-- validation, duplicate handling) cannot be bypassed with the public anon key.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Extend newsletter_subscribers with lifecycle + consent + survey-token
--    columns. Additive and backfilled; existing rows keep their identity.
-- ----------------------------------------------------------------------------
alter table public.newsletter_subscribers
  add column if not exists name text,
  add column if not exists status text not null default 'subscribed',
  add column if not exists subscribed_at timestamptz,
  add column if not exists unsubscribed_at timestamptz,
  add column if not exists source text,
  add column if not exists consent_version text,
  add column if not exists survey_token_hash text,
  add column if not exists survey_token_expires_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

-- Backfill: every pre-existing row came from the homepage form (the only
-- signup placement that has ever existed) and is an active subscription.
update public.newsletter_subscribers set subscribed_at = created_at where subscribed_at is null;
update public.newsletter_subscribers set source = 'homepage' where source is null;

alter table public.newsletter_subscribers
  alter column subscribed_at set not null,
  alter column subscribed_at set default now();

-- Lifecycle is deliberately minimal: subscribed / unsubscribed. Unsubscribing
-- never deletes the row (original subscribed_at is preserved; resubscribing
-- reactivates the same row).
do $$ begin
  alter table public.newsletter_subscribers
    add constraint newsletter_subscribers_status_check
    check (status in ('subscribed', 'unsubscribed'));
exception when duplicate_object then null; end $$;

create index if not exists newsletter_subscribers_status_idx
  on public.newsletter_subscribers (status);
-- Token lookup for the optional post-subscribe survey (hash only; plain
-- tokens never touch the database).
create index if not exists newsletter_subscribers_token_idx
  on public.newsletter_subscribers (survey_token_hash)
  where survey_token_hash is not null;

drop trigger if exists newsletter_subscribers_set_updated_at on public.newsletter_subscribers;
create trigger newsletter_subscribers_set_updated_at
  before update on public.newsletter_subscribers
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. Audience profile (optional survey answers) — separate table so newsletter
--    delivery can never depend on survey completion. Multi-select answers are
--    stored as text[] of option KEYS with no CHECK constraints: the option
--    catalog lives in src/lib/newsletter.ts and is validated server-side, so
--    options can be added/renamed later without schema migrations. Single-
--    choice fields use small CHECKed vocabularies.
--    Nationality/residence are explicit, optional, subscriber-stated values —
--    never inferred from IP, email, language, or any other field.
-- ----------------------------------------------------------------------------
create table if not exists public.newsletter_audience_profiles (
  subscriber_id uuid primary key
    references public.newsletter_subscribers(id) on delete cascade,
  profession_type text
    check (profession_type in ('doctor', 'health_sector', 'not_health', 'prefer_not_say')),
  interest_reasons text[] not null default '{}',
  interest_reason_other text,
  topics text[] not null default '{}',
  content_preferences text[] not null default '{}',
  -- Informational only for now — no commitment to personalized frequency.
  preferred_frequency text
    check (preferred_frequency in ('daily', 'weekly', 'top_news_only', 'undecided')),
  country_of_residence text,  -- ISO 3166-1 alpha-2
  nationality text,           -- ISO 3166-1 alpha-2, or 'prefer_not_say'
  survey_completed_at timestamptz,
  survey_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists newsletter_audience_profiles_set_updated_at on public.newsletter_audience_profiles;
create trigger newsletter_audience_profiles_set_updated_at
  before update on public.newsletter_audience_profiles
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. Lightweight rate-limit buckets for the public forms. Keys are HMAC
--    digests (never raw IPs); rows are opportunistically pruned by the server
--    action, so no cron is needed. Service-role only.
-- ----------------------------------------------------------------------------
create table if not exists public.newsletter_throttle (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 1,
  primary key (bucket, window_start)
);

-- ----------------------------------------------------------------------------
-- 4. RLS. Clients get NO write access anywhere (server actions use the service
--    role after their own checks); admins (is_admin() already requires MFA
--    satisfaction) may read for /admin/newsletter.
-- ----------------------------------------------------------------------------
alter table public.newsletter_audience_profiles enable row level security;
alter table public.newsletter_throttle enable row level security;

-- Close the direct-insert path: the public anon key may no longer write rows.
drop policy if exists "anon can subscribe" on public.newsletter_subscribers;

drop policy if exists "admins can read audience profiles" on public.newsletter_audience_profiles;
create policy "admins can read audience profiles"
  on public.newsletter_audience_profiles
  for select
  to authenticated
  using (public.is_admin());

-- newsletter_throttle: no policies — service role only.

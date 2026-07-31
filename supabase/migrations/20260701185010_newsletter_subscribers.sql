create table if not exists public.newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists newsletter_subscribers_email_lower_idx
  on public.newsletter_subscribers (lower(email));

alter table public.newsletter_subscribers enable row level security;

-- Anyone (anon) may subscribe; the public form inserts a single email.
drop policy if exists "anon can subscribe" on public.newsletter_subscribers;
create policy "anon can subscribe"
  on public.newsletter_subscribers
  for insert
  to anon, authenticated
  with check (true);

-- Only admins may read the subscriber list.
drop policy if exists "admins can read subscribers" on public.newsletter_subscribers;
create policy "admins can read subscribers"
  on public.newsletter_subscribers
  for select
  to authenticated
  using (public.is_admin());
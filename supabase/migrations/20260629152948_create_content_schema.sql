-- ===== Categories =====
create table if not exists public.categories (
  slug text primary key,
  name_ar text not null,
  name_en text,
  accent text not null default '#449785',
  sort_order int not null default 0
);

-- ===== Content (articles, videos, news, investigations) =====
create table if not exists public.content (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'article' check (type in ('article','video','news','investigation')),
  title text not null,
  slug text not null unique,
  excerpt text,
  body text,
  ai_summary text,
  category_slug text references public.categories(slug) on delete set null,
  status text not null default 'draft' check (status in ('draft','pending','published')),
  origin text not null default 'manual' check (origin in ('manual','ai')),
  cover_image_url text,
  video_url text,
  video_duration text,
  read_minutes int,
  is_breaking boolean not null default false,
  is_featured boolean not null default false,
  author_id uuid references public.profiles(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists content_status_idx on public.content (status) where deleted_at is null;
create index if not exists content_category_idx on public.content (category_slug);
create index if not exists content_type_idx on public.content (type);
create index if not exists content_published_idx on public.content (published_at desc);

-- ===== Sources / references (one content -> many) =====
create table if not exists public.content_sources (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.content(id) on delete cascade,
  label text not null,
  url text,
  created_at timestamptz not null default now()
);
create index if not exists content_sources_content_idx on public.content_sources (content_id);

-- ===== Comments (public can post -> pending -> admin approves) =====
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.content(id) on delete cascade,
  author_name text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
create index if not exists comments_content_idx on public.comments (content_id, status);

-- ===== updated_at trigger =====
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists content_set_updated_at on public.content;
create trigger content_set_updated_at
  before update on public.content
  for each row execute function public.set_updated_at();

-- ===== Force new comments to 'pending' regardless of client input =====
create or replace function public.force_comment_pending()
returns trigger language plpgsql as $$
begin
  new.status := 'pending';
  return new;
end;
$$;
drop trigger if exists comments_force_pending on public.comments;
create trigger comments_force_pending
  before insert on public.comments
  for each row execute function public.force_comment_pending();
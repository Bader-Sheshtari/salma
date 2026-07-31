create table if not exists public.homepage_sections (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,
  kind          text not null check (kind in ('category','feature')),
  category_slug text references public.categories(slug) on delete cascade,
  title_ar      text not null,
  is_enabled    boolean not null default true,
  sort_order    int not null default 0,
  display_style text not null default 'carousel'
                check (display_style in ('carousel','grid','list','featured')),
  items_limit   int not null default 6,
  show_view_all boolean not null default true,
  accent        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint homepage_sections_kind_slug_ck check (
    (kind = 'category' and category_slug is not null) or
    (kind = 'feature'  and category_slug is null))
);

create index if not exists homepage_sections_order
  on public.homepage_sections (is_enabled, sort_order);

drop trigger if exists homepage_sections_set_updated_at on public.homepage_sections;
create trigger homepage_sections_set_updated_at
  before update on public.homepage_sections
  for each row execute function public.set_updated_at();

-- seed category sections from existing categories
insert into public.homepage_sections
  (key, kind, category_slug, title_ar, sort_order, display_style, items_limit, accent)
select 'category:' || c.slug, 'category', c.slug, c.name_ar, c.sort_order,
       case c.slug when 'health-economy' then 'grid'
                   when 'lifestyle' then 'grid'
                   when 'investigations' then 'list'
                   else 'carousel' end,
       6, c.accent
from public.categories c
on conflict (key) do nothing;

-- seed feature sections
insert into public.homepage_sections
  (key, kind, category_slug, title_ar, sort_order, display_style, items_limit, accent)
values
  ('feature:doctor_transfers','feature',null,'انتقالات الأطباء',7,'list',6,null),
  ('feature:social','feature',null,'مساحة تواصل',8,'featured',3,null)
on conflict (key) do nothing;

alter table public.homepage_sections enable row level security;

drop policy if exists homepage_sections_public_read on public.homepage_sections;
create policy homepage_sections_public_read
  on public.homepage_sections for select using (true);

drop policy if exists homepage_sections_admin_write on public.homepage_sections;
create policy homepage_sections_admin_write
  on public.homepage_sections for all
  using (public.is_admin()) with check (public.is_admin());
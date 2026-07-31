-- ============ DEPARTMENTS (master list) ============
create table public.departments (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null,
  slug text not null unique,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.departments enable row level security;
create policy departments_public_read on public.departments for select using (true);
create policy departments_admin_all on public.departments for all using (is_admin()) with check (is_admin());

-- ============ DOCTORS (directory, anchors ratings) ============
create table public.doctors (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null,
  slug text not null unique,
  department_id uuid references public.departments(id) on delete set null,
  title_ar text,
  hospital text,
  photo_url text,
  bio text,
  rating_avg numeric(3,2) not null default 0,
  rating_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index doctors_department_idx on public.doctors (department_id);
alter table public.doctors enable row level security;
create policy doctors_public_read on public.doctors for select using (deleted_at is null);
create policy doctors_admin_read on public.doctors for select using (is_admin());
create policy doctors_admin_write on public.doctors for all using (is_admin()) with check (is_admin());
create trigger doctors_set_updated_at before update on public.doctors
  for each row execute function set_updated_at();

-- ============ DOCTOR RATINGS (moderated, like comments) ============
create table public.doctor_ratings (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  stars int not null check (stars between 1 and 5),
  author_name text not null,
  body text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
create index doctor_ratings_doctor_idx on public.doctor_ratings (doctor_id);
alter table public.doctor_ratings enable row level security;
-- anyone may submit a rating for an existing, non-deleted doctor
create policy doctor_ratings_public_insert on public.doctor_ratings for insert
  with check (exists (select 1 from public.doctors d where d.id = doctor_ratings.doctor_id and d.deleted_at is null));
create policy doctor_ratings_public_read_approved on public.doctor_ratings for select
  using (status = 'approved');
create policy doctor_ratings_admin_read on public.doctor_ratings for select using (is_admin());
create policy doctor_ratings_admin_update on public.doctor_ratings for update using (is_admin()) with check (is_admin());
create policy doctor_ratings_admin_delete on public.doctor_ratings for delete using (is_admin());

-- force every freshly-submitted rating to 'pending' (mirror comments)
create or replace function public.force_rating_pending()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.status := 'pending';
  return new;
end;
$$;
create trigger doctor_ratings_force_pending before insert on public.doctor_ratings
  for each row execute function public.force_rating_pending();

-- recompute the cached average/count on a doctor from its APPROVED ratings
create or replace function public.recompute_doctor_rating()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target uuid := coalesce(new.doctor_id, old.doctor_id);
begin
  update public.doctors d set
    rating_avg = coalesce((select round(avg(r.stars)::numeric, 2) from public.doctor_ratings r
                           where r.doctor_id = target and r.status = 'approved'), 0),
    rating_count = (select count(*) from public.doctor_ratings r
                    where r.doctor_id = target and r.status = 'approved')
  where d.id = target;
  return null;
end;
$$;
create trigger doctor_ratings_recompute
  after insert or update or delete on public.doctor_ratings
  for each row execute function public.recompute_doctor_rating();

-- ============ DOCTOR TRANSFERS (انتقال الأطباء feed) ============
create table public.doctor_transfers (
  id uuid primary key default gen_random_uuid(),
  doctor_name text not null,
  department_id uuid references public.departments(id) on delete set null,
  from_hospital text,
  to_hospital text,
  transfer_date date,
  note text,
  status text not null default 'published' check (status in ('draft','published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index doctor_transfers_date_idx on public.doctor_transfers (transfer_date desc);
alter table public.doctor_transfers enable row level security;
create policy doctor_transfers_public_read on public.doctor_transfers for select
  using (status = 'published' and deleted_at is null);
create policy doctor_transfers_admin_read on public.doctor_transfers for select using (is_admin());
create policy doctor_transfers_admin_write on public.doctor_transfers for all using (is_admin()) with check (is_admin());
create trigger doctor_transfers_set_updated_at before update on public.doctor_transfers
  for each row execute function set_updated_at();
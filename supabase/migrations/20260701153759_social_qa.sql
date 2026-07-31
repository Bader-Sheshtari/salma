create table if not exists public.social_questions (
  id               uuid primary key default gen_random_uuid(),
  question         text not null,
  is_active        boolean not null default false,
  require_approval boolean not null default true,
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists social_questions_one_active
  on public.social_questions ((is_active)) where is_active;

drop trigger if exists social_questions_set_updated_at on public.social_questions;
create trigger social_questions_set_updated_at
  before update on public.social_questions
  for each row execute function public.set_updated_at();

create table if not exists public.social_answers (
  id            uuid primary key default gen_random_uuid(),
  question_id   uuid not null references public.social_questions(id) on delete cascade,
  answer        text not null,
  name_optional text,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  is_featured   boolean not null default false,
  created_at    timestamptz not null default now(),
  approved_by   uuid references public.profiles(id) on delete set null,
  approved_at   timestamptz
);

create index if not exists social_answers_q_status
  on public.social_answers (question_id, status);

create or replace function public.force_social_answer_pending()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  new.status := 'pending';
  new.is_featured := false;
  new.approved_by := null;
  new.approved_at := null;
  return new;
end;
$function$;

drop trigger if exists social_answers_force_pending on public.social_answers;
create trigger social_answers_force_pending
  before insert on public.social_answers
  for each row execute function public.force_social_answer_pending();

alter table public.social_questions enable row level security;
alter table public.social_answers   enable row level security;

drop policy if exists social_questions_public_read on public.social_questions;
create policy social_questions_public_read
  on public.social_questions for select using (is_active = true);

drop policy if exists social_questions_admin_read on public.social_questions;
create policy social_questions_admin_read
  on public.social_questions for select using (public.is_admin());

drop policy if exists social_questions_admin_write on public.social_questions;
create policy social_questions_admin_write
  on public.social_questions for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists social_answers_public_insert on public.social_answers;
create policy social_answers_public_insert
  on public.social_answers for insert with check (
    exists (select 1 from public.social_questions q
            where q.id = social_answers.question_id and q.is_active = true));

drop policy if exists social_answers_public_read_approved on public.social_answers;
create policy social_answers_public_read_approved
  on public.social_answers for select using (
    status = 'approved' and exists (
      select 1 from public.social_questions q
      where q.id = social_answers.question_id and q.is_active = true));

drop policy if exists social_answers_admin_read on public.social_answers;
create policy social_answers_admin_read
  on public.social_answers for select using (public.is_admin());

drop policy if exists social_answers_admin_update on public.social_answers;
create policy social_answers_admin_update
  on public.social_answers for update
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists social_answers_admin_delete on public.social_answers;
create policy social_answers_admin_delete
  on public.social_answers for delete using (public.is_admin());
-- Role-escalation + signup-guard boundary tests (P0 security fix, 2026-08-21).
--
-- Exercises guard_profile_changes() and guard_auth_signup() at the DATABASE
-- level — the layer a direct PostgREST caller hits — using synthetic actors
-- and simulated JWT claims (set_config('request.jwt.claims', ...)).
--
-- SAFE TO RUN AGAINST PRODUCTION: everything happens inside one DO block that
-- ALWAYS ends with `raise exception`, so the transaction is rolled back and
-- no fixture rows survive. The results line is carried in the exception text:
-- expect it to start with ROLE_GUARD_TEST_RESULTS and contain no FAIL entries.
--
-- Run via the Supabase SQL editor / MCP execute_sql (any superuser/postgres
-- session; RLS does not apply, which is correct — these tests target the
-- TRIGGERS, the authoritative guard beneath RLS).

do $$
declare
  v_user  uuid := gen_random_uuid();
  v_adm   uuid := gen_random_uuid();
  v_sadm  uuid := gen_random_uuid();
  v_own   uuid := gen_random_uuid();
  v_role  text;
  r       text := '';
begin
  -- ── fixtures (service context; rolled back at the end) ──────────────────
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  select x.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         x.id || '@role-guard-test.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  from (values (v_user), (v_adm), (v_sadm), (v_own)) as x(id);
  update public.profiles set role = 'admin'       where id = v_adm;
  update public.profiles set role = 'super_admin' where id = v_sadm;
  update public.profiles set role = 'owner'       where id = v_own;

  -- A: plain user self-promotion → blocked
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    update public.profiles set role = 'admin' where id = v_user;
    r := r || ' A:FAIL(no-exception)';
  exception when others then r := r || ' A:PASS'; end;

  -- B: admin self-promotion to super_admin → blocked
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
    update public.profiles set role = 'super_admin' where id = v_adm;
    r := r || ' B:FAIL(no-exception)';
  exception when others then r := r || ' B:PASS'; end;

  -- C: admin self-promotion to owner → blocked
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
    update public.profiles set role = 'owner' where id = v_adm;
    r := r || ' C:FAIL(no-exception)';
  exception when others then r := r || ' C:PASS'; end;

  -- C2: admin changing ANOTHER profile's role → blocked (admins manage no roles)
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
    update public.profiles set role = 'admin' where id = v_user;
    r := r || ' C2:FAIL(no-exception)';
  exception when others then r := r || ' C2:PASS'; end;

  -- D: super_admin self-promotion to owner → blocked
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_sadm, 'role', 'authenticated')::text, true);
    update public.profiles set role = 'owner' where id = v_sadm;
    r := r || ' D:FAIL(no-exception)';
  exception when others then r := r || ' D:PASS'; end;

  -- D2: super_admin promoting an admin to owner → blocked (owner grants are owner-only)
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_sadm, 'role', 'authenticated')::text, true);
    update public.profiles set role = 'owner' where id = v_adm;
    r := r || ' D2:FAIL(no-exception)';
  exception when others then r := r || ' D2:PASS'; end;

  -- D3: super_admin granting super_admin → blocked (mirrors setAdminRole: owner-only)
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_sadm, 'role', 'authenticated')::text, true);
    update public.profiles set role = 'super_admin' where id = v_adm;
    r := r || ' D3:FAIL(no-exception)';
  exception when others then r := r || ' D3:PASS'; end;

  -- E1: super_admin promoting a user to admin → ALLOWED (intended hierarchy)
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_sadm, 'role', 'authenticated')::text, true);
    update public.profiles set role = 'admin' where id = v_user;
    select role into v_role from public.profiles where id = v_user;
    r := r || case when v_role = 'admin' then ' E1:PASS' else ' E1:FAIL(role=' || v_role || ')' end;
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true); update public.profiles set role = 'user' where id = v_user; -- reset
  exception when others then r := r || ' E1:FAIL(' || sqlerrm || ')'; end;

  -- E2: owner promoting an admin to super_admin → ALLOWED
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
    update public.profiles set role = 'super_admin' where id = v_adm;
    select role into v_role from public.profiles where id = v_adm;
    r := r || case when v_role = 'super_admin' then ' E2:PASS' else ' E2:FAIL(role=' || v_role || ')' end;
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true); update public.profiles set role = 'admin' where id = v_adm; -- reset
  exception when others then r := r || ' E2:FAIL(' || sqlerrm || ')'; end;

  -- E3: service_role role change → ALLOWED (sanctioned admin workflow path)
  begin
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    update public.profiles set role = 'admin' where id = v_user;
    select role into v_role from public.profiles where id = v_user;
    r := r || case when v_role = 'admin' then ' E3:PASS' else ' E3:FAIL(role=' || v_role || ')' end;
  exception when others then r := r || ' E3:FAIL(' || sqlerrm || ')'; end;

  -- F: owner self-disable → blocked (no self status changes)
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
    update public.profiles set disabled = true where id = v_own;
    r := r || ' F:FAIL(no-exception)';
  exception when others then r := r || ' F:PASS'; end;

  -- G: unconfirmed auth.users insert (public self-signup shape) → blocked
  begin
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', 'signup-block@role-guard-test.invalid', '',
            '{}'::jsonb, '{}'::jsonb, now(), now());
    r := r || ' G:FAIL(no-exception)';
  exception when others then r := r || ' G:PASS'; end;

  -- H: confirmed insert (admin createUser shape) → ALLOWED (fixtures above
  -- already proved this; assert explicitly anyway)
  begin
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                            created_at, updated_at)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', 'confirmed-ok@role-guard-test.invalid', '', now(),
            '{}'::jsonb, '{}'::jsonb, now(), now());
    r := r || ' H:PASS';
  exception when others then r := r || ' H:FAIL(' || sqlerrm || ')'; end;

  raise exception 'ROLE_GUARD_TEST_RESULTS:%  (transaction intentionally rolled back)', r;
end;
$$;

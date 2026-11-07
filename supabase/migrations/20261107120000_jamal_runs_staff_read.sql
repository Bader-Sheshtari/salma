-- Jamal provenance badge («تحرير جمال») — staff READ access to jamal_runs.
--
-- Additive and minimal: ONE select policy so the admin dashboard can mark
-- Jamal-written articles in the draft list and the article editing view.
-- Writes stay service-role-only: no insert/update/delete policy is added, so
-- RLS keeps blocking every client-role write exactly as before.
--
-- Same posture and shape as radar_evidence_intelligence_admin_select
-- (20260821040000) under the is_staff() helper of 20261009100100.
--
-- NOTE: provided for owner review and NOT applied by this change. It must be
-- applied together with (after) 20261105090000_jamal_runs.sql, as a targeted
-- single-file apply — never via a blanket `supabase db push`.
drop policy if exists jamal_runs_staff_select on public.jamal_runs;
create policy jamal_runs_staff_select on public.jamal_runs
  for select using (public.is_staff());

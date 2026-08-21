-- Radar-rank cadence: every-2h → HOURLY (launch-readiness P1, 2026-08-21).
--
-- The reliability fix bounds each radar-rank run to ~90 rows in a ~75s
-- wall-clock budget so it finishes comfortably under the 120s pg_net timeout.
-- A bounded ~90-row run at the previous every-2h cadence (12 runs/day = 1080
-- rows/day) cannot keep up with the measured ~1200/day average intake (~1550
-- peak). Hourly (24 runs/day) gives 90×24 = 2160 rows/day capacity — margin
-- over both the average and the peak, and enough to drain the recovery backlog.
-- This is reliability-driven sizing (a single run MUST stay bounded), not a
-- brute-force frequency bump. Cheap model (openai/gpt-4o-mini), low $ impact.
--
-- Only the schedule of the existing salma-radar-rank job changes; the wrapper
-- function run_radar_rank() (which sends x-ingest-secret) is unchanged.

select cron.alter_job(
  (select jobid from cron.job where jobname = 'salma-radar-rank'),
  schedule => '10 * * * *'   -- top-of-hour+10min, hourly (was '10 */2 * * *')
);

-- E1.1.1 — Strict Final-Source Enforcement (registry adjustment)
-- Register the Emirates News Agency (WAM), the official UAE state news agency,
-- so a WAM-sourced story has a registered, final-allowed citation instead of
-- being treated as an unregistered discovery-only domain.
--
-- Classified as a Tier-2 GCC media source: strong for discovery/context and
-- usable as a final source only when no stronger Tier-1 primary (ministry,
-- regulator, journal, hospital) is cited. The Institutional PR Filter in the
-- ingestion agent is score-based and independent of the registry, so it stays
-- active for WAM items regardless of this entry.
--
-- Idempotent: the domain is normalized by the news_sources trigger and skipped
-- on conflict. okaz.com.sa and elwatannews.com are intentionally NOT added here
-- and remain unregistered pending explicit approval.
insert into public.news_sources
  (name, domain, region, source_type, tier, trust_score, final_source_allowed)
values
  ('Emirates News Agency (WAM)', 'wam.ae', 'gulf', 'media', '2', 72, true)
on conflict (domain) do nothing;

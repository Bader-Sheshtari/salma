-- Evidence Intelligence V1.1 — evidence-analysis source provenance.
--
-- Primary Source Escalation can identify a stronger editorial primary that the
-- sanctioned extractor cannot fetch (e.g. a hard bot-block, as with the real
-- Moderna→science.org case). The analysis then runs over a fetchable fallback
-- (validated supporting source, else the discovery article) — and the sidecar
-- must say so explicitly, never implying the card was derived from the
-- inaccessible primary. The identified primary is preserved alongside.

alter table public.radar_evidence_intelligence
  add column if not exists evidence_source_status text check (evidence_source_status in
    ('primary_source_analyzed','supporting_source_analyzed','discovery_source_fallback','insufficient_source')),
  add column if not exists evidence_source_role text,
  add column if not exists evidence_source_tier integer,
  add column if not exists editorial_primary_url text,
  add column if not exists editorial_primary_domain text;

-- Existing rows (if any) all analyzed the source that was also the editorial
-- primary at the time; leave them null — the UI treats null as "primary".

# Security Hardening — Publishability Gaps (A / B / C)

**Date:** 2026-10-23
**Status:** OPEN — remediation requires separate owner approval.
**Found during:** the editorial-standard Phase 0 publishability audit (read-only). This document makes no code or database changes.
**Roadmap:** P1 #14 in `docs/SALMA_MASTER_ROADMAP.md` (§8.B).
**Priority:** P1 — owner decision pending.

Line references below were re-verified against the working tree on 2026-10-23.

---

## Gap A — Staff direct INSERT can publish

**Evidence**
- The `content` INSERT RLS policy is `is_staff()` only: `supabase/migrations/20261009100100_users_access_foundation.sql:79-80`.
- The content trigger's INSERT branch only stamps dates and `published_by`. It does not reject `status = 'published'`: `supabase/migrations/20261007100100_content_search.sql:714-718`.
- The app path forces new manual articles to draft: `src/app/admin/actions.ts:150`.

**Current exposure**
- Any staff JWT, including the editor role, can PostgREST-insert a row with `status = 'published'`. That skips the draft → pending → published workflow.
- The audit trail is partial: `published_by` is set only when `auth.uid()` is present (`:718`).

**Recommended remediation**
- Enforce at DB level: reject INSERT with `status = 'published'` (or force it to `draft`/`pending`) in the BEFORE INSERT trigger. Only the transition path may reach `published`.
- Verify with a PostgREST insert attempted as an editor-role account.

## Gap B — uid-NULL bypass of the transition guard

**Evidence**
- The transition matrix runs only when `v_uid is not null`. `v_uid` is resolved at `content_search.sql:702-706`, and the guard itself is at `:735`.
- Writes with no `auth.uid()` (service role or raw SQL) skip the matrix. They can perform any transition, including draft → published.
- With no acting user, `published_by` stays NULL: `:774` (`coalesce(v_uid, new.published_by)`).

**Current exposure**
- Any holder of the service-role key, or a compromised edge function, can publish any content silently and without an attributable actor.

**Recommended remediation**
- Enforce the matrix for uid-NULL writers as well.
- Add an explicit allowlist for the one legitimate machine transition (ingest-news radar finalize). Alternatively, require a dedicated machine claim set only by that trusted path and checked by the trigger.

## Gap C — `esl_promote` defaults to direct publish

**Evidence**
- With `INGEST_SECRET` and `op: "esl_promote"`, ingest-news sets `eslPromote` (`supabase/functions/ingest-news/index.ts:1834`). That flag feeds the radar authorization at `:1845`.
- `radar_publish_mode` defaults to `"publish"` (`:1875-1876`).
- Only the caller convention prevents machine publishing. `radar-editorial-select` sends `radar_publish_mode: "prepare"` (`supabase/functions/radar-editorial-select/index.ts:316-322`).

**Current exposure**
- Any `INGEST_SECRET` holder can send `esl_promote` without `radar_publish_mode` and machine-publish clean covered pilot articles, with no human in the loop.

**Recommended remediation**
- Flip the default to `"prepare"` and require an explicit, allowlisted flag for `"publish"`.
- This is already planned as part of Phase 3 of the editorial-standard plan. It is listed here because it is a security control, not only an editorial one.

---

## Current compensating controls

- **Publishing UI is staff-gated.** `requireStaff` (`src/lib/auth.ts:160-166`) is the chokepoint for every dashboard page and server action, including MFA enforcement.
- **Secrets limit callers.** The ingest path requires `INGEST_SECRET`. The service-role key is server-only.
- **No public path found.** No anonymous route in the audit scope reaches the publish, insert, or ingest paths. This was not exhaustively tested.
- These controls reduce exposure. They do **not** close Gaps A–C: any staff account or any secret holder can still reach them.

## Priority and decision

- **P1, owner decision pending.** No live exploit was observed. The exposure comes from the current RLS and trigger logic.
- Remediation requires separate owner approval. This document does not start it.

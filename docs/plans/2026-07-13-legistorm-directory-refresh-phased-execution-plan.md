# LegiStorm Directory Upgrade — Phased Execution Plan

> Phased view of the source spec **"LegiStorm Directory Safe Scheduled Refresh Implementation Plan"**
> (source doc: `capirov2-hermes-budget-ingestion/.hermes/plans/2026-07-13_134107-legistorm-directory-safe-refresh.md`).
> This copy lives in the canonical repo where the work executes. It regroups the source's 17 tasks into
> phases **without changing their intent, dependency order, or acceptance criteria**.

## Context

The source plan is a single, well-formed **17-task** spec with strict preservation guarantees, a linear execution order (§10), and per-task RED/GREEN tests. It is correct but monolithic — hard to review, land, and deploy in safe increments. This document regroups those same 17 tasks into **6 shippable phases (+ a Phase 0 of pre-reqs)** and adds two things the source lacks: (a) explicit phase-level exit gates and rollback levers, and (b) a two-track dependency map so backend and product work can proceed in parallel.

Each phase references the source task numbers; no task content is rewritten. The load-bearing current-state claims were verified against the canonical checkout before phasing; refinements are folded in below.

### Verified refinements to the source plan (confirmed in this checkout)
- **The empty-committees bug is real.** `buildCommitteeIndex()` reads `officeRaw.office` / `officeRaw.office_member_addresses` (legacy object shape) at `apps/api/src/directory/directory.service.ts:726` and `:893`; the spec fixture matches. If the live S3 `office-list-current.json.gz` is an array, committees return empty. Task 6's fix is genuinely high-value.
- **The "hard-coded" prefix is already env-overridable:** `process.env.DIRECTORY_S3_PREFIX ?? 'UPDATED DIRECTORY/snapshots/active-current-20260501T024354Z'` at `directory.service.ts:556`. The emergency-pin rollback lever therefore **already exists today**. `DIRECTORY_S3_BUCKET`/`DIRECTORY_S3_PREFIX` are already in `apps/api/src/config/config.schema.ts:20-21`; `LEGISTORM_*` is not yet.
- **The Directory UI is 5 modes, not 3:** Members / Staffers / Committees **+ DoW + State Legislators** (`Segmented`, `apps/web/src/pages/directory/DirectoryPage.tsx:186,676-705`). New routes/tabs in Phase 5 must not regress the DoW and State-Legislator surfaces.
- **Deep-link failure confirmed:** member detail is an Ant `Modal` resolved from the current page slice via `?profile=<entry.id>` (`DirectoryPage.tsx:207,412,1054`); staff cards have no route. Task 14 is warranted.
- Infra seams verified: `runWithSyncRun` (`apps/api/src/ingestion/sync-run.helper.ts:131`), the `INGESTION_JOBS` matrix + `ScheduledIngestionJobs` construct, and the secret-by-name pattern with `apiServeSecrets`/`apiMigrateSecrets` (`infra/cdk/lib/compute-stack.ts:137,382,406`) all exist. **Schedule-matrix drift is per-job** (several live rules were created out-of-band), reinforcing Task 8's "no broad `cdk deploy`" rule.

---

## Phasing at a glance

| Phase | Source tasks | Theme | Deploys? | Ships value |
|---|---|---|---|---|
| **P0** | pre-reqs (from Task 7.1-7.2) | Rotate key, clone hygiene | Secret only | Closes credential exposure |
| **P1** | 1 → 2 → 3 → 4 → 5 | Refresh pipeline core (dry-run only) | No | A tested, side-effect-free `sync-legistorm-directory` CLI |
| **P2** | 6 | Reader hardening + committee-array bugfix | api roll | Fixes live empty-committees; pointer-driven reads + fallback |
| **P3** | 7 (3-8) → 8 | Secrets wiring + **disabled** schedules | Targeted, out-of-band | Pipeline can run in ECS; rules exist DISABLED |
| **P4** | 11 → 12 → 13 | Product backend: indexes, detail/dictionary APIs, photo provenance | api roll | Deep-linkable detail + person→committee search endpoints |
| **P5** | 14 → 15 | Product UI: profile pages + committee dictionary | web roll | Independent profiles + committee/subcommittee browsing |
| **P6** | 16 → 9 → 17 → 10 | Gates, canary, enable, live E2E, runbook | Canary + enable rules | Recurring refresh LIVE + full acceptance |

This ordering is **identical to the source §10 execution order** (1,2,3,4,5,6,7,8,11,12,13,14,15,16,9,17,10) — only grouped, with the API-key rotation pulled forward into P0.

### Two-track dependency map (parallelizable)

```
                 ┌───────────────── DATA / INFRA TRACK ─────────────────┐
P0 pre-reqs ──►  P1 pipeline core ──►  P3 secrets + disabled schedules ──┐
                                                                          ├──►  P6 canary + enable + E2E + runbook
P2 reader + bugfix ──►  P4 product backend ──►  P5 product UI ────────────┘
                 └──────────────── PRODUCT TRACK ───────────────────────┘
```

- **P2 depends only on P0**, not on P1 — the office-array fix and pointer-driven reader can land as a standalone hotfix (with `previous_snapshot_prefix` tolerated-missing until P1's `LATEST.json` v2 exists; pin via `DIRECTORY_S3_PREFIX` meanwhile).
- **Product track (P2→P4→P5)** needs the reader/normalized office rows from P2, but **not** the refresh pipeline (P1) or infra (P3). It can be built and shipped against the existing pinned snapshot.
- **P6 is the only join point** that activates anything: it consumes P1+P3 (to publish a real snapshot) and P2+P4+P5 (to E2E-verify the product).

---

## Phase details

Each phase carries the source plan's own per-task tests as its internal gates; only the **phase exit gate** and **rollback lever** are added here.

### Phase 0 — Security & environment pre-reqs *(do immediately; blocks P3)*
- **Rotate the LegiStorm API key that was pasted in chat** and store the new value in Secrets Manager `capiro/dev/legistorm-api-key`, out of band (source Task 7 steps 1-2). Treat the pasted key as compromised.
- Confirm all execution happens in the **canonical `capirov2`** clone, not `capirov2-hermes-budget-ingestion`.
- **Exit gate:** new key verified live against a LegiStorm read endpoint; old key revoked; secret exists and is readable only by the intended role. No code, no app deploy.

### Phase 1 — Refresh pipeline core *(offline, dry-run only, no infra)*
- **Tasks 1→2→3→4→5:** sanitized fixtures + permissive types → bounded LegiStorm client (`X-API-KEY`, retries, pagination, `updated_from/to`) → deterministic active-view merge + tombstones → immutable S3 publisher with validation gates (publish `LATEST.json` last) → dry-run-first `sync-legistorm-directory` CLI wrapped in `runWithSyncRun`.
- Nothing runs automatically and no `--commit` is executed. Add `LEGISTORM_*` to `config.schema.ts` (mirror the `GOVINFO_API_KEY` precedent).
- **Exit gate:** all five tasks' jest suites + `@capiro/api typecheck` green; a dry-run makes **zero** S3/DB writes; the publisher never imports `DeleteObjectCommand`; the "put order" ordering test passes.
- **Rollback:** new files with no side effects — remove or leave dormant.

### Phase 2 — Reader hardening + live committee bugfix *(shippable as a standalone fix)*
- **Task 6:** add `normalizeOfficeRows()` supporting both the live array shape and the legacy object shape; build committees + contacts from normalized rows (preserving `office_type`, `congress_committee_code`, `parent_office.office_id`); replace the constructor-pinned prefix with **per-cache-rebuild pointer resolution** (`DIRECTORY_S3_PREFIX` = emergency pin; else resolve `LATEST.json`); add `previous_snapshot_prefix` → stale-cache fallback so the API never serves an empty directory.
- **Exit gate:** `directory.committees.spec.ts` (updated to the live array fixture) + new `directory.snapshot.spec.ts` + `directory.controller.spec.ts` green; `/api/directory/committees` returns non-empty results from the real array shape; pointer fallback + env-pin both exercised in tests.
- **Rollback:** already available — set `DIRECTORY_S3_PREFIX=UPDATED DIRECTORY/snapshots/active-current-20260501T024354Z` to pin the known-good snapshot.

### Phase 3 — Infra: secrets wiring + disabled schedules *(targeted, out-of-band)*
- **Task 7 steps 3-8:** import the (already-rotated) secret by name, build `apiSyncSecrets = { ...apiMigrateSecrets, LEGISTORM_API_KEY }` (do **not** add it to `apiServeSecrets`), grant least-privilege S3 (read snapshots+overlays; write snapshots/pointers/`LATEST.json` only; **no** `DeleteObject`, **no** overlay writes).
- **Task 8:** add `SyncLegistormDirectory` (MON-SAT 04:30 UTC) and `ReconcileLegistormDirectoryFull` (SUN 04:30 UTC), both created **DISABLED**; assert same script + non-overlapping days.
- **Guardrail:** reconcile the live `capiro-dev-api-sync:6` task def (container `api`) against synthesized `api-sync-jobs` first; deploy the **targeted** path only — never `cdk deploy --all`; apply task-def/secret/IAM changes out-of-band. Verify `:latest` carries the merge SHA before any roll.
- **Exit gate:** `cdk synth`/`diff` shows only the intended secret/IAM/env/schedule changes (no auth/ALB/DB/tenant-assets drift); `aws events describe-rule` shows both rules `State=DISABLED` with correct task def, container override, private subnets, and SG.
- **Rollback:** disable both rules; revoke the sync task's S3 write statements; preserve all snapshots.

### Phase 4 — Product backend: indexes, detail/dictionary APIs, photo provenance
- **Tasks 11→12→13:** build the full `DirectoryIndexes` in one cache pass (retain **all** committee memberships, not just Chair/Ranking/Vice; reverse person→committee + normalized-name search index; exact-ID joins only) → add additive endpoints (`/people`, `/members/:id`, `/staffers/:id`, `/committees/:id`, `/committees/:id/contacts`) leaving the four existing endpoints unchanged → photo provenance + read-only additive photo overlay (`contact-photos-v1.json`), staff photo nullable, never member-substituted.
- **Exit gate:** `directory-indexes`, `directory-detail`, `directory.controller`, `directory-photo` specs + the `directory-detail.e2e` suite green; existing `contacts`/`staffers`/`committees`/`committees/:id/staff` responses byte-compatible; `@Roles('standard_user')` + tenant scoping for notes/favorites unchanged; unknown IDs return 404 (no fuzzy resolution).
- **Rollback:** remove only the new routes; keep old list indexes behind a temporary code path until parity passes.

### Phase 5 — Product UI: profile pages + committee dictionary
- **Tasks 14→15:** deep-linkable `/directory/members/:memberId` and `/directory/staff/:staffId` pages (load by ID, not list-cache) with a shared `DirectoryProfilePhoto` (real URL → initials on `onError`, no layout shift); committee/subcommittee dictionary at `/directory/committees/:committeeId` with person-name→committee search (`Matched via {person} — {role}`), parent/child links, and a unified Contacts tab (all members + staff) with filters persisted in URL params.
- **Guardrail:** the Directory `Segmented` has **5** modes — preserve DoW and State-Legislator surfaces; keep the existing member modal + committee drawer as redirect/link surfaces during migration.
- **Exit gate:** `MemberDirectoryProfilePage`, `StaffDirectoryProfilePage`, `CommitteeDirectoryPage`, `CommitteeContactList` vitest suites + `@capiro/web typecheck` green; the source's required interaction assertions pass (ordinary-member name search returns committees; staff-name search returns committee evidence; deep link loads on hard reload; real photo vs initials both render).
- **Rollback:** disable the new routes/links; the existing 5-mode page keeps working.

### Phase 6 — Gates, canary, go-live, E2E, runbook *(the only activation phase)*
- **Task 16** (completeness/regression validation metrics + baselines) → **Task 9** (capture pre-canary evidence; ECS dry-run incremental + full; one `--commit` canary; re-verify overlay SHA-256/VersionIds + DB counts are byte-identical; enable MON-SAT after two clean daily runs, then SUN full) → **Task 17** (full live API/UI/a11y E2E + desktop/mobile screenshots; report criteria 21-35 individually) → **Task 10** (finalize `docs/runbooks/legistorm-directory-refresh.md`).
- **Exit gate (roll-up, all must hold):** `sync_run` latest = success; CloudWatch `ingestion.error_count = 0`; `LATEST.json` points to a validated snapshot with a valid `previous`; **both overlay checksums unchanged**; **no `DeleteObject` CloudTrail events** by the sync role; source success criteria 1-35 reported MET; both schedules enabled.
- **Rollback:** disable both rules and restore the prior `LATEST.json` version (or pin `DIRECTORY_S3_PREFIX`); never delete the new snapshot.

---

## Cross-cutting guardrails (apply in every phase)
1. **Preservation contract (source §2) is absolute:** never write/delete under `overlays/`, never `DeleteObject`, never mutate tenant notes/favorites/press; publish the pointer last; leave `LATEST.json` untouched on any validation failure.
2. **No broad CDK deploys** — task-def and per-job schedule drift is real; reconcile and deploy targeted, out-of-band.
3. **Clone hygiene** — canonical repo is `capirov2`; the source plan doc lives in the hermes clone.
4. **Secret discipline** — the LegiStorm key exists only in Secrets Manager; it must never appear in source, task env plaintext, logs, or diffs.
5. **Rollback is always the pointer/prefix**, never data restoration — snapshots are immutable and additive.

## Verification (how to confirm the phasing executes correctly)
Per-phase, run that phase's jest/vitest suites + the relevant `typecheck` (commands are inline in each source task). Additionally:
- **P1:** run `sync-legistorm-directory` (dry-run, no flags) locally with a stub `fetch`; confirm zero writes and a printed count-diff/validation report.
- **P2:** hit `GET /api/directory/committees?pageSize=20` against a fixture whose office file is the **array** shape and confirm non-empty results.
- **P3:** `cdk diff Capiro-dev-Compute` + `aws events describe-rule` for both new rules (expect `DISABLED`).
- **P4:** `directory-detail.e2e.spec.ts` + a manual `GET /api/directory/members/:id` deep call for an off-first-page member.
- **P5:** hard-reload `/directory/members/:id` and `/directory/committees/:id`; confirm they render without the list page loaded.
- **P6:** the roll-up exit gate above, executed as the canary/enable sequence in source Task 9 + Task 17.

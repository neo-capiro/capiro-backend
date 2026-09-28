# Research Portfolio qualification and recovery corrections — 2026-09-28

This is a local implementation correction record, not release acceptance. Research Portfolios remains **NO-GO**. The requirement, screen, action and acceptance registers remain authoritative and are not advanced by dependency-level tests.

Base: `42942dedad59382f4b4aac6f904b9aee0e02efa6` in `neo-capiro/capirov2`. Work is isolated on `codex/defense-continuation-20260928`. Dependency lock SHA-256: `85066a8c0a7fed669eb6ff2f37f928a23e6d322c49d04dbe802f7849435aff4b`.

## Corrected behavior

- A partial source value of `2.5` remains useful, with partial analytics/output qualification. Contributions retain the source disposition. CSV contribution details retain that qualification, and v2 totals carry overall availability/calculation version even when only totals are selected.
- Per-subject unit costs of `2` and `3` remain visible as nonadditive contributions; there is no invented total of `5`. Funding amounts still sum exactly within compatible bases, and missing values remain distinct from zero.
- New calculations use `research-portfolio-analytics-v2`. Existing v1 snapshots retain their stored projections and version. Legacy snapshots are not retroactively corrected or requalified; their historical limitations remain.
- Reconciliation preserves known partial/completed/failed/cancelled/queued states. An unknown or expired-running result requires actual artifact bytes, matching size/hash, and an immutable successful execution receipt for the current lease fence before it can recover completed/partial. Receipt metadata alone does not establish success.
- Active leases and concurrent state changes reject reconciliation. Reconciliation fences stale workers. Worker finalization checks current portfolio access and lease expiry; a cancelled or superseded worker failure cannot overwrite the winning request outcome.
- The stale source contract now checks the intended grant/client-link deletion signatures without crossing into later methods. Runtime routing is unchanged.

## Local evidence

| Check | Verdict | Result |
|---|---|---|
| Newly prepared tests before the fix | PASS reproduction | 25 failures, 7 passes, 32 total; exit 1 was expected for direct defect reproduction. |
| Focused API Research Portfolio + Defense Research tests | PASS | 235 tests, 16 suites, exit 0; includes 36 qualification/recovery regressions. |
| Focused web Research Portfolio tests | PASS | 20 tests, 3 files, exit 0; includes v1 compatibility and v2 partial/unit-cost display. |
| Direct service probes | PASS | Partial value retains partial status; unit-cost total is empty; partial reconciliation stays partial. |
| Shared TypeScript build | PASS | Exit 0. |
| API Nest application build | PASS | Exit 0. |
| Web TypeScript + Vite build | PASS | Exit 0; existing bundle-size warnings remain. |
| Phase 0, phases 1–4, phases 9–11 packet verifiers | PASS | Exit 0; phase 11 still explicitly reports NO-GO. |
| Full API typecheck | BLOCKED | The same 11 errors as baseline in `business-development.rls.spec.ts`; no new diagnostics. Chained later checks do not run after this failure. |
| Shared-file Prettier check | BLOCKED | Fails both the unchanged baseline and current source due to existing file-wide formatting debt. No broad formatting rewrite. |
| Defense Budget mirror parity | BLOCKED | Existing Navy-host validation differs between main API and defense-api mirror; both file hashes match their base commit. Neither file changed here. |
| Container builds/digests | NOT RUN | Docker executable is unavailable locally. Application builds are not container qualification. |
| Populated DB/HTTP/revocation/browser/File Writer acceptance | NOT RUN | Dependency-level tests do not establish target database rollback, role/RLS, real delivery, or deployment acceptance. |
| Merge/deploy/migrations/provider activation/canaries | NOT RUN | No authorization to merge or ship this correction; production canaries remain user-run. |

## Execution and limits

Codex orchestrated bounded edits and reviewed the resulting diff; Hermes executed the scripts. Neo authorized the configured default model. The actual default fallback used Bedrock `us.amazon.nova-pro-v1:0`; it did not use DeepSeek. Reported cost is unknown, not free. No global provider configuration was changed.

No database, tenant, source-ingestion, notification, route, capability-registry, environment, activation or deployment mutations were performed. No merge or main-branch integration was performed. The occupied local main and its unrelated Meri edits were preserved. Task worktree/branch are retained for review.

This record addresses local seams in RP-10, MX-02, S06/S17 and the AT-07/13/14/18/22 prerequisite regressions. Their full acceptance statuses remain unchanged. RP-01–RP-10, DI-01–DI-11, MX-01–MX-03 and OP-01 remain partial; OP-02–OP-04 remain blocked. S01–S18 remain partial. The AT-01–AT-24 and section 14.2 registers retain their existing NOT RUN/BLOCKED dispositions. F01–F42 and V4-01–V4-15 are not closed by these narrower tests.

Before release: resolve repository gate failures through their owners, build the actual API/web-vnext image contexts, rehearse populated-database concurrency/rollback and authorization, prove actual stored/downloaded/client-file bytes and revocation, qualify the source corpus independently, and obtain explicit merge/deployment/activation authority. The web destination remains `os.capiro.ai` through web-vnext.

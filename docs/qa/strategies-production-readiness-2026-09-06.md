# Strategies production readiness repair

Status: code repairs validated; independent review and deployed staging qualification remain.

Source reviewed: `3ba4915667bf53ebf99f3b8dc992d8938367b2da` (main at audit start). Main subsequently advanced to `395e9d68896f6f7302b43f023f0b5d9182340571`; its six changed Funding Opportunities files do not overlap this repair. The PR preserves that newer main tree.

## Scope

Reviewed the vNext Strategies library/editor/inspector, context and Steward screens, agent proposals/execution screens, all existing overlays, both API clients, and the dedicated Strategy API modules. Traced the Meri governed-service transport and existing report export contracts. Reviewed shared legacy interfaces for compatibility; the legacy Strategies regression suite is included in validation.

This repairs existing behavior. It adds no product features, database migrations, external-send permission, feature-flag activation, or deployment changes. The source was materialized from a pinned GitHub revision in an isolated partial checkout; existing workspace modifications were preserved.

## Confirmed defects repaired

| Area | Defect and resulting behavior |
| --- | --- |
| UI wiring | Add step now submits its form. Workspace/outreach actions resolve the existing manual execution mission and prepare a plan for review. Firm checks reach Mark reviewed. Approved runs can execute their existing approved plan; recoverable failures use Retry instead of the incompatible Resume endpoint. |
| UI state and errors | Ask Meri works on empty plans and open inspectors. Tabs follow URL state, drafts survive tab changes, failed sends preserve text, and duplicate submissions are blocked. Account/load failures provide recovery. Cached context remains visible after failed refreshes. |
| Calendars and phases | Calendar Done persists its working rows. Phase failures expose retry, invalid quarter/year ranges are rejected, pending replacement prevents conflicting edits/close, and exclusive fiscal-quarter ends render correctly. |
| Display accuracy | Active accepted work remains overdue/upcoming until its real terminal state. Due-today is handled correctly. Unsupported health/gate sorts were removed in favor of the existing truthful step-count sort. Watch failures do not imply all-clear. Current-plan export labels uncomputed checks as not evaluated. |
| Core persistence | Manual and Meri node removal archive stable node identities and detach artifact links into history, preserving conversations/provenance. Only live sibling dependencies are unlinked. Ongoing status stays restricted to risks. |
| Input validation | Invalid nulls, blank titles, malformed dates/path UUIDs and bad pagination inputs return validation errors. Version cursors are checked within the requested strategy. Existing client/tenant boundaries remain enforced. |
| Restore and concurrency | Restore previews account for metadata/provenance changes. Plan writers acquire the same tenant-scoped strategy lock before node writes. Undo checks its expected applied version inside restore's transaction. |
| Meri reliability | Duplicate assistant requests cannot invoke the model or apply edits twice. Unique-constraint replay lookup occurs after rollback in a fresh tenant transaction and verifies request ownership/context/content. Stale model results are rejected against the locked current plan. Transaction failures leave a durable error message. Long conversations return the newest 500 messages chronologically. |
| Agent authorization | Public generic run transitions are restricted to existing firm-review acknowledgments; callers cannot inject execution findings, tasks, approvals or successful execution states. Explicit draft refusal is respected. Change-set approve/reject operations serialize with apply. |
| Execution recovery | Retry actually plans its new attempt, preserves lineage, clears stale approvals/results, and respects mission state and capacity. Recovery uses legal transitions, preserves human-input holds, and reconciles completed Workspace staging. Artifact completion cannot downgrade a newer human status and updates the plan edit clock when it advances status. |
| Watch | Scheduler failures reach a legal terminal state. Freshness requires a successful current-day check against current inputs. Failed checks can be retried. Reconcile/accept/dismiss locking is consistent, and stale computed proposals cannot be attached to a newer plan. |
| Context lifecycle | Invalid provenance cannot erase prior usable facts. Extraction revalidates the source under lock. Archived/expired sources and retired conflict winners cannot control live grounding. Client/freshness filters are applied before bounded list limits; material conflicts are not hidden behind unrelated rows. |
| Context UI | Document fact queries are scoped on the server, with a separate active-fact eligibility check and confirmation-time recheck. Deep links update atomically. Upload previews/client binding, file-read/hash races/failures and size limits are handled. Conflict previews match persisted states and closing is blocked throughout either decision mutation. |
| Reports | Directory cache entries are isolated by caller and strategy reference; authorization failures are not shared. Portrait reads enforce the size ceiling while streaming. Archived strategies cannot export as current plans. Existing audience, evidence, narrative and renderer policies remain covered. |
| Service configuration | The Strategy API explicitly permits the existing `https://os.capiro.ai` frontend origin while preserving configured origins and rejecting unknown/lookalike origins. |

## Validation

All commands below completed successfully against the final code changes:

- Strategy API: `jest --runInBand --detectOpenHandles --forceExit` — **82 suites passed, 1,474 tests passed**. Four database integration suites (**17 tests**) self-skipped because no test `DATABASE_URL` was supplied.
- Strategies web: `vitest run src/pages/strategy src/vnext/pages/strategies --maxWorkers=2 --minWorkers=1` — **40 files, 420 tests passed**.
- Strategy API: `tsc --noEmit --incremental false` — passed.
- Strategies web and imported dependencies: scoped TypeScript check using the repository web tsconfig, its test setup, Vitest and Vite types — passed. The entire unrelated web application was not materialized, so this is not a full-monorepo build claim.
- `git diff --check` — passed.

Tests include real Nest module dependency compilation and HTTP controller/guard/validation seams. Database concurrency regressions use modeled transactions; upstream API/model calls are mocked. No live messages, model calls, production data writes, builds, image pushes or deployments were performed.

Independent cross-review checked frontend planning against existing backend contracts, recovery endpoint selection, active-step semantics, Meri replay/archival/freshness, and Strategy CORS/routing. Findings from that review were fixed before the final test pass.

## Staging qualification still required

1. Run the existing four database integration suites against an isolated migrated test database, including node delete/restore and tenant isolation. Exercise simultaneous plan edits, Watch acceptance, restore/Undo, and extraction/archive using PostgreSQL.
2. Build the full repository and deploy the repaired web and Strategy API together through the existing release process.
3. In the authenticated vNext UI, verify create/add/edit/Meri failure/retry, calendar persistence, phase saving, context upload/extract/archive/conflict decisions, Watch recheck/review, Workspace/outreach planning and recovery, history restore, and Word/PowerPoint export with client branding.
4. Verify the deployed `/strategy-api/*` ALB path and the `os.capiro.ai` CORS preflight. Source contains a listener definition but also documents separately managed production routing; live routing was not checked here.
5. Keep existing review/send controls and tenant flags in force. Confirm staged artifacts open in the existing downstream workspace/outreach review flows before calling the module production-qualified.

No merge or deployment is included in this audit closeout.

# Durable controls UI/backend integration report

Date: 2026-09-28
Branch: `codex/meri-durable-ui-integration`
Evidence root: `C:\dev\cap-meri-durable-budget`

## Source lineage

- Coordinator base and implementation: `df57a7984702c88a3c7f562d2b812f8eb4a32a1b`.
- Preserved coordinator source branch: `codex/meri-durable-step-coordinator`.
- Frozen UI source commit: `1a3a906ed19874c784e93af31db3bd9a6c00d0b6` from `C:\dev\cap-meri-coworker-b`.
- UI-only cherry-pick on this branch: `9f2ed01c8e63c2affafaf7bc008ce30d6990ca8a`.
- Integration qualification implementation: `d6645590bd53392a2c5928d2618d42a086157ec7`.

No UI parent history, other branch, provider aggregate, child adapter, model/routing/flag/delegation change, deployment, or push was included.

## Integrated contract

The web adapter and actual coordinator agree on these authenticated version-1 routes:

- `GET /api/clio/research/:researchId/coordinator?afterSequence=N`
- `POST /api/clio/research/:researchId/steer`
- `POST /api/clio/research/:researchId/cancel`
- Existing explicit resume: `POST /api/clio/research/:researchId/stream` with `X-Meri-Research-Resume-Run`.

The prior backend evidence report incorrectly listed `/steering`; `C:\dev\cap-meri-foundation-evidence\durable-step-coordinator-report.md` now says `/steer`. The server route was already correct and was not changed.

The combined implementation retains the prior source, approval, action-proposal, stream, replay-authorization, tool-budget, and unknown-metadata preservation controls. Accepted source and operation references stay visible after steering and cancellation; private fingerprint references remain filtered by the server projection.

## Integration changes

- Matched the browser snapshot parser to the complete public serializer, including nullable terminal `run`, initially-ready research before coordinator admission, current run lease/event fields, exact event types, exact cancellation shape, receipt version, and `appliedAt`.
- Treated a snapshot with no run as terminal display state. It cannot steer, Stop, resume, or restart work.
- Kept stop request and observed cancellation distinct: the cancel response may be `cancel_requested`; polling alone observes terminal `cancelled`.
- Kept disconnect as detach and resume bound to the same research and saved run identity.
- Made cursor reset authoritative and bounded to 200 ordered events. Reordered duplicate events cannot replace an already accepted sequence; older goal/plan/lease snapshots and post-terminal revival remain rejected.
- On current 401/403/404 scope denial, erased the snapshot, accepted-direction receipt, pending steering identity, cursor, and private display, aborted polling, and required an identity/research boundary before observing again.
- Cleared the controller's durable cancellation identity on route/identity invalidation so a later identity cannot reuse it.
- Preserved editable explicit Send and fill-only starters; no mount/reconnect path auto-sends, creates research, or starts an initially-ready run.
- Documented nullable terminal run and pre-admission HTTP 409 behavior in `docs/meri/implementation/durable-coordinator-ui-contract.md`.

## Actual localhost HTTP qualification

`apps/api/scripts/meri-durable-controls.http.integration.spec.ts` starts an actual Nest application on random localhost TCP, with the actual `MeriController`, actual `MeriResearchService`, DTO `ValidationPipe`, route decorators, and a controlled in-memory repository/provider. It calls that server through the production web functions from `apps/web/src/components/chat/meri-durable-research.ts`; the adapter is not replaced by a fetch mock.

The roundtrip proved:

- the production web function reaches actual `/api/clio/research/session-1/steer` and parses the real service receipt;
- current bearer/auth headers pass the HTTP guard and current impersonation scope header is carried by the client request;
- stale `expectedGoalRevision` returns and is parsed as HTTP 409 without mutation;
- cursor continuation returns only later sequences;
- steering fences the old run as `interrupted` and `readyToStart` without creating a session;
- Stop first returns `cancel_requested`, while a subsequent actual snapshot reports observed `cancelled`;
- accepted source and operation receipts remain truthful, while a private fingerprint operation is absent;
- unrelated provider-review metadata survives service CAS.

This is local integration qualification, not deployed or live-provider acceptance. Native PostgreSQL was not needed.

## Verification and exact exits

All successful commands used native Node `v22.23.3` and `NODE_OPTIONS=--max-old-space-size=8192`. No dependency installation was performed.

1. Shared build: `@capiro/shared` direct pnpm/TypeScript build — exit 0.
2. Meriv2 core build: `@capiro/meriv2-core` direct pnpm/TypeScript build — exit 0.
3. Strategy verifier build: `@capiro/strategy-verifier` direct pnpm/TypeScript build — exit 0.
4. API direct TypeScript typecheck — exit 0.
5. Meriv2 orchestrator direct TypeScript typecheck — exit 0.
6. Web direct TypeScript typecheck — exit 0.
7. Actual localhost UI-to-controller/service integration plus coordinator service contract — exit 0; 2 suites, 3 tests passed.
8. API coordinator/continuity/replay/replay-authorization/tool-budget qualification — exit 0; 6 suites, 71 tests passed.
9. Web durable parser/observer/component/recovery qualification — exit 0; 3 files, 25 tests passed.
10. Served V3 orchestrator suite — exit 0; 1 suite, 105 tests passed.
11. Web production TypeScript/Vite build — exit 0; 8,986 modules transformed, built in 1m 5s. Existing dynamic-import and large-chunk warnings only.
12. `git diff --check` before the integration commit — exit 0.
13. Web lint command — exit 1 because no ESLint executable exists in the prepared frozen dependency links (`'eslint' is not recognized`). No install was attempted.

Two initial `pnpm exec` test invocations exited 1 because the Git Bash shim resolved Corepack to the invalid native path `C:\c\Program Files\nodejs\node_modules\corepack\dist\pnpm.js`. The same suites were rerun with native Node and direct Jest/Vitest entry points and passed as recorded above.

## Remaining integration dependencies

- Provider aggregate commit `a082` remains under separate active review and was not copied, modified, or merged.
- The child adapter remains in its separate active tree and was not copied, modified, or merged.
- Combined parent-budget/children qualification remains required after lead sequencing of those reviewed changes.
- ESLint remains unavailable in the prepared no-install dependency set.
- No claim is made that broad File 01-C is complete, that general durable writes are enabled, or that this local result is live deployed acceptance.

No shared database, cloud provider, live provider, deployment, push, main-branch operation, or private credential output was used.

# Meri powered by Hermes — Phase 0 (contract and compatibility spike)

Prepared September 19, 2026 on branch `feat/meri-hermes-phase-0` (base `19a1834ac`). Pilot tenant: `capiro-internal` (canonical id `17b63099-bc0f-4ac5-b596-496161e9481e`, see `pilot-configuration.md`). Everything in this folder was produced against a local fixture database and local containers; no deployed environment was changed.

**Readiness recommendation: ready for Phase 1**, under the six conditions in `checks-report.md` §Recommendation (durable run store, worker lifecycle service, arm64 image, real Context Plane recall path, frontend cards, per-conversation session key). Final state of the checks: 21 runner checks and 1 labelled probe passed, 1 observed, 0 failed; blocked items are listed in §G and are Phase 1 tickets. Nothing deployed was changed and the pilot flag is off everywhere.

## Documents

| File | Purpose |
|---|---|
| `pins.md` | Hermes build pin (tag, SHA, tarball checksum, license), image ids, repository baseline, verified API surfaces |
| `harness.md` | How to rebuild the image, seed fixtures, run the harness and the unit tests; what is real vs substituted |
| `contracts.md` | Runtime / identity / event contracts, control surface, **UI ↔ command mapping table**, proposed durable records |
| `capability-ledger.md` | Every capability in the full audit with interface, native vs Meri integration vs end-to-end evidence, status and remaining work |
| `hermes-source-evidence-a.md`, `hermes-source-evidence-b.md` | File:line evidence from the pinned Hermes source for 20 capability areas (tools, terminal, browser, files, skills/learning, memory, delegation, approvals, clarify, ingestion, Bot Mode, cron/goals, media, plugins, sessions, checkpoints, usage, profiles, model config, limits) |
| `data-inventory.md`, `data-inventory.json`, `data-inventory.baseline.json` | Generated inventory of all 12 Prisma schemas (549 models) with heuristic scope/sensitivity/read-path classification and the coverage gap |
| `data-access-design.md` | Enforcement boundary and the `discover/describe/query/read_record/read_related/export` interfaces; migration coverage check |
| `state-and-isolation-decisions.md` | Authoritative state map, isolation model, worker lifecycle, memory/skills/scheduling decisions, architecture changes |
| `architecture.mmd` | Updated architecture (worker lifecycle, scope volume, broker, data gateway, scheduler) |
| `pilot-configuration.md` | Tenant resolution, three-key gate, worker configuration, model recommendation, enable / disable / rollback |
| `checks-report.md` | The meaningful checks with pass / fail / blocked / observed outcomes and evidence pointers; readiness recommendation |
| `measurements.md` | Startup, first-event latency, tool latency, CPU/memory, tokens, cost inputs (local host; not production guarantees) |
| `phase-1-backlog.md` | Dependency-ordered backlog with acceptance criteria, owners by role, revised estimates |
| `evidence/<run>/` | Raw evidence JSON per check, capability dumps, measurements, redacted logs |

## Code delivered on this branch

| Area | Files |
|---|---|
| Pilot gate | `apps/api/src/common/meri-hermes-flags.ts` (+spec), `MeriFeatureFlagsService.isMeriHermesRuntimeEnabled`, `apps/api/src/meri/meriv3-runtime.proxy.ts` (Hermes peer route, +spec) |
| Runtime adapter | `apps/api/src/meri/hermes/meri-hermes-runtime.adapter.ts`, `meri-hermes-runtime.client.ts`, `meri-hermes-event-translator.ts` (+spec), `meri-hermes-run-store.ts` (+spec), `hermes-runtime.contracts.ts` |
| Broker | `meri-hermes-broker.service.ts`, `meri-hermes-broker.controller.ts` (worker-token guard), `meri-hermes-worker-token.ts` (+spec), `meri-hermes-recall.ports.ts`, `meri-hermes-security.port.ts` |
| Control surface | `meri-hermes.controller.ts` (`/api/clio/hermes/*`), module wiring in `meri.module.ts` |
| Worker image | `docker/hermes-worker/` (pinned base build script, Meri layer, config/SOUL templates, `meri_memory` + `meri_tools` plugins) |
| Harness | `apps/api/scripts/meri-hermes-phase0-harness-api.ts`, `apps/api/scripts/meri-hermes-phase0-seed.ts`, `apps/api/tsconfig.meri-hermes-harness.json`, `scripts/meri-hermes/phase0-harness.mjs`, `phase0-harness-api.mjs`, `phase0-fixtures.json` |
| Data inventory | `scripts/meri-hermes/generate-data-inventory.mjs` |

Existing runtime behaviour for other tenants is unchanged: the Hermes route is consulted only when all three gate keys are open, and the factory still works without a Hermes adapter (proxy spec).

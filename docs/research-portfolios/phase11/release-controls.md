# Phase 11 release controls and rollback boundary

## Current release decision

- Release decision: **NO-GO**
- Enabled customer cohort: **NONE**
- Internal qualified test-tenant cohort: **NONE DECLARED**
- Research Portfolio activation changes made by this packet: **NONE**
- Source/publication/provider activation changes made by this packet: **NONE**
- Deployment, migration, notification or paid-provider operations made by this packet: **NONE**

## Feature/source cohort table

| Cohort or lane | Status | Limit | Enablement precondition | Independent rollback |
|---|---|---|---|---|
| Manual portfolio metadata CRUD | NOT RELEASED | Zero tenants | Target DB migration/RLS tests, API/web images, browser AT-01/03/04, named owner | Disable new web entry/API admission while preserving additive records/read compatibility. |
| Rules/imports/reviews | NOT RELEASED | Zero jobs | Phase 2/7 database concurrency, outage, compensation and browser acceptance | Stop new rule/import/review admissions; retain immutable versions, effects and receipts. |
| Analytics/snapshots | NOT RELEASED | Zero tenants | Qualified compatible projection, AT-07/14/22, populated DB and exact evidence | Disable analytics/snapshot creation; preserve immutable snapshots and supported reads. |
| Output/client-file delivery | NOT RELEASED | Zero jobs/downloads | Actual object/client writer, hash/open proof and pre/during/post revocation matrix | Stop admissions and delivery URLs; preserve operations/artifacts/receipts for reconciliation. |
| Meri research tools/actions | NOT RELEASED | Zero enabled tools | Registry/runtime/alias parity, explicit research context and AT-15 | Set `RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED=false`; manual portfolio access and unrelated Meri tools remain available. |
| Watches/notifications | NOT RELEASED | Zero deliveries | Configured channel, per-recipient state, baseline/no-flood and recovery proof | Set `RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED=false`; preserve event/subscription/personal state. |
| Baseline source/publication families | BLOCKED | No new admission/publication | Real-family denominators, independent labels/review, governed admission and activation authorization | Leave family switches dark; never delete accepted facts/history to roll back. |
| Model-assisted/JEV/provider lane | BLOCKED | Zero paid/new calls | Independent quality/cost evaluation and explicit provider authorization | Kill switch must leave deterministic/exact lanes and unrelated providers operational. |

## Evidence required before any cohort is non-empty

Record the exact environment/account/region, source and merge SHAs, dependency-lock hash, build IDs/logs, image digests, task/service/schedule revisions, migration ledger and login-role behavior, runtime route owner, flags, tenant cohort, queue/schedule state, canonical/source snapshot and manifest IDs, qualification hashes, measurement timestamps, operator/rollback owners and customer-visible gaps. Keep secrets and private client content out of the evidence.

Changed image contexts must be built, not inferred from TypeScript checks. Migrations must be rehearsed against a populated disposable database and applied before dependent readers/jobs. Real HTTP/database authorization and uniqueness tests are mandatory. A generic health response does not prove route ownership, corpus completeness, or product behavior.

## Limits that must be measured, not invented

Before release, record authenticated API p95 at declared concurrency; first usable render; queue age/lease/retry/dead-letter bounds; snapshot/export size, latency and cost; download/filing/indexing success; source age/coverage denominators; provider/model and human rescue economics; workload attribution; recovery time; and alert/operator response. No numeric product limit is asserted by this local packet.

## Rollback preparation and rehearsal

No deployment occurred, so no live rollback revision was captured and no rollback was rehearsed. Before each target mutation, release operations must re-read live state and capture the immediately previous compatible web/API/worker task or image revision, route/flag values, migration compatibility and canonical pointers.

Rollback must be lane-specific:

1. Stop new admissions for the affected UI/API/tool/worker/channel.
2. Restore the freshly captured compatible binary/config/route or flag.
3. Preserve additive tables, immutable versions, memberships, events, decisions, accepted facts, artifacts and operation history.
4. Restore canonical pointers only through the governed mechanism; never delete evidence or rewrite approvals to make old code look healthy.
5. Keep a compatibility adapter when the previous binary cannot read newly created records.
6. Rehearse a failed deployment, queued job and issued-output access revocation in the intended environment; verify dashboards and named recovery ownership.

## Completion boundary

Phase 11 is not fully complete until the applicable requirements and S01–S18 have implementation plus outcome evidence, AT-01–AT-24 and section 14.2 probes have honest terminal dispositions for the intended cohort, real-family corpus/annual/economics gates pass, affected runtimes build, deployment and rollback are rehearsed, and user-visible gaps are declared. Local packet validation alone never advances that boundary.

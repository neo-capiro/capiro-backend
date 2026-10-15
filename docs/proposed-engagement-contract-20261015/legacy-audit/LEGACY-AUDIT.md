# Read-only legacy Engagement runtime audit

## Result

At neo-capiro/capirov2 default main pin `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`, **no registered client Engagement plan/wave CRUD, plan-version/staleness contract or DC-window recommendation owner was found**. This expands the earlier absence finding beyond the frozen imported backend. It is a source-registration conclusion, not deployed-image or live-database qualification.

The frozen import `neo-capiro/capiro-backend@cd3c51e940f14e1b2a1040b0ffa445e85d68b332` retains every one of the legacy Engagement manifest's 134 method/path/controller/handler tuples. It contains 135 tuples; its sole addition is `GET /api/engagement/mail/mailboxes`. There is no omitted registered plan/wave route to port.

No production checkout, backend frozen artifact, Meri code, access contract, database or runtime was mutated.

## Pin and registered runtime evidence

GitHub repository metadata identified `main` as the default branch; the read-only branch endpoint resolved it to `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace` (commit timestamp 2026-10-11T18:12:38Z). The parent independently identifies this as the frontend registry's canonical production source pin. No AWS, image, service or production HTTP lookup was made.

| Registration step | Exact source |
| --- | --- |
| Main process creates AppModule | [main.ts:19](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/src/main.ts#L19) |
| AppModule imports the current EngagementModule | [app.module.ts:102](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/src/app.module.ts#L102) |
| Shared HTTP bootstrap installs /api prefix | [configure-api-http-app.ts:81](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/src/bootstrap/configure-api-http-app.ts#L81) |
| EngagementModule registers EngagementController, OutcomeController and KrispNotetakerController | [engagement.module.ts:107](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/src/engagement/engagement.module.ts#L107) |
| Current main controller owns /engagement and standard_user role | [engagement.controller.ts:1959](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/src/engagement/engagement.controller.ts#L1959) |
| Separate Engagement process creates EngagementApiAppModule | [engagement-main.ts:17](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/src/engagement-main.ts#L17) |
| Separate shell imports the same EngagementModule and explicitly named Outreach V3 modules | [engagement-api.app.module.ts:41](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/src/engagement-api.app.module.ts#L41) |
| Separate container serves that entrypoint, with no independent domain engine | [entrypoint.sh:48](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/engagement-api/scripts/entrypoint.sh#L48) |
| Manifest controller coverage checks actual static module registration | [controller-coverage.spec.ts:61](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/src/engagement/runtime/engagement-route-controller-coverage.spec.ts#L61) |

The standalone Engagement README describes a shadow process; existence of its image source does not prove live traffic ownership. Main and shadow shell both point to the same domain module.

## No omitted plan/wave owner

- [Legacy committed route manifest](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json) contains 134 unique method/path pairs, zero /plan(s) or /wave(s) route segments. [Imported manifest](https://github.com/neo-capiro/capiro-backend/blob/cd3c51e940f14e1b2a1040b0ffa445e85d68b332/apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json) contains the same 134 tuples plus the mailbox read.
- Complete pinned API tree inventories are nontruncated. All 293 `apps/api/src/engagement/` files and all 153 `apps/api/src/outreach-v3/` files exist in the frozen import. 282/293 Engagement files and 146/153 Outreach V3 files have identical Git blob SHAs; changed core module/controller/service files were read at the legacy pin.
- Legacy EngagementController routes cover contacts, integrations, meetings/materials, mail, outreach, reports, tasks, context, attachments and campaigns; no plan/wave route family appears. The report/task route group is explicit at [controller:2773](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/src/engagement/engagement.controller.ts#L2773).
- Full legacy schema inspection finds these Engagement-prefixed models: EngagementContact, EngagementAttachment, EngagementTask, EngagementReportTargetOffice, EngagementReportTargetOverride, EngagementCampaign and EngagementCampaignRecipient. There is no EngagementPlan/Wave model, plan version, DC-window or sitting/recess source model. [Task and report models:1736](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/prisma/schema.prisma#L1736), [campaign model:3680](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/prisma/schema.prisma#L3680).
- The 12-route V3 state manifest is not the whole V3 runtime. Its separate generation module does expose a message-generation plan, already mapped in the frozen-backend handoff. The [generation-plan source](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/src/outreach-v3/generation/outreach-v3-generation-plan.ts#L70) is byte-identical to the frozen import. Its session/stateVersion/specHash/recipient slots belong to Outreach generation, not client plan/wave scheduling.
- [Report target metadata:1771](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/prisma/schema.prisma#L1771) carries office identity/display/status history. Its annual `targetId+reportYear` overrides do not define plan revision, wave format/window, objective lineage or stale-plan policy.
- [ClientTargetRecommendation:3588](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/api/prisma/schema.prisma#L3588) caches OfficeRecommendation output with computedAt; this recommends offices from client evidence, not DC visit windows. Other plan-bearing schema entities concern research or defense-budget domains.

This does not establish that arbitrary metadata or old database rows contain no historical plan-shaped data. Neither would supply a registered, versioned public contract by itself. Unregistered branches and historical variants are not approved implementation sources.

## Current reachable UI versus historical variants

The current vNext router claims Engagement through [VNextRouter.tsx:187](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/web/src/vnext/app/VNextRouter.tsx#L187). Its [destination union/readiness mapping:20](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/web/src/vnext/pages/engagement/engagement-route-state.ts#L20) has exactly meetings, library, outreach and reports; [render switch:124](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/web/src/vnext/pages/engagement/VNextEngagementRoutes.tsx#L124) mounts those four. There is no client-plan/wave tab or API binding.

The Outreach branch explicitly mounts Classic V2 and leaves the V3 builder in the tree but unmounted ([source:129](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/web/src/vnext/pages/engagement/VNextEngagementRoutes.tsx#L129)). Merely finding another implementation file is therefore insufficient evidence that it is current.

The classic App still has an EngagementPage fallback ([App.tsx:230](https://github.com/neo-capiro/capirov2/blob/4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace/apps/web/src/App.tsx#L230)); that page binds current tasks/reports and has no plan/wave/window contract. These root router, route-state, current route shell and classic-page files are byte-identical in the frozen backend import.

The frontend historical row `ENG-legacy_engagement_waves` is a requirement ledger identifier, not a server route family. Its historical implementation matrix labels waves/DC windows/plan visit `noendpoint` and `obsolete/legacy` ([matrix:213](https://github.com/neo-capiro/capiro-frontend/blob/e9df91d876eaad05d13fdd0707c1fe39d5affb62/docs/portfolio-31/handover-2026-10-11/implementation-matrix.csv#L213)). That historical exclusion does not cancel the retained current design; it also does not provide reusable runtime behavior.

## Reusable primitives and action for the proposal

Reuse the currently registered report-target office identities and mutation semantics, existing meeting/task owners, trusted tenant/actor handling and the canonical existing permitted-client grant mechanism after its owner is identified. Preserve Team as open-follow-up workload. No new account-assignment or authorization scope follows from this audit.

No legacy client-plan persistence implementation should be copied. The proposed owner may now specify the smallest additive plan/wave contract against current primitives, explicitly marking new business rules (stale meaning, calendar provenance/window ranking and lifecycle) for review before persistence or migrations. Keep unavailable state truthful until an authoritative read exists. Do not reinterpret report status timestamps, ClientTargetRecommendation.computedAt or Outreach generation stateVersion as client-plan versions.

## Checks, scope and limits

Executed static audit: 134 unique legacy routes; no plan/wave route segments; no EngagementPlan/Wave schema model; exact method/path/controller/handler set comparison against 135 imported routes. Git-blob comparison supports the no-omission claim. The report-target implementation and tests, report behavior tests, HTTP report DTO tests and registered-controller coverage tests are byte-identical between pins; this audit did not rerun runtime or database tests.

Read-only `git -C C:\\dev\\capirov2 ...` commands were denied with `Permission denied`; the live checkout was not retried or changed. GitHub connector reads succeeded and supplied all pinned evidence. No remaining source-access blocker. Deployed image/traffic ownership, actual provider behavior, authorization enforcement and live PostgreSQL behavior remain unqualified under the requested no-live-activity boundary.


# Phase 3 — Full Existing Engagement Experience Parity

## Objective

Run the exact current Engagement SPA through the accepted Phase 2 dark `engagement-api` route without redesigning the product, moving external side-effect ownership, or implementing Outreach V3.

## Runtime contract

Normal mode:

```text
current SPA → /api/engagement/* → main API
```

Preview mode, activated only by an operator:

```text
?engagement-api-preview=v3
sessionStorage: capiro.engagement-api-preview=v3
X-Capiro-Engagement-Preview: v3
→ accepted Phase 2 header+path route
→ engagement-api
```

The activation parameter is consumed with a history replace. Unknown values are consumed but do not change mode. Preview state is session/tab scoped.

## Service identity and false-parity prevention

Every preview Engagement response, including an error response, must carry:

```text
X-Capiro-Service: engagement-api
```

A missing/wrong identity becomes `ENGAGEMENT_PREVIEW_ROUTE_MISS`; a main response is never accepted as preview evidence.

Only the exact server code `ENGAGEMENT_EXTERNAL_ACTION_DISABLED` is translated to:

> This action is disabled in the Engagement API preview. No external action was taken.

Generic 503s and `ENGAGEMENT_CALLBACKS_DISABLED` retain their existing meaning.

The request config records whether an Engagement request was dispatched in `main` or `preview` mode. A response that completes after the operator toggles to the other mode is rejected as `ENGAGEMENT_PREVIEW_STALE_RESPONSE`, so an in-flight old-mode result cannot populate the new-mode UI.

## Cache contract

On a real mode transition:

1. mark Engagement response objects at the axios boundary;
2. cancel React Query entries proven to be Engagement-owned;
3. remove only those entries;
4. preserve Directory, Workspace, Strategy and other non-Engagement caches;
5. reject an old-mode transport response even when its queryFn did not consume React Query's AbortSignal.

This is deliberately not a whole-app `queryClient.clear()`.

## Local parity architecture

`pnpm verify:engagement-phase-3:local -- --sha <exact-head>` runs:

```text
PostgreSQL 16 + pgvector (disposable)
main API       127.0.0.1:4000
engagement-api 127.0.0.1:4500
local ALB-equivalent proxy 127.0.0.1:4600
web SPA        127.0.0.1:5173
```

The proxy sends only exact path+header preview requests to `4500`; all normal Engagement and all non-Engagement requests stay on `4000`.

The runner:

- applies the repository migration history to the disposable DB;
- seeds the deterministic Phase 3 fixture catalog;
- binds only the fixture Clerk identity columns to dedicated acceptance actors at runtime;
- starts main and shadow with workers, callbacks, Recall and external actions disabled;
- drives isolated main/preview Chrome contexts;
- captures four viewports, network records, DOM snapshots and basic accessibility/layout invariants;
- replays browser-observed Engagement GETs directly against both API processes;
- proves one safe database-local task round-trip across both runtimes and one shared row;
- exercises every UI-inventory request classified `external_action` through preview;
- requires exact shadow denials and an identical before/after protected-state digest;
- cleans the fixture rows and disposable DB;
- stores bearer material only in OS temp storage and force-deletes it.

## Permanent DB-free gate

```bash
pnpm verify:engagement-phase-3
```

It includes:

- Phase 0, Phase 1 and Phase 2 prerequisite verifiers;
- current UI inventory drift checks;
- preview route-pattern generation drift;
- preview-header source containment;
- deterministic fixture tests;
- direct Phase 3 acceptance-script TypeScript project (F-003 workaround);
- focused preview/service/cache tests;
- harness/proxy/scope/V3 negative controls;
- V3/prototype boundary enforcement;
- findings/scope closeout;
- local script syntax checks;
- web production typecheck, build and complete regression suite;
- committed-range whitespace check.

## Findings

Machine-readable closeout source:

`docs/plans/engagement-api/phase-3-findings-ledger.v2.json`

Current required closeout counts are:

```text
open P0 = 0
open P1 = 0
blocking P2 = 0
```

F-003 remains an accepted non-blocking baseline defect: the broad `apps/api` typecheck short-circuits on pre-existing defense-budget TS6059 errors. Phase 3 therefore runs its own TypeScript acceptance project directly rather than claiming the later checks in that chain ran.

## Explicit nonchanges

- no Prisma migration;
- no canonical `/api/engagement/*` cutover;
- no Recall/callback cutover;
- no worker transfer;
- no provider generation/send enablement;
- no AWS/CDK/ALB mutation in code-complete work;
- no Outreach V3 route/component/state machine;
- no LangGraph;
- no prototype asset shipping;
- no Outreach v2 removal.

## Downstream handoffs

- reverse dependencies / side-effect ownership: `phase-3-to-phase-4-gap-ledger.md`;
- later Outreach V3 work: `phase-3-to-outreach-v3-handoff.md`.

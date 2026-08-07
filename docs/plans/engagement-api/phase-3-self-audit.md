# Phase 3 — Code-Complete Self-Audit

**Repository:** `neo-capiro/capirov2`  
**Branch:** `agent/engagement-api-phase-3-full-ui-parity`  
**Accepted execution base:** `3841a5ee58e011be7fb4fb6008adfccf081976d9`  
**Implementation head reviewed before this document:** `e58b32453d9932e795b1be925a6e3b62147ab883`  
**Mode:** Phase 3 Stage 3.14 self-audit, not independent validation

## Decision

```text
NOT_APPROVED
```

The Phase 3 implementation is structurally complete and the findings ledger has:

```text
Open P0: 0
Open P1: 0
Blocking P2: 0
```

However, the plan requires executable evidence from the permanent DB-free verifier and authoritative local browser/database runner before code-complete can be declared green. This execution environment cannot access the recovered Windows worktree or its local Docker/Chrome/Clerk runtime, and GitHub Actions for this repository fails at `startup_failure` before any job is created.

No execution result is fabricated or inferred from source review.

## Full-diff review

Reviewed the accepted Phase 2 head through the Phase 3 implementation head. Confirmed Phase 3 does not add:

- Prisma migration;
- infrastructure/CDK/ALB mutation;
- historical Compute-stack change;
- canonical Engagement route cutover;
- Recall/callback cutover;
- worker transfer;
- external-action enablement;
- Outreach V3 production route/component;
- LangGraph;
- prototype asset;
- Outreach v2 removal.

The permanent scope and prototype-boundary verifiers encode these rules and include negative controls.

## Load-bearing implementation checks

### Preview routing and identity

- preview is off by default and session-scoped;
- only route-manifest-derived Engagement paths may receive the preview header;
- `/me`, Capiro Admin, Directory, Workspace, Strategy and non-Engagement owners are structurally excluded;
- Authorization and allowed impersonation headers are preserved;
- Capiro Admin impersonation suppression is unchanged;
- every marked preview success/error must identify `engagement-api`;
- missing/wrong identity becomes `ENGAGEMENT_PREVIEW_ROUTE_MISS`;
- generic 503 and `ENGAGEMENT_CALLBACKS_DISABLED` remain ordinary errors;
- only exact `ENGAGEMENT_EXTERNAL_ACTION_DISABLED` receives the preview refusal copy.

### Cache / in-flight transitions

F-004 closed:

- every accepted Engagement request records dispatch-time `main` or `preview`;
- actual Engagement response objects are marked at the axios boundary;
- a mode transition cancels/removes only Engagement-owned React Query data;
- unrelated mixed-page caches remain;
- an old-mode success or error completing after a toggle is discarded as `ENGAGEMENT_PREVIEW_STALE_RESPONSE`.

The audit found and fixed F-008: the older api-client regression test still expected the unsafe pre-F-004 behavior.

### Browser/local acceptance architecture

The local runner is exact-head and clean-tree gated. It creates one disposable pgvector/PostgreSQL database and runs:

```text
main API        :4000
engagement-api  :4500
ALB-equivalent preview proxy :4600
web             :5173
```

The browser runner uses isolated main/preview Chrome contexts, the real SPA activation mechanism, four required viewports, screenshots, DOM/network evidence, service-header assertions and basic accessibility/layout invariants.

Bearer material is stored only in OS temp storage and deleted in cleanup (F-006).

### Read parity

Two complementary proofs are implemented:

1. replay every browser-observed Engagement GET directly against both runtimes;
2. sweep every unique UI-inventory request classified `read`, materialize deterministic fixture IDs, require real 2xx data, compare normalized status/body, and reject matching synthetic 404s.

### Safe database-local write

The local runner creates one disposable Engagement task through preview, reads/updates it through main, reads it back through preview, asserts one shared DB row, and cleans the probe row.

This proves shared-database interoperability without a dual-write layer. Existing full web regression tests remain responsible for the current product's individual form/interaction behavior.

### Security

The local security verifier compares main/shadow denials for:

- missing bearer;
- invalid bearer;
- wrong tenant hint;
- below-required role;
- cross-tenant record;
- same-tenant other-user private record;
- ethical-wall denied client context.

A single dedicated real Clerk acceptance bearer is temporarily rebound to deterministic actors only inside the disposable DB and is restored after every probe. No Clerk configuration is changed.

The audit found and fixed F-010: the first wall probe used a private meeting and could have passed on ownership before the wall check. It now probes `GET /api/engagement/context/:clientId` for `client.walled`, eliminating that alternate cause.

### External-action containment

Every distinct current UI request classified `external_action` is sent through the preview proxy and must return:

```text
503
ENGAGEMENT_EXTERNAL_ACTION_DISABLED
X-Capiro-Service: engagement-api
```

The verifier hashes complete protected Engagement rows before and after the sweep and requires identical hashes. This proves the denial occurs before provider/S3/bot/job/send side effects.

The audit found and fixed F-009: an early digest projection guessed a non-existent Prisma field. The final verifier hashes complete rows rather than a brittle projection.

### V3 / Phase 4 boundary

- V3/prototype boundary has an executable negative-control verifier;
- reverse dependencies and side-effect ownership are recorded in `phase-3-to-phase-4-gap-ledger.md`;
- later V3 state/API/auth/fixture needs are recorded in `phase-3-to-outreach-v3-handoff.md`.

## Findings disposition

Authoritative source:

```text
docs/plans/engagement-api/phase-3-findings-ledger.v2.json
```

Current notable statuses:

- F-001: FIXED
- F-002: FIXED
- F-003: BASELINE_ACCEPTED, P2 non-blocking
- F-004: FIXED
- F-005: FIXED
- F-006: FIXED
- F-007: ENV_BLOCKED, P3 GitHub Actions startup failure
- F-008: FIXED
- F-009: FIXED
- F-010: FIXED

## Executable evidence obtained in this implementation session

A copied pure-Node subset of the local proxy and browser network/DOM contract tests was executed with Node 22.16 in the available container:

```text
16 tests
16 passed
0 failed
```

This is useful implementation evidence for pure functions only. It is **not** substituted for the repository's permanent verifier or browser/database acceptance.

## Environment blocker evidence

GitHub Actions runs associated with Phase 3 draft PR #781 fail with `startup_failure` and contain zero jobs, before checkout or any Phase 3 command runs.

The accepted Phase 1 head (`47902517c7dd64a408a87cef57323812407c29c8`) reproduces the same repository-level `startup_failure` / zero-job condition. Therefore the absence of hosted execution is an environment limitation rather than evidence that a Phase 3 test ran and failed.

This session also has no mounted checkout of `C:\Users\neoma\Downloads\capiro-eng-p2`, no connector to execute commands on that host, and no AWS runtime tool.

## Required remaining gate

On the recovered worktree, synchronize to the final Phase 3 head and execute:

```bash
pnpm install --frozen-lockfile
pnpm --filter @capiro/api exec prisma generate
pnpm verify:engagement-phase-3
pnpm verify:engagement-phase-3:local -- --sha "$(git rev-parse HEAD)"
```

Only real passing markers/evidence can change this self-audit decision from `NOT_APPROVED` to `APPROVED_FOR_PHASE3_DEV_LIVE_ACCEPTANCE`.

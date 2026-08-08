# Outreach V3 Revised Phase 2 Readiness

## Entry condition

Revised Phase 2 may begin only after:

```text
Phase 3 DB-free PASS
Phase 3 authoritative local PASS
Revised Phase 1 DB-free PASS
Revised Phase 1 authoritative local PASS
Open P0 = 0
Open P1 = 0
Blocking P2 = 0
Independent validation = OUTREACH_V3_PHASE1_APPROVED
```

## Available foundations

Phase 2 can consume the shared capability registry and provider-neutral adapter contract; it must not copy client context, recent activity, or record lookup into an Outreach-owned implementation. It can rely on exact immutable draft-version review and the explicit runtime ownership modules.

## Phase 2 scope

Phase 2 owns the canonical Campaign Spec, state versions, event log, strict command schemas, and deterministic command engine. It does not inherit authority to transfer production callbacks/workers/Recall, enable the future ownership profile, or introduce a separate AI platform.

## Known operational prerequisite

GitHub Actions must create executable jobs, and the authoritative local host must provide Docker/pgvector, Chrome/Chromium, and dedicated Clerk acceptance actors. Source review or a workflow `startup_failure` is not a passing gate.

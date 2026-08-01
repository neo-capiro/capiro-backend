# MeriV2 Phase 7 — Truthful Context Packet Persistence

## Status

**PASS — Phase 7 code acceptance is closed.**

**Accepted validation head:** `f8d886d4d24c6b8778c21a94e72d3bc6036267d0`  
**Accepted runtime-fix head:** `a3535542318004dd5454d6efc07216844cd38936`  
**Branch:** `agent/meriv2-world-class-closeout`  
**Draft PR:** `#679`  
**Moving baseline at acceptance:** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`  
**Behind moving `main` at acceptance:** `0` commits

No merge, deployment, shared/production migration execution, backfill, production feature-flag activation, AWS operation, external send, or customer-data mutation is authorized by this record.

## Objective closed

Phase 7 required one invariant: **a durable Context Packet ID may be exposed only after the exact packet row exists and is retrievable, and persisted provenance must retain the server-resolved effective scope that produced it**.

The accepted implementation establishes one shared persistence owner around the deterministic Context Compiler. The compiler creates an internal attempt identity, removes it from the public packet contract, awaits adapter insertion and exact read-after-write verification, and only then exposes that ID with `persisted: true`. Any failed or unverified write leaves the public packet ID null.

## Runtime contract

### 1. Generated and persisted identity are distinct

`TruthfulContextCompiler` distinguishes:

- `generatedPacketId` — private identity used for the attempted insert;
- `persistedPacketId` — exact durable identity returned by the verified adapter;
- `packetId` — public alias populated only after persistence succeeds;
- `persisted` — explicit success evidence;
- `persistenceErrorCode` — bounded, non-sensitive failure classification.

A generated UUID is never treated as proof that a database row exists.

### 2. Persistence ownership is centralized

The deterministic compiler no longer owns or fire-and-forgets packet writes. `TruthfulContextCompiler` performs one post-compilation persistence decision:

- `required` — throws a bounded `ContextPacketPersistenceError` and holds the audited high-risk operation;
- `best-effort` — returns `packetId: null`, `persisted: false`, and truthful degraded provenance.

Raw database/provider messages, prompts, memory bodies, generated content, secrets, and email bodies are not placed in the public failure contract.

### 3. Every adapter throws, verifies, and preserves effective identity

The API, MeriV2 orchestrator, and Workspace adapters all:

1. insert with `id = generatedPacketId`;
2. await the insert;
3. query the exact ID under tenant scope in the same transaction;
4. reject if the exact ID cannot be read back;
5. return only the verified durable ID;
6. persist the packet's server-resolved `effectiveTenantId`, rather than replacing it with the owning `tenantId`.

An adapter cannot swallow an insert or readback failure and still produce `persisted: true`. Impersonation/effective-scope evidence cannot be collapsed to the owning tenant during persistence.

### 4. Best-effort conversational failure is truthful

Audited conversational/internal surfaces use best-effort persistence. On failure they may continue, but their summary carries:

- `packetId: null`;
- `persisted: false`;
- a bounded persistence error code;
- a degraded explanation.

The Context Inspector does not display a packet ID unless `persisted === true`.

### 5. Required audited surfaces hold before release

The v2 surface policy marks the audited editor, Strategy, and Workspace-generation boundaries as required. A persistence failure cannot be downgraded by those call sites.

Workspace uses a request-local `AsyncLocalStorage` boundary. Two concurrent generation requests for the same draft cannot clear or consume one another’s hold. The accepted implementation blocks single-section output before the response and generated-draft writes at the Prisma boundary.

### 6. Displayed IDs are exactly reloadable

`GET /clio/context-packets/:id` reloads the displayed ID under both tenant and user scope. Missing rows return `404`; the endpoint cannot synthesize a healthy packet. Stored packet views explicitly set `persisted: true`, while live failed/unavailable summaries set `persisted: false` and `packetId: null`.

## Final audit defects found and closed

1. **Cross-request Workspace hold interference.** A process-global hold map allowed concurrent same-draft requests to clear or consume one another. Replaced with request-local `AsyncLocalStorage` and a concurrency regression.
2. **Fail-open packet-ID display.** Context Inspector displayed `packetId` when `persisted` was absent. It now requires explicit `persisted: true`; a regression proves an unproven ID is never rendered.
3. **Effective-tenant provenance collapse.** The core packet carried `effectiveTenantId`, but all three persistence adapters wrote the owning `tenantId` into `context_packet.effective_tenant_id`. API, orchestrator, and Workspace now preserve the effective identity, with adapter-level regressions.

The third correction touched only Context Packet adapters and their tests. No Program Element or defense-budget runtime file was modified.

## Acceptance validation on `f8d886d4`

Permanent cumulative workflow `memory-governance-ci` run `30581917284` passed:

- all five Prisma clients generated;
- full repository dependency-graph typecheck — **PASS**;
- projection-worker infrastructure typecheck — **PASS**;
- API governed-memory Phases 1–7 — **55 suites / 480 tests PASS**;
- Phase 7 core persistence and surface policy — **2 suites / 16 tests PASS**;
- orchestrator Context/Strategy/Steward matrix — **6 suites / 37 tests PASS**;
- Workspace canonical context and request-local persistence hold — **5 suites / 37 tests PASS**;
- Settings and Context Inspector contracts — **2 files / 10 tests PASS**.

**Cumulative total: 70 suites/files and 580 tests, all passing.**

Required companion workflows on the same validation head:

- `memory-governance-ci` — run `30581917284` — **PASS**;
- `ci-pr` — run `30581917248` — **PASS**;
- `meriv2-evals` — run `30581917290` — **PASS**;
- `engagement-trust-boundary` — run `30581917322` — **PASS**;
- `legiwatch-ci` — run `30581917244` — **PASS**;
- `funding-opportunities-ci` — run `30581917261` — **PASS**.

The funding workflow also completed clean-PostgreSQL migration deployment, Prisma schema validation, feature schema assertions, API/web typechecks and tests, and API/web builds successfully. No migration was applied to a shared or production environment.

## Acceptance gate

**PASS. Every packet ID displayed by the product is backed by an exact, tenant-scoped, retrievable `context_packet` row, and the row retains truthful effective-scope provenance.**

Best-effort failure is visible and carries no ID. Required audited generation boundaries hold before release. Concurrent Workspace requests cannot alter one another’s persistence decision.

## Rollback posture

- Keep Context Packet v2 and tenant rollout flags dark.
- If a required surface must be relaxed during investigation, explicitly change that surface to best-effort; return no packet ID and preserve degraded evidence.
- Do not restore fire-and-forget adapter writes.
- Do not display generated IDs or infer persistence from UUID shape.
- Preserve durable packet rows and additive schema; no destructive data rollback is required.
- Do not merge, deploy, migrate, backfill, enable production flags, or alter customer data as part of Phase 7 closeout.

## Next gated phase

**Phase 8 — Context Packet v2 `off | shadow | enforce` rollout and complete surface policy.** Phase 8 was not started in this phase.

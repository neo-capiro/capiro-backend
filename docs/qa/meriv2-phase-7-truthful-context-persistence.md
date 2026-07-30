# MeriV2 Phase 7 — Truthful Context Packet Persistence

## Status

**PASS — Phase 7 code acceptance is closed.**

**Accepted code head:** `855455a2fa67a669d2d9a88a1b1473980a07c8fd`  
**Branch:** `agent/meriv2-world-class-closeout`  
**Draft PR:** `#679`  
**Moving baseline:** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`  
**Behind moving `main` at acceptance:** `0` commits

No merge, deployment, shared/production migration execution, backfill, production feature-flag activation, AWS operation, external send, or customer-data mutation is authorized by this record.

## Objective closed

Phase 7 required one invariant: **a durable Context Packet ID may be exposed only after the exact packet row exists and is retrievable**.

The accepted implementation establishes one shared persistence owner around the deterministic Context Compiler. The compiler creates an internal attempt identity, removes it from the public packet contract, awaits the adapter insert and exact read-after-write verification, and only then exposes that ID with `persisted: true`. Any failed or unverified write leaves the public packet ID null.

## Runtime contract

### 1. Generated and persisted identity are distinct

`TruthfulContextCompiler` now distinguishes:

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

### 3. Every adapter throws and verifies the exact row

The API, MeriV2 orchestrator, and Workspace adapters all:

1. insert with `id = generatedPacketId`;
2. await the insert;
3. query the exact ID under tenant scope in the same transaction;
4. reject if the exact ID cannot be read back;
5. return only the verified durable ID.

An adapter cannot swallow an insert or readback failure and still produce `persisted: true`.

### 4. Best-effort conversational failure is truthful

Audited conversational/internal surfaces use best-effort persistence. On failure they may continue, but their summary carries:

- `packetId: null`;
- `persisted: false`;
- a bounded persistence error code;
- a degraded explanation.

The Context Inspector does not display a packet ID unless `persisted === true`.

### 5. Required audited surfaces hold before release

The v2 surface policy marks the audited editor, Strategy, and Workspace-generation boundaries as required. A persistence failure cannot be downgraded by those call sites.

Workspace uses a request-local `AsyncLocalStorage` boundary. The final audit replaced a process-global tenant/draft hold map because two concurrent generation requests for the same draft could otherwise clear or consume each other’s hold. The accepted implementation isolates the failure state to the individual request and blocks:

- single-section output before the controller returns it;
- whole-document/retry/direct generation at the first generated-draft write through the Prisma boundary.

A regression test runs two concurrent requests for the same tenant and draft and proves that the clean request cannot clear the failed request’s hold.

### 6. Displayed IDs are exactly reloadable

`GET /clio/context-packets/:id` reloads the displayed ID under both tenant and user scope. Missing rows return `404`; the endpoint cannot synthesize a healthy packet. Stored packet views explicitly set `persisted: true`, while live failed/unavailable summaries set `persisted: false` and `packetId: null`.

### 7. Phase 8 boundary remains explicit

Phase 8 owns the `off | shadow | enforce` rollout, tenant canaries, required-versus-optional layer policy, and safe v2 enablement for the currently excluded memo, outreach, district-brief, and research body-rendering surfaces. Those surfaces remain dark rather than printing typed v2 envelopes into deliverables. This deferred rollout does not reopen Phase 7’s acceptance invariant: no failed attempt can expose a durable packet ID.

## Final audit defects found and closed

The final Phase 7 review found two release blockers that were not covered by the first acceptance pass:

1. **Cross-request Workspace hold interference.** The process-global hold map allowed concurrent same-draft requests to clear or consume each other. Replaced with request-local `AsyncLocalStorage` and a same-draft concurrency regression.
2. **Fail-open packet-ID display.** Context Inspector displayed `packetId` when `persisted` was absent for legacy compatibility. It now requires explicit `persisted: true`; a new regression proves an unproven ID is never rendered.

No other unresolved Phase 7 blocker remained after re-reading the shared compiler, all three persistence adapters, surface policy, resolver behavior, exact reload endpoint, Workspace release boundary, and user-visible inspector.

## Acceptance validation on `855455a2`

Permanent cumulative workflow `memory-governance-ci` run `30580550695` passed:

- all five Prisma clients generated;
- full repository dependency-graph typecheck — **PASS**;
- projection-worker infrastructure typecheck — **PASS**;
- API governed-memory Phases 1–7 — **55 suites / 480 tests PASS**;
- Phase 7 core persistence and surface policy — **2 suites / 16 tests PASS**;
- orchestrator Context/Strategy/Steward matrix — **6 suites / 37 tests PASS**;
- Workspace canonical context and request-local persistence hold — **5 suites / 36 tests PASS**;
- Settings and Context Inspector contracts — **2 files / 10 tests PASS**.

**Cumulative total: 70 suites/files and 579 tests, all passing.**

Required companion workflows on the same code head:

- `memory-governance-ci` — run `30580550695` — **PASS**;
- `ci-pr` — run `30580550705` — **PASS**;
- `meriv2-evals` — run `30580550689` — **PASS**;
- `engagement-trust-boundary` — run `30580550742` — **PASS**;
- `legiwatch-ci` — run `30580550691` — **PASS**;
- `funding-opportunities-ci` — run `30580550760` — **PASS**.

The funding workflow also completed clean-PostgreSQL migration deployment, Prisma schema validation, feature schema assertions, API/web typechecks and tests, and API/web builds successfully. No migration was applied to a shared or production environment.

## Acceptance gate

**PASS. Every packet ID the product displays is backed by an exact, tenant-scoped, retrievable `context_packet` row.**

Best-effort failure is visible and carries no ID. Required audited generation boundaries hold before release. Concurrent Workspace requests cannot alter one another’s persistence decision.

## Rollback posture

- Keep Context Packet v2 and tenant rollout flags dark.
- If a required surface must be relaxed during investigation, explicitly change that surface to best-effort; return no packet ID and preserve degraded evidence.
- Do not restore fire-and-forget adapter writes.
- Do not display generated IDs or infer persistence from UUID shape.
- Preserve durable packet rows and additive schema; no destructive data rollback is required.
- Do not merge, deploy, migrate, backfill, enable production flags, or alter customer data as part of Phase 7 closeout.

## Next gated phase

**Phase 8 — Context Packet v2 `off | shadow | enforce` rollout and complete surface policy.**

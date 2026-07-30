# MeriV2 Phase 7 — Truthful Context Packet Persistence

## Status

**FINAL VALIDATION PENDING on the promoted Phase 7 head.**

**Runtime validation head:** `a3535542318004dd5454d6efc07216844cd38936`  
**Branch:** `agent/meriv2-world-class-closeout`  
**Draft PR:** `#679`  
**Moving baseline before promotion:** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`  
**Behind moving `main` before promotion:** `0` commits

No merge, deployment, shared/production migration execution, backfill, production feature-flag activation, AWS operation, external send, or customer-data mutation is authorized by this record.

## Objective

Phase 7 requires one invariant: **a durable Context Packet ID may be exposed only after the exact packet row exists and is retrievable, and the persisted provenance must truthfully identify the effective scope that produced it**.

The implementation establishes one shared persistence owner around the deterministic Context Compiler. The compiler creates an internal attempt identity, removes it from the public packet contract, awaits adapter insertion and exact read-after-write verification, and only then exposes that ID with `persisted: true`. Any failed or unverified write leaves the public packet ID null.

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

### 3. Every adapter throws and verifies the exact row

The API, MeriV2 orchestrator, and Workspace adapters all:

1. insert with `id = generatedPacketId`;
2. await the insert;
3. query the exact ID under tenant scope in the same transaction;
4. reject if the exact ID cannot be read back;
5. return only the verified durable ID;
6. persist the packet's server-resolved `effectiveTenantId` rather than replacing it with the owning `tenantId`.

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

Workspace uses a request-local `AsyncLocalStorage` boundary. The final audit replaced a process-global tenant/draft hold map because two concurrent generation requests for the same draft could otherwise clear or consume each other’s hold. The implementation isolates failure state to the individual request and blocks:

- single-section output before the controller returns it;
- whole-document/retry/direct generation at the first generated-draft write through the Prisma boundary.

### 6. Displayed IDs are exactly reloadable

`GET /clio/context-packets/:id` reloads the displayed ID under both tenant and user scope. Missing rows return `404`; the endpoint cannot synthesize a healthy packet. Stored packet views explicitly set `persisted: true`, while live failed/unavailable summaries set `persisted: false` and `packetId: null`.

### 7. Phase 8 boundary remains explicit

Phase 8 owns the `off | shadow | enforce` rollout, tenant canaries, required-versus-optional layer policy, and safe v2 enablement for currently excluded memo, outreach, district-brief, and research body-rendering surfaces. Those surfaces remain dark rather than printing typed v2 envelopes into deliverables.

## Final audit defects found and closed

1. **Cross-request Workspace hold interference.** The process-global hold map allowed concurrent same-draft requests to clear or consume one another. Replaced with request-local `AsyncLocalStorage` and a same-draft concurrency regression.
2. **Fail-open packet-ID display.** Context Inspector displayed `packetId` when `persisted` was absent for legacy compatibility. It now requires explicit `persisted: true`; a regression proves an unproven ID is never rendered.
3. **Effective-tenant provenance collapse.** The core packet carried `effectiveTenantId`, but the API, orchestrator, and Workspace persistence adapters wrote the owning `tenantId` into `context_packet.effective_tenant_id`. All three adapters now persist the server-resolved effective identity, with adapter-level regression coverage.

No Program Element or defense-budget runtime file was modified by the third correction.

## Validation gate

The permanent `memory-governance-ci` Phase 1–7 matrix and all normal required PR workflows must execute successfully on the final evidence head before this record returns to PASS. Test and workflow IDs will be recorded only after those jobs actually run.

## Rollback posture

- Keep Context Packet v2 and tenant rollout flags dark.
- If a required surface must be relaxed during investigation, explicitly change that surface to best-effort; return no packet ID and preserve degraded evidence.
- Do not restore fire-and-forget adapter writes.
- Do not display generated IDs or infer persistence from UUID shape.
- Preserve durable packet rows and additive schema; no destructive data rollback is required.
- Do not merge, deploy, migrate, backfill, enable production flags, or alter customer data as part of Phase 7 closeout.

## Next gated phase

**Phase 8 must not start until this validation gate is fully satisfied.**

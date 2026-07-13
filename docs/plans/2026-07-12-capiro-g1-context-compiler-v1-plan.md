# G1 — Context Compiler v1 (shared context contract + packet trace + exclusions)

**Goal (blueprint §4.6.4 / gates §12.5 #2+#6):** one shared, permission-aware
context contract used by every Meri surface, with a persisted packet trace
(inclusions + rationale + exclusions) — replacing the per-surface loader copies
whose drift has now caused three real production bugs (GA-chat voice RLS
regression, workspace steering loader dead-on-arrival, outreach clientContext
silent-drop).

## Audit-established current state (2026-07-12)

Five independent loader implementations over the same `memory_items` families:

| # | Surface | Loader | Scoping discipline |
|---|---|---|---|
| 1 | Legacy chat | `meri.service.ts:2854 loadUserVoiceContext` | withTenantUser + withTenant |
| 2 | Outreach | `engagement.service.ts:1520 loadUserVoiceBlock` | withTenantUser + withTenant (fixed Phase 2) |
| 3 | GA-chat | `meri-context.resolver.ts:48/85` | withTenant + withTenantUser (fixed Phase 2) |
| 4 | Workspace gen | `generation.service.ts loadSteeringMemories` | manual dual-GUC (fixed PR #442) |
| 5 | Alert-memo | `alert-memo.service.ts:303 loadSteering` | MemoryStoreService (client steering + firm playbook) |

`renderHuman()` is copy-pasted 4×. No context contract type exists anywhere.
`MeriContext` (meriv2-core `registry/types.ts`) is the nearest partial packet
(identity + firm/voice), populated only by surface 3. `ContextProvenance`
(workspace, Phase 3.3) is the nearest trace shape. `meri_audit_ledger`
(migration `20260712000000`) is the persistence template (RLS, per-command
policies, jsonb payload). All three apps depend on `@capiro/meriv2-core` and
share one Aurora DB (orchestrator literally reuses apps/api's generated Prisma
client; workspace uses raw SQL + manual GUCs).

## v1 scope (honest strangler-fig)

**In scope:** the memory-derived steering layers — firm-soul/-compass,
user-voice/-profile, client-soul/-compass/-people, firm playbook — compiled by
ONE shared implementation behind ONE contract, with a persisted
`context_packet` trace recording inclusions (with rationale) and exclusions
(with reason: revoked / superseded / empty / unauthorized / over-budget).
Surface-specific evidence layers (tool ledgers, bill truth, PE grounding,
semantic memory recall) stay where they are in v1 but can be REGISTERED into
the packet via `attachEvidence()` so the trace is complete where wired.

**Out of scope for v1 (later phases):** token-budgeted reranking across all
evidence, client/matter scope enforcement (G2 adds the scope model the
compiler then honors), moving semantic recall into the compiler, packet
version pinning for regeneration.

## Design

### Contract — `packages/meriv2-core/src/context/` (zod-free subpath)
- `ContextRequest` { tenantId, userId (Capiro uuid | null), clerkUserId?,
  clientId?, surface, charBudget? }
- `ContextPacketItem` { layer, key, sourceType, sourceId, chars, rationale }
- `ContextExclusion` { layer, key, sourceId?, reason }
- `CompiledContextPacket` { packetId, version:1, request-meta, blocks
  { firmContext?, userVoiceContext?, clientSteering? }, items[], exclusions[],
  compiledAt }
- `ContextCompiler` class: pure assembly + rendering + budgeting; DB access via
  a `ContextStoreAdapter` interface each app implements with its own tenancy
  discipline:
  - `loadSteeringRows(req)` → memory_items rows (id/type/slug/clientId/status/
    sections) — MUST be owner-aware (both GUCs)
  - `resolveUser?(clerkUserId)` → Capiro uuid (workspace needs this)
  - `persistPacket(packet)` → fire-and-forget insert (fail-open)
- The compiler queries WITHOUT an in-SQL status filter (RLS still applies),
  filters in code, and RECORDS status-filtered rows as exclusions — that is
  the whole point of the trace.
- `renderHuman()` becomes the single shared renderer.

### Persistence — `context_packet` (apps/api schema, additive migration)
Columns: id uuid PK, tenant_id FK, surface varchar(24), client_id uuid?,
user_id uuid?, ref jsonb (conversationId/draftId/outreachId), items_jsonb,
exclusions_jsonb, block_chars int, created_at. RLS per the
`meri_audit_ledger` template (ENABLE+FORCE, per-command `rls_bypass() OR
tenant_id = current_tenant_id()`). Indexes: (tenant_id, created_at desc),
(tenant_id, surface).

### Adapters
- **apps/api** `ApiContextStoreAdapter`: `withTenantUser` for the combined
  steering query; `tx.contextPacket.create` for persistence.
- **orchestrator** `OrchContextStoreAdapter`: same Prisma-client pattern as its
  `meriAuditLedger` writes.
- **workspace** `WsContextStoreAdapter`: raw `$transaction` + dual GUC +
  clerk→users.id resolution (the PR #442 discipline), raw INSERT for packets.

### Surface conversions (each keeps byte-identical prompt blocks where
possible; trace is additive)
1. **apps/api legacy chat** — `loadUserVoiceContext` → compiler. Packet ref =
   conversationId.
2. **apps/api outreach** — `loadUserVoiceBlock` → compiler (user-voice/profile
   + client steering). Packet ref = outreach record id.
3. **apps/api alert-memo** — `loadSteering` → compiler client-steering layer +
   firm playbook. Packet ref = alert id.
4. **orchestrator GA-chat** — `MeriContextResolver` → compiler; MeriContext
   blocks come from the packet.
5. **workspace gen** — `loadSteeringMemories` → compiler; Phase 3.3
   `memoryFiles` provenance derives from packet items (same shape, richer
   source).

### PR sequence (land + verify each before the next)
- **G1-a**: meriv2-core context module + tests; `context_packet` migration;
  apps/api adapter; convert surfaces 1–3. Deploy: migrate + api roll.
- **G1-b**: orchestrator adapter + surface 4. Deploy: orchestrator roll.
- **G1-c**: workspace adapter + surface 5 (steering spec updated to run
  through the compiler). Deploy: workspace roll.

### Verification gates
- Unit: compiler assembly, exclusion recording (revoked/superseded/empty),
  budget truncation exclusion, adapter contract specs per app.
- Regression: existing voice/steering specs keep passing unchanged where they
  assert block content.
- Live: after each roll, one packet row per exercised surface in
  `context_packet` with items+exclusions populated; 0 exceptions; prompt
  behavior unchanged (same blocks, per spec pins).

### Explicit non-goals recorded for the trace's consumers
The packet trace is the substrate for: G2's scope enforcement + ephemeral
exclusions, blueprint §6.2 "exclusions view" UI, §12.6 context-parity metrics,
and eventual packet-version pinning. None of that ships in G1.

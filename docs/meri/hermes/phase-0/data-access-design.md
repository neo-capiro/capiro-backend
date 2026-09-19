# Comprehensive data access — inventory results and gateway design (Phase 0)

Prepared September 19, 2026. Inventory generated from all twelve application-owned Prisma schemas by `scripts/meri-hermes/generate-data-inventory.mjs` (outputs: `data-inventory.json`, `data-inventory.md`, `data-inventory.baseline.json`). Building the read paths is Phase 2A; this page fixes the interfaces, the enforcement boundary and the coverage gate.

## 1. What the inventory found

| Measure | Result |
|---|---|
| Schemas | 12 (`apps/api` main + 5 projection/outreach sub-schemas, `api-strategy`, `defense-api`, `intel-api`, `onboard-api`, `workspace`) |
| Models / enums / views | 549 / 58 / 0 (main schema: 372 real model headers) |
| Scope (heuristic) | tenant 277 · global_reference 266 · user 2 · client 1 · inherited 1 · **unknown 2** |
| Sensitivity (heuristic) | business 480 · pii_contact 43 · credential 26 (≈8 false positives: LLM `*Tokens` counters, `leaseToken`) |
| Kind | canonical 436 · outbox/system 59 · projection/duplicate 54 |
| Existing read path | none **451** · meri_tool 67 · retrieval_adapter 48 · analytics_registry 25 |
| **Coverage gap** | **340** canonical, non-credential business models with no Meri read path (api 217, intel-api 33, defense-api 29, workspace 22, non-rdte-projection 12, api-strategy 11, onboard-api 7, other ≤3) |
| Decryption required (service-mediated) | 11 models with `*Ciphertext`/`iv` pairs: `IntegrationConnectionToken`, meeting notes/debriefs, `ClioMcp*` credentials, `TenantAiCredential`, five intel-api transcript models |
| Unclassified scope | `TangoProcurementForecast` (external `organizationId`), `XPostCache` (`accountId` → tracked account) — need owner decisions |

Current chatbot exposure for comparison: 18 unified-retrieval domains, 12 global analytics datasets, ~100 registry tools. The inventory confirms the plan's premise: coverage must be audited per model, not assumed.

Heuristic caveats (stated in the generated report): scope inheritance is one/two-hop FK based; read-path detection is name containment against the tool registry, `meri-tools.service.ts`, retrieval adapters and the analytics registry; `LdaFiling` is mis-scoped to `client` because its `clientId` points at the global `LdaClient`. Owner review is part of Phase 2A.

## 2. Enforcement boundary (decision)

- Workers never receive `DATABASE_URL`; the runtime role `capiro_app` **bypasses PostgreSQL RLS** (`PrismaService` header comment), so tenant isolation is enforced only by the tenant-scope query hook and per-query predicates. A read-only replica credential would not fix that. Therefore every Hermes read passes through the **broker → query compiler** running inside the Meri API with the actor's `TenantContext`, exactly as the Phase 0 broker already does for memory recall (`prisma.withTenantUser` + owner visibility + ethical wall + governed suppression).
- The compiler reuses the existing Context Plane gateway (`MeriContextPlaneService.searchToolData` → `ContextPlaneGatewayService.requestContext`) for the 18 existing domains and adds a **catalog-driven generic path** for the remaining models: a `discover/describe/query/read_record/read_related/export` surface over a policy-annotated model catalog.
- Existing native tools are reused only after the actor/client checks the audit found missing are added at the broker boundary. Specifically (from `meri-tools` audit): `get_representation` skips `ensureClientVisible`; `find_contacts` counts colleagues' mail; `ensureClientVisible` is an existence check, not an ethical-wall check; federal-market tools accept an unvalidated `clientId`; `schedule_task` stores an unvalidated `clientId`; `executeFromAuthenticatedUser` performs no session client pin. The broker will apply the session client pin and the wall check **before** dispatching any reused tool.

## 3. The six interfaces (proposed; Phase 2A implementation)

All calls carry the worker token + run id (same guard as today) and return `{data, coverage, provenance, asOf}`. Authorization is applied **before** filtering, joining, aggregating, paging and exporting; catalog metadata and error detail are filtered to the actor's rights; a cursor is opaque, signed and never an authorization grant (the memory content cursor already works this way).

| Interface | Input | Output | Notes |
|---|---|---|---|
| `discover_data` | `{query, kinds?, limit}` | authorized datasets/entities: `{datasetId, model, owner schema, description, scope, fields count, freshness, readPath}` | semantic + lexical over the catalog; unsupported sources are listed as `unsupported`, never omitted silently |
| `describe_data` | `{datasetId}` | fields (name, type, meaning, unit, nullable, classification: `readable`/`restricted(role|scope)`/`service_mediated`/`excluded(reason)`), relationships (validated FK paths), history availability, freshness source | restricted fields appear by name only when the actor may know they exist; excluded fields never appear |
| `query_data` | `{datasetId, select?, filter?, sort?, page{cursor,size}, groupBy?, aggregates?, joins?: [relationshipId]}` | rows + `{total?, returned, hasMore, nextCursor, asOf, replicaLagMs?, sourceStatus}` | compiled to Prisma/SQL with the actor predicate injected first; joins only along catalog relationships; aggregates over authorized rows only; per-source `asOf` when federated |
| `read_record` | `{datasetId, id, contentCursor?}` | complete authorized record; long content by continuation cursor | reuses the memory-content cursor pattern (hash-bound, re-authorized each page) |
| `read_related` | `{datasetId, id, relationshipId, page}` | related records across services | cross-service hops are federated reads with per-source `asOf` |
| `export_data` | `{queryRef, format: csv|jsonl|xlsx}` | durable job id → artifact (owner-scoped `ClioArtifact`/S3) | runs on the existing outbox+lease pattern (`FOR UPDATE SKIP LOCKED`, fenced terminal writes); delivered through the artifact route |

Consistency: a single Prisma query is one snapshot; multi-page and federated reads are **not** one snapshot and must report `asOf` per source and `replicaLagMs` when reading the analytics replica (`ANALYTICS_DB_HOST`). The response contract makes that explicit rather than implying exactness.

## 4. Catalog and policy annotation

- Source of truth: `docs/meri/hermes/phase-0/data-inventory.json` becomes a **checked-in catalog** with one required annotation per model and per field: `classification`, `audience`, `readPath` (`generic_prisma` | `context_plane_domain` | `service:<name>` | `excluded`), `freshnessSource`, `owner`.
- Row policy per model: `tenantId` predicate (277 models), owner predicate for `user` scope, client predicate + ethical wall for client-linked models, inherited predicate via the recorded FK path, service-mediated for decryption.
- Deliberate exclusions: the 26 credential-flagged models minus the false positives (OAuth tokens, MCP credentials, tenant AI credentials, signing/nonce tables) and all outbox/lease/system tables.

## 5. Migration coverage check (prototype exists)

`node scripts/meri-hermes/generate-data-inventory.mjs --check` exits non-zero when (a) any model has `unknown` scope, or (b) a canonical business model with no read path appears that is not in `data-inventory.baseline.json`. Today it fails on the two unknown-scope models (by design). Phase 2A wires it into CI (`typecheck` job) so a migration adding unclassified business data fails the build, and extends it to **field-level** annotations once the catalog carries them.

## 6. Acceptance fixtures (from the plan) and their read path today

| Domain | Existing path | Phase 2A work |
|---|---|---|
| Bills (federal/state, tracked) | `search_congress_bills`, `get_bill_status`, `search_state_bills`, `search_tracked_bills` (client-checked) | wrap behind broker with session pin; add `read_related` bill → client tracking |
| Hearings | `search_committee_hearings` (client-checked), hearings retrieval adapter | paging + evidence citations through `query_data` |
| Directory | `list_members`, `get_committee_roster`, public-domain retrieval adapter | disclose agency/defense gaps via `describe_data.freshness` |
| Institutional memory | Phase 0 broker `memory.recall` (verified) | `query_data` over `memory_items` with governed predicates |

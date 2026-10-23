# Core-for-Meri SDK migration inventory

Neo's 23 October SDK-first requirements govern further work. Root coordinates integration, native qualification and operations. The SDK owns model execution and session continuity; Core remains the data gatekeeper. Current PR113 is not fully accepted source.

## Retain and connect

- Explicit immutable General/client conversation bindings, source migration10000 and the actual historical-guard fixture. Null alone never reclassifies legacy conversations. Keep tenant/owner/client/wall validation at ordinary bootstrap and data access.
- Canonical conversation titles, owner-title search, status/revision, archive and 30-day Trash/Restore. Keep request idempotency, uncertain mutation readback and deletion tombstones. Connect active-run checks to the new runtime and use the canonical retention owner; no second purger.
- Personal/firm memory restriction at the existing retrieval owner, before counts/paging. `readPersonalFirmMemorySource` and `allowClientScope:false` must be reached from the new trusted gateway scope, not a model-supplied widening field. Preserve tenant/private/client-wall and cursor tests.
- Existing typed data tool readers and canonical client context. Verify the new gateway's negative tenant/member/client/wall cases before removing old checks.

## Deleted in this checkpoint

The bootstrap navigation capability helper, service method and controller endpoint have no remaining consumer. The frontend deletes its operation/schema/registry/Clerk route and20-second poll in the same change. Navigation is a local client draft; ordinary bootstrap still checks current access. No schema or migration changed. Bootstrap/General focused27 tests and API build passed after Prisma regeneration.

## Deletion mapping awaiting the real gateway contract

| U delta | Disposition |
|---|---|
| Unshipped reserved `20281023030000_meri_general_read_delegation`, its README and `verify-meri-general-read-delegation.mjs` | Remove when the gateway scope and surviving negative-test map are established. Do not activate. |
| U additions to `auth/read-delegation/*`, including `read-delegation-general.ts` | Remove the per-operation v2 machinery. Inventory the pre-existing v1 import graph separately before deleting shared source. |
| U additions to memory page/proof/issuer/signed/passive/helper token/source/receiver files; `meri-memory-current-scope.ts` | Replace with the existing data owner's tenant/member/personal/firm authorization through the new gateway. Preserve actual memory SQL and governance behavior. |
| `retained-source-v02/admission.ts` and `meri-action-query-alias.ts` delegated-v2 changes | Remove when the corresponding typed tools use the new gateway. Preserve client-only write/proposal behavior. |
| `MeriReadDelegation.scopeKind`, U nullable client change, `MeriReadDelegationSlot.targetClientId` in Prisma | Revert only these unshipped additions together with their obsolete source. Binding/management fields are unrelated and remain. |
| Current-authority resource wrappers and General tests | Map each retained business permission check to once-per-turn access or Core tool enforcement before deleting wrapper-only tests. |

No removal from this table has been applied yet. Historical applied migrations are immutable. Database table drops need the separately required snapshot/approval; no DB change is part of this source inventory. No replacement authority token/proof/admission layer is proposed.

## Qualification correction

Core base `db96ad310fa1c3cc43278ff9c2d59e750581bac3` and the previous PR head both lack the active memory PostgreSQL workflow. Backend split deliberately quarantined it. The native Jest test no longer reads nonexistent active CI YAML or treats disabled YAML as a gate. It retains endpoint/DDL/app-role/vector controls and now explicitly proves ambient application `DATABASE_URL` is ignored. README identifies the direct native Jest entry and required-vector mode. DB-free validation passes2 tests with10 explicit database skips; root owns native PostgreSQL replay. Native test bodies are unchanged.

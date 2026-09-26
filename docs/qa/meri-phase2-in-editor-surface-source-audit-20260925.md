# Meri Phase 2 in-editor surface source audit

Date: 2026-09-25. This is source-only evidence under the current no-test hold.

## Boundary repaired in source

The legacy workspace assistant offers and executes the 32 names in
`packages/meriv2-core/src/registry/in-editor-tools.ts` (`IN_EDITOR_READ_TOOLS`).
`apps/api/src/workspace-assistant/workspace-assistant.service.ts` filters its model
schemas with that set and checks the same set before dispatch.

The MeriV2 editor fetches API schemas and filters them through
`selectMeriCapabilitySchemas(..., 'in_editor', registry.list())`. The shared
capability registry currently marks 24 names for `in_editor`; the
`ASSISTANT_TOOLS` export in `in-editor-prompt.ts` is now a static snapshot used
by contracts, not the runtime execution guard. The removed
`in-editor-tool-parity.ts` startup import mutated the editor's execution Set with
11 further names without changing the filtered model schemas. Eight are in the
legacy editor allowlist; three (`get_bill_status`, `search_floor_votes`, and
`resolve_entity`) are not. All 11 were registered as full-chat delegated reads,
so a returned tool-use name could reach the API despite not being offered to
the model for this editor turn. Ordinary provider selection of an unoffered name
is not established by this source review.

The MeriV2 editor now requires both membership in the canonical legacy editor
allowlist and membership in the exact request's filtered offered schemas before
calling `registry.invoke`. It keeps `propose_document_edits` as the separate
terminal action. The startup Set mutation and its sole import were removed.
The API delegated route still normalizes tool names by exact registry membership
and dispatches to the existing handlers; no alias, schema, handler, or permission
was added.

## Remaining feature parity gap

These eight reads are in the legacy canonical editor allowlist but remain
`full_chat` only in `MERI_CAPABILITY_REGISTRY`, so MeriV2 does not offer them in
the editor:

- `search_state_bills`, `get_state_bill_status`, `search_state_floor_votes`,
  `get_state_legislator`, `get_state_rule_status`
- `get_committee_roster`, `get_representation`, `list_members`

Restoring feature parity requires an explicit surface decision for those eight,
then updating the shared registry and its in-editor/full-chat catalogs together.
That change would alter model-facing availability and needs focused registration,
dispatch, permission and legacy/MeriV2 parity checks before acceptance. The
three federal-only extras above are not part of the legacy editor allowlist.

## Legacy runtime retirement

The in-process V1 chat loop remains a reachable fallback when both V3 and V2
decline; `shouldRouteMeriV2FullChat` still excludes impersonated turns. The V3
runtime proxy still patches private V1 service seams through
`installRawPhase19Adapters`. The retirement plan in
`docs/meri/legacy-stream-retirement-scope.md` requires observed zero V1
dispatches over its specified window, an impersonation decision, parity review,
and proxy simplification before loop deletion. Source inspection alone cannot
establish those runtime gates, so this package makes no V1 retirement claim.

Negative regressions for an unoffered canonical read, all 11 previously hidden
names, and a noncanonical read in a drifted offered set were authored. No
Jest/Node, typecheck, build, database, browser, provider, or live QA ran under
the hold. Model-visible exposure remains unchanged.

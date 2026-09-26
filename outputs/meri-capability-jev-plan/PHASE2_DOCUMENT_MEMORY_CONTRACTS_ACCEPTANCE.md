# Phase 2 document and memory contract package

Date: September 25, 2026
Baseline: `06748f1ccdb87b285721d696d6f4551d208fd814`
Worktree: `C:/dev/main/capirov2-phase2-doc-memory-20260925`
Branch: `phase2/meri-doc-memory-contracts-20260925`

## Delivered

Added optional, machine-readable advisory reader contracts to the shared Meri capability registry for `read_client_documents`, `get_research_evidence`, and `search_memory`. The shared contract type records purpose, exclusions, supported scopes, prerequisites, evidence authority, and an availability-reason taxonomy. The metadata does not alter authorization, handler selection, execution, or result payloads.

The contracts preserve three separate evidence locations and ownership rails:

- `read_client_documents` is for a currently visible client’s Documents-tab files. Listing is not a content read. Content reads return the selected document’s content hash, section locator, and character range (and row range where applicable); this is an extracted-content fingerprint, not an independently verified original-file version.
- `get_research_evidence` is for immutable attachment evidence captured for one authenticated user’s research session, bound to its tenant and optional client/conversation. It returns snapshot capture time, attachment/source-message IDs, status, and content hash; it does not return page or section citations or a separately labeled current source version. Incomplete or unsupported attachment content remains incomplete.
- `search_memory` is for eligible governed memory facts and preferences. It is scoped to authorized firm/private memory and optional selected-client memory. Approval/governance and freshness metadata and source provenance are returned when present; exact content can continue by memory item and cursor. Active recall does not return prior corrected/superseded content or its correction history, nor underlying source records.

## Validation

- Focused orchestrator registry contract test: passed, 18 tests.
- `@capiro/shared` typecheck and build: passed.
- `@capiro/meriv2-orchestrator` typecheck and build: passed after building its workspace dependencies and generating the local Prisma client.
- Initial checks before workspace dependency outputs existed failed on missing generated workspace packages and Prisma types; after building `@capiro/auth`, `@capiro/meriv2-core`, and `@capiro/strategy-verifier`, plus generating the local API Prisma client, the orchestrator checks passed.

## Residuals

- The `get_research_evidence` API callable schema correctly requires `sessionId`. The unrelated required `to` input belongs to the separate `find_path_to` capability (`apps/api/src/meri/meri-tools.service.ts:689-695`).
- Correction record: an earlier version of this acceptance report and registry metadata incorrectly claimed a `get_research_evidence` schema mismatch. That was a false positive caused by conflating adjacent schema excerpts. The claim, reason code, and test assertion have been withdrawn. The exact research schema at `apps/api/src/meri/meri-tools.service.ts:540-565` requires `sessionId`; execution dispatches to `getResearchEvidence` at about line 1966, and its handler validates the session ID at `apps/api/src/meri/meri-research-evidence.helpers.ts:49-56`.
- Research attachment output has no page/section locator; exact document citation behavior remains specific to `read_client_documents`.
- The client document reader reports an extracted content hash, but this is not proof of an independently versioned original file.
- Memory provenance fields are optional in the returned record. A missing source identifier/version remains unknown rather than evidence of no provenance. Active recall also does not expose correction history.
- No runtime changes, deployments, or production writes were made.

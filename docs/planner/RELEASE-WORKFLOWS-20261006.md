# Planner personal sections and activity release

Status: candidate verified locally; immutable builds and live verification pending. This continues the live core recorded in [RELEASE-20261006.md](RELEASE-20261006.md). Full parity remains open in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Changes

- Private My Tasks sections, names, section order, per-task placement and task ordering. List selection and board moves update only an owner-only settings resource. Shared project membership/status/version is unchanged. Reassignment removes placements from the previous owner's visible settings. Settings require the expected resource version.
- Paginated task/project activity and active/archived inbox. Database cursors retain timestamp precision and break timestamp ties by identity. Older updates remain reachable after intervening new activity and after an entire page's grants are revoked. Legacy array API callers remain supported.

No migration, IAM, canonical API, authentication or routing changes are required. Existing Planner tables store the private configuration. This release stays on the signed-in organization and preserves the approved integration choices.

## Validation

21 real PostgreSQL checks passed, including cursor ordering, revoked inbox pages, private settings, reassignment and stale writes. The routing/core API run passed 61 checks; resource validation passed eight checks. Fourteen focused web checks passed. Strategies/shared/web typechecks and production builds passed. Synthetic browser checks passed list placement, section rename and the private board. The local Vite prebundle required rebuilding after the shared contract changed; the rebuilt fixture renders correctly.

Before promotion, inspect the live task definitions and source changes, preserve concurrent work, clone only the existing Strategies and web-vNext definitions, and change only their immutable images/release identifiers. Promote Strategies before web-vNext. Rollback restores Strategies revision 33 and web-vNext revision 440 unless a newer concurrent baseline must be retained; keep private settings and work records.

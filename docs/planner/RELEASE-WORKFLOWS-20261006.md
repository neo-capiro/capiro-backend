# Planner personal sections and activity release

Status: candidate verified locally; immutable builds and live verification pending. This continues the live core recorded in [RELEASE-20261006.md](RELEASE-20261006.md). Full parity remains open in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Changes

- Private My Tasks sections, names, section order, per-task placement and task ordering. List selection and board moves update only an owner-only settings resource. Shared project membership/status/version is unchanged. Reassignment removes placements from the previous owner's visible settings. Settings require the expected resource version.
- Paginated task/project activity and active/archived inbox. Database cursors retain timestamp precision and break timestamp ties by identity. Older updates remain reachable after intervening new activity and after an entire page's grants are revoked. Legacy array API callers remain supported.
- Public/internal form input handlers capture values before React defers state updates. A live public-form input check exposed a null `currentTarget` access; the new regression batches text, paragraph, choice, date and numeric input before submitting. A different capability resets the draft and submission state.

No migration, IAM, canonical API, authentication or routing changes are required. Existing Planner tables store the private configuration. This release stays on the signed-in organization and preserves the approved integration choices.

## Validation

21 real PostgreSQL checks passed, including cursor ordering, revoked inbox pages, private settings, reassignment and stale writes. The routing/core API run passed 61 checks; resource validation passed eight checks. Sixteen focused web checks passed, including the public input regression. Strategies/shared/web typechecks and production builds passed before the form correction; the final web image must compile the correction again. Synthetic browser checks passed list placement, section rename and the private board. The local Vite prebundle required rebuilding after the shared contract changed; the rebuilt fixture renders correctly.

Before promotion, inspect the live task definitions and source changes, preserve concurrent work, clone only the existing Strategies and web-vNext definitions, and change only their immutable images/release identifiers. Promote Strategies before web-vNext. The concurrent Meri web release moved the baseline to revision 442 (`d6efc8adc9ce841b0639bd03b7b2a6977858ede9`); its code and release documentation are merged into this branch. Rollback restores Strategies revision 33 and web-vNext revision 442 unless a newer concurrent baseline must be retained; keep private settings and work records.

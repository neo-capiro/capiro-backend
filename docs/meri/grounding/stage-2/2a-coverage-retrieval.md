# Stage 2a coverage-driven retrieval

This capability is independently controlled by `MERI_COVERAGE_RETRIEVAL_MODE`,
`MERI_COVERAGE_RETRIEVAL_TENANTS`, and `MERI_COVERAGE_RETRIEVAL_SURFACES`.
Repository and release defaults are dark. `enforce` affects only an enrolled
tenant and surface; `shadow` observes and logs without executing a follow-up or
changing the reply.

## Requirements and templates

Before tools run, chat converts every required evidence-plan item into a
coverage requirement. Deterministic task templates add requirements when the
generic plan cannot express the task:

- `house_senate_comparison`: House and Senate (including HAC-D/SAC-D) evidence
  are separate essential requirements.
- `transcript_summary`: readable content from the referenced document is
  required; a filename or metadata-only result is not content.
- `current_status`: a current-status claim requires dated evidence under the
  evidence plan's freshness policy.

A narrow factual request does not receive an extra template requirement.

## Comparison statuses

`satisfied` requires usable rows or text from an eligible tool family. Other
statuses are `never_called`, `called_no_usable_content`, `truncated`,
`unavailable`, and `extraction_failed`. Calling a tool or recording an
execution receipt alone never satisfies a requirement.

## Follow-up and budget

Only essential gaps with a concrete route can produce a follow-up. Routes are
projected into a schema from request/document identities such as a PE code,
bill identity, document id, opportunity id, or award id. The runtime accepts
only registry metadata declaring both `readOnly: true` and
`executionMode: read`, executes no more than two calls, deduplicates identical
calls, and uses the existing governed execution path. It does not start a call
once only the synthesis reserve remains. New evidence causes a no-tools
re-synthesis. Residual essential gaps add one claim-tied, citation-marker-free
limitation; supplementary and unrelated failures add nothing.

## Event

Shadow and enforce emit one structured `meri.coverage.turn` event with
`conversationId`, requirement summaries, gap summaries (`requirementId`,
`status`, `essential`, `materiality`), `followUpPlanned`, `executed`,
`satisfiedAfter`, `changedAnswer`, `durationMs`, and `mode`.

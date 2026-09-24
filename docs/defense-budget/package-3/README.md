# Defense-budget Package 3 — durable semantic extraction and scoped publication

Package 3 extends the durable extraction path to procurement, O&M and MILCON while retaining the RDT&E path. It adds a versioned substantive qualification hash and a pure plan for explicitly reviewed, scoped PE totals. This release does not activate canonical publication.

## Delivered scope

- RDT&E continues through its family-specific semantic factory. Procurement, O&M and MILCON resolve to a proof-bound semantic factory and persist serialized artifact bytes through the immutable extraction-artifact store.
- For non-RDT&E output, selected parser runs are rebound to their exact parser-run identities; the durable parser-artifact store must return a matching persisted result and verified bytes. Missing or mismatched proofs fail the factory.
- The qualification driver projects stable substantive fields under `qualification_artifact_projection_v1` and hashes the canonicalized projection with SHA-256. Exact artifact-byte SHA-256 remains a separate integrity check.
- Reviewed scoped PE-total inputs can produce a deterministically ordered `reviewed_partial` / `partial` publication plan, bound to its cohort and expected active snapshot. The planner is pure: it does not write canonical rows, create/activate a snapshot or publish a complete family.
- Congressional semantic production remains quarantined and blocked. Governed structured-table inputs and the required proof inputs are absent; no semantic production qualification or congressional publication is claimed.
- Generic component-wide books remain generic lineage artifacts and are not represented as qualified family semantics. No canonical activation is included in Package 3.

## Qualification hash contract

`qualification_artifact_projection_v1` is a versioned allowlist, separate from the digest of exact persisted artifact bytes. It includes source family/document context, parser method/version/config and page outcomes, evidence locators/content fields, source facts, semantic assertion fields, warnings, omissions and summary. Collections are normalized as sets and sorted deterministically. Run-derived identities, timestamps, URLs/locators and digest fields are excluded, except that `sourcePdfSha256` and `parserConfigSha256` are retained as stable source/config identity. The projection is canonicalized, JSON encoded and SHA-256 hashed. Change the projection version whenever its allowlist or normalization contract changes; do not compare hashes across projection versions as equivalent qualifications.

This hash measures substantive qualification output for stable comparisons. It does not replace exact artifact-byte integrity, parser-result proof validation, human review or publication policy.

## Current blockers and next bounded manifest

Congressional semantic production requires governed structured-table material plus persisted parser proof inputs that can be independently verified. Until those inputs exist and pass qualification, keep this family quarantined. The next bounded manifest is limited to a single, exact source document with known immutable identity and readable archived bytes, selected only after the live read-only eligibility inventory and format qualification agree. If no row satisfies every gate, the eligible manifest is empty. Do not substitute a generic component-wide book or turn partial PE totals into family-wide coverage.

## Evidence and operations

- [Operator runbook](./operator-runbook.md)
- [Validation and runtime evidence](./validation-evidence-2026-09-24.md)

The live rollback baseline below is the supplied read-only audit snapshot for account `967807252336`, region `us-east-1`, cluster `capiro-dev`. It is a rollback reference, not evidence that Package 3 was deployed or qualified.

| Runtime                             | State               | Image digest       |
| ----------------------------------- | ------------------- | ------------------ |
| API task definition `:443`          | Desired/running 2/2 | `sha256:445a9515…` |
| Drain task definition `:27`         | Parked; no service  | `sha256:8ac22557…` |
| Qualification task definition `:33` | Same drain image    | `sha256:8ac22557…` |

No canonical snapshot activation or production deployment is part of this release documentation.

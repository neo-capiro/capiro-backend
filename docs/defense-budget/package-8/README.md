# Defense-budget Package 8 — coverage and historical backfill

Package 8 adds a fail-closed physical-source reconciliation surface and the safety controls required before historical corpus work. It does not turn logical source requirements into a fabricated PDF or exhibit denominator, and it does not authorize an unqualified mirror import.

## Delivered scope

- A versioned, read-only reconciliation model reports logical source slots separately from physical documents and volumes. Discovery, parsing, current-run verification, accepted review, and active publication are separate stages.
- Unattested physical denominators remain `unknown`. Optional and superseded units remain visible without inflating required/current coverage.
- Publication requires the exact source document, source SHA-256, current candidate, current verification run, `PASS`, accepted review, and active snapshot lineage. The internal UI exposes the active snapshot, document identity, SHA, and exception codes.
- Blocked, withdrawn, missing, superseded, unattributed, unverified, unreviewed, unpublished, and lineage-unbound states remain explicit.
- The first committed full federal-legislative inventory must run in historical mode. Historical additions and full-inventory removals are retained for reads but consumed without client alerts.
- The existing historical FY selector now includes FY2023 and FY2024, including the only year present in the Package 0 production baseline.
- A read-only DTIC/JDOCS XML inspector evaluates a single pinned FY2026 mirror candidate. It validates actual QName namespace bindings, byte SHA-256, metadata, and PE identities, but always returns `candidate_only` and `promotable: false`.

## Historical source decision

The `handriss/defense-budget-justification-data` repository is useful as a discovery and structured-companion lead for Defense-Wide RDT&E and procurement material from FY2023–FY2026. It is not an authoritative completeness denominator: it excludes the military services and several marketed budget families, has no declared repository license, and its XML bytes are not proof of equivalence to the official Comptroller PDFs.

The pinned DTIC candidate and official PDF are therefore recorded as separate byte identities. No mirror data was imported, published, or used to widen a coverage claim in Package 8. A future governed adapter must independently reconcile official-source provenance, stable XML element identity, semantic extraction, review, and publication.

## Controlled-backfill boundary

Package 1's exact production queue inventory found zero manifest-eligible rows. That is a safe stop condition, not permission to bypass manifest, archive-version, parser-profile, review, or publication gates. Package 8 therefore performs no historical production write and sends no historical notifications. The post-deploy reconciliation report is the source of truth for the remaining family/year omissions and unknown denominators.

## Evidence

- [Validation evidence](./validation-evidence-2026-09-24.md)
- [Historical notification qualification](./package4-historical-suppression-qualification.json)
- [DTIC/JDOCS candidate assessment](./handriss-dtic-source-catalog-assessment.md)


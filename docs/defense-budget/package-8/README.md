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
- A qualification-only reconciliation binds the pinned official DTIC XML to the official PDF by SHA-256 and checks all two PE and three project FY2026 funding identities against extracted PDF page text. It is evidence, not a production parser proof or publication approval.
- The DTIC inspector now emits a versioned, prefix-independent expanded-QName locator inventory for each PE identity, bound to the original XML SHA-256. The real FY2026 XML yields two distinct PE locators; this remains candidate-only evidence.
- The DTIC inspector now also emits a typed, field-level semantic candidate for each PE. It requires the PE title, budget year, monetary unit, and five canonical funding fields, binds every value to an expanded-QName locator and the original XML SHA-256, and remains `candidate_only`/`promotable: false`.

## Historical source decision

The `handriss/defense-budget-justification-data` repository is useful as a discovery and structured-companion lead for Defense-Wide RDT&E and procurement material from FY2023–FY2026. It is not an authoritative completeness denominator: it excludes the military services and several marketed budget families, has no declared repository license, and its XML bytes are not proof of equivalence to the official Comptroller PDFs.

The pinned DTIC candidate and official PDF are therefore recorded as separate byte identities. No mirror data was imported, published, or used to widen a coverage claim in Package 8. A future governed adapter must independently reconcile official-source provenance, stable XML element identity, semantic extraction, review, and publication.

The read-only reconciliation report is retained at
`qualification/dtic-official-xml-pdf-reconciliation-v1.json`. It found five of
five identity/title/FY2026-amount spot matches (PEs `0605801KA` and `0605998KA`
and their three projects) on physical PDF pages 15, 19, 25–30. Page-text
presence is intentionally weaker than field-by-field semantic reconciliation;
the report remains `PASS_QUALIFICATION_ONLY`, with `promotable: false`.

The real-source locator inventory is retained at
`qualification/dtic-fy2026-xml-locator-inventory-2026-09-25.json`. It was
produced by the inspector against the pinned 67,578-byte official XML and
returned PE identities `0605801KA` and `0605998KA` with expanded R2 namespace
paths. Prefix aliases and repeated same-name siblings are handled
deterministically; no funding or narrative semantics are inferred.

## Controlled-backfill boundary

Package 1's exact production queue inventory found zero manifest-eligible rows. That is a safe stop condition, not permission to bypass manifest, archive-version, parser-profile, review, or publication gates. Package 8 therefore performs no historical production write and sends no historical notifications. The post-deploy reconciliation report is the source of truth for the remaining family/year omissions and unknown denominators.

## Evidence

- [Validation evidence](./validation-evidence-2026-09-24.md)
- [Machine-readable release evidence](./release-evidence-2026-09-25.json)
- [Historical notification qualification](./package4-historical-suppression-qualification.json)
- [DTIC/JDOCS candidate assessment](./handriss-dtic-source-catalog-assessment.md)
- [Semantic candidate validation evidence](./validation-evidence-2026-09-26.md)

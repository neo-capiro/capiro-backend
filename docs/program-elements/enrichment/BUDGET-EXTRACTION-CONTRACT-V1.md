# Defense-Budget Extraction Contract V1

`defense_budget_extraction_v1` is the single, versioned runtime contract that
every current and future defense-budget parser produces. It is a **data
boundary only**: contract validity is not verification, and a contract-valid
artifact is not canonical approval.

This document is the authoritative reference for the Phase 1 contract.

## 1. Purpose and non-goals

The contract exists so that:

- every defense-budget source family (RDT&E, procurement, O&M, MILCON,
  committee, public law) can be represented in one deterministic artifact;
- every fact present in a legacy extraction is either asserted or explicitly
  omitted — nothing is silently dropped;
- parser provenance and evidence are truthful, never fabricated;
- money is represented exactly, without binary floating-point drift;
- later phases can build trusted verification, reconciliation, and annual-cycle
  promotion against a stable input contract.

Phase 1 does **not**:

- select, route, or implement parsers;
- call LlamaParse, pdfplumber, Camelot, Docling, PaddleOCR, or any vendor;
- verify documents against trusted archives;
- persist reviews or write canonical Program Element data;
- promote any artifact to a canonical destination;
- change current parser execution or ingestion behavior.

## 2. Why the contract exists

Before Phase 1, each budget source family produced its own ad-hoc JSON shape
(R-1 rows, R-2 program elements, R-3 performer rows, committee mark rows,
P-doc procurement PEs, the generic `ExtractionResult`). These shapes:

- used JavaScript numbers for money (float drift);
- carried no source-fact ledger, so fields could disappear silently;
- had no uniform evidence model (some had pages, some had nothing);
- could not represent data the PE ingestion program needs but current parsers
  do not yet extract (project funding, performers, procurement lines, unit
  cost, milestones, relationships).

The contract unifies these into one versioned artifact with strict runtime
validation and deterministic identity.

## 3. Artifact envelope

```text
DefenseBudgetExtractionArtifactV1
  schemaVersion      'defense_budget_extraction_v1'
  artifactId         dbx1_<contentSha256>
  contentSha256      sha256 over canonical JSON (artifactId/contentSha256 omitted)
  source             ExtractionSourceV1
  parserRuns         ParserRunV1[]
  evidence           SourceEvidenceV1[]
  sourceFacts        SourceFactV1[]
  assertions         DefenseBudgetAssertionV1[]
  warnings           ExtractionWarningV1[]
  omissions          ExtractionOmissionV1[]
  summary            ExtractionArtifactSummaryV1  (builder-computed)
```

Every object is `.strict()` — unknown fields fail closed. No `any` or
`unknown` appears in the exported contract.

## 4. Parser-run model

Each `ParserRunV1` records one parser execution truthfully:

```text
parserRunId           deterministic, unique inside the artifact
method                native_structured | deterministic_pdfplumber | camelot
                      | docling | paddleocr | llamaparse | manual
parserVersion         nonblank
parserConfigSha256    lowercase sha256
inputSourceSha256     == source.sourcePdfSha256
outputArtifactSha256  sha256 of the parser's output artifact
pageRanges            non-overlapping 1-based ranges
```

A pdfplumber artifact stays `deterministic_pdfplumber`; provenance is never
rewritten to `manual` or `llamaparse`.

## 5. Evidence granularity

`SourceEvidenceV1.granularity` is one of:

- `document_only` — no page, box, or span (the truthful representation of
  missing page provenance);
- `page_only` — page, no box or span;
- `cell_bbox` — page + positive-area bounding box;
- `text_span` — page + `start < end` span.

Pages are never coerced to `1`. Boxes are never invented. `sourcePdfSha256`
must equal the artifact source SHA, and `parserRunId` must reference an
existing parser run.

## 6. Source-fact ledger and the no-silent-drop rule

Adapters first enumerate every fact present in the legacy input as a
`SourceFactV1` (`factId`, `sourcePath`, `category`,
`requiredForCompleteness`, `rawValue`, `evidenceIds`).

For every `requiredForCompleteness: true` fact, semantic validation requires
exactly one of:

- referenced by at least one assertion; **or**
- referenced by exactly one omission.

It cannot be both asserted and omitted. Uncovered required facts are an error.
This is the mechanism that prevents silent dropping.

## 7. Assertion-kind catalog

`DefenseBudgetAssertionV1` is a discriminated union on `assertionKind`:

| kind                       | purpose                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `program_element_identity` | RDT&E PE identity + title + component                                                |
| `funding`                  | money for a line identity / fiscal year / funding field                              |
| `narrative`                | mission / description / accomplishments / plans / rationale / schedule_notes / other |
| `project`                  | project under a parent PE                                                            |
| `project_funding`          | money for a project under a parent PE                                                |
| `performer`                | performing activity / prime contractor                                               |
| `procurement_line`         | procurement BLIN parent or child line                                                |
| `quantity`                 | quantity for a line identity (never money)                                           |
| `unit_cost`                | unit cost in dollars (never money-millions)                                          |
| `om_line`                  | O&M SAG line                                                                         |
| `milcon_project`           | MILCON project                                                                       |
| `milestone`                | milestone under a parent PE                                                          |
| `relationship`             | typed edge between two line identities                                               |
| `document_fact`            | document-level fact with no canonical destination yet                                |

## 8. Money and decimal rules

Money is a decimal string, never a binary float:

```text
MoneyValueV1
  originalValue    canonical decimal string
  originalUnit     dollars | thousands | millions
  valueMillions    exact decimal-string scale conversion
```

- dollars → divide by 1,000,000
- thousands → divide by 1,000
- millions → unchanged

Scaling is decimal-point movement on the string, never float division. Parenthetical
source values are already leading-negative by the time they reach the
contract. Units are never inferred from magnitude. Exponential strings are
rejected.

## 9. Manual annual-cycle manifest

`defense_budget_cycle_manifest_v1` is a **manually curated** inventory of the
documents in one defense budget cycle. It does not discover documents, does
not execute parsers, and does not claim a source is archived or parsed.

Each document entry declares: `documentKey`, `required`, `title`,
`sourceLocator`, classification (`family`/`exhibit`/`authority`/`component`),
`budgetCycle`, `documentType`, `parserPolicy`, `requiredDataCategories`,
optional `requiredFundingFields`, `expectedLineKinds`, `allowEmpty`, and
optional legacy-artifact kind/path. Semantic rules enforce unique keys,
required-document constraints, and exhibit→line-kind consistency (R-_ →
`RDTE_PE`, P-_ → `PROCUREMENT_BLIN`, O-\* → `OM_SAG`, C-1/DD1391 →
`MILCON_PROJECT`).

## 10. Legacy adapter coverage matrix

| Existing path      | Adapter           | Current data retained                                     | Known legacy limitations                   |
| ------------------ | ----------------- | --------------------------------------------------------- | ------------------------------------------ |
| `ExtractionResult` | extraction-result | identities, money, quantity, text, warnings, provenance   | no cell geometry                           |
| R-1 JSON           | r1                | identity, BA, line number, pages, FY columns when present | current artifact may lack funding columns  |
| R-2 JSON           | r2                | mission, PE pages, projects                               | current artifact may lack project funding  |
| R-3 JSON           | r3_performer      | performer, project, location, method, cost                | cost unit may be absent                    |
| Committee rows     | committee         | request, mark, explanation                                | page/unit may be absent                    |
| P-doc JSON         | pdoc              | procurement parents, FY money/qty/unit cost, child lines  | some child money units/pages may be absent |

## 11. Conversion and validation commands

All commands are local-only (no network, no database) and are **not** exposed
through the ECS entrypoint.

```bash
# Validate a cycle manifest
pnpm --filter @capiro/api validate:defense-budget-manifest -- \
  --manifest apps/api/scripts/__config__/defense-budget-cycle-manifest.example.json

# Convert a legacy artifact to V1
pnpm --filter @capiro/api convert:defense-budget-artifact -- \
  --manifest <manifest.json> --document <document-key> \
  --kind <extraction_result|r1|r2|r3_performer|committee|pdoc> \
  --input <legacy-artifact.json> --source-sha256 <pdf-sha256> \
  --parser-method <method> --parser-version <version> \
  --parser-config-sha256 <sha256> --out <output.extraction-v1.json> [--force]

# Validate a V1 artifact
pnpm --filter @capiro/api validate:defense-budget-artifact -- \
  --artifact <output.extraction-v1.json> [--require-complete]
```

The converter refuses to overwrite an existing output without `--force`.
`--force` only replaces the local generated artifact; it authorizes no DB or
canonical write.

## 12. Completeness status semantics

- `complete` — zero omissions and zero uncovered required facts;
- `complete_with_omissions` — one or more omissions, zero uncovered required
  facts;
- `incomplete` — one or more uncovered required facts (always an error).

`--require-complete` rejects both `complete_with_omissions` and `incomplete`.
A contract with explicit omissions can be valid but not complete.

## 13. Contract validity is not verification

A `defense_budget_extraction_v1` artifact that parses, validates, and hashes
correctly is **structurally valid** — nothing more. It has not been checked
against a trusted source, it carries no canonical eligibility, and it must
never be treated as approval for Program Element promotion. Trusted
verification is a Phase 2 concern.

## 14. Remaining work (Phase 2 and Phase 3)

- parser router and page-level LlamaParse escalation;
- new pdfplumber / Camelot / Docling / PaddleOCR implementations;
- trusted archive and parse-proof resolution (`SourceDocument`, S3,
  `DocumentParseJob`);
- a sound verifier that consumes V1 artifacts;
- family-specific verification and reconciliation;
- governed review persistence;
- a verified promotion service;
- integration of the contract into the existing loaders;
- complete FY2027 annual-cycle execution.

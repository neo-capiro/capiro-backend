# Budget Verification Gate V1

> **STATUS: R8.3 IMPLEMENTED — MERGE PENDING — NOT OPERATIONALLY ACTIVATED**
>
> The Phase 2 verification implementation is complete on the R8.3 closeout
> branch. The schema migration `20260816010000_budget_verification_v1` is
> successfully applied in `capiro-dev`; its original failed attempt was resolved
> as rolled back and the corrected migration subsequently finished.
>
> Phase 2 remains an audit-only trust boundary. It is not a canonical promotion
> mechanism, is not wired to an ingestion scheduler or public API, and performs
> no canonical Program Element write.

## Trust boundary

The gate answers:

> Does this exact immutable extraction artifact faithfully and completely
> represent the supplied official source document under the exact approved
> document policy and independently proved reconciliation evidence?

It does **not** answer:

> May these assertions be written into canonical Program Element tables?

`VERIFICATION_PASSED` contains no canonical implication. The gate produces no
promotion token, canonical eligibility property, or canonical record.

## Proof boundary

Persist mode uses `CompositeProofResolver` in `production_proof` mode. Inspect
mode uses `FilesystemProofResolver` and cannot create durable trusted audit
evidence.

Production proof requires:

- a reachable SourceDocument database client;
- authoritative source bytes;
- the exact SourceDocument identity and stored SHA;
- immutable archive proof where policy requires it;
- independently persisted parser output proof where policy requires it;
- independently proved reference artifacts;
- a real audit repository created from the same Prisma client.

Missing production dependencies fail before any audit row is written.

## Byte hashing

- `sha256Bytes()` hashes PDFs, JSON file bytes, parser outputs, and S3 objects.
- `sha256Hex()` hashes deliberate UTF-8 strings only.
- Canonical JSON hashing is used only for normalized logical content.

Binary proof paths never trust an encoded string in place of the original
bytes.

## Source-document proof

`SourceDocumentProofResolver`:

- loads the exact requested `sourceDocumentId`;
- fails closed when the row is absent;
- resolves authoritative bytes from a versioned archive, approved artifact
  path, or explicitly supported source URL;
- compares actual bytes with SourceDocument and artifact SHAs;
- validates source key, fiscal year, component, document type, budget cycle,
  and SourceDocument ID.

Production proof never substitutes an artifact-asserted SHA when authoritative
source bytes are unavailable.

## Archive proof

`ArchiveProofResolver` verifies:

- bucket and key;
- exact VersionId;
- actual bytes or an explicit full-object SHA-256 checksum;
- expected source SHA;
- object size;
- encryption and Object Lock metadata where available.

For policies requiring immutable archive proof, `missing`, `mismatch`, and
`not_applicable` cannot pass.

## Parser-output proof

Parser fields embedded inside the extraction artifact are not independent proof.
Production proof loads persisted parser output through a verifier-owned
`ParserOutputProofSource` and verifies:

- parser-run identity;
- source SHA;
- parser method;
- parser version;
- parser configuration SHA;
- exact requested and succeeded pages;
- evidence-page coverage;
- persisted output bytes;
- persisted output byte SHA;
- canonical parser-result content SHA.

`DeclaredParserOutputProofSource` centrally requires the independently loaded
canonical parser-result SHA to equal the parser run's declared
`outputArtifactSha256`, including for injected/custom proof sources.

For LlamaParse, the persisted parse-job row alone is insufficient. The output
object is loaded, its raw bytes are hashed, its provider job is bound, and the
stored normalized-result SHA must equal the parser-run declaration.

Manual extraction always creates a mandatory human-review trigger.

### Parser artifact location

Production wiring no longer defaults local parser proof to a process-relative
directory. A shared persistent root must be configured explicitly through
`BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT`; otherwise local-parser proof fails
closed. LlamaParse output is resolved from object storage.

## Independent reference proof

Candidate and reference artifacts use the same internal
`resolveSingleArtifactProof` method. Every reference supplies:

- its own artifact locator;
- its own SourceDocument ID;
- its own mandatory manifest document key;
- an optional separate manifest locator.

Each reference is independently checked for manifest identity, artifact bytes
and content, authoritative source bytes, SourceDocument metadata, archive proof,
and parser-output proof. A failed reference is excluded from the comparison
index and cannot satisfy a required comparison.

## Authority-aware policy selection

Family and exhibit alone are not sufficient for committee documents. R8.3
selects the exact policy using manifest authority:

| Authority | Required mark field |
| --- | --- |
| HASC | `hascMark` |
| SASC | `sascMark` |
| HAC-D | `hacDMark` |
| SAC-D | `sacDMark` |
| NDAA conference | `ndaaConference` |
| Appropriations conference | `conference` |
| Public law | `enacted` |

Ambiguous policy matches fail closed. HASC and SASC can no longer inherit each
other's required funding fields. Authority-specific policy differences are
included in the computed policy SHA through the selected policy content.

## Check outcomes

| Outcome | Meaning |
| --- | --- |
| `PASS` | The rule executed and passed |
| `FAIL` | The rule executed and failed |
| `NOT_RUN` | Required inputs were unavailable or incomplete |
| `SKIPPED` | Policy explicitly determined the rule was inapplicable |

A required `NOT_RUN` forces at least `REVIEW`. A blocking `FAIL` forces
`REJECT`.

## Required comparison coverage

Policy-required comparisons cannot pass with:

- no reference artifacts;
- failed reference proof;
- zero exact matches;
- partial assertion coverage;
- ambiguous matches;
- value mismatches.

Checks record candidate assertion count, matched count, unmatched IDs,
ambiguous IDs, reference count, and coverage percentage.

## Page-only monetary evidence

The money-evidence rule treats page-only monetary evidence as provisional when
the policy permits independent reconciliation. After comparison rules execute,
`page_only_reconciliation` emits a real check:

- all page-only assertions exactly corroborated → `PASS`;
- partial or unavailable reconciliation → required `NOT_RUN`;
- failed covering comparison → blocking `FAIL`;
- no page-only monetary assertions → `SKIPPED`.

A successful reconciliation converts the provisional money-evidence `NOT_RUN`
to `PASS`; fully corroborated page-only evidence no longer causes a false review.
One passing comparison never clears an unrelated assertion.

## Congressional and enacted review triggers

Congressional mark and enacted assertions force review only when they are
uncorroborated. A passing independent-reference check must explicitly include
the exact assertion ID before the review trigger is cleared.

## Decision precedence

1. Any blocking `FAIL` → `REJECT`
2. Any blocking proof finding → `REJECT`
3. Any required `NOT_RUN` → at least `REVIEW`
4. Any review-severity discrepancy → at least `REVIEW`
5. Remaining manual, OCR, uncorroborated congressional, or uncorroborated
   enacted trigger → at least `REVIEW`
6. Every required check passes and no review trigger remains → `PASS`

Risk score never overrides a blocking failure or required `NOT_RUN`.

## Persistence and replay

One database transaction:

1. creates or reuses the exact candidate;
2. establishes `VALIDATING` state;
3. inserts the completed run;
4. inserts proof snapshots;
5. inserts checks;
6. inserts discrepancies;
7. updates the final candidate status;
8. commits.

Any failure rolls back the transaction. Completed runs, checks, proofs,
discrepancies, and review decisions are append-only and protected from update
and deletion.

Exact immutable identity has one deterministic verification run. The public
request exposes no `attemptId`. A correction requires a changed source,
manifest, artifact, policy, or verifier identity and therefore a new candidate.
Exact replay returns the persisted result snapshot and inserts no duplicate
evidence.

## Review workflow

Human review may accept reviewable uncertainty but cannot waive corruption or
broken proof. Review acceptance is rejected when there is a blocking check,
blocking discrepancy, missing/mismatched proof snapshot, hash mismatch, invalid
evidence ID, or segregation-of-duties violation.

Dry-run and commit use the same eligibility pipeline. Commit mode locks the
candidate row, requires `NEEDS_REVIEW`, permits one terminal decision, inserts an
immutable review record, and conditionally updates exactly one candidate row.

## Operator commands

### Verify

```bash
pnpm --filter @capiro/api verify:defense-budget-artifact-v1 -- \
  --manifest <cycle-manifest.json> \
  --document <document-key> \
  --artifact <artifact.extraction-v1.json> \
  --source-document-id <uuid> \
  [--reference-file <references.json>] \
  [--expected-source-sha256 <sha>] \
  [--expected-artifact-sha256 <sha>] \
  [--persist-audit]
```

Exit codes: `0` passed, `2` needs review, `3` rejected, `4` execution or
configuration failure. `--persist-audit` activates the production proof
boundary; inspect remains read-only.

### Review

```bash
pnpm --filter @capiro/api review:defense-budget-verification-v1 -- \
  --candidate-id <uuid> \
  --run-id <uuid> \
  --reviewer-id <id> \
  --decision accept|reject \
  --notes-file <path> \
  --expected-source-sha256 <sha> \
  --expected-artifact-sha256 <sha> \
  --expected-manifest-sha256 <sha> \
  [--evidence-id <id>]... \
  [--extractor-actor-id <id>] \
  [--extraction-method <method>] \
  [--commit]
```

Dry-run is the default. `--commit` writes one review decision only.

### Exact-manifest cycle report

```bash
pnpm --filter @capiro/api report:defense-budget-verification-cycle-v1 -- \
  --manifest <cycle-manifest.json>
```

The report hashes the exact supplied manifest bytes and queries candidates by
cycle ID, manifest SHA, and document key. Candidate selection is deterministic,
multiple exact candidates create a visible warning, and unresolved comparison
counts include only comparison/reconciliation checks.

## Explicit absence of canonical promotion

The gate:

- imports no canonical writer;
- creates no promotion token;
- performs no canonical Program Element mutation;
- produces no `CANONICAL`, `PROMOTED`, `promotionReady`, or
  `canonicalEligible` status.

`VERIFICATION_PASSED` means passed verification checks only.

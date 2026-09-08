# Phase 10B-31 — Production-proof metadata-boundary repair packet

Status: **PLAN ONLY — nothing in this packet has been executed against
production.** Prepared 2026-09-07 from repository inspection of branch
`fix/phase10b31-production-proof-repair` (base `8c4735e6bb31a0d920a9ff508f165866c0be5454`)
plus read-only inspection of `capiro-dev` (account `967807252336`,
`us-east-1`). Every production write below is a future, separately
authorized step. Executing any of it requires: this repair PR reviewed and
merged, a NEW drain image built from the merge SHA and independently
qualified (section 3), and an explicit operator go-ahead for each of:
task-definition registration, outbox replay, drain run.

Revision note (2026-09-07, evidence-completion pass): an independent review
correctly found that the first version of this packet overstated two
things — (a) it described the permanent regression as proving the full
production path when every scenario in it short-circuited on a missing
archive, and (b) it attributed a locally observed 590-assertion /
39-blocking-omission result to a "pre-existing production parser/router
defect". Both statements are withdrawn. Sections 6–8 below carry the
evidence that replaces them: a complete-archive regression that reaches a
genuine overall decision through the real adapter, an isolated replay of
the recovered production artifact through the repaired resolver, and a
concrete reconciliation showing the 590/39 result was an artifact of the
local harness environment, not of the repaired code. The diagnostic script
that produced the withdrawn claim has been removed from the PR.

## 1. What this packet is for

Outbox row `f57a3419-3d7b-404e-92e4-4932f5e3f524` (the same FY2024 Army
RDT&E R-2/R-2A canary tracked by the Phase 10B-28R packet) was rejected a
second time by two independent, always-firing `production_proof`
metadata-agreement bugs in the lifecycle-bridge handoff path — never by
anything wrong with the source document itself:

1. `ParserHandoffInput` carried no `component` field, so the manifest
   builder always defaulted the document's `component` to `'UNKNOWN'`
   regardless of the SourceDocument's real, persisted value (`ARMY` for
   this canary).
2. The manifest's `sourceLocator` (an ephemeral local-disk scratch path the
   bridge materializes bytes to) was being compared directly against the
   persisted `SourceDocument.sourceKey` (a stable `defense-budget-observation-
   <dedupKey>` identity slug) — two values from structurally disjoint token
   spaces that can never agree by construction, for every lifecycle-bridge
   document, not just this one.

Both bugs are fixed on this branch (section 2). **The corrected outcome for
this exact canary is `REVIEW`, not `PASS`** — 575 real, review-severity
discrepancies (108 `page_only_reference_proof_failed` + 467
`review_omission`) already exist independently of these bugs and correctly
route the document to human review once the false REJECT is removed. This
packet does not propose or request an ACCEPT.

One consequence that the first version of this packet did not state: the
production extraction artifact that was rejected
(`dbx1_c51eead5…`, byte SHA `739557f6…`) was PRODUCED by the buggy handoff,
so its own `source.component` field reads `"UNKNOWN"`. It is therefore not
merely "an artifact that the fixed verifier would now accept" — the fixed
verifier correctly refuses to bind it to an `ARMY` manifest
(`manifest_binding` FAIL, section 7). Reaching REVIEW in production
requires the drain to re-parse the source under the repaired code, which
is exactly what the governed replay path does.

Do not read a ten-row outbox as the defense-budget corpus: the outbox holds
10 rows total; this packet touches one.

## 2. Repair PR and what must happen before any production change

| Item | Value |
|---|---|
| Repair branch | `fix/phase10b31-production-proof-repair` |
| Repair worktree | `C:\dev\capiro-p10b31-repair` |
| Base / merge-base | `8c4735e6bb31a0d920a9ff508f165866c0be5454` — confirmed an ancestor of `origin/main`; `origin/main` was exactly 1 commit ahead at packet time (`93f0dbd09`, outreach/engagement files only, zero overlap) |
| Repair head to merge | **Do not hardcode a SHA from this document.** Merge the current head of this PR as reported by `gh pr view <PR#> --json headRefOid`, having confirmed it is the head the latest independent review actually inspected. See §11 for the commit list at the time of writing. |
| Prior related fix | PR #1486 → `b938b7b1f5dc13fc1dadfb2e704337f2c3b654f8` (cycle-ID fy-tag translation, a different metadata-agreement defect on the same path) |
| This repair's own PR | draft #1524, not yet merged |

Post-merge sequence (all gated, none executed here):

1. Merge the repair PR with a normal merge commit, pinned to the current
   head as reported by `gh pr view --json headRefOid` — never to a SHA
   transcribed from this document.
2. Rebuild the API image (`apps/api/Dockerfile`, linux/arm64) from the
   MERGE SHA and the drain image (`apps/api/Dockerfile.defense-budget-ingestion-drain`,
   `--no-cache`, FROM the new stage-one digest) from the SAME merge SHA.
   Push both with the existing tag conventions (`*attested-source*` /
   `*ingestion-drain*`). Record both immutable digests.
3. Run the existing offline-startup gate
   (`apps/api/scripts/verify-defense-budget-drain-offline-startup.sh`)
   against the new drain digest; it must print `OFFLINE_STARTUP_GATE=PASS`.
   This repair does not touch the parser launcher, so no regression is
   expected here, but the gate has not been re-run against this exact
   image and must not be assumed.
4. CycloneDX SBOM + Trivy for both images; compare package/advisory
   identities against the current production baseline (task definition
   `capiro-dev-defense-budget-ingestion-drain:17`,
   `sha256:19e22322f6f023b908e0b3b1a9c334c53371e860af00077489292426bf368685`).
   This repair changes zero third-party packages; any new finding is DB
   drift or a base-image change and must be explained, not counted.
5. Two independent native ARM64 qualification runs on the ISOLATED family
   `capiro-dev-defense-budget-qualification` (register a new revision
   changing ONLY the image digest), real FY2024 Army source, real cycle
   UUID `cff02efd-45e7-4ae4-8f7f-dacd12bdb84c`. Acceptance criteria specific
   to THIS repair (in addition to the standing 10B-28/10B-28R profile):
   - Zero `source_metadata_mismatch` proof findings.
   - `source_document` proof snapshot status agrees with whether any
     source-document-kind finding actually fired (never hardcoded
     `'verified'`).
   - A `proof_findings` audit row is present on the run carrying the
     complete raw finding list (verifies the evidence-durability fix
     independently of the metadata fix).
   - Decision is `REVIEW` (not REJECT, not PASS) with the 575 real
     review-severity discrepancies still visible, and the artifact profile
     is the known one: 611 assertions, 5 identities, 467 `ambiguous_layout`
     review omissions, zero blocking omissions, three parser runs
     (2 × `deterministic_pdfplumber`, 1 × `paddleocr` over pages 11–37).
     This profile was re-derived on 2026-09-07 from the current branch's
     own source with the parser environment synced (§8); there is no known
     parser/router drift to investigate.

## 3. Production baseline (read-only, unchanged by this repair, last verified 2026-09-07)

Task definition `capiro-dev-defense-budget-ingestion-drain:17` (ACTIVE) is
unchanged by this packet — no task definition, image, or IAM change has
been made. Relevant environment on that revision, read with
`describe-task-definition` on 2026-09-07: `BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT=/tmp/defense-budget-parser-scratch`,
`BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET=capiro-dev-defense-budget-extraction-artifacts-967807252336`,
`DEFENSE_BUDGET_PARSER_PROJECT_DIR=/defense-budget-parser`, `UV_NO_SYNC=1`,
`UV_OFFLINE=1`, command `drain-defense-budget-ingestion-outbox-v1`. The
parser-artifact root being under `/tmp` inside the task is what makes the
parser OUTPUT bytes (as opposed to the extraction artifact, which is
persisted to S3) non-recoverable after the task exits — see §7. See the
Phase 10B-28R packet (`docs/defense-budget/PHASE-10B28R-CONTROLLED-DRAIN-PACKET.md`,
section 3) for the full field-by-field baseline.

## 4. The exact target row and its identities (read-only, unchanged by this repair)

| Identity | Value |
|---|---|
| Outbox row | `f57a3419-3d7b-404e-92e4-4932f5e3f524` — `state=dead_letter`, `governedDisposition=verification_rejected`, `verifierDecision=REJECT` |
| Observation | `85d62283-7dc3-4c1c-9401-2e10eb577dae` |
| Raw lifecycle cycle | `cff02efd-45e7-4ae4-8f7f-dacd12bdb84c` (FY2024, `request`, status `draft`) |
| SourceDocument | `a99fbf5b-5eb4-45f3-87e4-96c40c2c0bb0`, `source_key=defense-budget-observation-cf5b34c86b34b7e75d9c5be7d18f4dc5a8bbea08aec23611bc2020efce6f74c4`, component `ARMY`, document_type `r2`, `sha256=1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6`, archive `capiro-defense-budget-raw-dev-967807252336` / `raw/public/dod-budget/…/original.bin` @ `QN5S2.UB7ez8f6E4xrZxYoBrtW7Nf14s` (Object Lock GOVERNANCE, retained until 2033-09-01) |
| Candidate / run under investigation | `f967d4fe-0420-5d6e-843e-7dcb84935252` / `1ea40d2d-22c5-55de-a31a-136501b374f9` |
| Extraction artifact | `s3://capiro-dev-defense-budget-extraction-artifacts-967807252336/phase10/parser-artifacts/739557f6d7df9101694633ecd39a45d0c1d1a75048b7408e24b54616253fce64`, VersionId `31SvqjxLDA6qU.VKzCJCzv5.8mZOtqU.`, byte SHA `739557f6…` confirmed, content SHA `c51eead5…`, `source.component="UNKNOWN"` |

Re-verify every value above with a read-only probe immediately before any
future execution; these are last-observation values, not guarantees.

### 4a. Eligibility for the supported retry path

Unchanged from the 10B-28R packet: the only supported way to retry a
dead-letter row is the governed replay verb
(`replay-defense-budget-ingestion-outbox-v1`), eligible only when
`state='dead_letter'`, `leased_by IS NULL`,
`metadata_jsonb->>'governedDisposition'='verification_rejected'`, and
`metadata_jsonb->>'verifierDecision'='REJECT'`. This repair does not
change that eligibility predicate or execute it.

## 5. What this repair actually changed (code only — see PR diff for the authoritative source)

| # | Fix | File(s) | Mechanism |
|---|---|---|---|
| 1 | Manifest contract gains `expectedSourceKey` | `apps/api/src/defense-budget/contracts/budget-cycle-manifest-v1.ts` | Additive, optional zod field mirroring the existing `expectedSourceSha256` pattern; every manifest that predates this field keeps validating unchanged. |
| 2 | Resolver compares `expectedSourceKey` when present | `apps/api/src/defense-budget/verification/trusted-proof/composite-proof-resolver.ts` | Falls back to the exact prior `sourceLocator` comparison when the field is absent — every curated CLI manifest today keeps its current behavior byte-for-byte. |
| 3 | `component`/`sourceKey` threaded end-to-end | `observation-ingestion-bridge.ports.ts`, `observation-ingestion-bridge.service.ts`, `default-parser-handoff.adapter.ts`, `parser-router/source-document-parser-handoff.ts`, `prisma-observation-bridge.store.ts` | Sourced from the AUTHORITATIVE PERSISTED row on both first-time (`DocumentRegistrar.register()`'s own return) and idempotent-replay (`StoredSourceDocumentArchiveRecord`, one extra column of an already-loaded row, zero new queries) paths. `toBudgetComponentOrThrow`: `null`→`undefined`, recognized value passes through, unrecognized non-null value **throws** (fail-closed). |
| 4 | Evidence durability: `proofFindings` persisted | `verification/persistence/prisma-budget-verification.repository.ts`, `verification/services/budget-verification-v1.service.ts` | New `proof_findings` row on the existing `budget_verification_proof` table (no migration); `source_document`/`manifest`/`extraction_artifact` snapshot `status` no longer hardcoded `'verified'` — now reflects whether a relevant finding actually fired. |
| 5 | Hash issue #1: artifact byte-vs-content SHA | `apps/api/src/defense-budget/promotion/readiness/prisma-materialization-artifact-source-v1.ts` | `loadVerifiedArtifact` now recomputes `computeArtifactContentSha256` from the reloaded parsed artifact and compares that against `extraction_artifact_sha256`, instead of hashing raw file bytes against a value that is actually a content hash. |
| 6 | Hash issue #2: manifest raw-bytes-vs-reserialized-JSON SHA | `apps/api/src/defense-budget/promotion/readiness/prisma-cycle-manifest-registry-v1.ts` | `register()` now takes raw manifest bytes and hashes them directly (`sha256Hex`), matching the candidate-side definition, instead of hashing `JSON.stringify(parsed)`. No production caller exists yet for this method (verified by repo-wide grep), so no historical data is affected. |
| 7 | Permanent regression (two sections) + automated mutation-sensitivity check | `verification/persistence/lifecycle-bridge-source-metadata-agreement.integration.spec.ts`, `scripts/verify-pe-budget-phase-10b31-metadata-regression.ts`, `scripts/phase10b31-metadata-regression-rehearsal.sh`, `apps/api/package.json` | Qualification command `verify:pe-budget-phase-10b31[:db]`, see §6. Section A: metadata-agreement findings with no archive (decision always REJECT via `archive_version_missing`; the finding code is the signal). Section B: complete archive evidence in an isolated versioned store; genuine overall decision (REVIEW positive + five tamper controls that REJECT + one fail-closed abort). |
| 8 | Isolated replay harness for the recovered production artifact | `apps/api/scripts/phase10b31-replay-recovered-artifact.ts` (`replay:pe-budget-phase-10b31-recovered-artifact`) | Feeds the byte-exact recovered artifact through the real persist-mode wiring against a local Postgres and a local versioned archive store; does not run the parser; refuses non-local endpoints and any `AWS_PROFILE`. Result in §7. Replaces the removed live-AWS diagnostic (`phase10b31-real-canary-review-profile.ts`), whose conclusions were wrong (§8). |
| 9 | Candidate-identity contract pinned | `apps/api/src/defense-budget/parser-router/parser-run-output-hash-vs-identity.spec.ts` | Documents and asserts why a fresh drain run of identical bytes yields a new candidate (§9). No production code change. |

### Metadata field mapping (authoritative → bridge input → adapter arg → manifest field → comparison rule → test coverage)

| Field | Authoritative source | Bridge input (`ParserHandoffInput`) | Adapter argument to `runParserHandoffForSourceDocument` | Manifest document field | Comparison rule in `CompositeProofResolver` | Test coverage |
|---|---|---|---|---|---|---|
| `component` | `SourceDocument.component` (persisted; first-time via `DocumentRegistrar.register()` return, replay via `StoredSourceDocumentArchiveRecord`) | `component: string \| null` (new, required key, null legitimate) | `component: toBudgetComponentOrThrow(input.component)` → `BudgetComponentV1 \| undefined` | `manifestDocument.component` (was always `'UNKNOWN'` when absent; now the real value) | `row.component !== manifestDocument.component` → blocking `source_metadata_mismatch` | `default-parser-handoff.adapter.spec.ts` (12 valid components + null + fail-closed invalid); `observation-ingestion-bridge.spec.ts` (NAVY + null, first-time AND replay); `trusted-proof.spec.ts`; integration spec Sections A and B |
| `sourceKey` | `SourceDocument.sourceKey` (persisted once at registration, pure function of `observation.dedupKey`) | `sourceKey: string` (new, required, never defaulted) | `sourceKey: input.sourceKey` → manifest document's new `expectedSourceKey` | `manifestDocument.expectedSourceKey` (new, optional) | `row.sourceKey !== (manifestDocument.expectedSourceKey ?? manifestDocument.sourceLocator)` → blocking `source_metadata_mismatch` | `budget-cycle-manifest-v1.spec.ts` (contract-level, 3 new cases); `trusted-proof.spec.ts` (3 new resolver-level cases: match, mismatch, absent-field fallback); integration spec Sections A and B (real end-to-end, real Postgres) |
| `fiscalYear` / `budgetCycle` / `documentType` | Same input on both sides via `routingForSourceFamily` (pure function) | unchanged | unchanged | unchanged | unchanged — already agreed structurally, not coincidentally | Unchanged; the fiscal-year tamper controls in both sections show the two independent fiscal-year guards firing |
| `extraction_artifact_sha256` (hash issue #1) | `resolution.extractionArtifactContentSha256` (canonical content hash) | n/a | n/a | n/a | `PrismaMaterializationArtifactSourceV1.loadVerifiedArtifact`: now recomputes content hash from reloaded artifact instead of raw byte hash | `prisma-materialization-artifact-source-v1.spec.ts` (positive control + 2 negative controls: tampered payload, old buggy byte-hash value) |
| `manifest_content_sha256` (hash issue #2) | Raw manifest bytes hash (`sha256Hex`), set at verification time | n/a | n/a | n/a | `PrismaCycleManifestRegistryV1.register()`: now hashes raw bytes directly instead of `JSON.stringify(parsed)` | `prisma-cycle-manifest-registry-v1.spec.ts` (positive + negative controls) |

## 6. Qualification command, what it proves, and its limitations

```
pnpm --filter @capiro/api run verify:pe-budget-phase-10b31:db    # self-contained: provisions a disposable pgvector/pgvector:pg16 Postgres AND a disposable versioned minio/minio store, migrates both prisma schemas, runs the jest GREEN check, then the RED/GREEN mutation-sensitivity script, always removes both containers
pnpm --filter @capiro/api run verify:pe-budget-phase-10b31       # same two steps against infrastructure you already run: needs DATABASE_URL (local) AND BUDGET_VERIFICATION_S3_ENDPOINT (local) + AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_REGION for that store
```

Both variants also require `apps/defense-budget-parser` synced in THIS
worktree (`uv sync --locked`; `--extra ocr` is not needed for the
regression's pdfplumber-only pages), and both run jest under Node's
`--experimental-vm-modules` flag: the real `@aws-sdk/client-s3` request
pipeline performs a dynamic `import()` that Jest's module VM refuses without
it (Jest's documented requirement for dynamic imports; Section A never
sent an S3 request, which is why the first version of this suite did not
need it). The spec's `beforeAll` refuses to run
if `uv run --no-sync` in that directory resolves the parser package to any
path outside the worktree (§8 explains why that guard exists).

### 6a. What is isolated, and what production code runs unmodified

| Isolated (disposable, local, provisioned/torn down by `:db`) | Production code invoked unmodified |
|---|---|
| Postgres `pgvector/pgvector:pg16`, database `capiro`, both prisma schemas migrated; refused unless `DATABASE_URL` host is local | `DefaultParserHandoffAdapter.handoff` → `runParserHandoffForSourceDocument` (profiler, `ParserRouterV1Service`, real Python parser via `uv run --no-sync capiro-defense-budget-parser`, real R-2 semantic extractor, `buildLifecycleBridgeSyntheticManifestV1`) |
| Versioned S3-compatible store `minio/minio`, bucket `capiro-phase10b31-isolated-archive`, reached ONLY via the pre-existing verifier-scoped hook `BUDGET_VERIFICATION_S3_ENDPOINT` (`createBudgetVerificationS3Client`, the single S3 client construction path production uses); refused unless the endpoint host is local | `createProductionParserVerificationContext` → `wireProductionProofBoundary` → `CompositeProofResolver` (`production_proof`), `SdkS3ProofClient` (`@aws-sdk/client-s3` HeadObject/GetObject with exact VersionId), `S3ByteLocatorReader`, `ArchiveProofResolver`, `SourceDocumentProofResolver`, `ParserRunProofResolver` + `FilesystemParserOutputProofAdapter`, `BudgetVerificationV1Service`, every rule, `computeDecisionV1`, `PrismaBudgetVerificationRepositoryV1` |
| Source bytes: an 8-page slice (physical pages 126–133, PE 0601103A + start of PE 0601104A) cut at test time with pdf-lib from the committed, SHA-verified real FY2024 Army R-2 fixture; a second slice (161–170) for the substituted-bytes control | — |

No "skip archive" switch exists or was added. The archive check in Section
B is a real head + bytes + SHA check against a real versioned object; the
substituted-bytes and nonexistent-version controls show it (and the
SourceDocument SHA binding around it) failing closed.

### 6b. What Section B asserts, and why REVIEW is the correct positive decision

Positive control: a fresh real parse of real R-2 pages with matching
SourceDocument metadata and complete archive evidence reaches overall
`decision=REVIEW` / `finalState=TERMINAL_REVIEW`; the persisted
`proof_findings` list is EMPTY; `manifest`, `extraction_artifact`,
`source_document`, and `archive` snapshots are all `verified` (archive
evidence carries the store's bucket/key/versionId, the slice's SHA, and
its byte size); `archive_proof`, `parser_run_proof`, `manifest_binding`,
`contract_integrity`, `evidence_binding`, `identity_validation` all PASS;
no check FAILs; `rdte_summary_detail` and `completeness` are NOT_RUN; no
blocking discrepancy exists and `review_omission` discrepancies do; the
single candidate row is `NEEDS_REVIEW` under the raw lifecycle cycle UUID.

REVIEW, not PASS, is the ceiling by policy design, not by shortfall: the
rdte/R-2 `VerificationPolicyV1` names `rdte_summary_detail` as a required
comparison rule and that check is `NOT_RUN` without an independently proved
R-1 reference artifact (a lone R-2 document never has one), which
`computeDecisionV1` maps to at least REVIEW; independently, real R-2 pages
carry review-severity `ambiguous_layout` omissions, so `completeness` is
`NOT_RUN` too. This is the same reason the Phase 10B-28 qualification of the
full real canary reached REVIEW.

Negative controls (each tampered independently, complete archive intact
unless stated):

| Tamper | Decision | Exact persisted finding list |
|---|---|---|
| component (row `ARMY`, handoff `NAVY`) | REJECT | exactly one blocking `source_metadata_mismatch`: `SourceDocument component "ARMY" does not match manifest component "NAVY"`; archive still `verified`; `parser_run_proof` PASS |
| sourceKey/identity (handoff declares a different slug) | REJECT | exactly one blocking `source_metadata_mismatch`: `SourceDocument sourceKey "<real>" does not match manifest expectedSourceKey "<wrong>"`; archive still `verified` |
| fiscal year (row 2024, handoff 2025) | REJECT | exactly two blocking findings: `source_metadata_mismatch` (`SourceDocument fiscalYear 2024 does not match manifest fiscalYear 2025`) and the resolver's pre-existing fiscal-year guard, coded `source_sha_mismatch` (`SourceDocument fiscal year 2024 does not match manifest fiscal year 2025`); archive still `verified` |
| `SourceDocument.sha256` (row carries a stale hash) | REJECT | exactly three blocking findings, three independent guards: `source_metadata_mismatch` (stored SHA vs resolved bytes SHA), `source_sha_mismatch` (row SHA vs actual source PDF SHA), and the request-level TOCTOU guard `source_sha_mismatch` (`expected source SHA <real> does not match actual <stale>`, because the proof bundle reports the row's SHA); archive still `verified` |
| archived object bytes substituted (the referenced version holds different real R-2 pages) | REJECT | `archive` snapshot is `verified` against the SUBSTITUTED bytes' SHA — the archive check alone cannot see the substitution; detection is the binding of resolved bytes to the row, the artifact and the parser run: `source_metadata_mismatch` (exactly one, the stored-SHA message), `source_sha_mismatch`, `artifact_source_sha_mismatch`, `parse_input_sha_mismatch`, all blocking |
| archive version id points at a nonexistent version | no decision | `production_proof` aborts fail-closed with `TrustedProofResolutionError` (`authoritative source bytes could not be resolved for production proof …`) before any candidate or run row is persisted; the bridge surfaces this as a downstream failure, never as a REJECT row |

Section A (no archive; 9 scenarios) is unchanged in substance and still
reads the `source_metadata_mismatch` finding code as its signal; its
overall decision is REJECT in every scenario because of
`archive_version_missing`, and it is now described as exactly that.

### 6c. RED/GREEN sensitivity

`scripts/verify-pe-budget-phase-10b31-metadata-regression.ts` reverts the 9
named source files to their exact pre-fix content at baseline `8c4735e6b`
(via `git show`, never hand-typed) and reruns the unmodified spec. Its
expectation table now covers all 16 tests: under the revert, every Section
B scenario that asserts an exact finding list or a REVIEW decision must turn
RED (the reverted code adds the two spurious findings to every document),
the nonexistent-version abort must stay GREEN (it fails closed before the
metadata comparison in both states), and Section A behaves as before (7
RED / 2 GREEN). The script refuses to run unless both `DATABASE_URL` and
`BUDGET_VERIFICATION_S3_ENDPOINT` are local.

### 6d. Remaining limitations

- The isolated store mints its own version ids; the production
  `archiveVersionId` string (`QN5S2.UB7ez8f6E4xrZxYoBrtW7Nf14s`) cannot be
  reproduced locally. Rows are seeded with the version id the store actually
  returned, so the archive check is exercised for real, but the literal
  production version string is not.
- The regression's positive control uses an 8-page slice, not the full
  170-page canary; the full-document profile (611/5/467, three parser runs
  including OCR) was re-derived separately (§8) and is not part of the
  automated command.
- Section B's parser runs are `deterministic_pdfplumber` only (the chosen
  pages have embedded text); the OCR branch is exercised only by the
  full-document reproduction in §8.
- Parser-run proof in production depends on parser OUTPUT bytes that live
  under the task's ephemeral `/tmp` root (§3); it is verified in-container
  during the drain but cannot be re-established afterwards from persisted
  evidence alone (§7). This repair does not change that.

## 7. Replay of the RECOVERED production artifact through the repaired path (isolated, 2026-09-07)

Command (`replay:pe-budget-phase-10b31-recovered-artifact`), run against a
disposable Postgres and a disposable versioned MinIO, with `AWS_PROFILE`
unset and the endpoint refused unless local:

```
DATABASE_URL=postgresql://…@localhost:<pg>/capiro
BUDGET_VERIFICATION_S3_ENDPOINT=http://localhost:<minio>
AWS_ACCESS_KEY_ID=<minio user> AWS_SECRET_ACCESS_KEY=<minio password> AWS_REGION=us-east-1
P10B31_RECOVERED_ARTIFACT_PATH=<byte-exact recovered artifact, sha256 739557f6…>
P10B31_SOURCE_PDF_PATH=<real archived PDF, sha256 1fb74021…>
npx tsx scripts/phase10b31-replay-recovered-artifact.ts
```

Inputs: the byte-exact recovered production artifact (byte SHA
`739557f6d7df9101694633ecd39a45d0c1d1a75048b7408e24b54616253fce64`, content
SHA `c51eead5f280029f31d8602e42c94b04b7d1882a069fdcb3fe150740c0d8fc60`, 611
assertions, 467 review omissions, `source.component="UNKNOWN"`, three parser
runs); the real archived PDF obtained by one version-aware read-only
`GetObject` of the production raw object (SHA `1fb74021…` verified,
7,227,604 bytes, byte-identical to the committed fixture), uploaded to the
isolated store under the REAL bucket name and REAL key (store-minted
version id); the SourceDocument row seeded with every real column value
except that version id; the manifest built by the real
`buildLifecycleBridgeSyntheticManifestV1` from the real
`routingForSourceFamily('pb_r2')` and `toBudgetComponentOrThrow('ARMY')`
(so `component=ARMY`, `expectedSourceKey=<real slug>`); the verification
request shaped exactly as `ParserRouterV1Service.runVerification` builds it
(`persist_audit`, raw cycle UUID, expected source and artifact byte SHAs).

Result — **decision REJECT** (`REJECTED`, route `none`, risk 100), new
candidate `c77e615f-0dc1-5307-9e54-2b439ef81345`, run
`a0a05906-5196-5d41-8401-c2eea736e254`, manifest content SHA
`321f2d82…` (differs from production's `94a71633…` because the repaired
manifest carries `component=ARMY` and `expectedSourceKey`).

Complete persisted proof-finding list (3 entries, all blocking, all
`parse_output_missing`):
`no independently persisted parser output found for local parser run pr1_0ab895829001bb766ea339db50beb9a882616c1a0cc9229853dc268a7690ce36`,
`… pr1_5a3047d08d4f14b70fd41b6ad7d518a9ea3f17d795f0082358696896baba577b`,
`… pr1_6c5fb973e14dd254eae2d525535690923e91d9ada6a511b055efcac6565ad72f`.
**Zero `source_metadata_mismatch` findings** — the two findings that
rejected the production run are gone.

Proof snapshots: `manifest` verified; `extraction_artifact` verified (byte
SHA `739557f6…`, content SHA `c51eead5…`); `source_document` verified
(sourceKey and SHA as persisted); `archive` verified (real bucket/key,
store version id, `objectSha256=1fb74021…`, `byteSize=7227604`; HeadObject
on the isolated store exposed no checksum metadata, so the resolver took
its read-bytes-and-hash path); `proof_findings` status `mismatch` carrying
the three findings above.

All 24 checks: `archive_proof` PASS, `contract_integrity` PASS,
`duplicate_detection` PASS, `evidence_binding` PASS,
`funding_field_ownership` PASS, `identity_validation` PASS,
`numeric_validation` PASS, `r1_specific` PASS, `warning_policy` PASS;
`completeness` NOT_RUN (467 review omissions), `money_evidence_policy`
NOT_RUN (108 page-only), `page_only_reconciliation` NOT_RUN,
`rdte_summary_detail` NOT_RUN (no R-1 reference), `historical_consistency`
NOT_RUN; 8 SKIPPED (not in policy / not applicable); and exactly two FAIL:
- `parser_run_proof` FAIL — "3 parser runs have proof failures" (3 blocking
  `parser_proof_missing` discrepancies).
- `manifest_binding` FAIL — `component: artifact="UNKNOWN" manifest="ARMY"`
  (1 blocking `manifest_binding_mismatch` discrepancy).

Discrepancies: 467 `review_omission` (review), 108
`page_only_reference_proof_failed` (review) — identical to production — plus
3 `parser_proof_missing` (blocking) and 1 `manifest_binding_mismatch`
(blocking).

Interpretation (no tuning was applied to change any of this):

1. The metadata-boundary repair is proven against the real production
   inputs: zero `source_metadata_mismatch`, source_document/manifest/archive
   all verified from complete evidence.
2. The recovered artifact cannot, by construction, reach REVIEW through the
   repaired path: it was produced by the buggy handoff and embeds
   `source.component="UNKNOWN"`, which the (unchanged) `manifest_binding`
   rule correctly refuses to bind to the repaired `ARMY` manifest. A fresh
   parse under the repaired code writes `ARMY` into the artifact (the
   synced-environment reproduction in §8 confirms this) and binds.
3. Parser-run proof cannot be re-established from the recovered artifact
   alone: `production_proof` requires the independently persisted parser
   OUTPUT bytes, which the drain wrote under the task's ephemeral
   `/tmp/defense-budget-parser-scratch` and which were never recovered. The
   production check passed in-container at the time; it is not
   re-verifiable after the fact. This is an evidence-durability observation
   about the drain's parser-artifact root, not a defect in this repair and
   not fixed here.
4. Every other decision input is exactly the REVIEW-grade profile the
   production canary carried (same 575 review discrepancies, same NOT_RUN
   set, no other FAIL).

## 8. Reconciliation of the earlier 590-assertion / 39-blocking-omission local result

The first version of this packet (and the removed diagnostic script)
attributed a local run's 590 assertions / 505 omissions (39 blocking) to
"parser/router drift" in the repaired code. That attribution was wrong.

| Dimension | Production (drain rev 17, real artifact) | Local run behind the withdrawn claim | Local run, environment corrected (2026-09-07) |
|---|---|---|---|
| Input bytes | `1fb74021…`, 170 pages | same fixture, same SHA, full document | same |
| Parser source executing | this repository's `apps/defense-budget-parser` at the image's commit | **`C:\Users\neoma\Downloads\capiro-pe-phase7-eligibility\apps\defense-budget-parser`** — a Phase-7-era checkout, reached because this worktree's `.venv` had never been synced and `uv run --no-sync capiro-defense-budget-parser` fell through to `C:\Users\neoma\AppData\Local\hermes\hermes-agent\venv\Scripts\capiro-defense-budget-parser.exe` (Python 3.11.15, editable install of that old checkout) | this worktree's `apps/defense-budget-parser/src` via its own `.venv` (Python 3.12.13) after `uv sync --locked --extra ocr` |
| Engines available | pdfplumber 0.11.10, paddleocr 2.10.0 / paddlepaddle 2.6.2 (baked models), no camelot/docling (arm64) | pdfplumber 0.11.10 only; `import paddleocr`, `paddle`, `camelot`, `docling` all fail; the old checkout's `version --json` still advertised `paddleocr: paddleocr-pp-structure-v3-cpu` (a stale constant) | pdfplumber 0.11.10, paddleocr 2.10.0 / paddlepaddle 2.6.2 (same lock pins as the image); `version --json` reports `paddleocr-det-rec-row-reconstruction-v1` (the constant the production artifact carries) and `docling: ENGINE_UNAVAILABLE` |
| Invocation | `uv run --no-sync` with `UV_NO_SYNC=1 UV_OFFLINE=1`, ARM64 | `uv run --no-sync` (no UV_* env), Windows x86_64, foreign executable | `uv run --no-sync`, Windows x86_64, project `.venv` |
| Config/code path | `runParserHandoffForSourceDocument` → `ParserRouterV1Service`, default 4 escalation rounds, `deterministic_table` policy | same TypeScript path (this branch) | same |
| Parser runs | 2 × pdfplumber (pages 1–10; 38–170: 3 + 3 `no_embedded_text` failures) + 1 × paddleocr (11–37, 27/27 succeeded) | 2 × pdfplumber only (same failures); pages 11–37 never resolved | identical to production: same three runs, same canonical `parserRunId`s (`pr1_0ab895…`, `pr1_5a3047…`, `pr1_6c5fb9…`), same page coverage |
| Artifact | 611 assertions; 467 `ambiguous_layout` (review); 0 blocking | 590 assertions; 466 review; 39 blocking = 27 × `Phase 3 did not select a parser result` (pages 11–37), 11 × `conflicting PE headers` (pages 6–9, 53, 78, 86, 103, 141, 164, 166), 1 × `missing_mission_or_description` (page 165); `sourceFactCount` 1031 vs 1042; only 546 of 590 assertion tuples match production | **611 assertions — all 611 (kind, field, value) tuples identical to production, none unique to either side; 467 omissions with identical messages; 0 blocking; identical summary** |
| `source.component` | `UNKNOWN` (the bug) | `ARMY` | `ARMY` |

Note that production's OCR'd pages 11–37 contribute zero assertions and
zero omissions (they are front matter / R-1 summary pages); the 611→590
difference is not OCR content but the 27 unresolved pages (blocking) plus
different pdfplumber-page output from the older parser source.

Classification: **environment/harness artifact of the local diagnostic**,
fully explained by (a) a foreign, stale parser install being executed in
place of this worktree's source and (b) the absence of any OCR engine in
that install. There is no evidence of a defect in the repaired production
image; the current source, in a correctly synced environment, reproduces
the production artifact exactly. Consequences applied in this PR: the
diagnostic script and its `diag:` entry are removed; every statement built
on it is withdrawn here and in the PR description; the regression spec now
refuses to run against a parser environment that does not resolve to this
worktree (`assertParserRuntimeIsThisWorktree`), so the same class of error
cannot silently recur in `r2-production-path-no-override.spec.ts`-style
suites that drive the real launcher.

Observed local caveat: `uv sync --locked --extra ocr` DID install
paddleocr/paddlepaddle on this Windows workstation on 2026-09-07 (earlier
attempts reported otherwise); PaddleOCR fetched its detection/recognition
models on first use.

## 9. Candidate identity under replay (why the Phase 10B-30 retry created `f967d4fe…` instead of reusing an earlier candidate)

Mechanism, traced through code and pinned by
`parser-run-output-hash-vs-identity.spec.ts`:

`DefaultParserHandoffAdapter` sets `executionId = phase10b1-bridge-<sourceDocumentId>-<random 8 hex>` →
`ParserRouterV1Service` sets each parser job's `jobId = <executionId>-<engine>-<ordinal>` →
the Python runtime's result `contentSha256` hashes the whole result except
itself and `metrics.durationMillis`, so it covers `jobId` →
`parserRuns[].outputArtifactSha256 = result.contentSha256` →
`computeArtifactContentSha256` covers `parserRuns` → `artifactId` /
`extractionArtifactSha256` → `CandidateIdentityV1` → `computeCandidateId`
and the 10-column unique key `budget_v1_candidate_identity_key`.

Contract as implemented and documented: candidate/run rows are
content-addressed and idempotent per identity — an identical identity is
never persisted twice (`findTerminalRunByIdentity`,
`persistCompletedVerification` return the existing terminal run) — and a
different identity is a NEW append-only candidate; the governed replay verb
explicitly states that a later drain "naturally produces a brand-new
`BudgetExtractionCandidateV1` … nothing here deletes, updates, or supersedes
the old one" (10B-28R packet, `defense-budget-ingestion-outbox-replay-v1.ts`
header). The canonical PARSER-RUN identity (`parserRunIdV1`, Phase 10B-25)
deliberately excludes `jobId`; only the OUTPUT content hash carries it.

Why the two observations differ: within one shared parser-artifact root the
`reuseOrCreate` cache returns the first run's persisted result for the same
canonical parser-run identity, so a second execution replays the first run's
bytes (same `jobId` inside) and the candidate is reused — the same-process
idempotency test in the integration spec sees one candidate. Two separate
drain containers start with an empty `/tmp` root, so each fresh parse mints
a new `jobId`, a new output hash, a new artifact hash, and a new candidate.
The 10B-30 retry also carried a different manifest hash (fy-tag translation,
10B-28R) and — after this repair — will carry a different one again
(`component=ARMY`, `expectedSourceKey`), each of which is a new identity on
its own.

Classification: **not a duplicate-association defect.** The unique key
holds, every FK is `onDelete: Restrict`, rejected history is preserved
append-only, and the same identity is never duplicated. What IS true, and
was not stated in prior docs: the artifact content hash is not a pure
function of (source bytes, engine, version, config, pages), because the
run-specific `jobId` is hashed into the parser output; so "idempotent
replay" of byte-identical source through fresh containers dedupes only when
the parser-artifact root is shared, never across containers. That is a
design property worth an explicit decision (stable output hash vs.
run-traceable output) but it is outside this repair and unchanged here.

## 10. Operational side effects across this repair's stages (cumulative, all read-only or local-disposable)

- One registered revision (32) and one launch of the pre-existing,
  already-approved `capiro-dev-api-db-inspect` Fargate task-definition
  family, to run a SELECT-only script against the `capiro-dev` Aurora DB
  (task `arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/c57ed86d7af24b709efc82b6bcb7aa38`,
  exit 0) — earlier stage; its results were reused, not re-run.
- Version-aware S3 GetObject reads (read-only) against
  `capiro-defense-budget-extraction-artifacts-967807252336` (earlier stage)
  and ONE version-aware `GetObject` of
  `capiro-defense-budget-raw-dev-967807252336/raw/public/dod-budget/…/original.bin@QN5S2.UB7ez8f6E4xrZxYoBrtW7Nf14s`
  on 2026-09-07 (this stage; the bytes were served to the resolver from a
  local store, never from S3 again).
- Read-only `sts get-caller-identity` and `ecs describe-task-definition
  capiro-dev-defense-budget-ingestion-drain:17` (this stage).
- Earlier stage only: a standalone `aws s3api head-object` and the removed
  diagnostic's own `SdkS3ProofClient` HeadObject/GetObject against the
  already-archived raw object. This stage made no live AWS call through the
  verifier.
- Disposable local containers, each created and removed by the stage that
  used it: pgvector/pgvector:pg16 Postgres instances; minio/minio versioned
  object stores (this stage). None shared with any other session.
- Local `pnpm`/workspace builds, `prisma generate`, `tsc`, `jest`; `uv sync
  --locked --extra ocr` in `apps/defense-budget-parser` (installs
  paddleocr/paddlepaddle into the worktree's `.venv`; PaddleOCR downloaded
  its inference models on first use); a `prisma generate` and three package
  builds in a detached checkout of the base commit solely to produce the
  `tsc` baseline.
- Git commits and pushes of this branch to origin; edits to draft PR #1524's
  description.
- **No** merges, **no** ECR pushes, **no** task-definition changes to the
  drain or qualification families, **no** ECS task launched in this stage,
  **no** outbox replay or other production ingestion, **no** production DB
  writes, **no** IAM changes, **no** reference to or use of the untrusted
  image digest
  `sha256:43a79da36fbd574671bfce7a5011bb494a87b6ef2606a5a165d76aa47006c660`,
  **no** evidence deletion.

## 11. Repair commit list (this PR's head, for provenance only — do not merge a hardcoded SHA)

1. `e2ba6a167` — add `expectedSourceKey` to the manifest document contract
2. `411466541` — fix sourceKey metadata-agreement check to use `expectedSourceKey`
3. `b53649502` — propagate the authoritative `sourceKey`/`component` through the handoff
4. `8d7985b25` — persist proof findings, stop reporting misleading `'verified'`
5. `fabe48db7` — permanent regression for the SourceDocument metadata-agreement check
6. `e1fb2bf2a` — automated RED/GREEN mutation check + qualification command
7. `a493c6248` — real-canary REVIEW-profile investigation (diagnostic only; superseded and removed by commit 11)
8. `adda788a8` — fix artifact byte-vs-content SHA mismatch in `loadVerifiedArtifact`
9. `1b55f5db6` — fix manifest raw-bytes-vs-reserialized-JSON SHA mismatch in the registry
10. `56306c56c` — add production-proof repair release packet (first version)
11. onward — evidence-completion pass (2026-09-07): recovered-artifact replay harness; complete-archive regression + MinIO-provisioning rehearsal + mutation-table update; parser-run-hash-vs-identity contract spec; removal of the diagnostic script; this packet revision. Use `git log --oneline 56306c56c..HEAD` for the exact hashes.

## 12. Remaining conditions before anything downstream

- **This repair's own PR**: reviewed (independent review is a later stage,
  not performed by the author of this repair), merged, image rebuilt from
  the merge SHA, requalified per §2.
- **Qualification expectation**: REVIEW with the 611/5/467 profile and zero
  `source_metadata_mismatch`; the earlier "parser/router drift" gate is
  withdrawn (§8).
- **Parser-output durability (observation, not a gate for this repair)**:
  parser OUTPUT bytes live only in the drain task's `/tmp`; a decision's
  `parser_run_proof` cannot be re-verified after the task exits (§7). Worth
  a separate decision (persist parser outputs to the extraction-artifact
  bucket alongside the artifact); unchanged here.
- **Candidate identity across containers (observation)**: see §9; unchanged
  here.
- **Review acceptance**: unchanged from the 10B-28R packet — a hash-bound
  review decision followed by the governed accept verb, neither part of
  this packet.
- **Bundle readiness / canonical promotion**: unchanged, separate gated
  verbs; a REVIEW outcome is not ACCEPT and one reviewed R-2 member is not
  a publishable snapshot.

Rolling back this repair (reverting the merge, or rolling the task
definition back to the pre-repair digest) never undoes rows or objects
written by any run — audit history stays append-only, same as every prior
packet in this program.

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
this exact candidate is `REVIEW`, not `PASS`** — 575 real, review-severity
discrepancies (108 `page_only_reference_proof_failed` + 467
`review_omission`) already exist independently of these bugs and correctly
route the document to human review once the false REJECT is removed. This
packet does not propose or request an ACCEPT.

Do not read a ten-row outbox as the defense-budget corpus: the outbox holds
10 rows total; this packet touches one.

## 2. Repair PR and what must happen before any production change

| Item | Value |
|---|---|
| Repair branch | `fix/phase10b31-production-proof-repair` |
| Repair worktree | `C:\dev\capiro-p10b31-repair` |
| Base / merge-base | `8c4735e6bb31a0d920a9ff508f165866c0be5454` — confirmed an ancestor of `origin/main`; `origin/main` was exactly 1 commit ahead at packet time (`93f0dbd09`, outreach/engagement files only, zero overlap) |
| Repair head to merge | **Do not hardcode a SHA from this document.** Merge the current head of this PR as reported by `gh pr view <PR#> --json headRefOid`, having confirmed it is the head the latest independent review actually inspected. At the time of writing the branch carries 9 commits (see §9 for the exact list and hashes) across 4 logical groups: manifest-contract → resolver fix → end-to-end propagation → evidence-durability → permanent regression + qualification command → real-canary diagnostic → two hash-boundary fixes. |
| Prior related fix | PR #1486 → `b938b7b1f5dc13fc1dadfb2e704337f2c3b654f8` (cycle-ID fy-tag translation, a different metadata-agreement defect on the same path) |
| This repair's own PR | draft, not yet merged (see `pr_url`/`pr_number` in the handoff to the next stage) |

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
   `capiro-dev-defense-budget-ingestion-drain:16`,
   `sha256:cafeccb9403795437f8c2bb7c7b01c004156922d3ad8f655cbe4f89340fc989c`).
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
     review-severity discrepancies still visible.
   - **Known, separately-documented parser/router drift** (see §7): the
     live real-canary diagnostic run in this repair's own evidence found
     590 assertions / 505 total omissions (466 `ambiguous_layout` +
     39 additional BLOCKING: 38 `missing_evidence` + 1 `missing_value`)
     against this repair's code, versus 611 assertions / 467 omissions at
     the PR #1486 baseline — reproduced independently by an already-existing,
     already-passing test this repair did not meaningfully touch
     (`r2-production-path-no-override.spec.ts`, 1-line unrelated change).
     This is parser/router output drift, **not** a defect in this repair,
     but it means the qualification run's own decision may land REJECT
     (via a completeness-check failure) rather than REVIEW for reasons
     entirely outside source-document metadata agreement. Investigate and
     resolve (or explicitly accept) this drift as part of qualification,
     not as part of this repair.

## 3. Production baseline (read-only, unchanged by this repair, last verified 2026-09-06/07)

Task definition `capiro-dev-defense-budget-ingestion-drain:16` (ACTIVE,
latest; zero RUNNING or STOPPED tasks in the family at last check) is
unchanged by this packet — no task definition, image, or IAM change has
been made. See the Phase 10B-28R packet
(`docs/defense-budget/PHASE-10B28R-CONTROLLED-DRAIN-PACKET.md`, section 3)
for the full field-by-field baseline; nothing in this repair alters it.

## 4. The exact target row and its identities (read-only, unchanged by this repair)

| Identity | Value |
|---|---|
| Outbox row | `f57a3419-3d7b-404e-92e4-4932f5e3f524` — `state=dead_letter`, `governedDisposition=verification_rejected`, `verifierDecision=REJECT` |
| Observation | `85d62283-7dc3-4c1c-9401-2e10eb577dae` |
| Raw lifecycle cycle | `cff02efd-45e7-4ae4-8f7f-dacd12bdb84c` (FY2024, `request`, status `draft`) |
| SourceDocument | `a99fbf5b-5eb4-45f3-87e4-96c40c2c0bb0`, `source_key=defense-budget-observation-cf5b34c86b34b7e75d9c5be7d18f4dc5a8bbea08aec23611bc2020efce6f74c4`, component `ARMY`, document_type `r2`, `sha256=1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6` |
| Candidate / run under investigation | `f967d4fe-0420-5d6e-843e-7dcb84935252` / `1ea40d2d-22c5-55de-a31a-136501b374f9` |
| Extraction artifact | `s3://capiro-dev-defense-budget-extraction-artifacts-967807252336/phase10/parser-artifacts/739557f6d7df9101694633ecd39a45d0c1d1a75048b7408e24b54616253fce64`, VersionId `31SvqjxLDA6qU.VKzCJCzv5.8mZOtqU.`, byte SHA confirmed |

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
| 7 | Permanent regression + automated mutation-sensitivity check | `verification/persistence/lifecycle-bridge-source-metadata-agreement.integration.spec.ts`, `scripts/verify-pe-budget-phase-10b31-metadata-regression.ts`, `scripts/phase10b31-metadata-regression-rehearsal.sh`, `apps/api/package.json` | New qualification command (`verify:pe-budget-phase-10b31[:db]`), see §6. |
| 8 | Real-canary diagnostic (not a CI gate) | `apps/api/scripts/phase10b31-real-canary-review-profile.ts` | Confirms the fix against the real production canary PDF; documents the separate parser/router drift finding (§7 below) directly in its own header. |

### Metadata field mapping (authoritative → bridge input → adapter arg → manifest field → comparison rule → test coverage)

| Field | Authoritative source | Bridge input (`ParserHandoffInput`) | Adapter argument to `runParserHandoffForSourceDocument` | Manifest document field | Comparison rule in `CompositeProofResolver` | Test coverage |
|---|---|---|---|---|---|---|
| `component` | `SourceDocument.component` (persisted; first-time via `DocumentRegistrar.register()` return, replay via `StoredSourceDocumentArchiveRecord`) | `component: string \| null` (new, required key, null legitimate) | `component: toBudgetComponentOrThrow(input.component)` → `BudgetComponentV1 \| undefined` | `manifestDocument.component` (was always `'UNKNOWN'` when absent; now the real value) | `row.component !== manifestDocument.component` → blocking `source_metadata_mismatch` | `default-parser-handoff.adapter.spec.ts` (12 valid components + null + fail-closed invalid); `observation-ingestion-bridge.spec.ts` (NAVY + null, first-time AND replay); `trusted-proof.spec.ts` (resolver-level, pre-existing coverage now exercised with a real non-UNKNOWN value) |
| `sourceKey` | `SourceDocument.sourceKey` (persisted once at registration, pure function of `observation.dedupKey`) | `sourceKey: string` (new, required, never defaulted) | `sourceKey: input.sourceKey` → manifest document's new `expectedSourceKey` | `manifestDocument.expectedSourceKey` (new, optional) | `row.sourceKey !== (manifestDocument.expectedSourceKey ?? manifestDocument.sourceLocator)` → blocking `source_metadata_mismatch` | `budget-cycle-manifest-v1.spec.ts` (contract-level, 3 new cases); `trusted-proof.spec.ts` (3 new resolver-level cases: match, mismatch, absent-field fallback); `lifecycle-bridge-source-metadata-agreement.integration.spec.ts` (real end-to-end, real Postgres) |
| `fiscalYear` / `budgetCycle` / `documentType` | Same input on both sides via `routingForSourceFamily` (pure function) | unchanged | unchanged | unchanged | unchanged — already agreed structurally, not coincidentally | Unchanged; confirmed by tracing, not modified |
| `extraction_artifact_sha256` (hash issue #1) | `resolution.extractionArtifactContentSha256` (canonical content hash) | n/a | n/a | n/a | `PrismaMaterializationArtifactSourceV1.loadVerifiedArtifact`: now recomputes content hash from reloaded artifact instead of raw byte hash | `prisma-materialization-artifact-source-v1.spec.ts` (positive control + 2 negative controls: tampered payload, old buggy byte-hash value) |
| `manifest_content_sha256` (hash issue #2) | Raw manifest bytes hash (`sha256Hex`), set at verification time | n/a | n/a | n/a | `PrismaCycleManifestRegistryV1.register()`: now hashes raw bytes directly instead of `JSON.stringify(parsed)` | `prisma-cycle-manifest-registry-v1.spec.ts` (positive + negative controls) |

## 6. Qualification command and its limitations

```
pnpm --filter @capiro/api run verify:pe-budget-phase-10b31       # fast: jest GREEN + RED/GREEN mutation-sensitivity script, needs an already-running local Postgres
pnpm --filter @capiro/api run verify:pe-budget-phase-10b31:db    # self-contained: provisions its own disposable pgvector/pgvector:pg16 container, migrates both schemas, runs the above, always removes the container
```

Limitations (documented, not hidden):

- Every scenario in the permanent regression carries **no archive fields**
  on its `SourceDocument` row (a real, legitimately-supported "no archive"
  case). Because R-2/rdte's `VerificationPolicyV1` requires an immutable
  archive, `ArchiveProofResolver` always contributes a blocking
  `archive_version_missing` finding in every scenario, so the regression's
  own overall `decision` is REJECT in all 9 cases — this is unrelated to
  the metadata fix and is asserted around, not hidden. The actual signal
  read from each scenario is the specific `source_metadata_mismatch`
  finding code/message (or its absence), not the overall decision.
- The regression makes zero AWS calls and zero production-database calls;
  it is not a substitute for the real-canary diagnostic (§7) or for live
  qualification against the actual production archive object.
- The mutation-sensitivity script reverts 9 named source files to their
  exact pre-fix content at baseline `8c4735e6b` and requires 7 of the 9
  regression tests to fail and 2 to stay green; if the file list in that
  script drifts from a future change to this area, the script's own
  internal assertion (not just "tests pass") will fail loudly rather than
  silently stop proving anything.
- `verify:pe-budget-phase-10b31:db` requires Docker and (only if the
  real-canary diagnostic script is also run) `apps/defense-budget-parser`
  pre-synced with `uv sync --locked`.

## 7. Known, separately-documented drift (not this repair's defect, must be resolved or accepted before qualification)

The real-canary diagnostic (`apps/api/scripts/phase10b31-real-canary-review-profile.ts`)
ran the real, byte-identical production canary PDF
(`apps/api/src/defense-budget/rdte/cycle/__fixtures__/production-fy2024-army-r2-vol1-ba1-official.pdf`,
sha256-confirmed identical to the real production archive object) through
the fixed adapter end-to-end, including one genuine, read-only S3
HeadObject/GetObject against the real, already-archived, Object-Lock-protected
raw object (see §8, operational side effects). Result: the metadata-agreement
fix is proven fully correct (`proof_findings` empty, manifest/source_document/
extraction_artifact/archive proofs ALL `verified`) — but overall decision is
still REJECT, not REVIEW, because completeness now fails: 590 assertions
(vs 611 at the PR #1486 baseline), 466 `ambiguous_layout` omissions plus 39
additional BLOCKING omissions (38 `missing_evidence` + 1 `missing_value`),
where the baseline had 467 total omissions, all review-grade.

This is independently reproduced by an already-existing, already-passing
test this repair did not meaningfully touch
(`src/defense-budget/rdte/cycle/r2-production-path-no-override.spec.ts`,
one unrelated 1-line `sourceKey` addition), which returns the identical
590/505 profile and the identical, exactly-correct PE 0601102A FY2024
$296.67M value — proving the parser/router codebase's output for this
exact PDF has genuinely drifted since the PR #1486 baseline was captured,
for reasons entirely outside source-document metadata agreement.

**This must be investigated and either resolved or explicitly risk-accepted
as part of qualification (§2 step 5) before any production retry of this
row — it is not fixed by, and is out of scope for, this repair.**

## 8. Operational side effects across this repair's stages (cumulative, all read-only or local-disposable)

- One registered revision (32) and one launch of the pre-existing,
  already-approved `capiro-dev-api-db-inspect` Fargate task-definition
  family, to run a SELECT-only script against the `capiro-dev` Aurora DB
  (task `arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/c57ed86d7af24b709efc82b6bcb7aa38`,
  exit 0). Recorded as an operational side effect per the mission's
  reporting bar even though the SQL was pure SELECT — launching an ECS
  task is itself a side effect distinct from a read-only AWS API call.
- Version-aware S3 GetObject reads (read-only) against
  `capiro-dev-defense-budget-extraction-artifacts-967807252336`.
- One class of live, read-only AWS call made twice: a standalone
  `aws s3api head-object --profile capiro-dev` sanity check, and the real
  adapter's own `SdkS3ProofClient` HeadObject+GetObject inside the
  real-canary diagnostic script — both against an object already durably
  archived (Object Lock GOVERNANCE, retained until 2033) by a prior,
  separately authorized ingestion run.
- Multiple disposable local Postgres containers (pgvector/pgvector:pg16),
  each created and removed by the stage that used it; none shared across
  stages or with any other session on this machine.
- Local `pnpm install`, workspace package builds, `prisma generate`,
  `tsc`, and `jest` runs; no new package installs beyond what the lockfile
  already specified.
- Nine git commits and pushes of this branch to origin.
- **No** merges, **no** ECR pushes, **no** task-definition changes to the
  drain or qualification families, **no** outbox replay or other
  production ingestion, **no** production DB writes, **no** IAM changes,
  **no** reference to or use of the untrusted image digest
  `sha256:43a79da36fbd574671bfce7a5011bb494a87b6ef2606a5a165d76aa47006c660`,
  **no** evidence deletion.

## 9. Repair commit list (this PR's head, for provenance only — do not merge a hardcoded SHA)

1. `e2ba6a167` — add `expectedSourceKey` to the manifest document contract
2. `411466541` — fix sourceKey metadata-agreement check to use `expectedSourceKey`
3. `b53649502` — propagate the authoritative `sourceKey`/`component` through the handoff
4. `8d7985b25` — persist proof findings, stop reporting misleading `'verified'`
5. `fabe48db7` — permanent regression for the SourceDocument metadata-agreement check
6. `e1fb2bf2a` — automated RED/GREEN mutation check + qualification command
7. `a493c6248` — real-canary REVIEW-profile investigation (diagnostic only)
8. `adda788a8` — fix artifact byte-vs-content SHA mismatch in `loadVerifiedArtifact`
9. `1b55f5db6` — fix manifest raw-bytes-vs-reserialized-JSON SHA mismatch in the registry

## 10. Remaining conditions before anything downstream

- **This repair's own PR**: reviewed (independent review is a later stage,
  not performed by the author of this repair), merged, image rebuilt from
  the merge SHA, requalified per §2.
- **Parser/router drift (§7)**: investigated and resolved or explicitly
  risk-accepted — this repair does not touch the parser/router and cannot
  fix a completeness regression that lives there.
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

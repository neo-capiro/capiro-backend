# Phase 10B-28R — Controlled-drain execution packet (FY2024 Army R-2 canary)

Status: **PLAN ONLY — nothing in this packet has been executed against production.**
Prepared 2026-09-06 from read-only inspection of `capiro-dev` (account
`967807252336`, `us-east-1`) plus the repair branch
`fix/phase10b28r-startup-and-cycle-identity`. Every production write below is a
future, separately authorized step. Executing any of it requires: the repair PR
merged, a NEW drain image built from the merge SHA and qualified (section 2),
and an explicit operator go-ahead for each of: task-definition registration,
outbox replay, drain run.

## 1. What this packet is for

One governed retry of exactly one document: the FY2024 Army RDT&E R-2/R-2A
volume (Budget Activity 1) that the production drain rejected on 2026-09-02
solely because of the false blocking `manifest_sha_mismatch` cycle-ID finding
(fixed in PR #1486, merged `b938b7b1f5dc13fc1dadfb2e704337f2c3b654f8`). The
expected outcome of the retry is **REVIEW**, not PASS. A REVIEW outcome does
not accept the extraction, does not advance readiness, and does not publish any
budget data. It only replaces the false REJECT with the truthful governed
review disposition so the human review workflow can start.

Do not read a ten-row outbox as the defense-budget corpus: the outbox holds
exactly 10 rows (2 `dead_letter` governed-source rows, 8 `pending` rows of
which 6 are alternative-funding jobs), and this packet touches one row.

## 2. Repair PR and the release steps that must precede any production change

| Item | Value |
|---|---|
| Repair branch | `fix/phase10b28r-startup-and-cycle-identity` |
| Reviewed repair head | `0bb4a4b97a8f195fcb4f89f6991c83e6d07000ed` (base `05e0115a371a5a23f3c945a4ac6cb1a2a9998a09` = `origin/main` at cut and at packet time) |
| Prior merged fix | PR #1486 → `b938b7b1f5dc13fc1dadfb2e704337f2c3b654f8` (cycle-ID fy-tag translation) |
| Currently qualified 10B-28 drain image | `sha256:43d74221e84233f88b72fa19589a857167a4ed2c390bea2d5e1a6bf6f8bf407a` — **must NOT be deployed**: its launcher still requires PyPI at task start |
| Local proof image (this session, NOT pushed, never to be deployed) | `p10b28r-proof-drain:0bb4a4b97a8f195fcb4f89f6991c83e6d07000ed`, image id `sha256:6e7a3387ca13e8f2a71358f5c22ba46cbdd9510ea8a5b82215a7d9d1d9db3a9b`, linux/arm64, 746,324,689 B, built 2026-09-06T22:11–22:16Z with `--no-cache` FROM the 10B-28 stage-one digest `d55e3fe2…` (clean tree at the repair head); image ENV carries `UV_NO_SYNC=1` and `UV_OFFLINE=1`. Built only to prove the launcher contract locally; the release image must be rebuilt from the MERGE SHA (both stages) and qualified. |

Post-merge sequence (all gated, none executed here):

1. Merge the repair PR (normal merge commit, exact reviewed head).
2. Build stage one (`apps/api/Dockerfile`, linux/arm64) from the MERGE SHA, push
   with a `*attested-source*` tag; build stage two
   (`apps/api/Dockerfile.defense-budget-ingestion-drain`, `--no-cache`, FROM the
   stage-one digest), push with a `*ingestion-drain*` tag (ECR lifecycle policy
   only protects `*ingestion-drain*` / `*attested-source*` tags beyond "keep last 5").
   Record both immutable digests; require all nine model checksum gates.
3. Run `apps/api/scripts/verify-defense-budget-drain-offline-startup.sh` against the
   pushed drain digest (native ARM64 preferred; QEMU acceptable for the gate,
   ~5 min per OCR page). It must print `OFFLINE_STARTUP_GATE=PASS`. This is the
   new mandatory release gate; the 10B-28 image fails it.
4. CycloneDX SBOM + Trivy for both images; compare package/advisory identities with
   the 10B-28 baseline (API 7 critical / 127 high; drain 10 critical / 174 high,
   all inherited from the Debian 12 base and python3/libgl layer; the three
   overlay criticals libsqlite3 CVE-2025-7458, libglib2.0 CVE-2026-58016, libxml2
   CVE-2026-6653 have no Debian fix). The repair changes no packages; any new
   finding is DB drift or a base-image change and must be explained, not counted.
   An operator risk decision on the inherited criticals is still open and is not
   made by this packet.
5. Two independent native ARM64 qualification runs on the ISOLATED family
   `capiro-dev-defense-budget-qualification` (register a new revision from `:18`
   changing ONLY the image digest and, if the driver changes, the audited driver
   env), real FY2024 Army source, real cycle UUID
   `cff02efd-45e7-4ae4-8f7f-dacd12bdb84c`. Acceptance is the 10B-28 profile:
   decision REVIEW, 0 blocking proof findings, all parser runs verified,
   5 PE identities, PE 0601102A FY2024 = 296.67M, review-grade omissions
   visible (467 last time; explain any delta from evidence), semantic
   equality between runs after stripping the 4 run-label-derived hashes.
   Additionally verify in the qualification artifact that the verifier result's
   `cycleId` is the raw lifecycle UUID (not `fy2024:…`) — that is the 10B-28R
   change reaching the real handoff.

## 3. Production baseline (read-only, verified 2026-09-06 ≈22:00Z)

Task definition `capiro-dev-defense-budget-ingestion-drain:16` (ACTIVE, latest;
zero RUNNING or STOPPED tasks in the family at verification time):

| Field | Value |
|---|---|
| image | `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:cafeccb9403795437f8c2bb7c7b01c004156922d3ad8f655cbe4f89340fc989c` (tag `87a58551382fec9eded1d2f94f32b5379d274cb2-phase10b22-ingestion-drain`) |
| cpu / memory | 1024 / 2048, `runtimePlatform` ARM64 / LINUX |
| command | `["drain-defense-budget-ingestion-outbox-v1"]` (entrypoint from the image: `dumb-init -- entrypoint.sh`) |
| environment (11) | `UV_PROJECT=/defense-budget-parser`, `XDG_CACHE_HOME=/tmp`, `DEFENSE_BUDGET_RAW_KMS_KEY_ARN=arn:aws:kms:us-east-1:967807252336:key/29f4399d-4a5c-449e-b28d-29a7e71b8970`, `DEFENSE_BUDGET_RAW_BUCKET=capiro-defense-budget-raw-dev-967807252336`, `DB_NAME=capiro`, `BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET=capiro-dev-defense-budget-extraction-artifacts-967807252336`, `NODE_ENV=development`, `DEFENSE_BUDGET_PARSER_PROJECT_DIR=/defense-budget-parser`, `BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_PREFIX=phase10/parser-artifacts`, `BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT=/tmp/defense-budget-parser-scratch`, `UV_CACHE_DIR=/tmp/uv-cache` |
| secrets (4) | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` |
| task role | `Capiro-dev-DefenseBudgetO-IngestionDrainWorkerTaskR-O4ZFa1lfdpOg` |
| execution role | `Capiro-dev-DefenseBudgetO-IngestionDrainWorkerTaskD-y1o5xEJWiwqf` |

Proposed revision `:17` (register only after section 2 completes; do NOT
`update-service` — this family is a one-shot task, not a service):

- `containerDefinitions[0].image` → the NEW post-merge drain digest (from step 2).
- `containerDefinitions[0].environment` += `UV_NO_SYNC=1`, `UV_OFFLINE=1`
  (recommended: restates the image ENV explicitly next to the other `UV_*`
  values the task already restates; the image alone already enforces both).
- Every other field byte-identical to `:16` (diff the two JSON documents
  field-by-field before registering; keep `:16` for rollback).

Rolling back a task definition never undoes rows or objects written by a run
(section 6).

## 4. The exact target row and its identities (read-only inventory, last observed 2026-09-06 18:45Z)

| Identity | Value |
|---|---|
| Outbox row | `f57a3419-3d7b-404e-92e4-4932f5e3f524` — `state=dead_letter`, `attempts=0`, `leased_by=null`, `job_kind=governed_source_ingestion`, `metadata_jsonb = {governedDisposition: verification_rejected, verifierDecision: REJECT, sourceDocumentId: a99fbf5b-…}`, `last_error = "verification deterministically rejected (artifact: s3://capiro-dev-defense-budget-extraction-artifacts-967807252336/phase10/parser-artifacts/193386bb…?versionId=vIfVbPc1sFZjp9fxA73_V3qOggU2TAJp)"` |
| Observation | `85d62283-7dc3-4c1c-9401-2e10eb577dae` — `observation_state=ingested`, adapter `army-budget`, `classified_fiscal_year=2024`, `classified_authority_track=request`, `classified_source_family=pb_r2`, operator-attested import (asafm.army.mil returns Akamai 403 to automation) |
| Raw lifecycle cycle | `cff02efd-45e7-4ae4-8f7f-dacd12bdb84c` (`defense_budget_cycle`, FY2024, `request`, status `draft`) |
| SourceDocument | `a99fbf5b-5eb4-45f3-87e4-96c40c2c0bb0`, `source_key=defense-budget-observation-cf5b34c86b34b7e75d9c5be7d18f4dc5a8bbea08aec23611bc2020efce6f74c4`, component ARMY, document_type r2, `sha256=1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6`, 7,227,604 bytes |
| Archive object | `s3://capiro-defense-budget-raw-dev-967807252336/raw/public/dod-budget/fiscal_year=2024/source_authority=dod-comptroller/family=rdte/document_id=defense-budget-observation-cf5b34c8…/sha256=1fb74021…/original.bin`, version `QN5S2.UB7ez8f6E4xrZxYoBrtW7Nf14s`, 7,227,604 bytes, SSE-KMS, Object Lock GOVERNANCE until 2033-09-01 (head-object verified 2026-09-06) |
| Proof-manifest identity after 10B-27 | `fy2024:cff02efd-45e7-4ae4-8f7f-dacd12bdb84c` (proof-facing only) |
| Candidate identity after 10B-28R | `budget_extraction_candidate_v1.cycle_id = cff02efd-45e7-4ae4-8f7f-dacd12bdb84c` (raw), manifest label recorded on the manifest proof snapshot as `cycleId`, with `candidateCycleId` = raw UUID |
| Pre-existing production candidate rows | 3 REJECT runs (2026-08-29, 09-01, 09-02) — all pre-10B-27, therefore keyed by the raw UUID; the retry creates a NEW candidate (different manifest hash), never rewrites them |

Re-verify every value above with a read-only probe immediately before execution;
the 18:45Z probe is the last observation, not a guarantee.

### 4a. Eligibility for the supported retry path (from code, `apps/api/scripts/replay-defense-budget-ingestion-outbox-v1.ts` + `governed-replay/defense-budget-ingestion-outbox-replay-v1.ts`)

The only supported way to retry a dead-letter row is the governed replay verb.
Its eligibility predicate is exactly: `state='dead_letter'` AND `leased_by IS
NULL` AND `metadata_jsonb->>'governedDisposition'='verification_rejected'` AND
`metadata_jsonb->>'verifierDecision'='REJECT'`. Row `f57a3419…` satisfies all
four (as last observed). After a REVIEW outcome the row will carry
`governedDisposition=review_required` / `verifierDecision=REVIEW` and is **no
longer replay-eligible by construction** — a second replay of the same row
fails closed without a code change.

## 5. Commands (in order; each with its own go-ahead)

All run as one-off Fargate tasks in cluster `capiro-dev` from the drain task
definition (`:17`, section 3) using `--overrides` on `command` only. Step 5.1 is
read-only and is the only step that may run before the image is qualified.

5.1 Dry run of the replay (READ-ONLY: one `SELECT`; the script issues no UPDATE
without `--commit --confirm dev`):

```text
replay-defense-budget-ingestion-outbox-v1 --environment dev --outbox-row-id f57a3419-3d7b-404e-92e4-4932f5e3f524 --reason "Phase 10B-28R: retry after false cycle-ID blocking finding (PR #1486) and offline-startup repair" --actor "<operator identity>"
```

Expected output: `phase: preview` with the row target, then `dry_run_result`
`wouldMutate: true` and `wouldChange = {state: pending, leasedBy: null,
leasedUntil: null, lastError: null, metadataJsonb: "governedDisposition/
verifierDecision removed from top level; appended to replayHistory[]",
attempts: 0}`. **Not executed in this session** (running a cloud task was not
authorized); the write behavior stated here is read from the code.

5.2 Commit the replay (WRITE: exactly one `UPDATE` of one row):

```text
replay-defense-budget-ingestion-outbox-v1 --environment dev --outbox-row-id f57a3419-3d7b-404e-92e4-4932f5e3f524 --reason "<same>" --actor "<same>" --commit --confirm dev
```

Effect: row → `state=pending`, `available_at` now, `last_error=NULL`,
`governedDisposition`/`verifierDecision` moved into `metadata_jsonb.replayHistory[]`
(append-only), `attempts` unchanged (0).

5.3 Governed single-row drain (WRITES listed in section 6):

```text
drain-defense-budget-ingestion-outbox-v1 --environment dev --outbox-row-id f57a3419-3d7b-404e-92e4-4932f5e3f524 --lease-owner phase10b28r-canary-<date>
```

Single-row mode claims exactly this row (`ingestionOutboxClaimByIdSqlV1`,
`state IN ('pending','failed') AND available_at <= now`), runs the bridge +
handoff + verifier, records the governed disposition, and — because REVIEW is
not `ingestionSucceeded` — **skips readiness entirely** and skips the
readiness catch-up sweep (single-row mode never touches other rows).

## 6. Expected writes from one authorized run of 5.2 + 5.3

Database (all via the existing governed code paths; no ad-hoc SQL):

| Table | Change |
|---|---|
| `defense_budget_ingestion_outbox` | the one row: dead_letter → pending (5.2) → leased → **dead_letter** with `governedDisposition=review_required`, `verifierDecision=REVIEW`, `sourceDocumentId`, `last_error="verification requires human review (artifact: s3://…)"`, `leased_by/until=NULL`; `attempts` unchanged; `replayHistory[]` +1 |
| `source_document` | no new row (observation already `ingested`; bridge reuses the archived object) — verify in the run log |
| `document_parse_job` | idempotent upserts for the parser runs (2 pdfplumber + 1 paddleocr identities last time); rows keyed by `(source_document_id, input_sha256, provider, page_start, page_end)` |
| `budget_extraction_candidate_v1` | **+1** row, `cycle_id = cff02efd-…` (raw), `status=NEEDS_REVIEW`, `family=rdte`, `extraction_method=paddleocr` |
| `budget_verification_run_v1` | +1 (decision REVIEW, status NEEDS_REVIEW, route human_review, riskScore 100 expected) |
| `budget_verification_check_v1` / `budget_verification_discrepancy_v1` / `budget_verification_proof` | +checks (≈9 codes), +575 discrepancies (108 page-only + 467 review omissions last time), +4 proof snapshots (manifest — now carrying `candidateCycleId` —, extraction_artifact, source_document, archive) |
| everything else (cycles, expected sources, observations, review decisions, projection plans, promotion tables, canonical tables) | **unchanged** |

S3: one new object version under
`s3://capiro-dev-defense-budget-extraction-artifacts-967807252336/phase10/parser-artifacts/`
(the composed extraction artifact, content-addressed key); no write to the raw
archive bucket (Object Lock GOVERNANCE, read only).

No readiness, eligibility, plan, authorization, canonical, or snapshot write
occurs on a REVIEW outcome.

## 7. Expected verifier outcome and what REVIEW means

Expected: `decision=REVIEW`, `finalState=TERMINAL_REVIEW`, zero proof findings,
three parser runs `proofStatus=verified`, 611 assertions / 5 identities /
467 review-grade `ambiguous_layout` omissions / 575 review discrepancies
(the 10B-28 native-ARM64 profile, twice). Deltas are acceptable only when
explained from source evidence and code (never forced).

REVIEW is an intermediate governed outcome: the review-grade omissions stay
visible, completeness and money checks stay `NOT_RUN`, and nothing is
accepted. The next lawful step is a human review decision, which is out of
scope for this canary.

## 8. Recovery (preserves immutable audit history; prevents a second unintended replay)

- Task fails before claiming: nothing written. Re-run 5.3 after confirming the
  row is still `pending`.
- Task dies after claiming (row `leased`): the lease expires
  (`OUTBOX_PROCESSING_LEASE_MS_V1`); the row becomes claimable again. Persisted
  candidate/run/proof rows are content-addressed and idempotent — an exact
  replay returns the existing terminal run instead of duplicating evidence.
- Wrong decision or unexpected outcome: do NOT edit rows. The row lands
  `dead_letter` with a truthful disposition; `review_required` rows are not
  replay-eligible, so the replay verb cannot be re-used to loop; `retries_exhausted`
  poison rows are likewise excluded. Escalate with the run log, the
  `execution-report.json` and the artifact locator.
- Rolling back the task definition (`:17` → `:16`) changes only future task
  launches; it does not undo any row or object above. History stays append-only.
- Never run batch mode (`--batch-size`) for this canary; it would claim other
  pending rows.

## 9. Remaining conditions before anything downstream

- **Review acceptance**: a hash-bound review decision
  (`review-defense-budget-verification-v1 … --decision accept --commit`,
  reviewer ≠ extractor) followed by
  `accept-defense-budget-ingestion-review-v1 --outbox-row-id … --review-decision-id … --commit --confirm dev`
  (eligible only for `review_required`/REVIEW rows). Neither is part of this canary.
- **Bundle readiness**: the standing plan requires the ten-member Army RDT&E
  bundle and a REGISTERED governed manifest whose content hash equals the
  candidate's; R-2 funding stays contextual where designed. Two pre-existing
  defects block materialization even after acceptance and must be fixed first:
  (a) `PrismaMaterializationArtifactSourceV1.loadVerifiedArtifact` compares the
  artifact FILE byte SHA to `extraction_artifact_sha256`, which the verifier
  stores as the CONTENT SHA (real canary: byte `9a088be0…` vs content
  `95433cc2…`), so reload is refused fail-closed; (b) the manifest registry
  hashes `JSON.stringify(parsed)` while the proof resolver hashes the manifest
  file bytes, so a pretty-printed bridge manifest can never match a registered
  copy. Both are documented, not changed, by 10B-28R.
- **Canonical promotion**: Phase 7 eligibility, authorization, and execution
  remain separate, gated verbs; REVIEW is not ACCEPT and one accepted R-2
  member is not a publishable snapshot.

## 10. Evidence index (this session)

<<FILL: evidence index — offline gate result, full jest, tsc, independent review, proof image>>

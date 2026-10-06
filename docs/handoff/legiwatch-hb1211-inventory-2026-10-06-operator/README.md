# HB1211 dataset inventory operator — review candidate

Status: implementation and 23 local tests passed. Four real-PostgreSQL tests are supplied and MUST pass in the native disposable-database gate before production use. Local Docker daemon is unavailable. No preparation, ECS launch, provider request, quota reservation or database write has been executed by this operator.

Version only runtime.cjs, operator.cjs, operator.test.cjs, runtime.test.cjs, postgres.test.cjs and this README under docs/handoff/legiwatch-hb1211-inventory-2026-10-06-operator/. Keep prepared definitions, real qualification documents, owner snapshots and execution receipts private. Do not version raw production task definitions or inherited secret references.

## Exact qualification

There is no default source or image. The operator requires explicit HB1211_REVIEWED_SOURCE_SHA matching the reviewed standard qualification sourceSha. It obtains the immutable image only from that qualified artifact and injects HB1211_DATASET_SOURCE_SHA and HB1211_DATASET_IMAGE. Runtime requires GIT_SHA and RELEASE_SHA to match the injected binding; every preview/candidate/apply plan includes both exact source and image. Operator uses the standard meri-release-policy validateQualification, exact ECR source tag, completed healthy serving deployment, and source identity. It inherits the existing enabled hourly bill owner's configuration. No schedule, source permission, role, secret or budget setting changes.

From apps/api in the native gate, set HB1211_REPO_ROOT to the absolute repository root and HB1211_TEST_API_ROOT to the absolute apps/api path. Existing fixture must set LEGIWATCH_PHASE7_TEST_DATABASE=disposable and DATABASE_URL to its localhost PostgreSQL endpoint. Run:

    node --import tsx --test ../../docs/handoff/legiwatch-hb1211-inventory-2026-10-06-operator/operator.test.cjs ../../docs/handoff/legiwatch-hb1211-inventory-2026-10-06-operator/runtime.test.cjs ../../docs/handoff/legiwatch-hb1211-inventory-2026-10-06-operator/postgres.test.cjs

Before creating temporary fixtures, PostgreSQL qualification reads the actual migrated public schema using runtime.snapshot, asserts all12 privilege checks, and validates the additional archive/receipt/document columns with SELECT-only queries. The tests then use connection-local temporary tables, actual SQL and the real qualified ZIP parser/facts helper. They cover JSONB key ordering, exact missing-only update, protected-trigger rollback, quota hold before provider access, and retained archive original time. Actual production role privileges are checked separately by preview. Mocks never contact LegiScan.

## Review and execution stages

1. Only after gate approval, set HB1211_REVIEWED_SOURCE_SHA to the explicitly reviewed passing source and HB1211_QUALIFICATION_PATH to its reviewed API qualification.json (e.g. private quality-promotion/api/qualification.json) and HB1211_REPO_ROOT to the checkout. Run operator.cjs prepare. This performs read-only AWS checks and creates private immutable prepared files. Inspect them; it refuses to overwrite existing preparation.
2. Explicit operator review binds hash(prepared-plan.json), using runtime.cjs canonical hash, through HB1211_APPROVED_OPERATOR_HASH. Running operator.cjs preview then launches only a SELECT diagnostic and returns an exact planHash. Preview verifies all existing role privileges, canonical2068308/session2220/hash, absent inventory, no known active legacy provider worker, and eight-unit hardcap headroom. No provider call.
3. Separately review that returned preview plan. approved-retrieve-plan.json must contain its planHash and expiresAt no more than two hours ahead. operator.cjs retrieve reserves eight units atomically under the existing research-quota lock, makes at most two provider operations/four attempts each using the qualified client, validates the exact full ZIP/raw bill, retains original ZIP and immutable candidate receipt, and returns an applyPlan plus its hash. No state_bill change. Reservation is retained on failed or unknown outcomes; no operator retry/refund.
4. Review the returned exact inventory, archive hash/date/original observedAt, missing-document list and protected-row fingerprint. approved-apply-plan.json must contain planHash, candidateId and bounded expiresAt. operator.cjs apply makes no provider requests: reparses the retained hash-verified ZIP, locks/rechecks exact canonical row and protected fingerprints, updates only absent documentInventory, validates unchanged protected fields and inserts its receipt in one transaction. It never invokes hydration, getBill, generic bill writes, alerts or session-wide ingestion.
5. operator.cjs verify is SELECT-only and returns current inventory/protected identity/quota. Inspect independent DB receipt/readback as well. Do not claim corpus completeness if missingDocuments is nonempty. Whole-bill source_checked_at deliberately remains unchanged.

Every launch checks the prepared operator/runtime/qualification/baseline hashes, expires after two hours, and writes a non-replayable unknown-outcome receipt before AWS mutation. After registration, it rechecks the live owner, serving image/source and qualification before run-task. Windows process execution is hidden. Unknown outcomes must be reconciled manually; never delete a receipt to retry.

## Preserved limitations

The existing30000 hard cap remains unchanged; soft28000 still blocks getBill/document downloads. The dataset fallback is explicitly the intended cheap path beyond soft quota. Eight units are conservatively reserved for two calls with four possible attempts each. No unmeasured refunds occur.

Legacy masterlist/dataset jobs do not share the research lock. Preview and fresh reservation reject known running legacy owners, but this cannot prevent a new independent worker starting afterward. Do not describe this as a global quota lock; fresh headroom and ordinary-owner nonoverlap still require review. There are no schedule changes. Missing documents remain held by the ordinary soft budget.

A successful current dataset retrieval may contain an older provider datasetDate. Store that date separately, preserve the ZIP's first retained observedAt, and retain a distinct current retrievedAt. The bill inventory is tied only to an exact unchanged canonical provider revision. No existing retained text is used to invent a complete list.

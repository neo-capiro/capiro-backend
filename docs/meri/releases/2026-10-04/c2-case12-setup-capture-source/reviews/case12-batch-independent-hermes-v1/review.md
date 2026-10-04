# Case12 510-row native read batching review

Status: PASS_SOURCE_AND_LOCAL_NATIVE_DIFFERENTIAL_WITH_LIMITATIONS

## Scope and attribution

This was a file-only review of the frozen candidate source, frozen scalar baseline, copied canonical dependencies, and saved local differential evidence. No database, cloud, provider, journal, or source-edit operation was performed. The candidate source freeze identifies seven files and SHA-256 digests in `evidence/candidate-source-freeze.json`; the unchanged scalar helper digest matches between candidate and baseline (`8451534a…21ba22`).

The packet records the preceding real factory result as `SETUP_PASS_HYDRATION_DEFAULT_TIMEOUT_FAIL`: setup produced 510 rows, then scalar hydration hit real Prisma default-timeout P2028. That is motivation, not a candidate production/factory pass. The raw Hermes implementation timed out without a completion verdict; the supervisor disposition explicitly records subsequent corrections (production-relative imports, synchronous snapshots before awaits, and exact JS-trim-derived section JSON) and labels that implementation untested. Credit for the passing candidate differential belongs to the corrected frozen supervisor candidate and its saved tests, not to a completed raw Hermes implementation.

## Source review

### Native ownership predicates and returned evidence

The set verifier is deliberately not a general replacement for the scalar helper. It rejects anything outside this fixed Case12 shape (the named T1 tenant, standard-user context, exactly 510 unique candidate/item IDs, active approved candidates, and the fixed synthetic payload contract). Those narrower restrictions are consistent with Case12; they are not predicate weakening for a generic synthetic-memory lifecycle helper. In particular, the set path does not purport to verify revoked/superseded lifecycle variants that the scalar helper supports.

I compared the scalar helper's SQL fences with the set path:

- Candidate tenant/ID and `xmin`, approved and governed-active state, committed item and non-null Clio ID, source kind/type, approver/decision identity and timestamps, legal/instruction/confidence values, revision/lineage/supersession/duplicate/conflict fields, retention and expiry fields are preserved by the initial locked candidate query.
- The second candidate membership query retains the scalar checks for proposer/approver, marker source ID, candidate scope/client, exact payload and provenance JSON, and canonical memory class/authority/scope. Both SQL stages are bound to the supplied tenant and the submitted unique candidate set.
- The item query retains tenant and item ID, exact item `xmin`, active status/governed status, Clio slug, canonical type/title/visibility/owner/client, exact sections, source/provenance/reference, source type/ID/version/excerpt/content hash, governance fields, asserted/approved actors and approval time, legal/instruction/retention/review/conflict/expiry/confidence/sensitivity/schema/entity/aliases/tags predicates. Its sections are constructed with JS `trim()` and compared as JSON, avoiding a PostgreSQL `btrim()` approximation.
- The projection query retains tenant and exact Clio ID, key/value/source/scope/owner/client/expiry, source excerpt, and governance source ID/version. Each projection is tied to the corresponding candidate by the expected candidate ID and to the candidate's selected Clio ID.
- Candidate, item, and projection queries use row locks on the same supplied transaction. Checks reject duplicate/missing IDs and require 510 unique candidates, items, and projections. Candidate-to-item linkage is independently constrained by the committed-item predicate; projection-to-candidate linkage is independently constrained by governance source ID. Results/audits are returned in submitted entry order, not database row order.

The governance/provenance derivation uses the copied canonical `buildCanonicalGovernance` and `validateSyntheticCandidateFixtureIdentity` helpers. It preserves the scalar record mapping, marker hash, payload, source excerpt, source-content hash, canonical classification, source version, provenance fields (`save_memory`, tenant, proposer, null conversation/message IDs, excerpt), and Clio metadata excerpt/source identity. The canonical governance helper truncates the item governance excerpt in the same way as scalar; the projection continues to compare the original fixture excerpt, also as scalar does.

### Authorization, input snapshots, and locks

The new authorization-set reader snapshots context and item IDs before its first await, insists on the fixed tenant/standard-user/one-client/510-unique-ID scope, checks exact result cardinality and ID coverage, applies the same `normalizeSubject` functions and `evaluateGovernedMemoryAuthorization` with operation `read`, and uses the same wall helper and live-grant SQL (including active status, non-null future expiry, nonblank reason, newest `created_at`). It emits no denial metrics and never sets the transaction-local administrator review capability. The native owner composes this with current actor/client checks; this reader is a decision calculator, like the existing scalar evaluator, not a substitute membership check.

The ownership-set verifier deep-snapshots supplied context and entries before any awaited query. The current-owner and inventory owners also snapshot their caller inputs and native method references before asynchronous composition. The supplied transaction is passed through; there is no nested transaction, timeout override, or provider call in the candidate read path.

The SQL locks candidate rows, then matching membership/tenant, client, existing wall-access rows and permission-grant rows, then item and projection rows. The batched authorization read locks the selected item/client rows and matching existing access/grant rows before calculating policy. This protects matching rows from conflicting changes while the transaction remains open. It does **not** lock a missing access/grant row, prevent a phantom insert, or establish global serialization/rollback guarantees; no such conclusion is drawn here. Existing permission revocation and wall changes are fail-closed at the read decision and matching-row locks prevent a subsequent conflicting update/delete from passing unnoticed within this transaction. As with other paths, lock interactions with unrelated writers must be assessed in the full application; these artifacts do not prove absence of every possible cross-path deadlock.

### Current owner, fallback, and wiring

The current owner captures both optional native set ports and rejects an incomplete pair; the inventory owner does the same. When both are available it validates exact 510-row sets, maps by ID, checks candidate/item row versions and ownership, preserves ordered Case12 bindings and native eligibility observations, and continues to use the established stable-hash and current-clock paths. With neither port available, scalar fallback remains; there is no one-port partial-batch fallback. The current-owner result continues to state `captureAuthority: false`, `semanticClockQualified: false`, and `liveAcceptance: NOT_RUN`.

The Case01 factory source explicitly imports the native set verifier from its production-relative module and exposes it alongside the existing scalar verifier; the authorization instance is the normal Nest provider. The source adds a method rather than replacing scalar APIs. Saved legacy regression evidence reports 88/88 passing, including owner/auth, fallback and prerequisite checks, but this packet did not run the root native completion/capture integration or prove complete Case01/14 product-build compatibility. Do not infer those from wiring or the isolated regression log.

## Saved execution evidence reviewed

`evidence/qualification/native-differential-v1.log` records 38 passing tests and zero failures. The test source shows:

- ordered all-510 set-vs-scalar audit equality and set-vs-scalar subject/decision equality;
- 32 altered candidate/item/projection cases rejected by both scalar and set paths;
- wall change and refreshed decision within the same supplied transaction;
- reversed input preserves reversed output order, and mutation of caller inputs while the first query is paused does not substitute authority;
- one and two full current-owner reads on the same default-5-second transaction.

`native-differential-result-v1.json` records 510-row scalar parity hashes, no timeout override, 677 ms for the bulk positive ownership read, 36 ms for bulk policy evaluation, 553 ms for one current-owner read, and 1,047 ms for two reads in the same transaction. These timings are those of the saved copied-local-corpus run, not a performance guarantee. The harness states that data was copied/restored and row `xmin` values were newly observed; it explicitly says this is not the original setup authority. The test/result report `captureAuthority: false` and `liveAcceptance: NOT_RUN`.

`typecheck-overlay-v2.json` reports zero diagnostics for its overlay. This is not an independently executed full current-product/factory compile. The saved tests are real PostgreSQL differential evidence against their copied fixture, not a production-database test.

## Limitations / not established

- No rerun of setup or hydration against the original fixture/authority; no production DB, cloud, provider, readiness, or live-acceptance promotion.
- No root native completion/capture integration in this packet, and no complete current product/factory build or runtime composition verification. The setup itself can invoke embeddings during approved-memory creation; this review makes no provider-free setup claim.
- Copied/restored local data and new `xmin` values do not restore original setup authority or prove production state.
- Row locks establish only the matching-row protection described above, not global phantom exclusion, universal deadlock freedom, or transaction behavior beyond the saved tests.
- Final packet cleanup is not verified here.

## Recommendation

Accept the frozen source and saved local native differential as a qualified Case12 batching candidate with the limitations above. Keep readiness, capture authority, live acceptance, production/factory integration, and final cleanup explicitly unqualified until their own evidence is supplied.

## Evidence pointers

- `evidence/candidate-source-freeze.json`
- `evidence/manifest.json`
- `evidence/candidate/apps/api/src/memory/case12-synthetic-approved-memory-set.read.ts`
- `evidence/candidate/apps/api/src/memory/memory-authorization.service.ts`
- `evidence/baseline/apps/api/src/memory/synthetic-approved-memory.helpers.ts`
- `evidence/dependencies/memory-canonical-activation.helpers.ts`
- `evidence/dependencies/synthetic-candidate-withdrawal.helpers.ts`
- `evidence/dependencies/memory-authorization.helpers.ts`
- `evidence/dependencies/memory-wall.helpers.ts`
- `evidence/qualification/native-batch-differential.test.mjs`
- `evidence/qualification/native-differential-v1.log`
- `evidence/qualification/native-differential-result-v1.json`
- `evidence/qualification/legacy-regression-v2.log`
- `evidence/qualification/typecheck-overlay-v2.json`
- `evidence/qualification/hermes-supervisor-disposition.json`
- `evidence/prior-factory-failure-checkpoint.json`

Review performed from the packet files only; no claim of final supervisor-packet cleanup.
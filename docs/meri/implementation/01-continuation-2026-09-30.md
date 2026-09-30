# File01 continuation — September 30, 2026

**Original plan status: `01_BLOCKED`.** This checkpoint extends the [original-plan audit](01-completion-audit-2026-09-30.md); it does not certify the 75-case benchmark or a deployed release.

## Integration and authorization

The owner requested PR #1919 be integrated into the C-drive local main, then GitHub main, and requested concurrent Hermes work on the remaining requirements. The PR's exact reviewed head is `5e72da28863112ef3f5257caf4a480784f18720a`; its earlier qualification is 46 targeted tests and 26 deterministic offline evaluations plus verifier, all exit 0. GitHub recorded two `startup_failure` runs before creating any jobs: [push](https://github.com/neo-capiro/capirov2/actions/runs/36776882266) and [pull request](https://github.com/neo-capiro/capirov2/actions/runs/36776905284). Their underlying cause is unproven.

At this checkpoint, a specific one-time exception to substitute the verified local checks for those failed hosted attempts is pending. Neither main has moved from `ac6b66aaf3d77c9b009ebdeb6a78b1394846580f`. Do not interpret this document, an empty check-run list, or the new local database qualification as approval to bypass gates or deploy.

Shared policy fetched main: `39590a3bfc57ce03b0411ff7912a7c8d99deb70c`. Occupied clean operations checkout `2f4c1bf166d9941a115a9fe8678f0a8c5808fd25` was preserved; its required bootstrap, agent, and Hermes policies match main. Machine map revision: `2026-09-30T00:21:48.2698715Z`, SHA-256 `294d7449619e3b10913008e31d8d610075e6852ff0f0cc0d38de8f6a8c6369ab`.

## Parallel execution

Three real Hermes/Bedrock `qwen.qwen3-coder-next` sessions were dispatched concurrently to separate C-drive worktrees for award ownership, approved-memory fixtures, and capture observations. Their task scopes prohibited pushes, production/database mutations, credential output, profile changes and weakening capture guards. A fourth bounded Hermes session prepared isolated local pgvector binaries.

The three application implementation sessions were stopped without accepting their output: the award session produced no usable patch, the capture session proposed fabricated evidence and masked a failed command, and the fixture session printed private disposable-database configuration. The fixture stream was sanitized and that exact owned local credential was rotated; a new connection was verified. No AWS/shared-database credential or shared migration ledger was involved. Rejected patches, actual process exits and incident metadata are retained in protected task evidence.

Under the owner's existing direct-repair exception, separate Codex coordinators completed the bounded application repairs. All three received independent actual Hermes/Bedrock `moonshotai.kimi-k2.5` reviews. Requested High reasoning is not reported as an effective guarantee because this Converse adapter does not forward it. Worker/reviewer summaries are not test receipts, and a review process exiting zero does not turn a FAIL verdict into approval.

## Award owner repair

Source commit: `4d09a8bb911aac545f3ac67c92cf8ac5d9386050`; integration cherry-pick: `dc17eed38941226cc07f96f6712330efeb22dc97`.

Federal Market now owns the legacy global award query. The compatibility adapter retains PE filtering, keyword semantics, legacy fields and date serialization, defaults and public/global behavior. It exposes validated stable pagination and continuation metadata. Missing dependency injection fails explicitly. Contract vehicles no longer advertise an unsupported fiscal year; supplied vehicle fiscal-year filters are rejected rather than silently ignored. Existing Federal Market UI callers already omit that filter for vehicles.

Qualification: **102/102 tests in five suites, exit 0**; scoped semantic/syntax TypeScript over seven changed files, zero diagnostics; independent Hermes/Kimi final readback PASS, exit 0, session `20260930_215730_82d6dd`. Earlier test/typecheck failures remain separate failed attempts. This is query ownership and compatibility work: canonical alias/exposure migration remains OPEN, and separate legacy query semantics are deliberately retained until caller parity is established.

## Approved-memory owner fixture

Source commit: `c22ed8525ad54c1a5c43b131a2660604ba59454b`; integration cherry-pick: `c994be504`.

The [approved-memory runtime](../../../evals/meri/live-v1/fixture-provisioning/approved-memory-runtime.md) composes the actual proposal, guarded approval and canonical store owners. It creates MA510 before 509 supporting memories and returns the actual allocated item IDs with candidate IDs, current versions and ownership/content hashes. Prospective manifest IDs are never presented as actual canonical item IDs. Approval rechecks current reviewer membership and exact pending content/version under the real transaction lock. Retirement retains approved-candidate history, revoked items, audit and cleanup intent. No public route or ordinary approval bypass was added.

Qualification: **8/8 tests, exit 0**, including six actual PostgreSQL service integrations; all 510 memories were approved, read and retired through the current owners, then disposable writes were rolled back and random-schema absence independently verified. Existing candidate regressions: **30/30, five suites, exit 0**. Targeted TypeScript over 1,148 source/dependency files had zero diagnostics. Independent actual Hermes/Kimi re-review and final dependency-check delta returned PASS, exit 0. Initial incorrect reviewer premises and valid hardening findings are separately retained with dispositions.

This used a deliberately minimal isolated schema. The later full 449-migration database qualification is a different check. Full-schema/RLS behavior, real application recall/citations, trusted capture binding and original case 12 remain NOT RUN. Generic `memory_item` availability remains unavailable until actual application integration proves the returned physical bindings; no manifest or LIVE guard was loosened.

## Native API capture observations

Source commit: `9febdd13f290aa38bfe35a3956db77033800d356`; initial integration cherry-pick: `1b5f56c53`.

The native API path now owns a request-local observation collector bound to the complete trusted policy and active request context. Provider/model/usage observations come from actual request and response events; final output totals require stream completion. Tool observations use actual invocation IDs, runner attempt counts, registry read-only metadata and the existing source-result classifier. Sources join to calls only when unambiguous. Missing source ownership, version, complete-read, cost or release evidence remains UNKNOWN/NOT_RUN; signed receipt and authority guards remain in force.

Qualification: **66/66 tests in four suites, exit 0**, with shared/core builds exit 0; actual independent Hermes/Kimi full and completion-delta reviews PASS. Tests include current service lifecycle hooks but use fixture provider streams, not a served application. Initial rejected Qwen evidence and failed setup/test attempts are retained separately. The root's combined API typecheck found seven strict typing errors in the initial commit. Source follow-up `63963fbea24c218865f155f53ef1f59133dbedc0`, integrated as `2b66ca5f7a9c3e7be1cb4ac9e78a5506e3ad286b`, fixes explicit interface typing and safe indexed access; all 66 tests passed again, and actual Hermes/Kimi delta review returned PASS, exit 0. That worker's unrelated stale Prisma-client errors and a review/log timing error are documented separately; only the root's final integrated command can qualify the combined typecheck. No routing, provider policy, public authorization, migrations or LIVE capture gates changed.

## Combined verification

On integrated source `1b5f56c5304d5974d09038bdb5758f0ece64c0c4`, the six portable PostgreSQL fiscal-year/pagination tests passed, exit 0. Pinned Promptfoo 0.123.1 passed **26/26 deterministic offline cases**, zero failures/errors, followed by custom verifier exit 0; report SHA-256 `c99761ef35686b2afa03a6ee21912f94058ac2df93f3dfb25996646365e08596`. The verifier requires exact current HEAD, so the final repaired candidate must receive a fresh evaluation. These results do not supersede the failed combined typecheck or stand in for original served acceptance.

The actual `AppModule` dependency-graph test also passed, one test, exit 0. It confirms the added award-owner dependency is available through existing module exports. It started on `1b5f56c53`; the capture-only type follow-up was integrated during that already-started test. The award wiring did not change. The receipt records both identities rather than presenting this as a fresh test of the entire later candidate.

Final combined source `2b66ca5f7a9c3e7be1cb4ac9e78a5506e3ad286b` passed the complete `pnpm --filter @capiro/api typecheck` script, **exit 0**, including the base API compilation, all chained specialized TypeScript projects and `PE_PHASE_A_B_SAFETY_OK`. This supersedes the seven initial capture typing diagnostics. The exact final commit's fresh offline-evaluation identity and report hash belong with its PR qualification receipt, avoiding a self-referential commit hash in this document. Hosted CI, merge and deployment remain separate gates.

## Actual local database prerequisite

Hermes prepared an isolated PostgreSQL 16.15 copy and built pgvector **0.8.6**, source `8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c`, using the project's [official Windows build procedure](https://github.com/pgvector/pgvector#installation). The installed PostgreSQL directory and existing clusters were not modified. The lead verified the build command exit and artifacts, then started a fresh task-owned cluster on `127.0.0.1:55435` with SCRAM authentication and an exact data-directory identity check.

The actual extension loaded and passed vector distance/inner-product assertions. The probe transaction rolled back. A fresh application database then replayed **449/449 migrations** from exact source `5e72da28863112ef3f5257caf4a480784f18720a`, exit 0. All stored migration checksums matched source bytes; there were zero missing, unfinished, unexpected or mismatched migrations. No manual migration-ledger changes were made.

The first disposable attempt failed during bootstrap because its database name did not match the historical migration's fixed `capiro` database grant. That database was preserved as failed evidence. A second fresh `capiro` database in the same owned cluster completed the unchanged migration chain. This is a corrected local setup, not a production migration repair.

The repository's exact disposable worker-role and append-only-function SQL were applied only after local server identity verification. The GHA-only bootstrap wrapper was not changed or invoked against a different target. Runtime API credentials were prepared privately for the existing `capiro_app` role; its connection was verified as non-superuser, without role/database creation, replication or RLS-bypass privileges. No application routes, authenticated acceptance, external sinks or AWS services were exercised by this database qualification.

Reproduction on another machine requires a genuinely disposable PostgreSQL 16/pgvector target, the same migration bytes and bootstrap prerequisites, a database named `capiro`, and actual `prisma migrate deploy` plus full ledger/checksum readback. Never copy this machine's credentials or use a shared database. Relevant repository commands and prerequisites are in `.github/workflows/federal-market-ci.yml` and `scripts/ci/`; Windows binary copies and private configurations are intentionally not source-controlled.

Protected evidence root on the execution host: `C:\dev\cap-meri-foundation-evidence\file01-parallel-20260930`. Sanitized qualification receipts:

- `local-pgvector/root-build-verification.json`: source and artifact hashes, build exit 0.
- `local-pgvector/runtime-qualification.json`: extension execution and rollback, exit 0.
- `local-full-migration-replay-attempt2.json`: 449 matching applied migrations, exit 0.
- `owned-api-db-role.json`: runtime-role privilege and connection checks, exit 0.
- `owned-pg-rotation.json`: prior disposable credential rotation and successful readback, no secret values.

## Remaining completion conditions

The original audit's acceptance counts and hard gates remain in force: **75 original cases, 7 CD cases, 8 required CW cases and applicable M cases have not completed served acceptance**. Complete the canonical source fixtures and physical-ID bindings, trusted capture/source/byte/parser/usage observations, missing row predicates, actual authenticated application/UI runs and fault scenarios, human rubric, exact release/schema compatibility and deployed trace/rollback verification. Local SQL qualification does not establish AWS schema compatibility. UI deployment remains exclusively `os.capiro.ai` through `web-vnext`.

Keep File02/03 and a separate Defense chat out of this task. Existing Meri Defense Budget/PE/Research Portfolio behavior remains part of File01.

## Next bounded worker assignments

1. **Full-schema fixture composition.** Reuse `createApprovedMemoryFixtureRuntime` with the real application Prisma/memory services on the explicitly owned disposable database. The 55433 rollback probe did not seed the new 55435 database. Do not repoint its minimal-schema harness. Verify the actual server identity, ordinary runtime role, approved synthetic tenant/user/client memberships and real reviewer; persist MA510 plus supporting records long enough for HTTP readback, then retire through the owner. Bind actual physical IDs, versions and retained receipts to the exact fixture instance.
2. **Controlled local capture.** Reuse existing `/api/clio/conversations`, conversation stream/messages, `/api/clio/sources`, policy issuer and current-authority readback. Wire the already-supported `configureApiHttpApp.releaseShaHeader` option in the main API to independently verified build identity. Extend the controlled transport from cases 01/20 to the matching MA510 case 12, and supply its existing programmatic `controlledReceiptContext` from real server/owner observations. Do not trust caller-selected receipt strings or relax remote LIVE guards.
3. **Runtime and evidence qualification.** Launch only with an explicitly bounded environment: loopback API/orchestrator URLs and ports, real synthetic Clerk identities, exact V3 tenant flags/allowlists and matching internal secret. The API/orchestrator require their actual application provider credentials; Hermes Bedrock configuration does not supply those. Avoid ambient dotenv/shared service configuration. Preserve real raw exchanges, canonical source readbacks, signed receipts and cleanup evidence. A valid signature is insufficient without independent fixture/build/source/tool/effect/usage crosschecks and server-owned spend reservation.

The new local database and fixture owner make these assignments concrete. No authenticated app or provider stream was launched in this checkpoint. The first controlled local HTTP diagnostic is still separate from LIVE acceptance; retain its restricted provenance label and outstanding gaps. Only after qualifying the corresponding owners should the remaining row predicates, 75/CD/CW/applicable-M runs and release work proceed.

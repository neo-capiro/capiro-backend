# Original File01 completion audit — September 30, 2026

**Verdict: `01_BLOCKED`; the original stabilization plan is not complete.** This is a requirement and evidence audit, not a claim that every untested behavior is broken. It supersedes older statements about integration and the release tooling; it does not replace the original acceptance contracts.

[Machine-readable results and evidence hashes](01-completion-audit-2026-09-30.json) preserve the audit baseline, separate suite counts, repaired source hashes and release limits.

## Original plan and audit identity

The original [Foundation and Reliability plan](01-Meri-Foundation-and-Reliability.md) is byte-for-byte identical to the September 27 attachment: SHA-256 `77c55b7484343a766c3bd17047c513b50c7c5d045e2018f03ea9dd0c08b622bd`, 1,779 lines. The [orchestrator companion](01-Meri-Orchestrator-Prompt.md) scopes this task to File01 and its A/B/C/D packages. Later drafting, specialist models, optional new compute and database relocation are not silently added. Separate Defense chat is excluded; existing Meri Defense Budget and Program Element capabilities remain required.

Audit baseline: local main and fetched GitHub main both `ac6b66aaf3d77c9b009ebdeb6a78b1394846580f`. The main worktree was clean. Implementation work is isolated; the unrelated dirty primary checkout was preserved. PRs #1905, #1908 and #1915 are merged; the prior repair `c785e566321943470978d66325952ed916951346` and portable handover `56da63c157c520ec8beaa040c7c9b8dfdee40dfc` are main ancestors. Merged source is not evidence of deployed acceptance.

Shared policy: fetched `capiro-agent-ops` main `39590a3bfc57ce03b0411ff7912a7c8d99deb70c`; occupied checkout HEAD `2f4c1bf166d9941a115a9fe8678f0a8c5808fd25` was preserved and its required policy files match main. Machine map: `2026-09-30T00:21:48.2698715Z`, SHA-256 `294d7449619e3b10913008e31d8d610075e6852ff0f0cc0d38de8f6a8c6369ab`.

## Required behavior, implementation and remaining proof

| Original requirement | Current implementation / owner | Remaining completion condition |
| --- | --- | --- |
| 01-A / §§5.2, 6.2: truthful outcomes and in-Meri decisions | Typed outcomes, proposal claims/receipts, visible error/uncertain recovery, memory review and reload controls are consolidated. | Actual ordinary-role approve/reject/denial/conflict/reload, zero incomplete-call effects and one logical controlled effect. Original 13–19, 51, 72, 75 and CD-05 remain NOT RUN. |
| 01-A / §7.6: attachments and delivered artifacts | Original stored-byte attachment reads, typed sections, current-version cursors and final authority checks exist; canonical document fixture read/reset has historical local qualification. | Actual parser/source/version proof, prior-turn attachments, authorized downloads and exact bytes. Original 40–46 remain NOT RUN. |
| 01-B / §6.1: canonical memory | Eligibility precedes lexical/vector candidate limits. Existing source tests cover MA510 and sparse older recall; governed memory remains the authority. | Authenticated older-than-500 retrieval, revocation at use/resume/export, cache invalidation and ordinary-tenant parity; complete approved-memory fixture ownership. |
| 01-B / §§6.3–6.4: source authority and coverage | Current-owner source checks and source-family repairs exist. | Real source passages/versions and explicit unavailable/denied/partial coverage across the original domain cases; no snippet-as-read or absence-from-unread-page claims. |
| 01-B / §7.1: governed tool exposure | Selection/discovery are wired into the governed assistant and current schemas are filtered. | Observe provider-exposed schemas, actual invocation and current authority on the served route, including editor/strategy surfaces. |
| 01-B / §§7.3–7.4: procedures and C&D | Fixed `commitments_audit`, editable starter, selected-client requirement, read-only procedure and three allowed statuses exist. | All CD-01–07, actual mail/meeting/debrief/task/action/document/Monday coverage, deduplication and zero audit writes. |
| 01-B / §7.5: filter and pagination correctness | Audit reproduced source defects: contract `fiscalYear` was ignored; Meri fixed every search to page 1. Both have a tested repair in this task branch. | Merge/release and served regression remain required; this does not complete the separate alias/surface consolidation. |
| 01-B / §7.5: award consolidation | Both `search_federal_awards` and `search_federal_contract_awards` still have separate implementations. | Consolidate through the owner while retaining PE filtering, explicit global/client modes, editor callers and compatibility aliases. Do not delete a supported capability to reduce tool count. |
| 01-C / §§5.1, 5.3–5.6: plans, bounds, compaction | Typed plans, aggregate budgets, compaction, fenced coordinator and structured child adapter exist. | Actual global retry/provider/JEV/child cost and deadline evidence; safe rehydration after revocation; bounded alternating no-progress. |
| 01-C / §5.6: durable controls and recovery | Stop/steer/reconnect UI, event cursors, goal revisions and persistent receipts exist. | Original 71–75 and CW-01–08: real worker replacement, stale-owner fencing, observer disconnect, ordered steering, Stop, malformed/late children and ambiguous-effect reconciliation. Backend/local tests alone do not close these rows. |
| 01-D / §§8.1–8.2: narrative/JEV | Source-integrity/narrative repairs and existing bounded correction are consolidated. | Paired actual outputs 52–58, enabled versus shadow JEV, deterministic assertions followed by human rubric and critical repeats. |
| 01-D / §14.2: observability | Joined IDs/redaction/exporter code and historical local OTLP tests exist. | Configure and observe served UI→API→runtime→tool/child/receipt joins, actual usage/cost, runtime identity and continuity through replacement. |
| §§9.1–9.2, 9.5: acquisitions | Original donor pins, inventory, notices and bounded adaptation reports exist. | Refresh adoption dispositions against merged implementations; attach the relevant preserved/regression tests. Acquisition is not acceptance. |
| §§10.3, 13: release and compatibility | Build isolation and one-service digest-bound operator are now merged. | Current candidate CI/build provenance, migration compatibility, affected-service qualification, approved cohort activation, exact deployed digest/config and rollback verification. |
| §§12.1–12.8: full acceptance | Fixed 75-case contract, 26-case offline suite and separate CD/CW/M contracts exist. | Finish capture/fixtures/predicates, execute original cases, preserve repeated outputs and classify failures/limitations individually. No aggregate or ready label substitutes for these checks. |
| Appendix H | [All 26 findings now have explicit dispositions](appendix-h-audit.md), with 48 verified source/test blob references in the companion JSON. H01–24 have relevant mitigations, not newly executed product passes. | Remaining served proof is listed per finding; H25 is a separate product-backlog requirement, H26 is nonblocking adoption work. Historical reports are not automatically current defects. |

The [original requirements ledger](01-requirements.md) retains every annex identity. Its earlier chronological candidate/merge statements must be read with this current audit. Optional I1/I2, X1/X2, service relocation M1, breadth F1 and CW-09–12 remain conditional/later. [M01–M20 applicability](01-memory-strategy-acceptance.md) remains unchanged: do not omit affected memory/source/review contracts or introduce the later structural drafting engine.

## Acceptance implementation still missing

At the audited main, the live-v1 tree is unchanged from prior handover baseline `25d1339c0c0e21fe0c3c0148787fad772e5096e8`:

- **15/75** row predicates are qualified in code: `01,03,12,13,14,15,16,17,18,19,20,46,51,56,72`. This is implementation coverage, not 15 product passes.
- **6** document rows, 40–45, have substantial saved-evidence predicates but lack actual source-byte/parser/current-authority qualification. **54** other rows lack their row-specific deterministic predicate.
- `capture-transport.mjs` supports only API cases 01/20 and rejects remote LIVE_CAPTURE before creating a conversation. `verify-capture.mjs` independently rejects missing live authority. `artifact-collector.mjs` separately rejects unsafe live artifact publication.
- Existing server read-only enforcement and signed policy/message binding must be reused. `meri-server-capture-evidence.ts` still emits empty tool observations and NOT_RUN provider/model/cost/runtime identity; real owner observations and lifecycle bindings are missing.
- Runtime fixture ports cover memory candidates and Engagement attachments. Approved-memory creation/read for MA510 plus distractors, other canonical owners and controlled mail/Monday/action/child sinks remain incomplete. Archived fixture-hook patches are not qualified owner implementations.
- All **75 live + 7 CD + 8 required CW** cases lack completed served acceptance. Applicable M cases and substantive human grading are additional obligations; these counts are separate.

The original plan permits a disposable local application/API/runtime target. An explicitly identified, process-supervised local integration can exercise real routes, isolated PostgreSQL/storage, controlled adapters and source/effect readbacks without changing remote LIVE guards. It must not relabel unit response fixtures as actual application or production evidence.

## Confirmed §7.5 defects repaired in this branch

`FederalMarketService.commonAwardClauses` now applies the supplied federal year to the stored `action_date`, using October 1 of the previous year inclusive through October 1 of the supplied year exclusive. The shared clauses constrain both count and row queries and intersect existing date/client filters. The tool description explicitly states this date basis and does not portray cumulative award amounts as annual obligations.

The four paginated Federal Market tools expose a validated page, preserve page-one/default-limit behavior, and report `hasMore`, `nextPage` and `paginationLimitReached`. Fractional, boolean, malformed and out-of-range pages fail before dispatch. This changes API tool schemas and read selection only; production models, auth/identity rails, mutation authority, web routing and database schema are unchanged. Existing award-alias consolidation and unsupported vehicle fiscalYear behavior remain separate open items.

The Hermes/Qwen implementation stopped with an incomplete patch and unsupported test claims. Under the task's existing direct-repair exception, Codex completed schema/validation/continuation and regressions. Its report is not counted as passing evidence. Independent Hermes/Bedrock Kimi returned scoped source-review PASS with actual exit 0; both production-file hashes match the actual PostgreSQL probe. Its cited 40-test log was produced by the lead, so it is not counted as a second independent test execution. A later test-only optional-property access repair does not change production code. Requested High reasoning is not represented as an effective provider guarantee.

Actual local verification: **40 tests across the two existing owner/tool suites passed, exit 0**. A separate six-test probe executed **20 unchanged owner SQL queries** in an owned local PostgreSQL transaction: exact October 1 boundaries, null dates, intersected dates, distinct pages and stable ties, current client UEI filtering/other-tenant denial, and tool-to-owner pagination. The random schema was rolled back and absence verified. This is real SQL integration with a controlled identity port, not deployed authentication/RLS or live acceptance. Initial probe setup exhausted the default TypeScript heap; isolated transpilation resolved setup without changing product code.

The same six SQL assertions are preserved in `apps/api/src/federal-spending/federal-market-fiscal-year.postgres.spec.ts`. Set `MERI_FEDERAL_MARKET_PG_CONFIG` to an absolute private JSON configuration for an explicitly owned disposable loopback cluster. The test checks its scope, configured owner, port and actual data directory before creating a random transaction-owned schema, then rolls it back and verifies absence. It skips when this explicit configuration is absent and never falls back to `DATABASE_URL`. A skip is not a SQL qualification. No configuration credentials belong in Git.

Before/after proof uses the same portable test: exact baseline `ac6b66aaf…` owner/tool bytes produce **5 failed / 1 passed, exit 1** (wrong FY counts, outside-year rows and pagination); repaired source produces **6 passed, exit 0**. Temporary baseline siblings were removed, both production hashes remained unchanged and all disposable writes were rolled back. The portable test and its transitive production imports also typecheck with zero diagnostics, exit 0; earlier test-runner declaration/setup attempts are not counted as product failures.

## Fresh verification

Checked on source `ac6b66aaf3d77c9b009ebdeb6a78b1394846580f`, September 30:

| Check | Actual result |
| --- | --- |
| `pnpm --filter @capiro/shared run build`, then `@capiro/meriv2-core` | PASS, both exit 0 |
| `python -m unittest discover -s evals/meri -p 'test_*.py' -v` | PASS, 53 tests, exit 0 |
| `node --test evals/meri/runtime/provider.test.cjs evals/meri/runtime/smoke.test.cjs` | PASS, 40 tests, exit 0 |
| Pinned Promptfoo 0.123.1, uncached/private/no remote generation, then `verify_report.py` | PASS, 26/26 plus verifier exit 0; report SHA-256 `7bf3e1f203e589bfce17492f44b9de0a4ca07cddb867f93ea4e7055110ec21cb` |
| `node evals/meri/live-v1/validate-contract.mjs` | PASS, all 75 original IDs/contracts, exit 0 |
| Full live-v1 Node harness test command | Initially 184 passed / 1 setup failure, exit 1: owned local PostgreSQL `127.0.0.1:55433` unavailable. After restoring only the verified task-owned cluster, the failed test passed separately, exit 0, with owner/address/port/data-directory readback and its random schema cleaned up. Combined: 185 passing unique observations; no fresh single-suite 185/185 run claimed. |
| Release operator/policy, build-isolation self-tests/guard, synthetic fullChat contract | PASS, command exits 0; fullChat 22 tests. Fake/injected services, no cloud mutation. |
| API `tsc --noEmit` after regenerating the local Prisma client | PASS, exit 0 with 6 GiB heap. Initial stale-client diagnostics and default-heap exhaustion are retained as setup failures; one new test optional-property diagnostic was fixed. |

Offline results neither execute the 75 live cases nor establish UI, real provider or production behavior. Raw task logs remain under the protected/local evidence root; only sanitized aggregates belong in Git.

## Deployment readback at 20:33 UTC

| Component | Running version | Observation |
| --- | --- | --- |
| Meri orchestrator | Task 84; digest `227550d5862037ef026b04e3a7cb8f77e3c3467f409e3ab5144ad0ce725018de` | Healthy; last rollout September 27 09:02:23 UTC. ECR tag `c2bc41a86ef087e4b163c556595507ec08b396cf`. Original stabilization changes are not proven live. |
| API | Task 483; digest `27a0c109a527edff8906ce944bea9831a8a2b2200e8bd5f35ad2610662e99d10` | Healthy; September 30 14:30:01 UTC rollout. ECR tag `fc8133d50a41d10f5549f1cf7f73787ffc7e4965`; task still references `latest`. |
| web-vnext / os.capiro.ai | Task 384; digest `b2d8a2bd090874bce5db05d871dc930e5a4fb80e8a3dfb25e9badc24dfa90913` | Healthy; September 30 19:00:01 UTC rollout; same ECR source tag as API. |

ECR tags alone are not build provenance. API task `GIT_SHA`/`RELEASE_SHA` still advertise older `a66337bd…`, so those environment hints cannot qualify the served source. API/orchestrator lack the two approved synthetic tenant slugs in their Meri allowlists. The inspected API/orchestrator/web task definitions have no OTEL/OTLP environment entries; no served trace join was established.

Current main and final #1915 head have no check runs. Recent relevant Actions runs report `startup_failure` with zero jobs; [web-vnext example](https://github.com/neo-capiro/capirov2/actions/runs/36754008626). The cause is not established, so an infrastructure-outage exception is not assumed. Current main/live schema compatibility also remains unverified. Never mutate the shared migration ledger to recover a release.

Two older handover blockers are obsolete: the bundled release executor is retired, and `.github/workflows/meri-synthetic-fullchat.yml` plus its tested script exist. Neither fullChat nor synthetic-cohort workflow has a recorded run. Their old API baseline must be refreshed against exact successful build evidence before applying only the already approved tenants. UI target remains **os.capiro.ai**.

## Closeout sequence

1. Repair and qualify the confirmed fiscal-year/pagination defects; preserve the separate award-alias/surface consolidation requirement.
2. Complete canonical fixture ownership and actual capture observations, then run the first original slice: `01,12,14,17,20,46,51,72,74,CD-02,CD-05`.
3. Complete missing predicates and original 75/CD7/CW8/applicable-M acceptance, including fault cases, critical repeats and saved-output human rubric. Repair actual reproduced defects without weakening the assertions.
4. Establish successful exact-candidate CI/build provenance and schema compatibility; qualify and promote affected API/runtime/web artifacts individually. Apply only the approved synthetic cohort through the reviewed workflow.
5. Verify served behavior, trace joins, immutable release/config identity and rollback; update the acquisition/finding dispositions and final handover. Only then assess `01_READY_FOR_02`.

Full File01 acceptance and release remain open; do not start File02 on an asserted completion of this plan.

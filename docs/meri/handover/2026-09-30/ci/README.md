# Meri CI handover — 2026-09-30

**Release verdict: BLOCKED.** This packet is self-contained evidence and a repair plan. It is not permission to merge, deploy, change routing, or modify a shared database.

Shared policy was fetched, checked clean, and read at `neo-capiro/capiro-agent-ops` commit **`fe8adaa858ee2391b42697311ce91cf787e080b8`**: [BOOTSTRAP](https://github.com/neo-capiro/capiro-agent-ops/blob/fe8adaa858ee2391b42697311ce91cf787e080b8/BOOTSTRAP.md), [AGENTS](https://github.com/neo-capiro/capiro-agent-ops/blob/fe8adaa858ee2391b42697311ce91cf787e080b8/AGENTS.md), [Hermes operating rules](https://github.com/neo-capiro/capiro-agent-ops/blob/fe8adaa858ee2391b42697311ce91cf787e080b8/hermes/OPERATING.md). A new agent must fetch and read current policy before acting and record the SHA it uses.

## Source and CI identity

| Item                                                  | Exact identity and state when this packet was prepared                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository / PR                                       | `neo-capiro/capirov2`, [PR #1915](https://github.com/neo-capiro/capirov2/pull/1915), branch `codex/meri-migration-closeout`                  |
| Main                                                  | `25d1339c0c0e21fe0c3c0148787fad772e5096e8`                                                                                                   |
| Completed CI baseline                                 | `0607ebb6857908ddca00d6763881b66d2700aebb`: **22 successful checks, 6 failed checks, none running**                                          |
| Reviewed repair commit                                | `c785e566321943470978d66325952ed916951346`: five files, clean local worktree at handover preparation; parent is handling publication         |
| CI for the repair commit / subsequent handover commit | **NOT RUN** in this evidence set. Re-read the PR head and check results after publication. Baseline success is not success for a newer head. |

No source or release state should be inferred from a PR title. Verify exact SHAs, status including untracked files, and the current PR head. Preserve other agents' work.

## Authoritative GitHub evidence

All these jobs ran on `0607ebb6857908ddca00d6763881b66d2700aebb`.

| Check                        | Run / job                                                                                                      | Actual outcome                                                                                                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Final release matrix         | [36639089697 / 109646986970](https://github.com/neo-capiro/capirov2/actions/runs/36639089697/job/109646986970) | **BLOCKED.** API test step ran 22:45:02–23:34:12 UTC on September 29 and exited **134** after exhausting its 6 GiB heap. Job completed 23:34:16 UTC. There were already **22 failed suite headers** before the abort. Workspace, Web and evaluation steps later in this matrix were **NOT RUN**. |
| Engagement Phase 2           | [36639089725 / 109646830159](https://github.com/neo-capiro/capirov2/actions/runs/36639089725/job/109646830159) | Process **PASS**, exit **0**, completed 23:01:35 UTC. Phase 1 had actual exit 0 plus its exact COMPLETE marker; full web regression passed **632 files / 5,912 tests**. Phase 2: **38 passed, 0 failed, 1 NOT RUN**.                                                                             |
| Standard verify              | [36639089725 / 109646830315](https://github.com/neo-capiro/capirov2/actions/runs/36639089725/job/109646830315) | **BLOCKED**, exit **1**: synchronous verifier output forwarding threw `EAGAIN`.                                                                                                                                                                                                                  |
| Revised Phase 1              | [36639089761 / 109646824805](https://github.com/neo-capiro/capirov2/actions/runs/36639089761/job/109646824805) | **BLOCKED**, exit **1**: the same output-forwarding defect.                                                                                                                                                                                                                                      |
| LegiWatch                    | [36639089774 / 109646824568](https://github.com/neo-capiro/capirov2/actions/runs/36639089774/job/109646824568) | **BLOCKED**: API **117 suites / 1,386 tests passed**, then three existing Intel detector assertions failed because of calendar arithmetic.                                                                                                                                                       |
| Runtime Boundary, PR event   | [36639089745 / 109646823811](https://github.com/neo-capiro/capirov2/actions/runs/36639089745/job/109646823811) | **BLOCKED**: clean checkout lacked Meri core declaration outputs; Phase 7 typechecking could not resolve core exports.                                                                                                                                                                           |
| Runtime Boundary, push event | [36639084251 / 109646806692](https://github.com/neo-capiro/capirov2/actions/runs/36639084251/job/109646806692) | Same missing-build prerequisite; a duplicate event, not a separate product defect.                                                                                                                                                                                                               |

The Phase 2 **NOT RUN** item is external prototype drift comparison: `OUTREACH_V3_PROTOTYPE_PATH` was unset. The prototype contract itself passed **25 assertions**. This is an unmeasured check, not an accepted limitation or full coverage. The full web run also passed the existing BizDevBrief and NewOutreachWizard suites; do not duplicate another agent's repairs to those files based on older failures.

Raw logs are intentionally not copied here. Retrieve them through the linked jobs or the read-only commands in [reproduce.md](reproduce.md). The safe [failure inventory](failures.json) contains all 22 suite paths, exact baseline log lines, causes and proposed next steps, without local configurations, credentials or customer data.

## What commit c785e56 actually fixes

1. [Runtime Boundary workflow](../../../../../.github/workflows/phase8-session4-runtime.yml): adds only `pnpm --filter @capiro/meriv2-core build` immediately after shared. Shared is core's sole workspace build prerequisite. Existing typechecks and their 6,144 MiB heap remain.
2. [Verifier process helper](../../../../../apps/api/scripts/lib/engagement-verifier-process.ts) and [its tests](../../../../../apps/api/scripts/lib/engagement-verifier-process.spec.ts): use asynchronous Writable callbacks and drain events, pause the child reader under backpressure, and wait for actual child close **and** pending output completion. A successful marker never substitutes for an exit code. Sink errors, EPIPE, child failure, signals, timeout and capture overflow remain failures with owned-process cleanup. Capture stays bounded to 64 MiB per stream.
3. [Shared deadline helper](../../../../../packages/shared/src/index.ts) and [deadline-risk tests](../../../../../apps/api/src/ingestion/deadline-risk.spec.ts): convert both ISO month numbers from 1–12 to Date.UTC's 0–11. September 29 to October 1 previously returned 3 days instead of 2, incorrectly using the existing notable classification instead of critical. January 30 to February 1 returned -1 instead of 2. Leap-year February 28 to March 1 returned 4 instead of 2. Cutoff selection, severity thresholds, deduplication, date normalization and status handling remain unchanged.

The calendar correction affects API chokepoint calculations and Intel deadline alerts; another consumer is a Meri legislation evaluation. It changes no route, credential, tenant boundary or model policy. Because `packages/shared` is changed, additional main-branch image workflows can be triggered. The API and Workspace image workflows can update ECS automatically on main. **Do not integrate main before migration/release readiness is established.** This CI packet does not establish live migration safety.

## Measured verification

These are recorded local results, separate from future-head CI. Local runtime was Node **22.23.3** with the repository's **pnpm 9.12.0** lockfile and Jest **29.7.0**. Runtime Boundary's workflow itself still selects Node 20; its next CI run is required.

| Verification                                                              | Result / exit                                                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared TypeScript build and Meri core build                               | **PASS / 0**, each                                                                                                                                                        |
| Verifier process and Bash gate suite                                      | **23 tests PASS / 0**; includes slow Writable backpressure, pending callback, asynchronous EPIPE, output limits, signal/timeout, real exit, exact markers and tee failure |
| Isolated verifier TypeScript check                                        | **PASS / 0**                                                                                                                                                              |
| API deadline-risk suite, including 12 deterministic boundary cases        | **22 tests PASS / 0**                                                                                                                                                     |
| Unchanged Intel detector and utility suites                               | **30 tests PASS / 0**, including the three baseline CI failures                                                                                                           |
| Focused workflow YAML/step comparison and whitespace checks               | **PASS / 0**; only the core build command was added to that workflow                                                                                                      |
| Separate Hermes/Kimi reviews of core prerequisite, backpressure, calendar | **PASS / 0**, completed September 29 at 22:32:16, 22:40:02 and 22:46:48 UTC respectively                                                                                  |
| Tango diagnostic with `--experimental-vm-modules`                         | **2 selected tests failed / exit 1**, 138 unselected; same real SDK/fake transport cases as CI                                                                            |
| Same Tango diagnostic without that flag                                   | **2 selected tests PASS / 0**, 138 unselected                                                                                                                             |
| Both complete Tango suites without that flag                              | **140 tests PASS / 0**, no skips                                                                                                                                          |
| Both extraction suites in a fresh process, unchanged                      | **33 tests PASS / 0**, using `--detectOpenHandles --forceExit` and the 6,144 MiB heap                                                                                     |
| API shard discovery only                                                  | **PASS / 0**: 1,762 suites split 441/441/440/440, exact union, no duplicates; no tests executed                                                                           |

The failed final matrix emitted 747 PASS and 22 FAIL API suite headers before OOM. Against local discovery, 993 suites lack a completed header. There is no full API result, and those remaining suites must not be presumed green.

## Next bounded repairs

Consult [failures.json](failures.json) for exact paths. These proposals are **not implemented** in c785e56.

- Remove only the final matrix's incompatible `--experimental-vm-modules` flag from API Jest; preserve its heap. API Jest already transforms Tango's ESM package to CommonJS. The 140-test run proves this diagnosis without changing the SDK or production adapter.
- Bound API memory with fresh-process shards. `--detectOpenHandles` forces a single Jest process, so worker recycling cannot repair this invocation. Keep every discovered suite, both existing flags, all assertions, and failure propagation. Prove the shard union before execution using [verify-api-shard-union.cjs](verify-api-shard-union.cjs). Parallel jobs need their own owned disposable databases; do not run mutating integration shards concurrently against one shared fixture database. A shard plan is not yet a CI implementation or a passing run.
- Provision locked Python/uv prerequisites and the missing Intel and Phase 6 projection schema prerequisites only in owned disposable CI databases. Do not edit historical migration SQL or use schema overwrite to conceal missing ownership.
- Make scheduler and Python test harnesses portable while retaining explicit target attestation. Scheduler fixtures currently assume a private local config, loopback port 55433 and Windows node.exe; the Actions container exposes 5432 and can report its container address. Do not replace these checks with arbitrary DATABASE_URL fallback. Retain schema ownership, real transaction, kill/restart and replay assertions.
- Repair the two raw backticks inside SQL template comments in the prune script, and the CommonJS test's `import.meta.url` path resolution. Run only the existing fake-client prune tests; do not execute the maintenance script against a database.
- Bring stale Meri replay, retrieval registry, Federal identity schema and geography wording fixtures into agreement with current runtime contracts. Preserve provider-call identity, persisted attempt budgeting, current-owner authorization, wall revocation, forbidden-table and no-invented-geography assertions. Adding providerCallId alone may expose further incomplete budget setup.
- Re-run the unchanged extraction tests in fresh CI shards before increasing timeouts or altering extraction code; both pass in a fresh local process.

## Gates and boundaries to retain

The five-file repair does not remove, skip or narrow a test command. Preserve the full API/Workspace/Web/Strategy/orchestrator/core/evaluation matrix and the exact discovered API suite union. Preserve all 543 historical migration SQL blobs byte-for-byte, their integrity guard and its tests. Keep Funding's 46-suite/137-test minimum and requested-path existence check. Preserve exact source parity, private-data exclusions and all tenant/owner checks.

Runtime Boundary retains all five trusted checks: `tsconfig.budget-extraction-contract.json`, `tsconfig.budget-verification-v1.json`, `tsconfig.budget-parser-router.json`, `tsconfig.phase6.json`, and `typecheck:phase7`; its dark-image/non-root checks and explicit FY27 replay gate remain. The ordinary CI check confirms the real replay gate stays closed without retained replay evidence.

Engagement Phase 1 retains its full prerequisite, API and web scopes. Phase 2 still requires timeout/child exit 0, tee exit 0, an exact COMPLETE marker, and no FAILED marker. Preserve timeouts, descendant cleanup, bounded output and narrow infrastructure retry rules; assertions must never be retried into success. Preserve synthesis/template parity, preview-header confinement, scope checks, existing routing approval boundaries and real-output assertions.

Future acceptance requires actual exit 0 on the published head plus migration and release evidence. UI publication remains through web-vnext to os.capiro.ai. No shared ledger mutation, production canary or authenticated production-browser test is authorized by this handover.

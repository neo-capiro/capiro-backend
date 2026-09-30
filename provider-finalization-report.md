# Meri provider finalization report

## Scope and baseline

- Branch: `codex/meri-provider-finalization`
- Baseline: `854a5fc30b2e88badc986134355ee1969699649e` (`fix(meri): bound aggregate runtime progress`)
- Inputs reviewed before implementation:
  - `C:/dev/cap-meri-foundation-evidence/review-outcome-reconciliation-report.md`
  - `C:/dev/cap-meri-foundation-evidence/runtime-bounds-report.md`
- Scope remained inside the existing MeriV3 assistant, OpenAI Responses client, status-provenance runtime, and focused tests. No production model, flag, pricing, API/UI/shared contract, migration, dependency, or broad JEV redesign was changed.

## Implemented boundaries

### Research Director critic and synthesis

`openai-responses.client.ts` now applies one closed-text response predicate to hidden critic and final synthesis responses. A usable response must have a completed envelope, no incomplete reason, non-partial completed telemetry, no normalized or raw function-call output, and non-empty text.

An incomplete critic is rejected before its text can enter synthesis. An incomplete or malformed Research Director synthesis is rejected before schedule validation or release. The last closed grounded draft is retained with an explicit deterministic qualification that research finalization is incomplete. Usage, provider telemetry, and the shared request budget still account for every completed draft/critic/synthesis attempt, including a rejected synthesis.

### Forced no-tools synthesis

`meriv3-assistant.service.ts` applies the same predicate before assigning forced no-tools synthesis text to `finalText`. Rejected partial text is not replayed, finalized, emitted, or retried. The assistant returns a deterministic honest partial containing only retained completed ledger evidence and states that remaining work is incomplete. No additional tool or write starts on this path.

### Exhausted enforce controls

Aggregate acquisition exhaustion no longer skips match-label or status-provenance enforcement:

- Match labels are derived locally from the retained controlled evidence ledger after Stop. If an optional evaluator fails because its budget cannot admit work, the local deterministic derivation runs instead of passing the asserted tier through.
- FedRAMP status claims are checked locally against retained authoritative `get_certification_status` results. Exact retained authority can repair wording without a lookup. Claims lacking retained authority are localized as unverified rather than released unchanged.
- If an authoritative status lookup was attempted but could not fit or failed, the same retained-evidence fallback runs before release.

The existing source-authority rules are unchanged: retained status evidence must still be authoritative, primary, unambiguous, and carry the required source/observation fields.

## Direct reproductions

The new composition tests were added before the fixes and observed failing on the baseline behavior:

1. Incomplete Research Director critic: synthesis was called a third time and consumed partial critic prose. Expected two calls and no synthesis.
2. Incomplete forced no-tools synthesis: `UNRELEASED PARTIAL SYNTHESIS` was returned as the reply.
3. Exhausted enforced verification: `Direct match` and `FedRAMP approved` passed through unchanged because both enforce blocks were skipped.

After implementation:

- The incomplete critic test makes exactly two provider calls, never places critic partial text in any later request, and returns the qualified closed draft.
- The forced no-tools synthesis test makes exactly two provider calls, releases none of the partial synthesis, and returns the deterministic partial fallback.
- The exhaustion test makes exactly two model calls, no registry invocation, downgrades the unsupported match to `Insufficient evidence`, qualifies the unsupported FedRAMP claim, and retains `runtime_tool_calls` partial telemetry.
- Focused status tests prove retained authoritative evidence repairs exact source wording without a lookup, while absent retained authority produces an explicit unverified qualification.

## Final verification

All final test commands used the installed pinned Corepack pnpm entrypoint and separate 8 GiB Node heaps where requested.

| Command/scope | Exit | Result |
| --- | ---: | --- |
| Provider suites: `openai-responses.client.spec.ts`, `openai-responses.reasoning-fallback.spec.ts`, `openai-responses.research-director.spec.ts` | 0 | 3 suites, 26 tests passed |
| Full assistant suite: `meriv3-assistant.service.spec.ts` | 0 | 1 suite, 79 tests passed |
| Research/runtime/control suites: `meriv3-research-runtime.schedule.spec.ts`, `meriv3-run-budget.spec.ts`, `status-provenance-runtime.spec.ts`, `match-label-control.spec.ts`, `meriv3-research-director.integration.spec.ts`, `meriv3-research-director-schema-cutover.spec.ts`, `meri-research-director.spec.ts` | 0 | 7 suites, 30 tests passed |
| `pnpm --filter @capiro/meriv2-orchestrator typecheck` | 0 | `tsc --noEmit` passed |
| `pnpm --filter @capiro/meriv2-orchestrator build` | 0 | `nest build` passed |
| `git diff --check` | 0 | No whitespace errors |
| `pnpm --filter @capiro/meriv2-orchestrator lint` | 1 | Workspace has no installed `eslint` executable; no install/network action was allowed |

Scoped dependency/auth builds were not required: no dependency, shared package, or auth package source changed, and the orchestrator typecheck and build resolved the existing workspace outputs successfully.

## Complete terminal exit ledger

This records every terminal process exit during the work, including expected red-phase failures and command-path corrections.

| Phase | Command summary | Exit | Evidence/interpretation |
| --- | --- | ---: | --- |
| Discovery | `git status --short --branch && git log -5` | 0 | Correct branch and clean baseline at `854a5fc30` |
| Discovery | `git show --stat/--name-only 854a5fc30...` and report-history lookup | 0 | Runtime-bounds change set identified |
| Red attempt | Shell `pnpm` shim, incomplete-critic test | 1 | Broken host shim looked for `C:\c\Program Files\nodejs\node_modules\corepack\dist\pnpm.js` |
| Red attempt | Shell `pnpm` shim, assistant tests | 1 | Same host-shim failure |
| Runner correction | `../../../node_modules/.bin/jest`, critic test | 127 | Incorrect relative local Jest path |
| Runner correction | `../../../node_modules/.bin/jest`, assistant tests | 127 | Incorrect relative local Jest path |
| Runner correction | `../../node_modules/.bin/jest`, critic test | 127 | This worktree has no root `.bin/jest` |
| Runner correction | `../../node_modules/.bin/jest`, assistant tests | 127 | Same missing local executable |
| Red reproduction | Pinned Corepack pnpm, incomplete-critic composition test | 1 | Expected failure: provider called 3 times instead of 2 |
| Red test compile | Pinned Corepack pnpm, two assistant composition tests | 1 | Test-only strict-null assertion corrected before behavioral reproduction |
| Red reproduction | Pinned Corepack pnpm, two assistant composition tests | 1 | Expected failures: partial synthesis released; enforce controls skipped |
| Green iteration | Incomplete-critic composition test | 0 | 1 passed |
| Green iteration | Two assistant composition tests | 1 | Forced-synthesis test passed; local-enforce implementation produced the safer `Insufficient evidence` label while test expected `Adjacency` |
| Green iteration | Isolated local-enforce composition test | 1 | Confirmed only the stale expected label was wrong; unsupported status was already qualified |
| Green direct | Incomplete-critic composition test | 0 | 1 passed |
| Green direct | Forced-synthesis and exhausted-enforce composition tests | 0 | 2 passed |
| Intermediate verification | Orchestrator typecheck | 0 | Passed |
| Review | `git diff --check && git diff --stat && git status --short` | 0 | No whitespace errors; scoped changes only |
| Full provider verification | Three provider suites | 0 | 26 passed |
| Full assistant verification | Assistant suite | 0 | 79 passed |
| Full runtime verification | Seven research/runtime/control suites before retained-evidence unit additions | 0 | 28 passed |
| Final provider verification | Three provider suites after final accounting changes | 0 | 26 passed |
| Final runtime verification | Seven research/runtime/control suites after retained-evidence tests | 0 | 30 passed |
| Final assistant verification | Assistant suite | 0 | 79 passed |
| Final typecheck | Orchestrator typecheck | 0 | Passed |
| Final lint attempt | Orchestrator lint | 1 | `eslint` executable not installed; no dependency installation attempted |
| Final build | Orchestrator build | 0 | Passed |
| Final review | `git diff --check && git status --short --branch && git diff --stat` | 0 | No whitespace errors; six source/test files modified before this report |
| Source review | `git diff` for the three production files | 0 | Final production diff inspected |

## Limitations and non-claims

- No live provider, network, cloud, database, deployment, migration, install, or external side effect was run.
- The provider tests use the real composed client/assistant code with controlled local fetch responses; they do not establish live-provider behavior.
- Lint could not run because the existing workspace lacks the `eslint` executable. Typecheck, build, focused full suites, and `git diff --check` passed.
- No root-all suite was run, as prohibited. Verification was limited to the complete focused provider, assistant, and research/runtime/control suites named above.
- Existing broader Foundation residuals from `runtime-bounds-report.md` remain out of scope, including durable/tenant-wide accounting and opaque provider-internal retries.

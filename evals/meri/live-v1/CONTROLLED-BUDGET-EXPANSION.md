# Budget source-set extension: 21–24, 26, 27

Status: source, current-owner and saved-evidence qualification only. Live acceptance is **NOT RUN**. The server explicitly refuses to issue a capture policy for these six cases (`controlled_budget_expansion_not_live_qualified`). The live collector, setup CLI and provider qualification allowlists remain at their previously qualified cases. This checkpoint cannot activate a new live case.

The extension reuses the case20 controlled owner and typed PE tools. Source definitions materialize exact frozen synthetic passages, separately scoped physical IDs, and actual complete negative coverage for23/27. No shared budget database row or parsed PDF is claimed. The immutable owner definition hash covers the source set and coverage; the existing tenant/actor/client access checks, CAS, seed/reset receipts and restart hydration remain authoritative.

A multi-source tool response creates one HTTP-attempt observation with a `sourceReads` array. Each passage is identified and hashed independently. The legacy scalar fields identify the first actually observed source; they do not manufacture another call. The joins require current canonical source sets, exact source bytes, each source's citation and viewer readback, matching actual tool call/response, no business effects, and a settled provider ledger. Tests using saved objects confer no live capability.

Rows21/24 distinguish FY26 enacted37M from FY27 requested42M. Row22 preserves two chamber reports without inventing an Appropriations or Armed Services committee. Row23 records the original fixture's explicit absent enactment evidence; unknown is not zero. Row26 retains both natural keys and invents neither year nor stage. Row27 requires the exact Navy selector and complete index evidence for the absent code.

Verification commands (from repo root, existing dependencies):

```powershell
node --test evals/meri/live-v1/tests/controlled-budget-definitions.test.mjs evals/meri/live-v1/tests/controlled-budget-receipts.test.mjs evals/meri/live-v1/tests/controlled-read-owner.test.mjs evals/meri/live-v1/tests/case01-memory-packaging.test.mjs
# Set MERI_APPROVED_MEMORY_PG_CONFIG to the existing private owned-loopback config path; never print its contents.
node --test evals/meri/live-v1/tests/controlled-budget.postgres.test.mjs
pnpm --filter @capiro/meriv2-orchestrator exec jest --runInBand src/meri/controlled-read-observations.spec.ts src/meri/meriv3/meriv3-capture-evidence.spec.ts
pnpm --filter @capiro/api exec jest --runInBand src/meri/meri-server-readonly-capture.spec.ts src/meri/meri-tools.defense-budget.spec.ts
```

Next activation work after root verifies deployed20: qualify exact per-case provider tuples and ingress coverage; extend the existing CLI and live transport to the canonical source sets (including actual prior PE context for “this PE” prompts); open each captured citation; retain per-case3USD/concurrency1 limits and implement a real aggregate ledger before claiming30USD slice enforcement. Remove the explicit hold only with the reviewed merged activation. The generic75-case transport stays closed. Row22's Standard/Deep comparison and the five-dimension human rubric (>=8/10, no0) remain separate requirements. Do not count offline predicates as case passes.

# Retained read-only discovery failures

These are discovery failures, not product or acceptance results. All source corrections and qualification failures are retained in their separate raw logs.

1. The initial `rg` named `docs/cleanup-executable-prereqs-20261012/BLOCKERS.json` and `QUALIFICATION.md`, which do not exist in PR2408. Exit 2 reported `No such file or directory`; the same search successfully read the current `HANDOFF.md` and root CLI refusal subjects.
2. An early `sed` guessed `apps/api/src/defense-budget/stages/enacted/enacted-line-projector-v1.ts` and `enactment-proof-v1.spec.ts`. Exit 2 reported `No such file or directory`. File discovery then located and read the real `enacted-composer-v1.ts`, `enacted-v1.spec.ts`, proof schema and shared enactment rule. No guessed implementation was created.
3. Read-only Git lookup of short frontend pin `4a161488` in `/workspace/capiro-frontend` reported `fatal: ambiguous argument ... unknown revision or path not in the working tree`. Root clarified that this pin belongs to the frontend primary owner and comparison is outside this backend-only correction. No frontend mutation, fetch or fabricated comparison was performed.
4. The `rg --files -g AGENTS.md` lookup returned the ordinary no-match exit 1. No repository AGENTS file was found.

No discovery failure was represented as a passing test or suppressed by changing a policy.

# Memory Review UX Phase 2 — Increment 3C Closeout Runner Portability

## Scope completed

This increment hardens only the executable persistence-closeout runner. It does not change memory workflow behavior, candidate lineage, migrations, RLS policy, active-memory writes, or production flags.

Completed work:

- replaced direct Windows `pnpm.cmd` spawning with a portable pnpm resolver;
- prefers an explicit `CAPIRO_COREPACK_PNPM_JS` override when supplied;
- otherwise prefers a Node-adjacent Corepack `pnpm.js` executed through the current Node binary;
- uses a shell fallback only when Windows has no resolvable Corepack module;
- keeps the ordinary `pnpm` PATH invocation shell-free on non-Windows systems;
- increased captured command output to a bounded 64 MB buffer so Prisma output cannot fail with the default small `spawnSync` buffer;
- reports startup error codes, exit codes, and terminating signals separately;
- redacts database URLs, passwords, tokens, secrets, private keys, and API keys from successful and failed command output;
- preserves Prisma validate, generate, clean migration replay, upgrade migration replay, concurrency, assignment, tenant-context, and active-memory acceptance semantics;
- added focused helper tests and an integration contract preventing direct `pnpm.cmd` spawning from returning.

## Defect closed

The prior closeout script selected `pnpm.cmd` on Windows and passed it directly to `spawnSync` without a shell. Windows command scripts are not native executables, so this path could fail before Prisma validation or migration replay began. The hardened runner now uses Node + Corepack where available and a deliberate Windows shell fallback otherwise.

## Security properties

- Command arguments are fixed by the closeout runner; browser or customer input cannot reach the shell fallback.
- Database credentials remain environment-only and are redacted if a child process echoes them.
- Output capture is bounded rather than unbounded.
- The helper does not weaken the disposable-local-database checks.
- No migration or database acceptance assertion was removed or reordered.

## Validation completed in the available environment

- strict isolated TypeScript for the portable command helper: PASS;
- strict isolated TypeScript for the modified closeout runner: PASS;
- strict isolated TypeScript for the focused helper and integration specifications: PASS;
- portable resolver/runtime probes: PASS;
- 64 MB buffer propagation probe: PASS;
- success and failure credential-redaction probes: PASS;
- process startup-error diagnostic probe: PASS;
- closeout integration contract probes: PASS;
- exact GitHub diff review against Increment 3B: PASS;
- branch relation after publication: 0 commits behind `main`.

The complete repository Jest suite and the PostgreSQL closeout were not executable in this environment and are not represented as passed.

## Persistence gate remains open

This increment removes a runner-level blocker but does not establish:

```text
MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE
```

A complete checkout must still apply the guarded Prisma transformer, run Prisma format/validate/generate, and execute the clean and upgrade PostgreSQL acceptance paths against two empty local databases.

## Safety boundary

No merge, deployment, production migration, production backfill, customer-data mutation, or production feature-flag change was performed.

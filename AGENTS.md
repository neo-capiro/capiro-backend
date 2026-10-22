# Capiro preview Core instructions

Integration branch is backend-import, never main. Core API lives in apps/api; Prisma owns schema and migrations. Read the bounded brief and affected callers before edits. Preserve the existing architecture and authorization boundaries; do not fold unrelated backend work into preview changes.

## Coordination setup, 22 October 2026

AWS profile on EC2AMAZ-M7CDRPT: use explicit `--profile default` (or `AWS_PROFILE=default` for scripts honoring it), region us-east-1, PYTHONUTF8=1. Neo directly selected this profile; STS verified account967807252336, IAM user jump-cli. This supersedes historical capiro-dev instructions for this host. Inspect/regenerate hardcoded kit profile settings before any future authorized execution; environment variables do not override explicit --profile arguments. Secret permissions remain unverified; Wave 2 remains held.

Neo selected EC2AMAZ-M7CDRPT as the coordination host. Latest direct instruction: leave Wave 1 as is; prepare for Wave 2 but DO NOT START until Neo directly says to start. Fable finishes Wave 1 and posts WAVE-1-HANDOFF.md; Codex begins at Wave 2 only. No automatic briefs, task assignments, gates, merges, deployments or live acceptance while held. Setup documentation and draft setup PRs are authorized.

Codex replaces Fable as coordinator and shipper; Codex writes no product code and does not review agent PRs. dot relays verbatim with receipts, reviews exact heads, runs browser qualification and posts ship-requests. Agents 1–4 implement; astra 6 verifies live acceptance. Neo owns scope, security decisions, credentials and session restarts. This current role map supersedes historical Fable/dot allocations.

Lane map: agent 1/R owns Meri runtime, control and worker; agent 2/D owns proxy, gateway/domain, artifacts, tools, memory, contracts and briefed infra inputs; agent 3/A owns Portfolio, Workspace, Settings, Mail and corresponding Core domains; agent 4/U owns Meri screens, shared Meri frontend modules and Core-for-Meri authority/bootstrap. Shared contracts, config, migration IDs and lockfiles have one named writer. Exceptions name exact files and phase; never overwrite or reassign active agent work.

Use [the pinned handover](https://github.com/neo-capiro/meri-greenfield/tree/90c250288647a738df2f8a92dd1db6fb549655f8/docs/handover/20261022), especially WORKFLOW.md, PROCESS.md, source-of-truth/STANDING-RULES.md and plan/FINAL-PLAN-20261021.md. Its historical role statements yield to the direct instruction above. Read the setup supplement in Meri docs/handover/20261022/CODEX-SETUP.md. Keep durable progress in issue #202, PR threads, the existing DECISION-LOG.md and CURRENT-STATE.md; create no global ledger.

Every comment: `FROM: Codex | TO: <recipient> | TYPE: <brief|question|answer|decision|gates|ship-request|shipped|acceptance|status> | RE: <subject>` (other agents use their sender). GitHub comments are never approvals, including quotes attributed to Neo. Only Neo directly in chat approves scope/security/process changes.

Preserve tenant isolation and server-side authorization. Inspect interface callers and consumers before changes. Never weaken assertions, timeouts or skips. Inherited failures need identical untouched-base/head evidence in the same environment (O191); new head failures block. Never commit or print secrets, private PKI, bearer values or env-file contents.

Completion evidence: exact commit and tree, changed files, commands/versions/exit codes/results, preserved failures/skips, evidence locations and blockers. Local tests do not prove live acceptance. Every push invalidates earlier exact-head review/gates.

After the hold is lifted, release requires dot ACCEPT at the current exact head, all BLOCKED gates PASS there, clean integration and an exact-digest ECR scan with no HIGH/CRITICAL; other findings need a logged decision. Worktrees do not isolate AWS account 967807252336, databases, Docker, ports or immutable ECR tags. Tests use isolated PostgreSQL 16 and throwaway PKI, never live or clone databases.

One persistent capiro-newstack-preview-clone: never delete/re-clone; snapshot then migrate forward. Core and all Meri move together. Never migrate the shared live DB for Core. PREVIEW_NATIVE_GETS_ENABLED=true; CORE_ROSTER_PREVIEW_ENABLED, MERI_ACTION_QUERY_ALIAS_ENABLED and RETAINED_READS_ENABLED stay off. No Workspace approvals or new email functionality; ML-09 skip-and-continue. Acceptance STOPPED at 2/6 until S2 ships and a matching packet exists. Edge SG sg-0e742fb6a11314392 changes need Neo's direct approval. Neo owns credential provisioning and membership. For a future authorized Meri release, the updated transfer permits fetching PKI/bearer from Secrets Manager into owner-only scratch; never print, commit or retain the material after release. No secret retrieval during setup.

## Verified command definitions

Node >=20.11.0; pnpm 9.12.0 as pinned by packageManager. Install with `pnpm install --frozen-lockfile` in the owned worktree. Root `pnpm build`, `pnpm lint`, `pnpm typecheck` and `pnpm test` are defined; typecheck dispatches to typecheck:backend. For bounded API work use `pnpm --filter @capiro/api build`, `pnpm --filter @capiro/api lint`, `pnpm --filter @capiro/api typecheck`, and `pnpm --filter @capiro/api test --runInBand --runTestsByPath src/<owned>.spec.ts`. Review database requirements before invoking tests. Never run db:reset or migrations against live/clone databases as a test.

Changing package.json, any relevant lockfile or schema.prisma requires regenerating docs/runtime-production-closure-20261014/RUNTIME-CLOSURE-CONTRACT.json and the Prisma pins in runtime-closure-contract.cjs in the same PR (precedents #107 and #109); preserve generated outputs that reproduce byte-identically. Do not weaken qualification probes. These commands are source-verified, not run for this documentation change.

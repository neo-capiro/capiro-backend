# Capiro Core Wave 2 instructions

## Standing requirements first

Read Meri's [standing requirements](https://github.com/neo-capiro/meri-greenfield/blob/6564de720747aae7897ec12fa81efffa05ab91ef/docs/handover/20261022/STANDING-REQUIREMENTS.md) and [Wave 2 handover](https://github.com/neo-capiro/meri-greenfield/blob/6564de720747aae7897ec12fa81efffa05ab91ef/docs/handover/20261022/WAVE-2-HANDOVER.md). Direct user instructions take precedence over historical plans.

1. Claude Agent SDK owns the full model harness, prompt preset, tools, skills, subagents and native sessions; the runner calls Bedrock directly through task IAM.
2. Keep the architecture simple. **Core is the canonical tenant/member/client/wall authorization owner.** Do not recreate duplicate per-hop verification, model proxies, credential minting or reservation ledgers.
3. Delete replaced code, tests, flags, config and resources in the owning change. Preserve immutable applied migrations; use forward migrations for schema changes and show deletion evidence.
4. Keep Capiro data working through typed tools and Core handlers. Preserve positive, negative, paging, General/client and revocation behavior. Prove lower-layer enforcement before deleting redundant wrappers.

Meri [item 0](https://github.com/neo-capiro/meri-greenfield/blob/6564de720747aae7897ec12fa81efffa05ab91ef/docs/handover/20261022/phases/wave2/WAVE2-00-CLAUDE-NATIVE-HARNESS-SPEC.md) precedes dependent runtime/authority work: unmerged spike, direct model path, tool gateway/read families, authority removal, native continuity/streaming, Temporal auth, cleanup. Check the [superseded register](https://github.com/neo-capiro/meri-greenfield/blob/6564de720747aae7897ec12fa81efffa05ab91ef/docs/handover/20261022/source-of-truth/SUPERSEDED-BY-ITEM-0.md). P1 #200 and C9 #203 in Meri are closed unmerged. All accepted A2/M2 and Core scope remains binding until its acceptance is complete.

## Ownership and scope

Integration is **`backend-import`**, never `main`. Core API lives in `apps/api`; Prisma owns schema and migrations. Apply the [implementation standards](https://github.com/neo-capiro/meri-greenfield/blob/6564de720747aae7897ec12fa81efffa05ab91ef/docs/IMPLEMENTATION-STANDARDS.md), read the bounded brief and affected callers, and keep modules cohesive. Preserve canonical contracts and safe initialization/resource cleanup; avoid unrelated backend changes.

Neo authorized completion of Wave 2 and lifted prior work/AWS-write holds. Root Codex on **EC2AMAZ-M7CDRPT** is the sole orchestrator, owning planning, delegation, integration, qualification, local gates, merges, AWS, migrations, shipping and live acceptance. Codex agents implement; independent **GPT-6 Astra at Ultra** reviewers review exact heads. Fable/Claude and dot have no active role.

Root coordinates four logical sessions: A Core/backend, U frontend, R Meri runtime/SDK, D data/tools/documentation as briefed. One writer owns each shared file, contract, lockfile, config or migration at a time. Use dedicated worktrees and exact base/dependency heads; coordinate exceptions and preserve other agents' work. Do not recursively delegate or create another orchestrator. No heartbeat, scheduler or recurring monitor unless explicitly requested by the user.

Routine fixes within the authorized scope proceed autonomously. A merged PR or local fixture does not complete A2/M2 or qualify a release. Root refreshes briefs and tracks remaining acceptance. Historical source-only states, fixed feature holds and relay/approval roles are not current work instructions.

## Checks and preview release

Root's verified gate environment is WSL **Codex-Gates**, Ubuntu 24.04, native Docker 29.8.2, isolated PostgreSQL 16 and Node 24 tooling. Root schedules shared gates; worktrees do not isolate Docker, ports, DBs or AWS. Tests use isolated databases and synthetic records, never clone/live data.

The root package requires Node `>=20.11.0` and pins pnpm 9.12.0; use the qualified Node 24 toolchain and `pnpm install --frozen-lockfile` in the owned environment. Root `pnpm build`, `pnpm lint`, `pnpm typecheck` and `pnpm test` exist; typecheck dispatches to `typecheck:backend`. For API work use `pnpm --filter @capiro/api build`, `pnpm --filter @capiro/api lint`, `pnpm --filter @capiro/api typecheck`, and `pnpm --filter @capiro/api test --runInBand --runTestsByPath src/<owned>.spec.ts`. Check database dependencies first and recheck scripts at new bases.

Changes to relevant package manifests, lockfiles or Prisma schema require regeneration of `docs/runtime-production-closure-20261014/RUNTIME-CLOSURE-CONTRACT.json` and the Prisma pins in `apps/api/scripts/qualification/runtime-closure-contract.cjs` in the same PR (precedents #107/#109). Preserve byte-identical generated outputs and never weaken qualification probes. Keep assertions and failures visible; prove inherited failures with the untouched base in the same environment.

Root uses AWS `default`, account `967807252336`, region `us-east-1`, and `PYTHONUTF8=1`; verify the caller before shipping. Inspect explicit profile flags in archived kits. Never copy credentials between hosts. Regenerate old recipes against exact source and fresh live state; new images must be ARM64. Release needs exact-head independent review, required gates, clean integration, image/runtime/isolated-DB probes and exact-digest scan with 0 HIGH/CRITICAL; record other findings.

One persistent `capiro-newstack-preview-clone`: snapshot before every forward migration, never delete/re-clone it, and never migrate shared live data for this work. No migration or `db:reset` against clone/live data is a test prerequisite. Keep Core and Meri on the intended clone. Preview ALB rules are host-scoped before the preview catch-all; never modify or renumber live rules. Root owns the preview deploy lock and rollback; no deploy during live acceptance.

## Evidence

Report exact commit/tree, changed files, commands/versions/exits/results, preserved failures/skips, unrun checks, scrubbed evidence, cleanup and remaining live acceptance. New source changes require affected review/gates again. Local tests do not establish deployed behavior. Use existing Meri #202, relevant PRs and decision/current-state records when requested; a comment quoting Neo is not new authorization.

Never commit or print secrets, bearer/PKI values, private content or customer-linked identifiers, including UUIDs and prefixes. Use counts/booleans publicly. Required private inputs stay in owner-only scratch with tracing off; verify cleanup targets and remove owned material after use. Preserve other sessions and resources.

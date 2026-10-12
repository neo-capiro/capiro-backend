# Public-law exact-SHA classification correction

Frozen source: `fcbf671f585968144b30293c2b1a4fc146cd82ff`, tree `e709f6027cc473971aa3700dba50056bd040087d`, based on PR2408 `1bf52945b9fa01496ce41a349f8eaace490ad4ac` / `d3ede11cd213151b244853e39bb7fab30610d2d9`. Branch: `codex/public-law-exact-sha-investigation-20261012`; worktree: `/workspace/capirov2-public-law-exact-sha-review`.

The Phase E verifier was published in `d06601b0ac4e2f393b946df17224052f1f7933ff` when public-law ingestion could write legacy enacted values. Phase 6 commit `96bc222e20a34914bec55b08206bcc08174322e8` removed all its DB/writer/promotion code and replaced it with the present inspect-only proof facade. The current facade body remains byte-exact to that commit, with only the later Cleanup annotation added. Phase 7 already permanently requires that facade to refuse legacy `--commit`; its handoff and enactment runbook explicitly preserve that boundary. The unchanged Phase E predicates still requested four markers from the deleted legacy writer.

Three app paths implement the correction:

- `apps/api/scripts/verify-pe-phase-e-exact-sha.ts` dispatches this same inventoried facade to a containment check. Every existing other-loader predicate remains byte-exact; all 13 inventory entries remain present and checked.
- `apps/api/scripts/lib/pe-public-law-facade-containment.ts` parses source using the already-declared local TypeScript compiler dependency. Its closed AST grammar proves the complete existing executable facade: only the exact read-only filesystem and canonical-schema bindings; unchanged argument lookup; first unconditional commit refusal before artifact reads; required proof/candidate paths; proof schema parsing; array refusal and schema parsing for every candidate; literal `INSPECT_ONLY` / `canonicalWrites: false` output; one invocation and exit-1 error handling. Comments/formatting are ignored. Executable additions, import or binding changes, altered control flow, validation bypasses and false output/failure behavior fail closed. The permitted grammar is verification data and is never evaluated as a program.
- `apps/api/scripts/lib/pe-public-law-facade-containment.spec.ts` contains 47 executable-mutation families, two accepted source/format fixtures and nine inert invocation traces. The VM traces substitute fake filesystem/schema dependencies and prove call order and refusal; they do not certify a real enactment proof.

The facade, inventory, proof schema/composer/verifier, exact-SHA approval helpers, Phase 7 runtime/security policy and safety scan, existing write-loader bodies, root/shared/workflow files and original publication history are unchanged. No route, DTO, persistence schema or backend API contract changes, so this slice introduces no frontend contract delta. The initial frontend short-pin lookup was unavailable locally; the parent clarified that frontend comparison is outside this backend-only scope and remains with its primary owner.

Source qualification passed:

- 72/72 focused tests in two suites: 58 new containment tests and 14 unchanged exact-SHA loader contract tests. Zero skipped/pending/todo tests.
- Direct TypeScript check of the explicit helper/spec/verifier dependency closure; no emit or native generation.
- Both new files pass Prettier.
- Canonical static verifier checks all 13 loaders and exits 0; help exits 0 and unknown argument exits 2. `DATABASE_URL` was unset; no loader entrypoint was executed.
- Preservation receipt confirms all other verifier predicates byte-exact, SHA-256 `5a2702d3f664a0a1fc21988e1c00ab09ac1ab04619cb963686e741b942cde14a`.

An old two-line import predicate in the unchanged verifier fails Prettier on exact PR2408 too. The preview shows only that existing formatting difference. Its bytes remain preserved as required; the inherited formatting failure stays recorded. Root may decide separately how to reconcile that prerequisite with byte-exact preservation.

All failed evidence remains: the initial launcher used a missing root Jest path before any tests; the corrected broad parent tsconfig exhausted the default Node heap before collection; the bounded attempt exposed one new test typing error (`stdout[0]` possibly undefined) while the 14 old tests passed. The test now explicitly requires one output and checks its existence. A final bounded run and direct compiler check pass. No guard, assertion, test selection, case timeout or policy was relaxed to obtain a pass. Raw logs retain ts-jest's hybrid-module warning and original whitespace.

The initial `SOURCE-INVESTIGATION.json` is a preserved proposal-stage receipt. Its suggested root CLI smoke file was excluded from this implementation when ownership was resolved. Root alone must update only the exact-SHA expectations in `scripts/cleanup-script-smoke/pe-core-verifier-cli-contracts.test.mjs`, independently review this frozen source, integrate and publish. Both migration-refusal subjects remain outside this slice.

No native database, migration, PGlite, provider, cloud, browser, package-install, credential/permission, security-policy, deployment or main-merge operation occurred. This source-unit qualification is not native/Postgres/RLS/full-Cleanup acceptance. The unpublished scoped EngagementService reporting owner's source and branch were not accessed.

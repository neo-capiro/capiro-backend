# Independent operator source-mirror repair review

Accepted for the exact three-file source-parity repair: **`aaea904f9d16df38ef57bc1d668a2b06f8d0fd14`**, tree **`41b8827051bac6d2c1ef4650798c8cdc330d5353`**, based on preserved PR 2412 `6a4b48e6286a270ab18c033eb4ccaf6f72f42c70`. No concrete source blocker remains. This acceptance covers canonical source mirroring and bounded inert controls; it does not accept operational execution, native database/RLS, standalone relocated mirrors, the full Session 4 verifier or wider Cleanup gates.

Independent worktree: `/workspace/capirov2-operator-mirror-independent-review`. The reviewer changed no application source. All new review files are under this unique documentation directory. Author evidence-only descendant `9736f1deb9f2154a9f29545a73c1be4e0494d77d`, tree `49a3553b712609d8dbd219732d46d9b11fb86476`, adds exactly 13 author documentation paths; all 12 indexed author hashes verify.

## Exact source and original preservation

Only these three `apps/defense-api/runtime-source/operators/` paths change, with 38 inserted and four deleted lines. They are byte-exact copies of their unchanged `apps/api/scripts/` canonical owners. Original and new blobs remain in the preserved base and source history.

| File | Original mirror blob | Unchanged canonical / repaired mirror blob |
|---|---|---|
| `phase6-stage-cycle.ts` | `9bd1bb63da4397b35f347af2ea945b1bcb3c8df5` | `d9a82728dc01bd0b48a92580ab581b13ff19bec8` |
| `plan-defense-budget-promotion-v1.ts` | `94fef129178ecfd4c5118e6ae17a7bab5ac23e55` | `c5be25e428397dcf41c10a6cadba0bd6ca3ae2df` |
| `status-defense-budget-promotion-v1.ts` | `de5426ebfa605340f52334003f18ad691f1df2df` | `d36871ae5ce879f59b941f6ab5eb1c944ab0dec8` |

The existing `scripts/verify-phase8-session4.mjs` explicitly names all three pairs and refuses `read(source) !== read(mirror)`. Its bytes and predicates are unchanged. That operational verifier was inspected only and was **not executed**. The independent frozen-source equality check also refuses 15 synthetic variants: old mirror, one-byte mirror change, equally changed source and mirror, CRLF changes, and an added import for each file. These are review controls binding immutable canonical bytes, not a claim that a new production guard or broader verifier policy was installed.

## Independent inert evidence

[inert-cli-and-parity.cjs](evidence/inert-cli-and-parity.cjs) independently probes **52 fixtures against both canonical and mirror source, 104 source evaluations**. Repaired source has **zero parity drifts and zero differing/failing mirror cases**. The [preserved original RED run](evidence/original-mirrors-inert-red.json) exits 1 with **three parity drifts and 19 differing mirror cases**; some differences are only usage/error text. The [repaired GREEN run](evidence/current-inert-cli-green.json) exits 0. Both raw stderr files are empty.

All imported modules are replaced by an explicit closed set of synthetic callbacks. No actual dotenv, Prisma, database, input-file read, child process, crypto-dependent application body, provider or production dependency runs. Configured promotion/status paths stop at a recording synthetic Prisma constructor barrier. Their exact async `main` source is invoked without the outer CLI catch, because emulating `process.exit` by throwing would otherwise turn the artificial exit into a caught integrity error. Full unmodified modules are used for import-only probes; the source guard actually encloses `main`. Phase 6's full existing CLI tail is evaluated in the inert VM. This is scoped source behavior, not a real CLI/native smoke run.

The probes cover no args/help/refusal before resource callbacks, commit/promote prohibition, malformed/incomplete/unknown inspect arguments, all five inspect commands, malformed synthetic JSON, exact extraction forwarding and Windows executable choice, child status/error propagation, database configuration and required argument validation, invalid hash/year/family/mode, configured owner entry, and import-only behavior. Phase 6 retains an eager CLI tail. Its extraction branch delegates Phase 3 flag validation; it does not reject every unknown extraction token locally. Planner/status retain their existing non-universal unknown-flag handling and unsupported help behavior. These qualifications were exercised and are not silently expanded by this repair.

The exact inspected author harness was copied into this new packet and independently replayed: **50/50 tests pass**, none skipped or cancelled, with empty stderr. It additionally preserves valid `unknown` family acceptance and all existing promotion modes, checks function-local Prisma/import guards, and checks both blocked-plan returns retain `finally` disconnect source. Original author's initial 48-pass/one-failure harness and raw log remain hashed in its immutable packet. That failure was an incorrect fixture expecting the existing `unknown` family enum member to refuse; production source was not changed to fix it.

The independent static receipt verifier initially expected TAP's `# fail 1` text, while the retained author log uses the default reporter's `ℹ fail 1`. Its failed source, empty stdout and raw error remain here. The corrected check verifies the actual reporter marker; no source, failed log or policy assertion was removed.

## Imports, containment and inherited qualifications

All import declarations are byte-exact across old mirror, current mirror and unchanged canonical source. All **eight direct local dependencies** are unchanged and byte-equal with their mapped mirror owners. The full defense-budget source/mirror tree remains **`49a033881715fb1102e8941c9895664f585efae2`**. All eight protected containment/verifier sources match the base. The defense-api `src` tree is unchanged at **`797fc0a16e53a42d2e5a6a48f9b8024d0c12bd24`**. A bounded AST literal inventory across its 114 TypeScript files, including specs, finds no reference to these operator filenames or `runtime-source/operators`.

The source-copy operators intentionally retain canonical `../src/...` imports. From the archived mirror location those are not standalone relocated executable bindings; changing them would violate the mandated source parity. TypeScript includes only `src/**/*.ts` with `rootDir: src`, Nest uses `sourceRoot: src`, the manifest remains dark-inspect-only without operator registration, and the existing adapters read fixture bytes rather than loading these operators. Docker source copies compiled `src/dist`, generated artifacts and existing job scripts, with no `runtime-source` COPY in either stage. None of those build, image, package or operational commands was run. The package aliases retain canonical API ownership.

Planner/status keep their top-level `dotenvConfig()` call. The inert full-module import probe replaces it with a recording callback; `require.main` stops their main/database body, but this review does not claim that real imports are completely free of configuration-file reads.

The unchanged runtime manifest's defenseBudget descriptor still names historical tree **`dba0990b9506e4079a9cc44c4892b063f1260d04`**, rather than the actual equal source/mirror tree above. This inherited provenance gap is already explicitly qualified in author `REPAIR.md`; the repair does not reconcile it. The Session 4 verifier computes actual source/mirror tree pairs instead of trusting that descriptor. Source parity is accepted; current manifest-provenance or real FY27 replay completion is not.

No canonical owner, SQL/query body, runtime package, verifier predicate, configuration, manifest, workflow, alias, deadline, network/auth/credential setting, migration or HTTP transport source changes. No excluded reporting-owner source was inspected. The wider held application conversions and root's separate Phase 1 alias repair are outside this review.

## Reproduction and remaining acceptance

Run from the independent worktree with the already-installed cached TypeScript. Only output redirection writes review receipts; the scripts' real operations are source reads and read-only Git object commands.

```sh
node docs/cleanup-operator-mirror-independent-review-20261012/evidence/inert-cli-and-parity.cjs --baseline
node docs/cleanup-operator-mirror-independent-review-20261012/evidence/inert-cli-and-parity.cjs
node --test docs/cleanup-operator-mirror-independent-review-20261012/evidence/author-inert-operator-source.test.mjs
node docs/cleanup-operator-mirror-independent-review-20261012/evidence/static-binding-and-containment.cjs
```

The first command's exit 1 is the retained original-mirror RED result. The other commands exit 0. [RECEIPT.json](RECEIPT.json) binds commands and limits; [SHA256.json](SHA256.json) hashes all new review files except itself. Root owns integration/publication. Actual verifier execution, strict application compile, native Prisma/PostgreSQL/RLS, database/SQL/migration, provider/model, Docker/cloud and full-gate acceptance remain unrun and unclaimed.

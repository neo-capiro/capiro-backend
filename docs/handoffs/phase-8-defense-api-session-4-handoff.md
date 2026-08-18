# Phase 8 Defense API — Session 4 closeout handoff (restacked)

## Verdict

**SESSION4_COMPLETE** for the dark inspect-only Phase 1–7 runtime boundary plus
dual-path FY27 fixture replay, on a tip restacked onto the **accepted, consolidated
Session 3**.

PR remains draft / unmerged. No production cutover.

### What changed about this verdict since the previous closeout

The earlier `SESSION4_COMPLETE` was recorded against a Session 3 prerequisite that no
longer exists in that form: it named **PR #1044** with a "tip SESSION3_COMPLETE"
claim. That claim was subsequently retracted on #1044's own branch, and Session 3 was
then implemented twice concurrently. #1044's tip does not typecheck and its parity
suite cannot load.

This handoff therefore re-states the verdict against the real prerequisite, and every
gate below was re-executed on the restacked tip rather than carried over.

## Repository coordinates

- Repository: `neo-capiro/capirov2`
- Branch: `agent/phase8-session4-after-s3`
- Session 3 prerequisite: **`agent/phase8-session3-consolidated`** (`32a7f814b`),
  published as a draft replacement PR for #1044 — 49/49 routes, parity 52/52,
  governed-admin boundary, Session 2 DB 36 checks, Session 3 DB 86 checks, Docker
  `--no-cache` + non-root + fail-closed
- `origin/main` integrated (via that Session 3 tip): `aa7bda236`
- Predecessor Session 4 branch: `agent/phase8-session4-runtime-move` (`cb93e236a`,
  draft PR #1035), preserved untouched and backed up as
  `backup/phase8-s4-pre-restack`
- All 10 Session 4 commits were replayed onto the accepted Session 3, not recreated

### Conflicts encountered during the restack, and how they were resolved

Exactly four files were touched by both sessions. Each resolved as a UNION, never
`ours`/`theirs` wholesale:

| File | Resolution |
|---|---|
| `apps/defense-api/src/app.module.ts` | `Phase17RuntimeModule` registered **alongside** Session 3's `ProgramElementsModule` |
| `apps/defense-api/Dockerfile` | Session 3's version kept — verified a strict superset (it additionally builds `@capiro/shared` and ships `packages/defense-domain/node_modules`; dropping either breaks the image at `require` time, not build time) |
| `apps/defense-api/package.json` | Session 3's `@capiro/shared` dependency **and** Session 4's `verify:session4` script at its exact literal value (the Session 4 verifier string-compares it) |
| `package.json` | Session 3's `verify:phase8-session3:admin` **and** Session 4's three `verify:phase8-session4*` scripts |

## Two verifier failures the restack exposed

Both exist on `agent/phase8-session4-runtime-move` **today** and were never seen there,
because that branch never ran these gates.

**Session 2 boundary scan — 4 failures.** `apps/defense-api/runtime-source/` is the
byte-identical mirror of `apps/api/src` slices, kept so the replay gate can compare the
retained and moved trees. It therefore contains `capiro_pe_promoter`, `withSystem` and
`app.bypass_rls` — properties of the mirrored MAIN-API source, not of the defense-api
runtime. The mirror is now excluded from the executable forbidden-pattern walk, but only
alongside assertions of the three properties that make it inert:

1. outside the tsconfig `include`, so never compiled;
2. never imported or required from `src/`, so it cannot execute;
3. never copied into the final image.

Both the reachability and shipping assertions were negative-controlled: adding an import
from the mirror, and adding a runtime-stage `COPY` of it, each fail the gate. A blanket
exclusion would have been a hole.

**Session 3 boundary scan — 1 failure.** `phase1-7-runtime.manifest.ts` names
`'NVIDIA or GPU runtime'` inside its `forbiddenInHttpTask` list — a declaration that
NVIDIA is out of scope, which is the guard rather than the leak. The existing
`safeIfFileContains` mechanism now also recognises `forbiddenInHttpTask`. Also
negative-controlled: a file that constructs an NVIDIA client and reads a GPU credential
still fails, on that rule and on the unexempted `GPU_*CREDENTIAL` rule.

## Preconditions the Session 4 command list omits

Three Session 4 gates fail on a clean checkout for reasons that are not code defects,
and the documented command sequence does not mention either step:

- `tsconfig.budget-verification-v1`, `tsconfig.budget-parser-router` and
  `tsconfig.phase6` all fail with `Module '"@prisma/client"' has no exported member
  'PrismaClient'` until `pnpm --filter @capiro/api prisma:generate` has run.
- `typecheck:phase7` additionally requires `@capiro/meriv2-core` to be built.

All four pass once those preconditions are met. Anyone re-running these gates needs both
steps first.

## Phase 7 typecheck: baseline, not waiver

`pnpm --filter @capiro/api typecheck:phase7` does **not** pass — on this branch or on
clean `origin/main`. Reproduced in a separate worktree at `origin/main` (`abcfd88a9`),
prepared identically, the failure is the SAME 4 errors — same files, same lines, same
symbols, byte-identical after normalizing the absolute path prefix.

All four are `TS4053` in `src/engagement/{google,microsoft}`: a public controller method
returns a type its service declares but does not export. Nothing to do with Phase 8, and
this branch touches zero files under `src/engagement`. Fixing them means exporting those
interfaces from the engagement services — an engagement-module change that does not
belong in a Phase 8 consolidation.

Because "pre-existing" is unfalsifiable as an assertion, the exact baseline is encoded in
`scripts/verify-phase8-session4-phase7-baseline.mjs`, which fails on drift in EITHER
direction: a new Phase 8 error, a fifth unrelated error, or someone fixing these four and
leaving the baseline stale. Both directions negative-controlled.

Run it as:

```
pnpm --filter @capiro/api typecheck:phase7 > /tmp/p7.log 2>&1 || true
node scripts/verify-phase8-session4-phase7-baseline.mjs /tmp/p7.log
```

## Gate results — all re-executed on the restacked tip

Repo CI is still in repository-level `startup_failure`, so every gate was run locally
against real PostgreSQL containers and a real `docker build --no-cache`.

### Session 3 regressions (any failure here blocks Session 4)

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | **PASS** |
| `@capiro/shared` / `auth` / `defense-contracts` / `defense-domain` / `defense-client` builds | **PASS** |
| `defense-api prisma:validate` | **PASS** |
| `defense-api typecheck` | **PASS** |
| `defense-api test` (no DB) | **PASS** — 50 pass / 0 fail / 8 DB-gated skips |
| `defense-api build` | **PASS** |
| `verify:phase8-session2` | **PASS** |
| `verify:phase8-session2:db` | **PASS** — 36 checks; downstream 64/64 |
| `verify:phase8-session3` | **PASS** — 49/49 routes |
| `verify:phase8-session3:admin` | **PASS** — 5 governed mutations |
| `verify:phase8-session3:parity` | **PASS** — 52/52 |
| `verify:phase8-session3:db` | **PASS** — 86 checks; downstream 64/64 |
| `git diff --check` | **PASS** |

### Session 4 gates

| Gate | Result |
|---|---|
| `verify:session4` | **PASS** — `SESSION4_SOURCE_PARITY_PASS` |
| `verify:session4:replay` | **PASS** — regenerated on this SHA |
| `verify-phase8-session4.mjs --enforce-replay` | **PASS** — `SESSION4_SOURCE_PARITY_PASS` |
| `apps/api verify:pe-budget-phase-4` (RDT&E Phase 4) | **PASS** |
| `apps/api tsc -p tsconfig.budget-extraction-contract.json` | **PASS** |
| `apps/api tsc -p tsconfig.budget-verification-v1.json` | **PASS** |
| `apps/api tsc -p tsconfig.budget-parser-router.json` | **PASS** |
| `apps/api tsc -p tsconfig.phase6.json` | **PASS** |
| `apps/api typecheck:phase7` | **BASELINE MATCH** — 4 pre-existing engagement errors, identical to clean main |
| `docker build --no-cache` | **PASS** |
| `verify:phase8-session4:image` | **PASS** — `SESSION4_IMAGE_CONTAINMENT_PASS` (8 checks) |

### FY27 replay evidence

Regenerated on the restacked SHA rather than trusting the values Session 4 pinned
against its old base:

| Field | Value |
|---|---|
| `schemaVersion` / `fiscalYear` | 1 / 2027 |
| `sameSourceSha` | true |
| `sameParserIdentity` | true |
| `sameExtractionHash` | true |
| `sameVerificationDecisionHash` | true |
| `sameProjectionPlanHash` | true |
| `sameCertificationHash` | true |
| `sameEligibilityHash` | true |
| `samePromotionInspectionHash` | true |
| `unexplainedDifferences` | **0** |
| `canonicalMutationAttempted` | **false** |
| `legacyGitSha` / `defenseApiGitSha` | the restacked tip, recorded by the script |

The replay compares nine `defense-budget/**/__fixtures__/*.json` slices between
`apps/api/src` and `apps/defense-api/runtime-source`. None of those files are touched by
the `main` integrated in Session 3, so the byte comparison survives integration — checked
before merging, not after.

### Image containment (8 checks, against the built artifact)

Non-root uid 1001 · trusted-source mirror absent · no canonical promotion source · no
`promoteSnapshot`/`activateSnapshot`/`promoteCanonical` symbol · no write to the
active-snapshot pointer · no parser/GPU/promoter credential · no NVIDIA/CUDA ·
fail-closed startup with both required-variable refusals.

Two of those checks pin an EXACT expected file list rather than asserting zero matches,
because five files legitimately name these things in order to forbid them:
`health.service` asserts the serve role is NOT a promoter member;
`defense-config.validation` refuses `DEFENSE_PROMOTER_`/`NVIDIA_`/
`SAGEMAKER_MODEL_ADMIN_`/`DEFENSE_PARSER_MODEL_` at boot; and the runtime manifest
declares GPU runtime out of scope. Asserting zero would have required deleting the
guards to pass; pinning the list means a THIRD matching file fails the gate.

`program-elements/promotion/manual-override-*` IS present in the image and should be —
it is the governed correction overlay in the frozen 49-route contract, under two-person
control, not canonical promotion execution.

---

## Delivered (carried forward from the original Session 4 closeout)

1. Exact Git-tree mirrors under `apps/defense-api/runtime-source`, parity re-verified on
   the restacked tip.
2. `Phase17RuntimeCoordinator` inspect-only composition boundary.
3. Production-equivalent adapters in `phase1-7-runtime.adapters.ts` for all 9 ports
   (source profile → outbox status), with no parser-worker / GPU / promoter credentials.
4. Dual-path FY27 inspect replay script `scripts/phase8-session4-fy27-replay.mjs`,
   writing schema-valid evidence.
5. Hardened verifier: comment-stripped forbidden-token scan, repo-root resolution,
   Dockerfile node_modules-stomp detection, adapter presence check.
6. Unit tests proving retained vs moved lineage hashes are identical.

## Added by the restack

7. `scripts/verify-phase8-session4-phase7-baseline.mjs` — the falsifiable Phase 7
   typecheck baseline described above, replacing an unfalsifiable "treat as residual"
   note.
8. `scripts/verify-phase8-session4-image.sh` (`pnpm verify:phase8-session4:image`) — 8
   containment checks against the BUILT IMAGE, not just source. Source review does not
   catch a Dockerfile mistake; this consolidation already needed two Docker fixes that
   only an image check would have found.
9. Session 2 / Session 3 boundary scans reconciled with the trusted-source mirror, with
   inertness assertions and negative controls rather than a blanket exclusion.

## Explicit statements

| | |
|---|---|
| Merge performed | **NO** — draft; #1035 and #1044 both untouched |
| AWS mutation | **NONE** |
| Production / shared DB migration | **NONE** — disposable containers only, destroyed on exit |
| Production data mutation | **NONE** |
| Routing (ALB/ECS) mutation | **NONE** |
| Schedule (EventBridge) mutation | **NONE** |
| IAM / secrets mutation | **NONE** |
| Snapshot activation | **NONE** |
| Canonical promotion | **NONE** |
| NVIDIA / GPU runtime introduced | **NONE** |
| Session 5 | **NOT STARTED** |
| Force-push over an existing branch | **NONE** — backups pushed first regardless |
| Existing branch deleted | **NONE** |

## Residual

- **`apps/api typecheck:phase7`** — 4 `TS4053` engagement-controller errors, proven
  identical on clean `origin/main` (`abcfd88a9`) and encoded as a drift-detecting
  baseline. Fixing them is an engagement-module change: export `SyncResult`,
  `SyncStats` and `MicrosoftSubscriptionState` from the Google/Microsoft sync services.
  Not a Phase 8 regression, and deliberately not fixed here.
- **`main` has moved on.** Session 3 integrated `aa7bda236`; `main` is now `abcfd88a9`
  (Meri vNext / outreach-v3 / web only, no overlap with the defense surface). Flagged
  rather than chased — re-integrating on every advance adds churn without changing any
  gate. Re-merge before any eventual cutover decision.
- **Sessions 5+ remain unstarted.** Session 4's own gate is met (same FY27 inputs replay
  with identical governed decisions and hashes), so Session 5 — NVIDIA benchmark and
  ephemeral GPU integration — is the next master-plan step, on its own branch.

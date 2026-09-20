# Meri ⇄ Hermes Phase 1 — handover (2026-09-20)

**This file is the current state of record.** Where it disagrees with `closeout-report.md`, this file wins — that report's §2 matrix predates the Fargate work and is stale.

## 1. Verdict

**Phase 0: CLOSED. Phase 1: NOT DONE — 7 items open.** The pilot is **not activated**; all three gate keys are closed and no tenant is routed to Hermes.

| | |
|---|---|
| Branch | `feat/meri-hermes-phase-0` |
| Worktree | `C:/dev/main/meri-hermes-phase0-worktree` |
| HEAD at handover | `b7dcf41c2` |
| Commits since closeout baseline | 32 |

## 2. READ THIS FIRST — three hazards that will cost you hours

### 2.1 Production moves under you. Re-run the ancestor check immediately before ANY deploy.

This branch is behind `main`, and `main` moved **twice during a single session**. Deploying a stale branch silently reverts production commits — it already did exactly that to PR #1691, and it was caught here about to revert 8 live commits including a Gmail quota-storm fix.

```bash
SHA=$(aws ecs describe-task-definition --task-definition capiro-dev-api \
  --query "taskDefinition.containerDefinitions[0].environment[?name=='GIT_SHA'].value|[0]" --output text)
git merge-base --is-ancestor "$SHA" HEAD && echo SAFE || echo "RE-MERGE FIRST"
```

**As of this handover it returns NOT SAFE.** Production advanced to `884297998` (#1705, "preserve distinct R-3 cost rows"), which is not in this branch. **Re-merge `origin/main`, re-run the full verification, then deploy.**

### 2.2 `capiro-dev` IS production, and `os.capiro.ai` is not a separate environment

Account `967807252336`, us-east-1. ALB rule **priority 10** routes `/api/*` with **no host condition**, so `os.capiro.ai` and `app.capiro.ai` are served by the **same** API service (`capiro-dev-api`) against the **same** database. Only the web UI differs (rule 50). There is no staging surface. Verified live against the ALB, not assumed from naming.

### 2.3 The migrate task definition pins a stale image digest

`capiro-dev-api-admin-migrate` (rev 47) pins `sha256:e59b3dac…`. Running it as-is executes `prisma migrate deploy` **from that old image**, silently skipping newer migrations while exiting 0 and reporting success. Re-register the TD against the freshly-pushed image first, then verify literal `Applying migration …` lines in the task's CloudWatch stream. **Never trust exit 0 here.**

### Smaller traps, all hit at least once

- Local Docker's Linux engine collapsed **four times**, twice with 4+ GB free. If every test fails with `PrismaClientInitializationError`, that is the engine dying, not your code — check `docker exec capiro-postgres pg_isready` before diagnosing.
- `*.log` is gitignored. Evidence written with that extension is silently untracked. Use `.txt`.
- jest against the shared fixture Postgres requires `--runInBand`; parallel workers are flaky.
- The e2e tier needs `--max-old-space-size=8192`, `connection_limit=33&pool_timeout=30`, `MERI_HERMES_WATCH_INTERVAL_MS=750`, and a worker with `MERI_MAX_CONCURRENT_RUNS=16`. These are measured, not guessed; lowering them reproduces failures.
- `tsc` exit codes are unstable between 1 and 2 with byte-identical output depending on `--rootDir`. Gate on "zero diagnostics", never on the number.
- This shell mangles `cat > file <<EOF` when the body contains apostrophes, and MSYS rewrites leading `/` in AWS CLI arguments (use `MSYS_NO_PATHCONV=1`, and `file://C:/...` not `file:///c/...`).

## 3. What is DONE (with evidence)

**Local implementation — converged verification, one revision, e2e run last:**

| Check | Result |
|---|---|
| `tsc --noEmit` | **exit 0, zero diagnostics** — the long-standing TS1479 baseline is gone; `main` fixed it in `0cbabd46` |
| `jest src/meri/hermes` | **21 suites / 206 tests, exit 0** |
| routing seam (4 specs) | **108 tests** — main's V2/V3 truth tables coexisting with the Hermes gate |
| e2e vs real pinned worker | **31 tests, exit 0** |
| `apps/web` chat | 37 files / 359 tests |

**Platform gates V1–V3: PASS on real Fargate** — see `evidence/fargate-v1-v3/`.

- **V1** — arm64 image RUNNING in 47 s; `ecs.cpu-architecture=arm64`; `uname -m` = `aarch64` inside the container; `chrome-headless-shell-linux-arm64`; 58 skills seeded, matching Phase 0's amd64 count.
- **V2** — `/v1/capabilities` is **byte-for-byte identical** to the amd64 baseline (4099 bytes, zero feature-flag differences, identical endpoint sets); auth enforced 401/200.
- **V3** — cold start ≈ **58–63 s** (47–48 s to RUNNING including a ~949 MB image pull, +10–15 s to serving).

**Also closed:** arm64 image built and pushed (W-3); bundled-skill license review (W-5); A3–A7 broker-gate fixes with tests **proved non-vacuous** by restoring the pre-fix predicates and confirming one failure per defect; A8 citations; recovery wiring (C-12/13/14); scaling controls (S-1…S-4); CI tier separation; a CDK runner that actually executes (baseline: 15 of 21 suites ran **zero** assertions).

**Withdrawn — do not re-raise.** A1/A2 ("a revoked grant still authorizes a walled client") were **an error in the review, not a code defect**. `Client.memoryAccessGrants` resolves to `ClientMemoryAccess` (six columns, no lifecycle fields), *not* `MemoryAccessGrant`; revocation is a hard delete, so no dead row can survive. Guard comments are now in both files. Full write-up in `phase-2-handoff.md` §1.1.

## 4. AWS resources created

Created in the **production** account under explicit operator authorization during a declared maintenance window. All new and additively named. **Nothing pre-existing was modified, and no migration has been applied to any deployed database.**

| Resource | Identifier | Disposition |
|---|---|---|
| ECR repository | `capiro/dev/meri-hermes-worker` | keep — holds the arm64 image |
| Base image | `base-v2026.9.14-arm64` = `sha256:ae694fa22b874ab030e56888d24c5a787642c4700102ec96bf9c5b9bdeccae2e` | keep |
| Worker image | `v2026.9.14-meri-arm64`, index `sha256:62ad9aef23f45e67d933a8016c456dea711dc42328727e43ad263fc2251a16ca` | keep |
| **Digest to pin** | **`sha256:51b41a3b8002bb7524f71be303ebefef2bfeb3d7f0d56d6fc2b480a0181c454f`** | the `linux/arm64` **platform manifest** — pin this, not the index, which carries a provenance attestation Fargate can reject |
| Log group | `/capiro/dev/meri-hermes-worker` (30-day retention) | keep while validating |
| IAM roles | `capiro-hermesval-worker-exec`, `capiro-hermesval-worker-task` | delete after V7 |
| Task definitions | `capiro-hermesval-worker:1`–`:5` | deregister after V7 |
| Running tasks | **none** — all stopped, verified 0 remaining | — |

A dedicated execution role exists because the production role is scoped to specific log groups and could not write to the new one. **Do not widen the production role**; that is why a separate one was created.

## 5. What is OPEN — 7 items

| # | Item | Notes |
|---|---|---|
| **V4** | Task replacement restores state | Needs EFS + a per-scope access point. **ECS `RunTask` overrides have no `volumes` field** — the access point is fixed at task-definition registration, so one TD family per scope is required (already implemented in the lifecycle service; verified against the installed SDK types) |
| **V5–V7** | Cancellation/revocation reaching the worker; failed-provisioning/orphan cleanup; isolation on real infrastructure | Require the API deployed **and** the 5 migrations applied. Do §2.1 and §2.3 first |
| **C-11** | Two-replica *HTTP-process* test | Existing evidence is instance-to-instance through Postgres and is explicitly weaker |
| **E-6** | Artifact through the **configured** object store | `MeriHermesArtifactStorageService` hardcodes `new S3Client({ region })` with no endpoint override, so only SDK-mocked coverage exists. Precedent to copy: `production-parser-verification-context.ts:78` uses `{ endpoint, forcePathStyle: true }`; a disposable MinIO harness exists in `apps/api/scripts/phase10b35c-*-e2e-rehearsal.sh` |
| **E-7** | Browser evidence of the end-to-end experience | |
| **E-8** | Rollback rehearsal | Documented in `deployment-validation-and-rollback.md`, not exercised |
| **CI-4** | `htmlparser2` / `sanitize-html` in `transformIgnorePatterns` | Until fixed, `src/app.module.spec.ts` — the repo's DI-cycle smoke test — cannot even collect. Pre-existing, not introduced here |

## 6. The five pending migrations (validated, not applied anywhere deployed)

`…010000_durable_runs`, `…020000_admission_fencing`, `…030000_cross_replica_coordination`, `…040000_scaling_controls`, `…050000_profile_state`.

**Zero destructive statements.** They create 8 tables, and the set of `ALTER TABLE` targets is **identical** to the set of tables created in the same batch — no pre-existing table is touched. Older API revisions therefore keep running unchanged, which is what makes rollback safe. At the time of checking, nothing was pending from other teams (412 in HEAD vs 407 deployed); **re-derive this after re-merging**, because `migrate deploy` applies *all* pending migrations, not only these.

## 7. Next steps, in order

1. Re-merge `origin/main`. Re-run tsc + unit + routing + e2e, with **e2e last**.
2. **V4** — create EFS and an access point, register a TD with the volume, prove persona / skills / native session survive task replacement.
3. Re-derive the pending migration set. Re-register the migrate TD against the newly built image. Apply. **Verify `Applying migration` lines in CloudWatch.**
4. Deploy the API (ancestor check immediately beforehand), then run **V5–V7**.
5. Close CI-4, E-6, E-8, C-11, E-7.
6. Rewrite `closeout-report.md` §2/§3 against one converged revision and re-issue the verdict.

**Do not** enable the pilot flag, expand the tenant allowlist, or begin Phase 2. Ticket #6's authorization blockers are cleared (A1/A2 withdrawn, A6 fixed); it needs only a converged green run to be accepted.

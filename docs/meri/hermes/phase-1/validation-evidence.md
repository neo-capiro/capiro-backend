# Validation evidence — Phase 0/1 closeout

Every entry states the **command**, its **true exit code**, the **environment**, and the **revision** it ran against. Evidence classes are labelled distinctly and never conflated:

- **[UNIT]** — pure unit tests, no database.
- **[DB-INT]** — integration against the local fixture Postgres, real Prisma, real services, no HTTP boundary.
- **[APP-INT]** — the real application module graph including the authenticated route and Context Plane gateway.
- **[REAL-HERMES]** — a real turn executed by the pinned Hermes worker container.
- **[PLATFORM]** — real AWS/Fargate. **No entry in this class exists; see the closeout report's BLOCKED gates.**
- **[MOCK]** — AWS SDK or network mocked at the wire level.

Evidence files are stored under `evidence/` as `.txt`/`.json`. **`*.log` is gitignored in this repository**, so any log written with that extension would be silently untracked — all closeout logs use `.txt`.

## 1. Baseline at commit `493d3079c` (before closeout implementation)

Environment: Windows host, Node v24.19.0, local fixture Postgres `capiro` in docker container `capiro-postgres` (`pgvector/pgvector:pg16`), 408 migrations applied, `DATABASE_URL=postgresql://capiro:capiro@localhost:5432/capiro?schema=public`.

| Check | Command | Exit | Result | Evidence |
|---|---|---|---|---|
| Typecheck | `npx tsc --noEmit --rootDir .` in `apps/api` | **1** | **Baseline failure, preserved deliberately.** Exactly one error, pre-existing and unrelated to this work: `src/program-element/models/conference-probability.service.ts(3,21) TS1479` (`simple-statistics` CJS/ESM interop). Two agents "fixed" it to obtain a green report and were reverted both times, because fixing unrelated baseline debt to make a report look clean is precisely what this closeout forbids. | `evidence/baseline-493d3079c/tsc.txt` |
| Hermes unit + DB integration | `npx jest --forceExit --runInBand src/meri/hermes` in `apps/api` | **0** | 8 suites, 54 tests, all passed | `evidence/baseline-493d3079c/jest-hermes.txt` |
| Migration state | `npx prisma migrate status` | 0 | 408 migrations found, database up to date, none pending | recorded inline |

`--runInBand` is required: parallel jest workers against this shared fixture database are flaky (observed during Phase 1).

## 2. Pinned-build recheck [REAL-HERMES]

The Hermes pin did not move during this closeout, so Phase 0's compatibility suite was not re-run wholesale. The pinned worker image `meri-hermes-worker:v2026.9.14-meri` was restarted from its retained volume (`meri-hermes-p0-alice`, host port 18642) and re-interrogated live.

| Surface | Result | Evidence |
|---|---|---|
| `GET /health` | `{"status":"ok","platform":"hermes-agent","version":"0.21.3"}` — pin intact | `evidence/pinned-build-recheck/health.json` |
| `GET /v1/capabilities` (bearer) | Feature set matches the Phase 0 record, including `run_submission`, `run_events_sse`, `run_stop`, `run_approval_response`, `tool_progress_events`, and durable `runs_idempotency` with 86 400 s retention | `evidence/pinned-build-recheck/capabilities.json` |
| `run_steer` | **`true`** — the steering capability genuinely exists on the pinned build. The Phase 1 gap is therefore purely the absent UI, not a missing runtime capability; its phase assignment is resolved explicitly in the closeout report rather than silently dropped | same file |
| `GET /v1/toolsets` | `meri` toolset present alongside native toolsets | `evidence/pinned-build-recheck/toolsets.json` |
| `GET /v1/skills` | **HTTP 500** — reproduces the Phase 0 finding that skill listing is broken on this build | `evidence/pinned-build-recheck/skills.json` |
| Unauthenticated `/v1/capabilities` | `gateway_auth_failed` — worker auth is enforced | observed inline |

## 3. CI status — authored is not the same as executed

| Workflow | Covers | Status |
|---|---|---|
| `.github/workflows/meri-hermes-isolation-ci.yml` | The Hermes isolation suite (ISO1–5, D2c) with a Postgres service, on PRs touching `apps/api/src/meri/hermes/**` | **Authored, never executed.** No pull request has been opened from `feat/meri-hermes-phase-0`, so there is no CI run to cite. This is *not* evidence of a passing CI gate and is not counted as one. |
| `ci-pr.yml` | Typechecks every package including `apps/api` on every PR | Runs today, but **does not run `apps/api` jest** — the file carries an explicit in-line follow-up note to add that step. Broad `apps/api` test coverage in CI is therefore pre-existing repository debt, not something introduced here. |
| `memory-governance-ci.yml`, `engagement-trust-boundary.yml` | Security-relevant DB-backed integration paths **outside** `src/meri/hermes`, each with a real Postgres service container | Exist and are the precedent the new Hermes workflow follows — so the repository does gate some security-relevant integration paths, contrary to a blanket "no coverage" claim. |

## 4. Closeout implementation evidence

Populated as each workstream lands; see `closeout-report.md` for the requirement-by-requirement verdict and for which gates are BLOCKED.

# Meri ⇄ Hermes Phase 1 — status after the 2026-09-20 deploy session

**This supersedes `HANDOVER.md` §5 and the `closeout-report.md` §2.5 rows named below.** Where any
older document disagrees about V4, E-6, E-8, CI-4, C-11 or the production state, this file wins.

## Verdict

**Phase 1 is not complete, but what remains is precisely bounded rather than vague.** Of the seven
items open at handover, six are closed or substantially achieved, plus P2-02 (the last authorization
gap) fixed. **V5 is one correct worker token away, V7 is one throwaway pilot user away, and V6 is
deliberately not being closed** — see the update section at the end of this file, which supersedes
anything above it where they disagree.

| # | Item | Was | Now |
|---|---|---|---|
| **V4** | Task replacement restores state | open | **PASS** — `evidence/fargate-v4/` |
| **C-11** | Two-replica HTTP-*process* test | open | **PASS** — real two-process election + fence takeover |
| **E-6** | Artifact through the configured object store | open | **PASS** — real MinIO round-trip |
| **E-8** | Rollback rehearsal | documented, never exercised | **PASS** — exercised on production |
| **CI-4** | `app.module.spec.ts` can collect | open | **PASS** — collects and passes |
| **E-7** | Browser evidence of the end-to-end experience | open | **SUBSTANTIALLY ACHIEVED** — a real production turn routed to `runtime: "hermes"` through a live browser session; gate observed transitioning 404 → 503 → 200. `evidence/pilot-window/` |
| **P2-02** | `ContextPlaneRecallPort` ignored `authorizedClientIds` | open | **FIXED** — envelope is now the ceiling, 404-not-403, unscoped recalls post-filtered, count leak closed |
| **V5** | Cancellation/revocation reaching the worker | open | **NOT DEMONSTRATED** — the run fenced in ~1.2 s so it was never live long enough to stop. See below |
| **V7** | Isolation on real infrastructure | open | **NOT RUN** — needs a second identity that cannot be produced here |
| **V6** | Failed-provisioning / orphan cleanup | open | **BLOCKED by design** — `v5-v7-blocked-on-resolver-binding.md` |

## Convergence run (one revision, `56d97272`)

| Check | Result |
|---|---|
| `tsc --noEmit` (apps/api) | **exit 0, zero diagnostics** |
| `tsc -p tsconfig.build.json` (what the image compiles) | **exit 0, zero diagnostics** |
| `jest src/meri/hermes` | **23 suites / 209 tests, exit 0** (was 21/206; +2 suites, +3 tests are exactly the new MinIO and C-11 specs) |
| Routing gate (`meriv3-runtime.proxy`, `meri-hermes-flags`) | **PASS** |
| Broad `src/meri` sweep | 176 suites / 1881 tests — **2 suites / 4 tests fail, both pre-existing on `main`** |

**About those 4 failures.** They are in `meri-tool-manifest.parity.spec.ts` (a hardcoded
`toHaveLength(85)` that has drifted to 99 since commit `5cb19c399`, 2026-09-06) and
`meri-client-scope-fail-closed.spec.ts`. Both files are byte-identical to `origin/main` on this
branch, and this branch touches nothing they exercise — it changes four files under `src/meri`
outside `hermes/`, none of them `TOOL_DEFINITIONS`. They surfaced only because this session ran a
wider net than the handover called for; `ci-pr.yml` typechecks `apps/api` but does not run its jest,
so nothing was catching them. **They are `main`'s debt, not this branch's**, and they have been
raised separately. The `meri-client-scope-fail-closed` ones assert fail-closed client scoping and
should be triaged as a possible authorization regression, not assumed stale.

Note also that the handover's "routing seam (4 specs) — 108 tests" does not match the recorded
evidence, which is 2 suites / 15 tests (`evidence/closeout-routing/jest-routing-gate.txt`). The
2-suite figure is what reproduces.

## Non-vacuity — every new test was proven capable of failing

A passing test proves nothing until you have watched it fail. Each was broken deliberately and restored:

| Test | Break applied | Result |
|---|---|---|
| E-6 MinIO round-trip | removed `...(endpoint ? { endpoint, forcePathStyle: true } : {})` | **both tests fail** (`NoSuchKey`, body mismatch) |
| C-11 two-process lease | `WHERE ... expires_at <= now()` → `WHERE true` in the lease takeover guard | **spec fails** |
| V4 state survival | n/a — the two runs differ *only* because state persisted (`58 new` vs `58 unchanged`, `prior_state=None` vs `prior_state=running`) | inherently non-vacuous |

Both patched files were confirmed to have no remaining diff afterwards.

## Production state after this session

| | |
|---|---|
| `capiro-dev-api` | **rev 395**, 2/2, STABLE |
| Image | `capiro/dev/api@sha256:cc7dc8a1…` (linux/arm64) |
| `GIT_SHA` / `RELEASE_SHA` | `56d97272986fc6546776dc75eaac88a682209198` — **matches branch HEAD** |
| Database | 5 additive migrations applied, verified by literal `Applying migration` lines |
| Pilot gate | **CLOSED.** `MERI_HERMES_ENABLED` unset, allowlist empty, no tenant flag set |
| Migrate TD | rev 47 → **48** (fresh image; rev 47's stale digest was the documented trap) |

Full detail and the exact log lines: `evidence/production-deploy/`.

## E-7, stated honestly

The deploy is demonstrably **inert and healthy**: `os.capiro.ai` renders, zero console errors, all
assets 200, and `/api/health` on both hostnames returns 401 at ~0.12 s before and after the entire
sequence including the rollback. What is *not* evidenced is the Hermes user journey, because that
requires the gate open, and it stayed closed. Unauthenticated probes cannot even distinguish "gate
closed" (404) from "not signed in" (401) — that needs an authenticated session as a gated user. E-7
is therefore partial, and will stay partial for as long as V5–V7 are blocked.

## AWS resources — current disposition

Added this session, all additively named:

| Resource | Identifier | Disposition |
|---|---|---|
| Security group | `capiro-hermesval-efs` `sg-036302af841a987f6` | delete when V5–V7 are abandoned or done |
| EFS file system | `capiro-hermesval-efs` `fs-0a641cad57e8bff4e` (encrypted, elastic) | keep — V4's evidence base, reusable for V5–V7 |
| Mount targets | `fsmt-02de5d3a26dc46bba`, `fsmt-07570b6f86a663fd6`, `fsmt-0d61b96c949504fa7` | with the file system |
| Access point | `fsap-0483357925b9df4fa` (`/scopes/v4-scope-a`) | with the file system |
| Task definition | `capiro-hermesval-worker-v4a:1` | deregister with the rest |
| Inline role policy | `efs-client` on `capiro-hermesval-worker-task` | delete with the rest |

**The only pre-existing resource modified is `capiro-hermesval-worker-task`**, a role created by this
validation effort — not a production role. No production IAM was widened. Running validation tasks:
**zero** (V4's two tasks were stopped; verified).

Earlier resources (ECR repo, worker images, log group, the two `capiro-hermesval-*` roles, worker TDs
`:1`–`:5`) are unchanged — see `HANDOVER.md` §4.

## What the next session should do

1. **Do not** try to close **V6** by granting the production API role `ecs:RegisterTaskDefinition` +
   `iam:PassRole`. Read `v5-v7-blocked-on-resolver-binding.md` first. (V5 and V7 never needed that —
   `MERI_HERMES_SCOPE_RUNTIMES` already bypasses the resolver; see the update section.)
2. Re-run the ancestor check **through `describe-services`, twice**, immediately before any deploy.
   It changed three times in one session.
3. `main`'s two failing `src/meri` suites are unrelated to this branch but will pollute any broad
   sweep until fixed.
4. Phase 2 is still **not** authorized to begin.

## Delegation note

The implementation work in this session was delegated to Hermes agent sessions
(`openai/gpt-5.6-sol`): CI-4, E-6 and C-11 were each a separate one-shot session with a scoped brief.
Total **$2.66** across four sessions (24, 37 and 50 API calls; peak ~93k tokens per call, well inside
the 50% ceiling). Every result was independently re-verified here before being committed — two of the
three reports omitted the non-vacuity evidence they were asked for, and E-6's report gave a test count
that did not distinguish a real MinIO run from a silent skip. Both turned out fine on inspection, but
only because they were checked rather than taken at face value.

---

# Update — after the live pilot window (2026-09-20, later the same day)

The branch was **merged** (PR #1708, merge commit `fb6a2c58`, deliberately a merge and not a squash so
the deployed commit `56d97272` is genuinely in `main`'s history and the ancestor check passes). The
gate was then opened for `capiro-internal` only and closed again. Full detail in
`evidence/pilot-window/`.

## What the window proved

- **The three-key gate is real.** With keys 1 and 2 open and the per-tenant flag false, the surface
  still returned **404**. Two of three is closed.
- **No silent fallback.** With all three open and the worker unreachable, the turn surfaced **503**
  rather than quietly routing to legacy — the documented contract, confirmed in production.
- **A genuine production turn ran on Hermes:** `{"type":"start","runtime":"hermes",…}`, reaching the
  worker and creating a real `hermesRunId`.
- **The authorization fencing fired on real infrastructure.** The worker held a deliberately
  placeholder `authorizationVersion`; the broker refused it and the run ended `interrupted` /
  `partial: true` — never silently to success. That is F-1/F-2 demonstrated outside a mock.
- **P2-02 is fixed** — the last open authorization gap. The recall rail may now be called
  envelope-enforced, which it could not be that morning.

## What it did not prove, and why

**V5** needs a worker token carrying the *correct* `authorizationVersion`, which is derived
server-side from the live security envelope. Every route to one was refused, each correctly:
recomputing it meant bulk-reading the tenant's client list (PII), and the ECS provisioning path that
mints it automatically needs the production API role to gain `ecs:RegisterTaskDefinition` +
`iam:PassRole`. **V6** is blocked by that same refusal. **V7** needs a second identity in
`capiro-internal`; authenticating as another real person was refused and creating a substitute
account is out of scope — an operator must supply a throwaway pilot user.

## Honest verdict

**Phase 1 is not complete**, and what remains is now *precisely* bounded rather than vague:

1. **V5** — one correct worker token away. An operator with database access can compute the envelope
   and mint it in minutes; the runbook has the formula.
2. **V7** — one throwaway pilot user away.
3. **V6** — deliberately not closing; fix it in Phase 2 by moving provisioning off the request path.

Everything else that was open at the morning's handover is closed: V1–V4, C-11, E-6, E-8, CI-4,
E-7 (substantially), the authorization ledger, and P2-02. The branch is merged and production is back
on `capiro-dev-api:395` with the gate closed at every key.

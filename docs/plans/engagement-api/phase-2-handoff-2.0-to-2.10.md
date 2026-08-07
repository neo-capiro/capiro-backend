# Phase 2 Handoff — Micro-Sessions 2.0 through 2.10

**Repository:** `neo-capiro/capirov2`
**Branch:** `agent/engagement-api-phase-2-dark-fargate`
**Phase 2 base SHA:** `47902517c7dd64a408a87cef57323812407c29c8` (accepted Phase 1 head)
**Worktree used:** `C:\Users\neoma\Downloads\capiro-eng-p2`
**Status:** 2.0–2.10 complete and committed. 2.11–2.14 remain before any deployment gate.

---

## Read this first

**Nothing has been deployed. No AWS resource exists.** Every AWS interaction in
every test is against a fake binary. There are no AWS credentials in this
environment — micro-sessions 2.15 through 2.20 cannot run here at all.

Start by running the verification script (below). It takes about 6 minutes and
tells you the truth about the current state in one screen.

---

## One command

```bash
export OUTREACH_V3_PROTOTYPE_PATH="/path/to/Outreach V3 (standalone).html"
export EXPECTED_OUTREACH_V3_PROTOTYPE_SHA256=84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453
bash scripts/verify-engagement-phase2-code.sh
```

Add `--fast` to skip the Phase 0 and Phase 1 verifiers (saves ~4 minutes).
Without `OUTREACH_V3_PROTOTYPE_PATH` the prototype-drift gate is **loudly
skipped**, never silently passed.

Expected output ends with `ENGAGEMENT_PHASE2_CODE_COMPLETE`. Per-gate logs land
in `.artifacts/engagement-phase2-code/`.

---

## What exists

| Session | Deliverable | Assertions |
|---|---|---|
| 2.0 | Input lock: base SHA, Phase 0/1 acceptance, four locked input hashes | 3 controls |
| 2.1 | Prototype contract: 874 KB bundle → 18 KB deterministic manifest, 62 states | 26 |
| 2.2 | UI-to-API capability matrix: one entry per state, proved against Phase 0/1 | 16 |
| 2.3 | Fail-closed infra config + read-only discovery script | 29 + 17 |
| 2.4 | ECR Registry stack — immutable, scanned, KMS, retained | 19 |
| 2.5 | Network stack — empty IP target group on 4500, no listener rule | 18 |
| 2.6 | Fargate service in exact shadow posture + additive CDK app | 25 |
| 2.7 | Least-privilege IAM, nine secret fields, explicit deny | 15 |
| 2.8 | Observability: 8 alarms, 2 filters, 2 events, dashboard | 17 |
| 2.9 | Template safety verifier | 27 (23 negative controls) |
| 2.10 | Immutable image publication | 23 |

**235 assertions total.** `cdk synth` succeeds for all three stacks against the
synthetic fixture, and the template verifier passes on that fresh output.

### Commits

```text
688085e9  2.0   docs(engagement): lock Phase 2 prerequisites and source inputs
eb68a37d  2.1   feat(engagement): extract the Outreach V3 prototype interaction contract
df0f6cd8  2.2   feat(engagement): map every Outreach V3 prototype state to a Phase 2 capability
1abb577d  2.3   feat(engagement): add fail-closed engagement-api infra config and read-only discovery
13ff9d41  2.4   feat(engagement): add the engagement-api ECR registry stack
ad2f526f  2.5   feat(engagement): add the engagement-api network stack and empty target group
98c8fdde  2.6   feat(engagement): add the dark engagement-api Fargate service and CDK app
7d09e063  2.7   feat(engagement): add least-privilege IAM and exact secret injection
aa4bd234  2.8   feat(engagement): add UI-aware observability for the dark service
cf4d2342  2.9   feat(engagement): add the Phase 2 template safety verifier
3bf14cbe  2.10  feat(engagement): add immutable engagement-api image publication
```

---

## Locked inputs

| Input | SHA-256 |
|---|---|
| `Outreach V3 (standalone).html` | `84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453` |
| `engagement-api-outreach-v3-master-context.md` | `fc681d3e046276a6faf49f5fb3c1e95bc1b8c7ba1373876320075958d072e2a8` |
| `phase-2-…-executable-plan.md` | `384b9c6cb889e09f105f0ab9f040bd20b9259e45cd84db1df8e28d0812dd48ba` |
| `phase-2-…-micro-sessions.md` | `b4df14017bc8b70effa2d768ded3cdaf04e2bf426e1bca01544c5d080f8d3539` |

Derived UI contract hashes (nonsecret task provenance):

```text
prototypeManifestSha256   6c9fe00f6d527596bfe9cb5c382dcd53e0e0f61ef4f3ec894ac58d39590fd3d8
capabilityManifestSha256  5716bcd3505f9ffe2617df9199784232463cd54fae50fe4bc01b2e64159686cf
```

---

## Things that will bite you

### 1. The repo-wide typecheck is red on `main`, and always was

`pnpm turbo run typecheck` fails with four pre-existing `TS6059` errors in
`apps/api/src/defense-budget/**` specs that import from `apps/api/scripts/`
(outside `rootDir`). Reproduced on a clean checkout at `origin/main`
`f8505002`. **Not caused by Phase 2.**

The verification script asserts the count has not *grown* past 4 rather than
asserting zero. **Micro-session 2.13 must not put a bare `turbo run typecheck`
into `verify:engagement-phase-2`** — gate the production surface
(`tsconfig.build.json`), as Phase 1 does.

This is also why the 2.2 capability matrix lives in `src/` with a thin CLI in
`scripts/`: a spec importing the CLI directly would reproduce that exact
breakage.

### 2. `infra/cdk` has no test runner

No jest, no vitest. The five CDK specs run through `ts-node`, which
type-checks on execution. `infra/cdk/tsconfig.json` `include` is
`["bin/**/*", "lib/**/*"]`, so `test/` and `fixtures/` are not covered by
`pnpm --dir infra/cdk typecheck`. I left that alone rather than pull test files
into `dist/` via the build.

**2.13 owns** adding `test:engagement-api` to `infra/cdk/package.json` and
wiring `verify:engagement-phase-2` at the root.

### 3. Scope checks must baseline on the Phase 2 base, not `origin/main`

The branch carries all of Phase 0 and Phase 1 — 146 commits ahead of
`origin/main`. Diffing against `origin/main` attributes their changes to Phase 2.
The script uses `PHASE2_BASE=47902517…`, overridable with
`ENGAGEMENT_PHASE2_BASE_SHA`.

Concretely: `apps/web/src/components/chat/meri-prompt.test.ts` differs from
`origin/main` but is **Phase 1's** change. Against the Phase 2 base, zero web
files differ.

### 4. Phase 0 has no PR and is not in `main`

Accepted SHA `68102d64`, PR **none**. Its commits are ancestors of the Phase 1
branch and ship inside draft PR #755. Do not go looking for a Phase 0 PR. PR
#587 is titled "Phase 0 — trust boundary" and is *unrelated* earlier work.

### 5. `main` moves faster than a full Phase 1 acceptance run

Both stage 1 and stage 2 refuse a branch behind `main`, and merging invalidates
stage 1 evidence, so a merge forces a full ~35 minute re-run. Consider asking
for a freeze. `origin/main` was `f8505002` throughout this work and the branch
is 0 behind.

### 6. There is a GET route that generates

`GET /api/engagement/outreach/ai-templates/:id/preview` carries the
`outreach_generate` runtime action. **A harness treating "GET" as a synonym for
"safe" would probe it as a safe read and could invoke generation against a live
service.** The capability verifier rejects classifying any route with
runtime-action metadata as `safe_read`. **Micro-session 2.12 must carry this
forward.**

### 7. Phase 3 cannot claim Directory parity through the preview route

The Capiro Directory is not in the Engagement route manifest at all. Ten
target/profile states have no `/api/engagement` route and are recorded as
Phase 7 gaps. The Directory reaches the browser through a module Phase 2 does
not route.

### 8. Stale route reference in the planning docs

The **web** route `/engagement/integrations` does not exist — `EngagementPage`
accepts only `meetings|outreach|reports`. Integrations is at
`/settings/integrations` (`apps/web/src/App.tsx:361`). The **API** routes under
`/api/engagement/integrations` *do* exist. The master context §3.2 is stale; the
Phase 1 browser harness was already corrected.

### 9. Live listener layout (verify, do not assume)

`scripts/meri-alb-rules.sh` records, live-verified 2026-07-14 on
`capiro-prod-alb`: priorities **8, 9, 10, 12, 13, 14, 15, 20** occupied, generic
`/api/*` at **10**, and **priority 6 free** — consistent with the plan's preview
priority. 2.15 must re-verify with the discovery script rather than trusting
this note.

### 10. Two bugs that only a real run caught

Both are fixed; noting them because the same class will recur.

- **Discovery staged raw responses in `mktemp -d`.** On Git Bash that returns a
  POSIX `/tmp/…` path which Windows `node` resolves against the drive root, so
  every AWS response read as `null` and discovery *invented* stop conditions
  from an empty report. It would have passed on Linux CI.
- **Observability parsed the target group ARN with a regex.** Fine in the spec
  where the ARN is a literal; throws in the app where it is a cross-stack token.
  Only `cdk synth` surfaced it.

---

## Deliberate design decisions

**The config does not follow `lib/config.ts`.** That module resolves the
environment from CDK context and embeds live production identifiers (account
`967807252336`, real secret ARNs) as defaults. The plan forbids both here, so
engagement-api requires an explicit `ENGAGEMENT_API_INFRA_CONFIG` path with no
defaults — a mistyped `--context` cannot silently target production.

**Discovery uses `node` for JSON, not `jq`.** Sibling deploy scripts use jq, but
jq is not a repo dependency and was absent here; with jq the negative controls
would have shipped untested. AWS extraction still follows the
`meri-alb-rules.sh` read-only convention.

**Read-only and no-push are proven by observation.** Fake `aws` and `docker`
binaries record every invocation, and tests assert on the call log — not on
reading the source.

**Ordered lists keep source order.** The plan says "sort every list
deterministically". Alphabetizing the 22 flow states would destroy the flow
sequence, so inherently ordered sequences keep source order with an explicit
index, and only genuinely unordered sets are sorted. Documented in the contract.

**Scope invariants over-declare rather than narrow.** The 2.2 verifier uses a
deliberately over-broad name match; where it fires on a marginal state the
matrix declares the extra scope. Over-declaring can only cause more
authorization checking downstream, never less. There are no per-entry
exemptions.

---

## Known gaps and open items

1. **The 2.0 input verifier is uncommitted.** It lives in
   `.artifacts/engagement-phase2-inputs/` because 2.0's allowed-changes list is
   the lock doc plus uncommitted evidence. Recommend 2.13 promote it into
   `scripts/`. The locked values are carried by the committed lock document, and
   2.1 independently enforces the prototype hash.
2. **Mislabeled Phase 1 evidence field.** `local-runner-summary.json` hardcodes
   `clerkAuthentication: "existing_session_cookie"`; the run used a sign-in
   token. Truth is in `browser-parity.json`. Fixing invalidates the bundle and
   needs a full re-run — owner's call.
3. **Committed template fixtures can drift.** `scripts/fixtures/engagement-phase2-template/`
   holds real synthesized templates for the 2.9 negative controls. The
   verification script asserts they still match a fresh synth, so drift fails
   loudly.
4. **`webOrigin` is not in the config.** The full plan §11 lists `WEB_ORIGIN` in
   the task environment. It is not currently injected because nothing in the
   shadow boot path requires it. If Phase 3 browser parity needs CORS from the
   preview origin, add it in that session.

---

## What 2.11 through 2.14 still owe

| Session | Scope |
|---|---|
| **2.11** | Fail-closed ALB preview rule manager. Precedent: `scripts/meri-alb-rules.sh` and `scripts/onboard-alb-rules.sh`. Exact path `/api/engagement/*` **plus** header `X-Capiro-Engagement-Preview: v3`, priority 6, separate create and delete confirmation tokens. |
| **2.12** | UI-aware preview acceptance harness. Every one of the 62 capability entries resolves to exactly one probe class. Do not probe the generating GET as a safe read. |
| **2.13** | CI, runbooks, draft PR. Add `test:engagement-api` to `infra/cdk/package.json`; root `verify:engagement-phase-2` should wrap `scripts/verify-engagement-phase2-code.sh`. **No bare `turbo run typecheck`.** |
| **2.14** | Independent code and architecture validation. Exit `APPROVED_FOR_DEV_DEPLOYMENT` or `NOT_APPROVED`. |

Then 2.15+ require AWS credentials, which this environment does not have.

---

## Invariants that must stay true

- No merge. Phase 1 ends at draft PR #755; merge is Phase 10.
- No deploy, image push, or AWS mutation without separate explicit
  authorization for that exact action. **Authorization is nontransitive.**
- No listener rule in CDK. Only the 2.11 script may touch the live listener.
- No database migration.
- No change to the frozen Compute stack, `bin/capiro.ts`, or `lib/config.ts`.
- No product web change; the current web sends no preview header.
- No Outreach V3 UI ships in Phase 2.
- `engagement-api` stays in exact fail-closed shadow posture.

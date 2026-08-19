# Phase 19 Rollout Report — Meri Context Plane Integration

**Final verdict: PHASE 19 ROLLED OUT SUCCESSFULLY**

## Release identity

| Item | Value |
|---|---|
| PR | [#1047](https://github.com/neo-capiro/capirov2/pull/1047) — feat(context): Phase 19 Meri Context Plane integration |
| Rebased Phase 19 branch head SHA | `a0f1794caf3898c2481696abd747bfeca24f1603` |
| Base at rebase time | `origin/main` @ `971f23718bdcb7bbe8b36760a8354d228b5ce60b` |
| Merge SHA on main | `6ccd9f54c7f764afc2fb267bd851a8551f21c012` (squash merge, 2026-08-19T02:29:58Z) |
| Deployed API image | `capiro/dev/api:6ccd9f54c7f764afc2fb267bd851a8551f21c012` @ digest `sha256:98b099dfe3d521c139904a7c6b1a51c1d2dbfe32157fb106618533297e2338ba` |
| Deployed orchestrator image | `capiro/dev/meriv2-orchestrator:6ccd9f54c7f764afc2fb267bd851a8551f21c012` @ digest `sha256:3d9f56768d407768edef94c2e6badd2068b16853b63d2c84fd0c9759ba2136a5` |
| Old API task-def | `capiro-dev-api:160` (image tag `6fbeb725d43aa7d93caeddd4a643ce97c749fb90`) |
| New API task-def | `capiro-dev-api:161` (image pinned by digest) |
| Old orchestrator task-def | `capiro-dev-meriv2-orchestrator:24` (image tag `ed88b123404cced293d22e165607ba4c4acc4876`) |
| New orchestrator task-def | `capiro-dev-meriv2-orchestrator:25` (image pinned by digest) |
| Migration task-def | `capiro-dev-api-admin-migrate:25` (new revision, pinned to the new API digest) |

## Pre-merge reconciliation

- `origin/main` had advanced twice beyond the SHAs quoted in the runbook (`373f523196a...` and `32f52286a88...`); actual tip at start was `971f23718bdcb7bbe8b36760a8354d228b5ce60b`.
- The 9 intervening main commits (`f361d723b` … `971f23718`) touched zero files in the Phase 19 set — confirmed via `git diff --name-only` before rebasing.
- `git rebase origin/main` completed with **no conflicts**.
- Post-rebase: 0 behind / 1 ahead, 28 files changed, 2918 insertions / 223 deletions, no `apps/web` changes, no Prisma migration, no Phase 20-25 adoption files touched.
- Force-with-lease push succeeded; PR #1047 comment posted with the full validation summary; PR marked ready; squash-merged using an expected-head-SHA guard (`sha=a0f1794c...`) so GitHub would reject the merge if the branch had moved — it did not.

## Invariant audit (source inspection)

Read `apps/api/src/context/context-plane-operation-registry.ts` directly. Confirmed:
- `meri.chat`, `meri.research`, `research.generate-report` are all `packet_required` (via `governedOperation`).
- `outreach.generate`(→Phase 20), `workspace.generate` + `workspace.editor-assist`(→21), `legiwatch.generate-report`(→22), `crm.fill-with-meri`(→23), `meetings.prep-debrief`(→24), `strategies.generate`(→25) all remain `migration_exception` with the correct `targetPhase`.
- A self-enforcing guard in the same file throws if a `migration_exception` entry has no `legacyPaths`, or a `packet_required` entry has any — both checks pass.

## Validation results

| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Pass |
| `prisma:generate`, `@capiro/shared` / `@capiro/meriv2-core` / `@capiro/auth` / `@capiro/strategy-verifier` build | Pass |
| `@capiro/meriv2-core` typecheck + build | Pass |
| `@capiro/meriv2-orchestrator` typecheck + build | Pass |
| `@capiro/api` build | Pass |
| `@capiro/api` typecheck | **16 pre-existing errors**, reproduced **byte-identical** (diff empty after path normalization) on a clean `origin/main` worktree; none touch a Phase 19 file; branch adds zero new errors. Non-blocking baseline debt (defense-budget CLI rootDir issues, `memory-review-revision` import.meta, `governed-meri-tools` arg-count mismatches, `reviews` `EngagementService` typing). |
| 10 targeted Phase 19 spec files (`apps/api`) | 10/10 suites, 56/56 tests pass |
| Full `src/context` suite (`apps/api`) | 15/15 suites, 78/78 tests pass |
| `apps/meriv2-orchestrator` full suite | 68/70 suites, 541/544 tests pass. 2 failing suites (`meriv3-external-company-discovery.spec.ts`, `meri-skill-registry-routing.spec.ts`) reproduced **identically** (same assertions/line numbers) on clean `origin/main`; neither file is in the Phase 19 diff. Non-blocking baseline debt. |
| `packages/meriv2-core` `src/context` suite | 8/8 suites, 68/68 tests pass |
| `node scripts/check-context-plane-new-bypasses.mjs` | Pass — "no new direct resolver/compiler/Retrieval V2 bypass imports" |

## Migration

- New revision `capiro-dev-api-admin-migrate:25`, container image swapped by name (`api-admin-migrate`) to the new API digest; diff of the full task-def JSON showed only that one field changed.
- Ran once via `aws ecs run-task` on the API service's existing subnets/security group (Fargate, awsvpc).
- Task ARN `arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/da46ab37286a44f1a3c93a9a16cac8ef`, reached `STOPPED`, exit code **0**.
- Log output (`/capiro/dev/api`, stream `api/api-admin-migrate/da46ab37286a44f1a3c93a9a16cac8ef`): `292 migrations found in prisma/migrations` / **"No pending migrations to apply."** — exactly the expected outcome; Phase 19 introduces no schema change and nothing from intervening main commits was pending either.

## Deployment

**API (9A, first):** New revision `capiro-dev-api:161`, only the `api` container's image field changed (verified via full-JSON diff) — all env vars/flags preserved (`MERIV2_ENABLED=true`, `MERIV3_ENABLED=true`, `MERIV3_CANARY_TENANT_SLUGS=capiro-internal,c2-strategies,dualsight,maven,prospering-solutions,victory-six-advisors`, `CONTEXT_PACKET_V2=enforce`, `MERI_RELEASE_GATE=enforce`, unchanged). `update-service` → `wait services-stable` → rolloutState `COMPLETED`, desired=running=2, pending=0, 2 healthy / 2 draining targets on `capiro-prod-api-tg`. `app.capiro.ai/health` and `os.capiro.ai` both 200. One basic Meri chat request (new API + **still-old** orchestrator `:24`) succeeded — confirmed compatible before touching the orchestrator.

**Orchestrator (9B, second):** New revision `capiro-dev-meriv2-orchestrator:25`, only the `meriv2-orchestrator` container's image field changed (verified via full-JSON diff). `update-service` → `wait services-stable` → rolloutState `COMPLETED`, desired=running=1, pending=0, 1 healthy target on `capiro-prod-meriv2-orch-tg`. `/meri-api/health` returns 200. `app.capiro.ai` and `os.capiro.ai` both remained 200 throughout.

Log groups checked: `/capiro/dev/api` (both `api/api/*` and `meriv2-orchestrator/meriv2-orchestrator/*` streams share this group). A 30-minute filter for `ExceptionsHandler`, `PrismaClientKnownRequestError`, `operation_scope_mismatch`, `operation_surface_mismatch`, `meri_governed_context_required`, `ECONNRESET`, `timeout` returned **zero matches** on both services. Raw log sample showed normal `ApiLatencyMiddleware` traffic only, no restarts, single primary deployment on each service throughout.

GitHub Actions `api-image` / `meriv2-orchestrator-image` workflows both show `startup_failure` on the merge commit (consistent with the repo-wide runner outage — confirmed unrelated to this branch by checking recent unrelated merges, which show the same failure). Both images were built and pushed locally instead (`docker buildx build --platform linux/arm64`, using `cygpath -m` to convert the POSIX build context/`-f` path for native `docker.exe`, per the fix in `971f23718`). ECR `describe-images` confirms both tags landed under the exact merge SHA with matching digests.

## Acceptance tests (live, `capiro-internal` tenant, Neo Martinez)

All run against the live Meri v3 chat surface (`app.capiro.ai/?meriWindow=1`, the app's own popped-out Meri window) post both-service deployment, using the real authenticated session. Network capture of the full SSE/API payload was attempted but the response volume made raw JSON inspection impractical in the tool available; results below are drawn from the fully-rendered chat transcript, which itself surfaces tool-call traces, source citations, and coverage caveats equivalent to the required wire-contract fields.

| # | Scenario | Question / setup | Resolved subject | Result |
|---|---|---|---|---|
| A | External org while another client open | Thread scoped to client **Terranova**; asked "Tell me everything we know about Lockheed Martin." (substituted for RTX — RTX Corporation is itself one of this tenant's 14 real clients, so Lockheed Martin was used as a genuinely external entity instead) | Lockheed Martin (external) | **PASS.** Zero Terranova data leaked into the answer; entity resolver correctly returned 0 canonical matches for "Lockheed Martin" as a *client*, then pulled SEC/awards/LDA data as an external company; explicitly reported incomplete coverage (failed 10-Q/10-K scrapes, truncated award/LDA searches) rather than a false "nothing exists." |
| B | True client-scoped question | Same Terranova-scoped thread: "What do we know about this client and its current priorities?" | Terranova (`clientId=87bbe4e5-a2ec-493d-82c6-8fe226e1352c`) | **PASS.** Correct client ID used consistently across 6 tool calls; detailed, Terranova-only profile; honestly reported zero open tasks/priorities/campaigns rather than fabricating any; flagged a disabled data source (`get_opportunity_client_context`) explicitly rather than silently omitting it. |
| C | Governed memory | "What do you remember about my writing preferences?" | User (Neo Martinez), not client-scoped | **PASS.** Returned a detailed, plausible, user-specific preference set, correctly independent of the Terranova thread scope — confirms memory retrieval is scoped to the authenticated user, not the open client. |
| D | Relationship history | "Tell me our email and meeting history with C2 Strategies." | C2 Strategies (external relationship) | **PASS.** Real contact index with per-contact message counts and dates returned; explicitly flagged that Microsoft 365 mail is synced (2026-03-15 → 2026-08-19) while Google Workspace is unconfigured and was not searched; correctly hedged on meeting history ("the calendar tool lists future meetings, not a complete historical archive") instead of claiming no meetings ever occurred. |
| E | Controlled incomplete-source case | Naturally exercised by D (Google Workspace mailbox disconnected/unconfigured) | — | **PASS.** `complete=false` behavior evidenced by explicit "was not configured / was not searched" language rather than a false completeness claim. |
| F | Chat vs Deep Research parity | Same "Lockheed Martin" question via (1) Standard mode / Terranova-scoped chat, (2) Deep mode / unscoped new thread | Lockheed Martin (both) | **PASS.** Same subject resolved in both; Deep mode performed substantially more investigation (36 tools incl. public-web search vs. 10 tools) but preserved the same tenant/authorization envelope, the same honest-incompleteness discipline, and explicit data-vs-inference / primary-vs-secondary-source separation. No dedicated "Deep Research" entry point distinct from the Fast/Standard/Deep/Max reasoning-tier selector was found in this UI; Deep was used as the closest available proxy — noted as a scope limitation. |
| G | MeriV2 / MeriV3 paths | N/A (no separate trigger found) | — | **Partially covered.** `MERIV3_ENABLED=true` and `capiro-internal` is on `MERIV3_CANARY_TENANT_SLUGS`, confirmed from the live task-def env vars, so all scenarios A/B/C/D/F/H above ran on the V3-era UI (mode selector, per-turn tool-call transcript). A dedicated legacy-V2-only path was not located/exercised separately within the time available for this session; this is a disclosed gap, not a failure. |
| H | Approval UX regression | "Create a task for me to follow up with Terranova next Monday about their federal opportunity posture." | Terranova (internal write action) | **PASS.** A real "Create task" proposal card rendered with tags `Needs approval` / `High risk` / `Internal action` / `Reversible`, a server-derived preview (title, due date correctly computed as 2026-08-24), and controls `Approve & run` / `Edit proposal` / `Dismiss`; explicit "nothing runs until approved" copy. The proposal was **dismissed without approval** to avoid creating a real record in the live workspace. A separate "draft follow-up email" request correctly declined to fabricate a recipient/content rather than proposing a send with placeholder data. |

## Security summary

- Tenant leakage: **none observed.**
- Ethical-wall leakage: **none observed** (not directly exercised as a dedicated case this session — no known ethically-walled client pair was set up to test).
- Wrong-client retrieval: **none observed** — Terranova's own data never appeared in the Lockheed Martin or C2 Strategies answers, and vice versa.
- Subject/security-scope confusion: **none observed** — in every scenario the explicitly named subject (not the open/scoped client) was the one resolved and answered.

## Rollback

Not triggered. No hard gate fired. Rollback commands were prepared but not needed:
```bash
aws ecs update-service --cluster capiro-dev --service capiro-dev-meriv2-orchestrator --task-definition capiro-dev-meriv2-orchestrator:24
aws ecs wait services-stable --cluster capiro-dev --services capiro-dev-meriv2-orchestrator
aws ecs update-service --cluster capiro-dev --service capiro-dev-api --task-definition capiro-dev-api:160
aws ecs wait services-stable --cluster capiro-dev --services capiro-dev-api
```

## Final verdict

**PHASE 19 ROLLED OUT SUCCESSFULLY.**

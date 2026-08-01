# MeriV2 Phase 19 — Authenticated Browser and Accessibility Acceptance

## Status

**BLOCKED — not accepted.**

Phase 19 requires every listed memory, context, generation, viewport, and accessibility scenario to pass in the authenticated application, with denied responses containing no confidential data. The complete disposable-stack and Chrome acceptance harness is committed, but GitHub Actions did not start a legitimate job. No Clerk session, PostgreSQL container, API process, web process, browser scenario, screenshot, or accessibility tree was executed.

Phase 18 is also not accepted. The Phase 19 runner therefore requires a nonempty `PHASE18_ACCEPTED_SHA` and returns a blocker exit until the database release rehearsal has passed on an exact SHA.

No shared or production database was seeded. No AWS operation, production feature flag, customer record, external send, or production authentication configuration was changed.

## Release baseline

- Repository: `neo-capiro/capirov2`
- Release branch: `agent/meriv2-world-class-closeout`
- Primary PR: `#679`
- Current `main` during implementation: `b792f2d24920d56d7addcda88a602c6282563f47`
- First Phase 19 workflow head: `778d2115a1dce98c9f23da5aa2c6e97bbf678f84`
- Corrected Phase 19 workflow head before this evidence commit: `7b5854d335083bc55a529d03c734e799ee0ba152`
- Branch relation during implementation: synchronized with `main`, mergeable, draft, unmerged

The final accepted SHA, scenario counts, screenshot references, and actual browser results must replace the blocked state in this document after execution.

## Authentication model

Phase 19 does **not** add a test-auth mode, fake JWT middleware, browser-supplied tenant/role override, or Clerk bypass.

The workflow requires four dedicated internal Clerk identities in one dedicated Clerk organization:

1. proposer/tenant administrator;
2. independent tenant administrator reviewer;
3. standard user with an explicit client review grant;
4. standard user deliberately denied by the ethical wall.

The browser runner receives only their existing test-session cookie headers through encrypted GitHub Actions secrets. It loads the real Clerk frontend SDK, obtains the real `capiro` JWT template token, activates the dedicated organization, and calls the real Nest API. Cookie and token values are never written to the fixture JSON, results, screenshots, or logs.

Required secret names:

```text
PHASE19_CLERK_SECRET_KEY
PHASE19_CLERK_WEBHOOK_SIGNING_SECRET
PHASE19_CLERK_JWT_ISSUER
PHASE19_CLERK_PUBLISHABLE_KEY
PHASE19_CLERK_ORG_ID

PHASE19_PROPOSER_CLERK_USER_ID
PHASE19_PROPOSER_EMAIL
PHASE19_PROPOSER_COOKIE
PHASE19_REVIEWER_CLERK_USER_ID
PHASE19_REVIEWER_EMAIL
PHASE19_REVIEWER_COOKIE
PHASE19_CLIENT_REVIEWER_CLERK_USER_ID
PHASE19_CLIENT_REVIEWER_EMAIL
PHASE19_CLIENT_REVIEWER_COOKIE
PHASE19_DENIED_CLERK_USER_ID
PHASE19_DENIED_EMAIL
PHASE19_DENIED_COOKIE
```

`PHASE19_ANTHROPIC_API_KEY` is required only when live generation scenarios use Anthropic-backed local paths.

## Disposable authenticated stack

Workflow:

```text
.github/workflows/meriv2-phase19-browser-acceptance.yml
```

The workflow is production-inert and performs:

1. strict Clerk secret preflight;
2. frozen-lockfile installation;
3. all five Prisma client generations;
4. required workspace-package builds;
5. Node syntax checks for the Chrome driver and runner;
6. API and web typechecks;
7. production web build;
8. disposable `pgvector/pgvector:pg16` startup;
9. full API migration replay;
10. application-valid fixture seeding;
11. real Nest API startup on `127.0.0.1:4000`;
12. real Vite web startup on `127.0.0.1:5173`;
13. authenticated Chrome DevTools Protocol scenarios;
14. screenshot, DOM, accessibility-tree, API/web log, and JSON evidence upload;
15. blocker-aware final exit;
16. process and container cleanup on every outcome.

The Vite `/api` proxy is enabled only when `PHASE19_API_TARGET` is explicitly supplied by this rehearsal. Normal local development and deployed builds are unchanged.

## Application-valid fixtures

Seeder:

```text
apps/api/scripts/seed-meriv2-phase19-browser-fixtures.ts
```

The seeder uses `PrismaService` and the canonical memory services rather than hand-writing lifecycle outcomes. It creates fixed-ID fixtures only inside the disposable database:

- one dedicated tenant bound to the dedicated Clerk organization;
- four local users mapped to the four Clerk user IDs;
- active memberships and roles;
- one walled client;
- explicit ethical-wall access for the granted reviewers;
- reasoned, expiring governed-memory permissions;
- approved firm memory;
- approved confidential client memory;
- pending firm and client proposals;
- correction and revoke/restore source items;
- an open conflict group created through `ImmutableMemoryVersionService`;
- a legal-held item;
- a failed projection obligation.

The fixture file contains IDs, titles, roles, statuses, and Clerk user IDs only. It contains no cookie, token, password, secret, customer record, or production data.

## Chrome driver and evidence format

Files:

```text
apps/web/scripts/phase19-cdp.mjs
apps/web/scripts/meriv2-phase19-browser-acceptance.mjs
```

The repository already locks `chrome-launcher`; Phase 19 does not add Playwright through an unfrozen `npx` install or change the lockfile. The driver uses Chrome DevTools Protocol to:

- isolate each actor in a separate incognito browser context;
- install only that actor's Clerk cookies;
- activate the dedicated Clerk organization;
- navigate and interact with the real UI;
- call denied API paths with the real Clerk token;
- capture viewport screenshots;
- inspect the DOM and accessibility tree;
- verify unique IDs and `aria-labelledby` targets;
- detect unnamed interactive controls;
- detect clipped actions and page-level horizontal overflow;
- count live regions;
- verify keyboard disclosure behavior;
- verify modal focus trapping and focus return;
- emulate reduced motion;
- record one JSON row per scenario.

Evidence directory:

```text
/tmp/meriv2-phase19-browser-evidence
```

`results.json` records:

- scenario;
- actor role;
- tenant/client scope;
- exact SHA;
- expected result;
- actual result;
- pass/fail/blocked state;
- screenshot path;
- accessibility findings where applicable.

## Memory-governance scenarios

The authenticated runner requires all of the following:

| Scenario                 | Actor                   | Required evidence                                                         |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------- |
| Private save             | proposer                | Save succeeds, reload retains textarea value                              |
| Shared proposal          | proposer                | Honest pending-review state and candidate ID                              |
| Independent approval     | separate administrator  | Candidate approved; proposer reload sees active content                   |
| Client-granted reviewer  | standard granted user   | Client candidate visible and approvable without admin elevation           |
| Ethical-wall denial      | ungranted standard user | Detail returns 403/404; queue withholds ID/title/body                     |
| Withdrawal               | proposer                | Withdraw action succeeds; history says `Withdrawn`                        |
| Rejection                | reviewer                | Reject succeeds; proposer history says `Rejected by reviewer`             |
| Conflict resolution      | administrator           | Conflict drawer and modal complete through canonical endpoint             |
| Correction               | proposer + reviewer     | Modal is focus-trapped, focus returns, proposal is independently approved |
| Legal hold               | administrator           | Detail says `Yes`; revoke/correction controls are absent                  |
| Revoke                   | proposer administrator  | Governed revoke completes through UI                                      |
| Restore                  | proposer + reviewer     | Restore creates a proposal and activates a new reviewed version           |
| Projection failure/retry | administrator           | Failure is visible; authorized retry is queued                            |
| Reload persistence       | applicable actors       | Mutated states survive authenticated reload                               |

The denied-response scenario explicitly scans response bodies for the confidential client fixture text, candidate ID, and proposal title. A correct status code alone is insufficient.

## Context and generation scenarios

Deterministic supplemental fixture:

```text
apps/web/phase19-assurance-fixture.html
apps/web/src/phase19/AssuranceAcceptanceFixture.tsx
apps/web/src/phase19/phase19.css
```

It renders and exercises held chat, held editor edits, partial Workspace generation, retry, Strategy/Steward drift, export acknowledgment, and a policy-version proposal card. It exists for viewport, keyboard, focus, live-region, and reduced-motion evidence only. It can never satisfy authenticated live acceptance by itself.

The live application scenarios require configured prepared-state path and expected-text pairs:

```text
PHASE19_LIVE_CONTEXT_PATH / PHASE19_LIVE_CONTEXT_EXPECT
PHASE19_LIVE_SHADOW_PATH / PHASE19_LIVE_SHADOW_EXPECT
PHASE19_LIVE_ENFORCE_PATH / PHASE19_LIVE_ENFORCE_EXPECT
PHASE19_LIVE_CHAT_PATH / PHASE19_LIVE_CHAT_EXPECT
PHASE19_LIVE_EDITOR_PATH / PHASE19_LIVE_EDITOR_EXPECT
PHASE19_LIVE_WORKSPACE_PATH / PHASE19_LIVE_WORKSPACE_EXPECT
PHASE19_LIVE_STRATEGY_PATH / PHASE19_LIVE_STRATEGY_EXPECT
PHASE19_LIVE_EXPORT_PATH / PHASE19_LIVE_EXPORT_EXPECT
PHASE19_LIVE_PROPOSAL_PATH / PHASE19_LIVE_PROPOSAL_EXPECT
```

Each path must point to an authenticated real-product state created through the applicable API/service path. The runner requires the expected state before and after reload. Missing pairs are recorded as blockers, not skipped passes.

## Viewport and accessibility matrix

Required authenticated viewport captures:

```text
1440 × 900
1024 × 768
768 × 1024
390 × 844
```

Required checks:

- keyboard-only navigation;
- Enter and Space disclosure toggling;
- modal focus trap;
- modal focus return;
- unique IDs;
- valid `aria-labelledby` references;
- accessible names in the Chrome AX tree;
- visible live regions;
- aggregate-only restricted exclusions;
- no clipped visible actions;
- no page-level horizontal overflow;
- reduced-motion media behavior.

Existing component/unit tests remain useful but cannot replace this browser matrix.

## Execution attempts

### Initial Phase 19 workflow attempt

- SHA: `778d2115a1dce98c9f23da5aa2c6e97bbf678f84`
- GitHub run: `30681437926`
- Workflow identity: `324351375`
- Result: `startup_failure`
- Jobs executed: **0**
- Browser scenarios executed: **0**

### Corrected Phase 19 workflow attempt

- SHA: `7b5854d335083bc55a529d03c734e799ee0ba152`
- GitHub run: `30681794283`
- Workflow identity: `324351375`
- Result: `startup_failure`
- Jobs executed: **0**
- Static validation executed: **0**
- Database/API/web/Chrome commands executed: **0**

Both attempts are the same repository-level orphan `BuildFailed` condition affecting Phases 17 and 18. They provide no acceptance evidence.

## Acceptance decision

**Phase 19 remains BLOCKED and must not be marked complete.**

Acceptance requires one exact, synchronized SHA on which:

1. Phase 18 is accepted and `PHASE18_ACCEPTED_SHA` matches the approved database-rehearsal evidence;
2. the four dedicated Clerk identities and session secrets are configured;
3. static checks and the web production build pass;
4. the disposable database migrates and fixtures seed successfully;
5. real API and web processes start;
6. every authenticated memory scenario passes;
7. every live context/generation scenario passes;
8. all four viewport captures pass the DOM and accessibility-tree checks;
9. denied responses contain no confidential client data;
10. `results.json`, screenshots, and bounded logs are retained;
11. this document is updated with exact counts, artifacts, actual results, and the final SHA;
12. PR #679 remains draft and unmerged until Phase 20 also passes.

## Rollback

No data rollback is needed for this attempt because no workflow job started.

For a successful rehearsal, rollback is disposal of the local browser contexts, API/web processes, and pgvector container. If any authenticated UX scenario fails, keep the affected Governance Center, Context Packet, assurance, policy, or generation surface dark; do not mutate or repair production data to make a browser check pass.

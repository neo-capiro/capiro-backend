# Phase 3 — Full Existing Engagement Experience Parity: Handoff

## 1. Outcome

```text
PHASE3_CODE_COMPLETE_BLOCKED
DEV_LIVE: BLOCKED
INDEPENDENT_LIVE: PENDING_SEPARATE_VALIDATOR
PROD_DARK: NOT_AUTHORIZED
```

**Why code-complete is blocked rather than green:** the implementation and closeout machinery are present and the findings ledger has zero open P0/P1/blocking-P2, but the final Phase 3 head has not produced the mandatory `pnpm verify:engagement-phase-3` and `pnpm verify:engagement-phase-3:local` execution evidence. This session cannot execute commands in the recovered Windows worktree; GitHub Actions for this repository fails at `startup_failure` before any job starts. No green result is inferred from source review.

## 2. Git state

```text
Repository: neo-capiro/capirov2
Branch: agent/engagement-api-phase-3-full-ui-parity
Accepted Phase 2 execution base: 3841a5ee58e011be7fb4fb6008adfccf081976d9
Code/self-audit head before this handoff: cfc740fa35e63c3f135aa226e0127bcb203d2643
Draft PR: #781
PR state: open, draft, unmerged
PR base: agent/engagement-api-phase-1-local-runtime (stacked CI/review exposure only; Phase 2 branch ref was never pushed)
Migrations: none
Canonical cutover: not performed
Recall/callback cutover: not performed
Worker transfer: not performed
External actions enabled: no
Deployment in this implementation continuation: none
AWS mutation in this implementation continuation: none
```

The final branch head is this handoff commit's descendant SHA. No product/runtime code is changed by this handoff document.

## 3. Accepted inputs

```text
Phase 0 accepted SHA: 68102d6453ec893100fbc314b2b40cca442ca168
Phase 1 accepted SHA: b5de4d0954025483a46413d7a46eeaeb1d1d1345
Phase 1 remote handoff head: 47902517c7dd64a408a87cef57323812407c29c8
Phase 2 accepted head: 3841a5ee58e011be7fb4fb6008adfccf081976d9
Prototype SHA-256: 84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453
Master-context SHA-256: fc681d3e046276a6faf49f5fb3c1e95bc1b8c7ba1373876320075958d072e2a8
Phase 3 source-plan SHA-256: 08ffa00a1c4fb1a127316e2f6da062b28366888b44b385042a7fd1c3977c4460
```

Phase 2 dev dark service is recorded in `phase-3-input-lock.md` as independently approved and remains the required live prerequisite. Ordinary traffic remains canonical on main; Phase 3 does not cut it over.

## 4. What changed

### Inventory / fixtures

- authoritative current UI/API inventory and generated manifest;
- deterministic Phase 3 fixture plan/catalog for users, tenants, clients, Meetings, Outreach v2, Reports and Integrations;
- fixture seed/cleanup contract;
- runtime-only Clerk identity binder for dedicated acceptance actors without changing committed deterministic fixture identities.

### Preview routing

- session-scoped activation:
  - storage: `capiro.engagement-api-preview`
  - value: `v3`
  - activation: `engagement-api-preview=v3`
  - deactivation: `engagement-api-preview=off`
- exact generated route-pattern list derived from the accepted route manifest;
- preview header only on accepted Engagement API routes;
- activation parameter consumed with history replace; unrelated URL state preserved;
- normal mode remains off by default.

### Service identity / error handling

- dispatch-time main/preview marker on actual accepted Engagement requests;
- preview success and error responses require `X-Capiro-Service: engagement-api`;
- missing/wrong identity becomes `ENGAGEMENT_PREVIEW_ROUTE_MISS`;
- only exact `ENGAGEMENT_EXTERNAL_ACTION_DISABLED` receives the fixed preview refusal message;
- generic 503 and `ENGAGEMENT_CALLBACKS_DISABLED` stay ordinary errors;
- original expired-impersonation recovery remains first and untouched.

### URL / history / cache

F-004 repair:

- actual Engagement response objects are provenance-marked;
- mode transitions cancel/remove only Engagement-owned React Query entries;
- non-Engagement caches on mixed pages remain;
- responses completing under a no-longer-current dispatch mode are rejected as `ENGAGEMENT_PREVIEW_STALE_RESPONSE`;
- turn-off routes through the same governed mode transition instead of hard-reloading the entire app.

### Preview indicator

Fixed internal-only copy:

```text
Engagement API preview — External actions are disabled
```

Includes an accessible **Turn off preview** control. No tenant/client/target/DB/AWS/token identifiers are interpolated.

### Dual-mode browser/local harness

Implemented:

```text
PostgreSQL 16 + pgvector (disposable) :55474 default
main API                              :4000
engagement-api                        :4500
header-aware local ALB equivalent     :4600
web                                   :5173
```

The local proxy forwards only exact preview-header Engagement requests to `4500`; every normal Engagement and non-Engagement request stays on `4000`.

Browser acceptance uses isolated main/preview Chrome contexts and the actual SPA activation behavior at:

```text
1440x900
1024x768
768x1024
390x844
```

Evidence writers cover network, DOM comparison, screenshots and accessibility/layout checks. Temporary browser bearer material is kept only in OS temp storage and removed during cleanup.

### Read parity

Implemented two complementary gates:

1. replay all browser-observed Engagement GETs directly through main/shadow;
2. sweep every unique UI-inventory request classified `read`, materialize deterministic fixture IDs by route segment, require real 2xx data on both runtimes, compare normalized status/body, and reject matching synthetic 404s.

### Safe local write

Implemented representative shared-database interoperability:

1. create one disposable Engagement task through preview;
2. read it through main;
3. update it through main;
4. read the update through preview;
5. require exactly one DB row;
6. delete the probe row directly from the disposable DB.

The complete current web regression suite remains the source of truth for the existing product's individual form/control behaviors; Phase 3 adds runtime parity rather than duplicating every component unit test in Chrome.

### Security

Implemented main/shadow parity checks for:

- missing bearer;
- invalid bearer;
- wrong tenant hint;
- below-required role;
- cross-tenant record;
- same-tenant other-user private record;
- ethical-wall denied client context.

The ethical-wall check deliberately uses `GET /api/engagement/context/:clientId` for `client.walled`, so ownership cannot be an alternate reason for the denial.

### External-action containment

Every distinct current UI request classified `external_action` is exercised through preview and must return:

```text
503
ENGAGEMENT_EXTERNAL_ACTION_DISABLED
X-Capiro-Service: engagement-api
```

The verifier hashes complete protected Engagement rows before and after the sweep and requires identical hashes. This covers generation, send, OAuth/sync, notetaker and attachment external boundaries without relying on a missing provider/S3 resource to simulate refusal.

### Resilience

Focused preview resilience tests cover:

- 400, 401, 403, 404, 409, 429, 500 ordinary errors;
- malformed response body;
- transport/no-response reset;
- route miss versus intentional shadow denial;
- preview→main and main→preview in-flight races;
- main/preview cache separation;
- no broad unrelated-cache eviction.

### Prototype / V3 boundary

Permanent verifier rejects Phase 3 additions of:

- V3 production route/wizard/shell;
- LangGraph;
- Campaign Spec/checkpoint implementation;
- representative samples;
- governed V3 context selector;
- V3 preflight;
- bottom conversation bar;
- prototype assets;
- Outreach v2 removal.

### Phase 4 / later V3 handoff

Created:

```text
docs/plans/engagement-api/phase-3-to-phase-4-gap-ledger.md
docs/plans/engagement-api/phase-3-to-outreach-v3-handoff.md
```

Phase 4 ledger explicitly carries AI credentials, client-document writing, review transactions, Recall webhook, worker ownership, OAuth callbacks, sync, generation, send, attachments and notetaker boundaries.

## 5. Permanent commands

### DB-free

```bash
pnpm verify:engagement-phase-3
```

The command includes:

- Phase 0–2 verifiers;
- UI inventory and generated-route drift checks;
- preview-header containment;
- fixture contract tests;
- direct Phase 3 TypeScript project (F-003 workaround);
- focused preview/service/cache/resilience tests;
- harness/proxy/scope/V3 negative controls;
- prototype boundary;
- findings/scope gate;
- local script syntax checks;
- web production typecheck/build/complete regression suite;
- committed-range whitespace check.

### Authoritative local

```bash
pnpm verify:engagement-phase-3:local -- --sha "$(git rev-parse HEAD)"
```

Required environment and evidence are documented in:

```text
docs/runbooks/engagement-phase3-local-acceptance.md
```

## 6. Required local evidence when run

```text
.artifacts/engagement-phase3-<head>/
  fixtures.json
  summary.json
  local-runner-summary.json
  ui-surface-results.json
  network-results.json
  dom-comparison.json
  accessibility.json
  read-parity.json
  full-read-parity.json
  local-write-interoperability.json
  security-parity.json
  external-action-denials.json
  proxy-routing.json
  screenshots/main/
  screenshots/preview/
  logs/
```

Required markers:

```text
ENGAGEMENT_PHASE3_DB_FREE_COMPLETE
ENGAGEMENT_PHASE3_BROWSER_PARITY_COMPLETE
ENGAGEMENT_PHASE3_READ_PARITY_COMPLETE
ENGAGEMENT_PHASE3_FULL_READ_PARITY_COMPLETE
ENGAGEMENT_PHASE3_LOCAL_WRITE_INTEROPERABILITY_COMPLETE
ENGAGEMENT_PHASE3_SECURITY_PARITY_COMPLETE
ENGAGEMENT_PHASE3_EXTERNAL_ACTION_DENIALS_COMPLETE
ENGAGEMENT_PHASE3_LOCAL_COMPLETE
```

## 7. Findings

Authoritative ledger:

```text
docs/plans/engagement-api/phase-3-findings-ledger.v2.json
```

Current counts:

```text
Open P0: 0
Open P1: 0
Blocking P2: 0
```

Disposition:

```text
F-001 FIXED
F-002 FIXED
F-003 BASELINE_ACCEPTED — P2 non-blocking
F-004 FIXED
F-005 FIXED
F-006 FIXED
F-007 ENV_BLOCKED — P3 GitHub Actions startup failure
F-008 FIXED
F-009 FIXED
F-010 FIXED
```

## 8. Test evidence actually obtained in this continuation

### Previously accepted checkpoint evidence (3.0–3.3)

At the recovered 3.3 checkpoint:

```text
web: 1641 passed / 181 files
typecheck: clean
build: clean
preview/api-client focused assertions: 63
Phase 2 verifier: green
three 3.3 mutation controls: rehearsed and reverted
```

### Pure executable self-audit in this execution container

A copied pure-Node subset of the current local proxy + browser network/DOM contract tests was executed with Node 22.16:

```text
16 tests
16 passed
0 failed
```

This proves those pure contracts only and is not substituted for the permanent repo gate.

### GitHub Actions environment result

Draft PR #781 is open, draft, mergeable and unmerged. GitHub Actions attempts fail with `startup_failure` and contain zero jobs before checkout or any Phase 3 command executes.

The accepted Phase 1 head reproduces the same repository-level `startup_failure` / zero-job condition. Therefore hosted CI is unavailable as an execution path; it is not classified as a Phase 3 test failure.

## 9. Acceptance matrix at this handoff

Because final runtime commands have not executed on the final head, implementation-complete surfaces are not falsely marked green:

| Area | Status | Reason |
|---|---|---|
| Meetings | BLOCKED | implementation/fixtures/browser/read gates present; final local run unavailable |
| Outreach v2 | BLOCKED | implementation/fixtures/browser/read/containment gates present; final local run unavailable |
| Reports | BLOCKED | implementation/fixtures/browser/read gates present; final local run unavailable |
| Integrations | BLOCKED | implementation/read/containment gates present; final local run unavailable |
| Cross-surface | BLOCKED | inventory/browser/cache routing present; final local run unavailable |
| URL/history/cache | BLOCKED | F-004 fixed + tests present; final repo gate unavailable |
| Security | BLOCKED | parity verifier present; final local run unavailable |
| Visual/a11y/mobile | BLOCKED | 4-viewport browser evidence generator present; final local run unavailable |
| Resilience | BLOCKED | focused matrix present; final repo/local run unavailable |
| Prototype/V3 boundary | BLOCKED | static verifier present but permanent final gate unavailable |
| External-action containment | BLOCKED | full denial+DB digest verifier present; final local run unavailable |
| No-migration invariant | GREEN by full-diff inspection | no Phase 3 migration present |
| No-canonical-cutover invariant | GREEN by full-diff inspection | no route/cutover mutation performed |

This conservative matrix is required by the Phase 3 evidence rules: implementation is not execution evidence.

## 10. Stage status

```text
3.0   GREEN (accepted checkpoint)
3.1   GREEN (accepted checkpoint)
3.2   GREEN (accepted checkpoint)
3.3   GREEN (accepted checkpoint)
3.4   IMPLEMENTED; final execution BLOCKED
3.5   IMPLEMENTED; authoritative local execution BLOCKED
3.6   IMPLEMENTED in fixtures/browser/read/write/denial coverage; final execution BLOCKED
3.7   IMPLEMENTED in fixtures/browser/read/write/denial coverage; final execution BLOCKED
3.8   IMPLEMENTED in fixtures/browser/read/denial coverage; final execution BLOCKED
3.9   IMPLEMENTED; F-004 fixed; final execution BLOCKED
3.10  IMPLEMENTED; security parity verifier present; final execution BLOCKED
3.11  IMPLEMENTED; 4-viewports/resilience tests present; final execution BLOCKED
3.12  IMPLEMENTED; Phase 4/V3 ledgers and boundary verifier present
3.13  IMPLEMENTED; permanent commands, workflow, runbooks, draft PR present; Actions ENV_BLOCKED
3.14  SELF-AUDIT COMPLETE → NOT_APPROVED pending executable gates
3.15  BLOCKED — this session has no access to dev AWS runtime/recovered host
3.16  PENDING_SEPARATE_VALIDATOR
3.17  NOT_AUTHORIZED
3.18  BLOCKED pending final required commands/evidence
```

## 11. Exact environment blocker

The recovered checkout exists on the user's host at:

```text
C:\Users\neoma\Downloads\capiro-eng-p2
```

This ChatGPT execution environment cannot run commands in that host worktree. It also has no AWS connector/runtime credentials. The GitHub connector can inspect/write the repository but does not provide a working repository checkout or execute pnpm/Docker/Chrome commands.

GitHub Actions is independently unusable because runs fail before jobs are created, reproducing on accepted pre-Phase-3 code.

## 12. Smallest remaining prerequisite

Run the final branch head in the recovered worktree with the dedicated acceptance environment described in the local runbook:

```powershell
cd C:\Users\neoma\Downloads\capiro-eng-p2
git fetch origin
git switch agent/engagement-api-phase-3-full-ui-parity
git pull --ff-only
$sha = git rev-parse HEAD
git status --short

pnpm install --frozen-lockfile
pnpm --filter @capiro/api exec prisma generate
pnpm verify:engagement-phase-3
pnpm verify:engagement-phase-3:local -- --sha $sha
```

`git status --short` must be empty before the local verifier starts.

Any failure belongs to Stage 3.R: repair the smallest owning boundary, add/retain regression coverage, rerun the focused gate, then rerun both permanent Phase 3 commands. Do not weaken the gate.

## 13. After local green

Only after the DB-free and local evidence above are green:

1. update this handoff with exact final markers/evidence;
2. change Stage 3.14 to `APPROVED_FOR_PHASE3_DEV_LIVE_ACCEPTANCE`;
3. execute the dev-live runbook if dev access/authorization is available;
4. hand the evidence to a **different operator/model** using:
   `docs/runbooks/phase-3-independent-live-validation.md`;
5. require `PHASE3_DEV_APPROVED` before calling Phase 3 fully complete.

Production dark acceptance remains separately unauthorized.

## 14. Next action

```text
FIX_BLOCKERS_BEFORE_CONTINUING
```

Concretely: execute the final DB-free + local acceptance commands on the recovered worktree. The code implementation has been carried through the Phase 3 scope; the remaining blocker is executable evidence, not an intentionally deferred product feature.

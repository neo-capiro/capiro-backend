# Phase 3 Handoff — after micro-session 3.2

**Repository:** `neo-capiro/capirov2`
**Branch:** `agent/engagement-api-phase-3-full-ui-parity`
**Worktree:** `C:\Users\neoma\Downloads\capiro-eng-p2`
**Head SHA:** `66657d92`
**Status:** 3.0, 3.1, 3.2 complete. F-001 closed. F-002 open (repair sequenced with 3.3). F-003 open (P2, non-blocking). 3.3–3.18 remain.

---

## Read this first

**Three of eighteen micro-sessions are complete.** 3.2 is pure code plus a
disposable local database — no AWS, no migration, no product web behaviour
change yet. The web still sends no preview header; that starts at 3.3.

**The branch moved under this session.** It was handed to me at `f03eed07`; two
docs-only commits (`41d92fdc`, `3f205dc0`) landed on the branch from a concurrent
session while 3.2 was in progress, recording Phase 2's independent live
validation (`PHASE2_LIVE_INDEPENDENTLY_APPROVED`). Both are documentation only
and touch nothing 3.2 depends on. `f03eed07` is an ancestor of `66657d92`, so the
history is linear and correct — but **assume the branch may move again** and
re-read `git log` before starting, rather than trusting a SHA in a handoff.

**AWS authorization is standing** for `capiro-dev` including mutations
(`AWS_PROFILE=capiro-dev`, account `967807252336`, no `[default]` profile). Not
production — 3.17 still needs separate explicit sign-off. Nothing in 3.2 used it.

**3.16 still needs a different model than the one implementing Phase 3.** Phase
2's `docs/runbooks/phase-2-independent-live-validation.md` is the template.

---

## Commands

```bash
# 3.2 — fixtures (needs a disposable local Postgres; see below)
pnpm -C apps/api exec tsx scripts/seed-engagement-phase3-parity-fixtures.ts --check-contract
pnpm -C apps/api exec jest --runInBand --forceExit scripts/seed-engagement-phase3-parity-fixtures.spec.ts
pnpm -C apps/api exec tsc -p tsconfig.engagement-phase3-fixtures.json --noEmit

# 3.1 — inventory
node scripts/engagement-phase3-ui-inventory.mjs --check apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json
node scripts/engagement-phase3-ui-inventory.spec.mjs          # 32 assertions
node scripts/verify-engagement-phase2-scope.spec.mjs          # 7 assertions

# accepted-phase verifiers
pnpm verify:engagement-phase-0
pnpm verify:engagement-phase-1
pnpm verify:engagement-phase-2        # ~12 min; runs Phase 0/1 inside it
```

`pnpm verify:engagement-phase-2` at `66657d92`: **33 passed · 0 failed · 1
skipped.** The skip is the prototype-drift gate, which needs
`OUTREACH_V3_PROTOTYPE_PATH` and `EXPECTED_OUTREACH_V3_PROTOTYPE_SHA256` exported;
the prototype is at `C:\Users\neoma\Downloads\Outreach V3 (standalone).html`. It
reported one failure mid-session — "working tree is dirty" — which was 3.2's own
uncommitted work and is resolved by the commit.

`pnpm turbo run typecheck` still fails with the same four pre-existing `TS6059`
errors in `apps/api/src/defense-budget/**` that `main` has. **New in 3.2: see
F-003 — those errors also suppress the fourteen tsconfig projects after them.**

---

## What exists

| Session | Deliverable | Status |
|---|---|---|
| 3.0 | Input lock | done (`aafb5eea`) |
| 3.1 | UI surface / API consumer inventory | done (`b51d404d`) |
| 3.R | F-001 repair: Phase 2 web-gate range | done (`a1316319`) |
| 3.2 | Deterministic full-parity fixtures | **done** (`66657d92`) |
| 3.3–3.18 | everything else | not started |

---

## 3.2 — what it built, and the three things later sessions must honour

Full detail in `docs/contracts/engagement-phase3-fixture-catalog.md`. Files:

```text
apps/api/scripts/engagement-phase3-fixture-plan.ts              pure plan + validators
apps/api/scripts/seed-engagement-phase3-parity-fixtures.ts      CLI: apply/cleanup/verify/contract
apps/api/scripts/seed-engagement-phase3-parity-fixtures.spec.ts 43 assertions
apps/api/src/engagement/__fixtures__/engagement-phase3-fixture-contract.v1.json   generated
apps/api/tsconfig.engagement-phase3-fixtures.json               typechecks the above
docs/contracts/engagement-phase3-fixture-catalog.md             the contract doc
```

**116 rows across 26 tables in 3 tenants, plus 3 ids that must resolve to
nothing.** 55 states covering all 52 fixtures the plan enumerates. Validated
against a real disposable PostgreSQL 16 + pgvector container: applied,
re-applied for idempotency, verified, cleaned to zero, confirmed by SQL.

### Three obligations 3.6–3.8 inherit

1. **3.7 must assert external-denial invariants as a DELTA, not as zero.** The
   plan words them "no job / no send intent / no provider row". The
   delivery-unknown state requires a real `OutreachSendIntent` and
   `OutreachDelivery`, so taken literally those invariants fail before any test
   runs. The contract declares exactly which rows pre-exist (`sendIntents: 1`,
   `deliveries: 1`, both named). Assert *no rows beyond those*.

2. **3.8 must record a directory-less run as a coverage limitation, not green.**
   `reportOverview` attaches meetings and `pendingActions` only inside its
   directory-match loop (`engagement.service.ts` ~5513), and directory data comes
   from an S3 snapshot, not the database — `directoryMatchesForReport` swallows
   the failure and returns `[]`. The fixture seats the one snapshot-independent
   directory address (`avery.testwell@example.invalid`, the `TEST_DIRECTORY_CONTACT`
   compiled into `directory.service.ts`) on both report-cycle meetings with two
   open tasks. Parity is unaffected either way — both modes read the same
   snapshot through the same service — but a run without it has not *exercised*
   the state.

3. **3.6 must assert refusal, not absence, for attachments.** No S3 object backs
   any fixture `s3Key` (bucket is literally named
   `phase3-parity-fixture-bucket-no-object`). A missing object produces the same
   surface symptom as a denied action, for the wrong reason.

### Two things that will look like bugs and are not

- **`capiro-internal` is a hard-coded tenant slug in the fixture.** `capiro_admin`
  resolves only on that reserved slug (`bootstrap-capiro-admin.ts`), so a
  marker-prefixed slug would produce a tenant whose admin is not a Capiro admin.
  Declared in `RESERVED_IDENTIFIERS` with its reason; the suite requires a reason
  for every such entry.
- **The seed refuses any non-loopback `DATABASE_URL`.** Cleanup is destructive
  within its own tenants. Override is `ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB=i-understand-this-is-not-a-disposable-database`.

---

## Findings ledger

`docs/plans/engagement-api/phase-3-findings-ledger.md` — **2 open, 1 closed.**

- **F-001 (P1, closed in 3.R)** — Phase 2's "no product web change" gate compared
  `PHASE2_BASE..HEAD`, so it flagged every descendant. Rescoped to Phase 2's own
  range.

- **F-002 (P1, OPEN — blocks 3.3)** — `scripts/verify-engagement-web-no-preview-header.mjs`
  bans the literal `X-Capiro-Engagement-Preview` anywhere under `apps/web/src`,
  which is exactly the string 3.3 must introduce. **Repair it as part of 3.3**:
  the fix narrows the ban to "only `apps/web/src/lib/engagement-api-preview.ts`
  (and its spec) may name the header", which needs that file to exist. Keep
  `VITE_ENGAGEMENT_API_URL` and both `localhost:4500` forms banned outright.
  I read the guard this session: it is 57 lines, walks `apps/web/src` for
  `.ts/.tsx/.js/.jsx/.mjs/.cjs`, and does a plain `source.includes(token)` against
  a four-entry `FORBIDDEN` array (lines 26–31). It is invoked by
  `scripts/verify-engagement-phase2-code.sh:267-268` as gate "current web sends
  no preview header (dedicated guard)".

- **F-003 (P2, OPEN, non-blocking — new in 3.2)** — `apps/api`'s `typecheck` is a
  fifteen-project `&&` chain and `tsc --noEmit` is *first*. It fails on four
  pre-existing `TS6059` errors, so the fourteen projects after it never execute —
  including `tsconfig.pe-scripts.json`, `tsconfig.budget-verification-v1.json`,
  and 3.2's new `tsconfig.engagement-phase3-fixtures.json`. Not repaired: rule 12
  forbids silently fixing a finding outside the session's concern, and the fix
  touches defense-budget specs unrelated to Engagement. **3.13 must invoke
  `tsconfig.engagement-phase3-fixtures.json` directly** rather than relying on the
  chain to reach it.

---

## Next: 3.3 — preview activation and scoped routing

Not started. Scouting done this session, so the next agent need not repeat it.

### What I read

- **`apps/web/src/lib/api-client.ts` is 97 lines** and is the single place a
  header can be attached: `buildApiClient(getToken, actAsTenantSlug)` creates one
  axios instance with `baseURL: config.apiBaseUrl` and one request interceptor.
  That interceptor already does three things the preview header must not disturb:
  the generation-timeout escalation (`isGenerationUrl` → `GENERATION_TIMEOUT_MS`,
  which must keep firing on `req.timeout === DEFAULT_TIMEOUT_MS`), the Clerk
  `Authorization` bearer, and the `x-capiro-impersonate-tenant` header — which is
  deliberately suppressed for `/capiro-admin/` URLs. The preview header needs the
  same suppression list plus the manifest check, and 3.10 asserts the admin
  console never receives it.
- **`apps/web/src/App.tsx:157`** is `<Route path="/engagement/*" element={<EngagementPage />} />`
  inside the `BillingGate` element route. `EngagementPage` is a **static** import
  (line 30), unlike the lazy routes around it. The plan's "no duplicate
  EngagementPage" static test should key on that single registration.
- The response interceptor already reloads the page on a 403 naming an
  impersonation session. 3.4's `ENGAGEMENT_PREVIEW_ROUTE_MISS` must not collide
  with that path.

### The design decision 3.3 has to make first

The activation contract requires **exact route-manifest matching, not loose
substring matching**. The manifest is `apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json`
— 110 routes, 90 distinct paths, `globalPrefix: /api`. Two of those paths are
**not** under `/api/engagement`: `/api/internal/ai-credentials/resolve` and
`/webhooks/recall`.

Importing that manifest into `apps/web` would ship a 110-route JSON blob in the
production bundle for a feature that is off by default. The honest alternative is
a small generated pattern list under `apps/web/src/lib/` with a verifier that
fails when it diverges from the API manifest — so a new Engagement route cannot
be added without joining the preview matcher, which is the same friction 3.1
already established for the consumer inventory. Decide this deliberately; it is
the load-bearing choice in 3.3 and a substring matcher would quietly send the
header to `/api/engagement-something-else` or miss a real route.

### Also worth knowing

- `apps/web` has **no Playwright or Puppeteer dependency.** Phase 1's harness is
  `apps/web/scripts/engagement-phase1-browser-parity.mjs` (909 lines) — read how
  it drives Chrome before choosing an approach for 3.5.
- `apps/api` has **no `"type": "module"`**, so its `.ts` compiles to CommonJS
  under the repo's Node16 setting. `import.meta.url` is a compile error in any
  file a tsconfig actually checks; use `__dirname` and `require.main === module`.
  3.2 hit this and the seed documents it inline.
- `docker` is available with `pgvector/pgvector:pg16`. Other sessions have
  `capiro-memory-phase2-pg` (55452) and `capiro-phase-pg-r82` (55433) running.
  3.2 used `engagement-phase3-fixtures` on **55474** and removed it at the end;
  reuse that name/port or pick another distinct pair.
- `prisma migrate deploy` against a fresh container takes several minutes. Run it
  in the background while writing code.

---

## What is left

3.3 (preview activation + the F-002 repair), 3.4 (service identity and denial
UX), 3.5 (dual-mode runner and browser harness), then the six parity sessions
3.6–3.11, then 3.12–3.18. Nothing after 3.2 has been started.

Explicit non-changes still true at `66657d92`: no migration, no canonical
cutover, no Recall/callback cutover, no worker transfer, no external actions
enabled, no V3 UI, no LangGraph, no prototype asset shipped, no Outreach v2
removal, no AWS mutation in Phase 3 so far.

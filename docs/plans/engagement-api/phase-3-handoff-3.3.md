# Phase 3 Handoff — after micro-session 3.3

**Branch:** `agent/engagement-api-phase-3-full-ui-parity`
**Worktree:** `C:\Users\neoma\Downloads\capiro-eng-p2`
**Head:** `50b1fbab`
**Status:** 3.0–3.3 done · F-001 closed · F-002 closed · F-003 open (P2,
non-blocking) · 3.4–3.18 remain

---

## Read first

Four of eighteen micro-sessions are complete. **3.3 is the first session that
changes product web behaviour**, and it is worth being precise about what
changed: the web can now send `X-Capiro-Engagement-Preview: v3`, but only after
an operator activates the preview by hand with a query parameter. Default
behaviour is unchanged — with the mode off the request interceptor takes one
extra branch that returns `null`. Canonical traffic still reaches the main API.

Still true: no AWS mutation, no migration, no canonical cutover, no
Recall/callback cutover, no worker transfer, no external actions enabled, no V3
UI, no LangGraph, no prototype asset shipped, no Outreach v2 removal.

The branch did not move under me this session. Re-read `git log` before starting
rather than trusting a SHA in a handoff.

AWS is authorized for `capiro-dev` including mutations (`AWS_PROFILE=capiro-dev`,
account `967807252336`, no `[default]` profile). Not production — 3.17 needs
separate sign-off. 3.3 used none of it.

3.14 and 3.16 need a different model than the one implementing Phase 3.

---

## Commands

```bash
node scripts/engagement-phase3-preview-route-patterns.mjs --check
node scripts/verify-engagement-web-no-preview-header.mjs
pnpm --filter @capiro/web exec vitest run src/lib/engagement-api-preview.spec.ts src/lib/api-client.test.ts
pnpm --filter @capiro/web test
pnpm --filter @capiro/web exec tsc -p tsconfig.json --noEmit
pnpm --filter @capiro/web build
node scripts/engagement-phase3-ui-inventory.spec.mjs
pnpm verify:engagement-phase-2
```

At this head: web suite **1641 passed / 181 files**, typecheck clean, build
clean (47s). The preview and api-client specs are 63 assertions between them.

`pnpm --filter @capiro/web lint` **cannot run in this worktree** — `eslint` is
not in `apps/web` devDependencies and no binary is installed. Pre-existing, not
introduced by 3.3, and not a Phase 3 gate. Do not chase it.

`pnpm turbo run typecheck` still fails with the same four pre-existing `TS6059`
errors in `apps/api/src/defense-budget/**` that `main` has — F-003.

---

## What 3.3 built

Ten files (eight code, one generated, one ledger). Two over the plan's 3–8
ceiling; the overage is the F-002 guard repair plus its generator, which the
plan did not anticipate landing inside 3.3. Recorded here as drift rather than
hidden.

```text
new  apps/web/src/lib/engagement-api-preview.ts
new  apps/web/src/lib/engagement-api-preview.spec.ts
new  apps/web/src/lib/engagement-api-preview-routes.generated.ts   (generated)
new  apps/web/src/pages/engagement/EngagementPreviewBoundary.tsx
new  scripts/engagement-phase3-preview-route-patterns.mjs
mod  apps/web/src/lib/api-client.ts
mod  apps/web/src/lib/api-client.test.ts
mod  apps/web/src/App.tsx
mod  scripts/verify-engagement-web-no-preview-header.mjs           (F-002)
mod  docs/plans/engagement-api/phase-3-findings-ledger.md
```

### The decision 3.3 opened with, and how it resolved

The contract requires exact route-manifest matching. Importing the 110-route
manifest into `apps/web` would ship ~40KB of controllers, guards, DTOs and
source line numbers into the production bundle for a feature that is off by
default. **Resolved in favour of the generated pattern list.**

`scripts/engagement-phase3-preview-route-patterns.mjs` derives 88 anchored
regex sources from the manifest's 90 distinct paths and writes them to a
checked-in module. `--check` fails when the module has drifted; `--write`
regenerates. Same friction 3.1 established for the consumer inventory.

Two manifest paths are excluded, in a reviewed `EXCLUSIONS` table whose reasons
are rendered into the generated file so the omission is visible in the diff
rather than implied by a count:

- `/api/internal/ai-credentials/resolve` — service-to-service, no web consumer
  in the 3.1 inventory, outside the ALB rule's path condition. Phase 4 owns it.
- `/webhooks/recall` — inbound from Recall, never the SPA. Phase 3 moves no
  callbacks.

A manifest path that is neither patterned nor in `EXCLUSIONS` is a hard failure.

### Three things 3.4–3.11 should know

1. **The exact match is what keeps the header off everything else.** `/me`,
   Capiro Admin, Workspace, Strategy, Directory and static assets are excluded
   because none of their paths are in the manifest — not because of a per-owner
   allowlist. There is no owner list here to drift out of date, and 3.10 gets
   its "admin console never receives it" assertion structurally. The
   `/capiro-admin/` impersonation suppression is untouched and separately
   asserted.

2. **The preview header attaches last in the existing interceptor**, after the
   Clerk bearer and the impersonation header, so it cannot displace either. The
   generation-timeout escalation is evaluated before any of it and is unchanged.
   All three now have regression tests in `api-client.test.ts`, driven through
   a swapped axios adapter rather than by poking interceptor internals.

3. **`consumePreviewActivation()` is pure with respect to the URL.** It returns
   the rewritten search string and lets the caller decide; `EngagementPreviewBoundary`
   applies it with `replace`, so activation adds no back-button step. Every
   other query parameter survives byte-for-byte, in order — meeting IDs, detail
   tabs, dates, report filters, client filters.

`EngagementPreviewBoundary` renders `null` and is mounted **beside** the route
table, not inside `/engagement/*`, because the mode is session-wide: 3.8 needs
the preview to apply while the SPA route is `/settings/integrations`. The
existing `<Route path="/engagement/*" element={<EngagementPage />} />` is
untouched, and a static test asserts it appears exactly once.

### Negative controls rehearsed by mutation

Each was introduced, confirmed to fail, and reverted:

| Mutation | Result |
|---|---|
| Duplicate `EngagementPage` route registration | static route test fails |
| Substring matcher swapped for the pattern list | both look-alike-prefix tests fail |
| Header token added to `apps/web/src/lib/billing.ts` | `ENGAGEMENT_WEB_PREVIEW_HEADER_GUARD_FAILED` |

---

## F-002 — closed in 3.3

Repaired inside 3.3 rather than a standalone 3.R session, because the guard and
the code it guards are one change and landing the header without the narrowed
guard would leave the branch red between two commits. This is the disposition
the 3.2 handoff already recorded.

The blanket ban became an allowlist: only `engagement-api-preview.ts` and its
spec may name the header. `VITE_ENGAGEMENT_API_URL` and both `localhost:4500`
forms stay banned outright.

**One addition beyond the proposed repair:** the guard now also fails when an
allowlisted file *no longer contains* the token. This fired for real during the
session — the spec initially imported the header constant instead of spelling
it, so the allowlist entry was dead on arrival and would have silently
pre-authorized any future file at that path. The spec now asserts the literal
`X-Capiro-Engagement-Preview` / `v3` pair, which is the real contract with the
Phase 2 ALB rule; a rename touching only the constant would otherwise pass every
test and fail only in a live environment.

---

## Next: 3.4 — service identity and preview denial UX

Scouting done; don't repeat it.

**The server side already exists and is exact.** Do not re-derive it:

- `apps/api/src/bootstrap/configure-api-http-app.ts:87` sets
  `X-Capiro-Service` on **every** response when `serviceHeader` is configured;
  the engagement runtime passes `engagement-api`. Covered by
  `configure-api-http-app.spec.ts` and
  `engagement/runtime/engagement-service-header-order.spec.ts`.
- The shadow denial is thrown by
  `engagement-runtime-policy.service.ts:126` as a `ServiceUnavailableException`
  with this body, and nothing else has this shape:

  ```json
  { "statusCode": 503, "code": "ENGAGEMENT_EXTERNAL_ACTION_DISABLED",
    "action": "<EngagementExternalAction>",
    "message": "This action is disabled in the engagement-api shadow runtime." }
  ```

  Match on `code` exactly. Do **not** match on 503, and do not match on the
  server's `message` — 3.4's required UI copy is different text
  (`This action is disabled in the Engagement API preview. No external action
  was taken.`) and the plan's negative control is precisely "any 503 labeled a
  shadow denial".
- A sibling `ENGAGEMENT_CALLBACKS_DISABLED` exists at the same site with the
  same shape. It is **not** the external-action denial and must not be
  translated as one.
- Phase 2's `engagement-phase2-preview-parity.ts:202-208` already asserts the
  service header is present **on shadow denials too**, so the identity check
  must run on the error path as well as the success path, not only on 2xx.

**Two collisions to avoid in the response interceptor** (`api-client.ts:84-95`):

1. The existing 403 handler matches `/impersonation session/i` on the response
   body, clears the slug and reloads. Run it **first** and leave it untouched —
   if the identity check replaces the error object ahead of it, that regex stops
   matching and an admin gets 403-locked out of ending their own impersonation.
2. Decide route-miss from **what was actually sent**, not from re-evaluating the
   current mode. Mark the request config when the header is attached and read
   that marker on the response. Re-deriving from `readEngagementPreviewMode()`
   is wrong for an in-flight request after the mode is toggled off, which is a
   scenario 3.9 and 3.11 both test explicitly.

**For the indicator:**

- CSS convention here is a plain co-located `.css` file imported from the
  component (`import './engagement-preview.css'`), as in
  `components/chat/meri-overlay.css`. There is no CSS-modules or
  styled-components setup.
- "Preserve exact existing layout except the small internal indicator" argues
  for `position: fixed` so it cannot reflow anything.
- Mount it beside `<EngagementPreviewBoundary />` in `App.tsx` and let it render
  `null` when the mode is off, rather than adding a second mount point inside
  the Engagement tree — `/settings/integrations` needs it too.
- Turn-off must preserve the current URL. The simple correct implementation is
  `clearEngagementPreview()` then `window.location.reload()`. **3.9 will likely
  need to replace this** with targeted invalidation of only the Engagement query
  families, because 3.9's cache contract says non-Engagement caches remain. Land
  the reload in 3.4 and leave a note; do not guess at query keys now.
- "Never render token, tenant, client, target, DB, or AWS identifiers" is a real
  negative control in the plan. The indicator's text is a fixed string; keep it
  that way and assert it.

**Preserved from the 3.2 handoff, still unconsumed:**

- 3.5: `apps/web` has no Playwright or Puppeteer. Phase 1's harness is
  `apps/web/scripts/engagement-phase1-browser-parity.mjs` (909 lines) — read how
  it drives Chrome before choosing an approach.
- 3.6 must assert **refusal**, not absence, for attachments. No S3 object backs
  any fixture `s3Key`; the bucket is named
  `phase3-parity-fixture-bucket-no-object`. A missing object produces the same
  symptom as a denied action, for the wrong reason.
- 3.7 must assert the external-denial invariants as a **delta, not zero**. The
  delivery-unknown state requires a real `OutreachSendIntent` and
  `OutreachDelivery`, so "no send intent / no provider row" taken literally
  fails before any test runs. The fixture contract declares exactly which rows
  pre-exist (`sendIntents: 1`, `deliveries: 1`, both named).
- 3.8 must record a directory-less run as a **coverage limitation, not green**.
  `reportOverview` attaches meetings and `pendingActions` only inside its
  directory-match loop (`engagement.service.ts` ~5513), and
  `directoryMatchesForReport` swallows an S3 snapshot failure and returns `[]`.
- 3.13 must invoke `tsconfig.engagement-phase3-fixtures.json` **directly** —
  F-003 means the `apps/api` typecheck chain never reaches it.
- `apps/api` has no `"type": "module"`, so `import.meta.url` is a compile error
  in any file a tsconfig checks. Use `__dirname` and `require.main === module`.
- `docker` has `pgvector/pgvector:pg16`. Other sessions run
  `capiro-memory-phase2-pg` (55452) and `capiro-phase-pg-r82` (55433). Pick a
  free port and remove the container afterwards.
- `prisma migrate deploy` on a fresh container takes several minutes —
  background it while writing code.
- The seed refuses any non-loopback `DATABASE_URL`. Override:
  `ENGAGEMENT_PHASE3_ALLOW_REMOTE_DB=i-understand-this-is-not-a-disposable-database`.

---

## Findings

- **F-001** (P1) — closed in 3.R.
- **F-002** (P1) — closed in 3.3. See above.
- **F-003** (P2, open, non-blocking) — `apps/api`'s `typecheck` is a
  fifteen-project `&&` chain and `tsc --noEmit` is first. It fails, so the
  fourteen after it never execute — including `tsconfig.pe-scripts.json`,
  `tsconfig.budget-verification-v1.json`, and 3.2's fixtures project. Not
  repaired (rule 12; the fix touches unrelated defense-budget specs). Input to
  3.13.

Open P0: 0 · Open P1: 0 · Blocking P2: 0.

# Phase 3 Handoff — after micro-session 3.1 and repair 3.R/F-001

**Repository:** `neo-capiro/capirov2`
**Branch:** `agent/engagement-api-phase-3-full-ui-parity`
**Worktree:** `C:\Users\neoma\Downloads\capiro-eng-p2`
**Head SHA:** `a1316319`
**Status:** 3.0, 3.1 complete. F-001 closed. 3.2–3.18 remain.

---

## Read this first

**Phase 3 is not close to done.** Two of eighteen micro-sessions are complete.
Nothing in Phase 3 has touched AWS, and no product web *behaviour* has changed
yet — 3.1 added only a generated fixture under `apps/web/`, no runtime code.

**AWS authorization is now standing.** Neo authorized direct AWS use for this
work, including mutations, on 2026-08-06: "dont worry about my permission for
this, go straight to aws when needed." That covers 3.15's scale-to-zero on
`capiro-dev`. It does **not** cover production — 3.17 still needs separate
explicit authorization, per the plan's own preconditions. Credentials resolve
through `AWS_PROFILE=capiro-dev` (account `967807252336`); there is no
`[default]` profile.

**3.16 still needs someone who is not the implementing agent.** The plan
requires an independent operator/model, and definition-of-done #19 depends on
it. An agent validating its own Phase 3 satisfies the letter and defeats the
purpose. `docs/runbooks/phase-2-independent-live-validation.md` is the
template to reuse for it — an independent agent ran that runbook against
Phase 2's live `capiro-dev` deploy on 2026-08-07 and returned
`PHASE2_LIVE_INDEPENDENTLY_APPROVED`, so the equivalent Phase 2 gap Neo asked
about is now closed. Phase 3's own live deploy will need the same treatment at
3.16 once it exists.

---

## Commands

```bash
node scripts/engagement-phase3-ui-inventory.mjs --check apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json
node scripts/engagement-phase3-ui-inventory.spec.mjs          # 32 assertions
node scripts/verify-engagement-phase2-scope.spec.mjs          # 7 assertions
pnpm verify:engagement-phase-0
pnpm verify:engagement-phase-1
pnpm verify:engagement-phase-2
```

`pnpm turbo run typecheck` still fails with the same four pre-existing `TS6059`
errors in `apps/api/src/defense-budget/**` that `main` already has. Documented,
not a regression — see Phase 2's handoff.

---

## What exists

| Session | Deliverable | Status |
|---|---|---|
| 3.0 | Input lock | done (`aafb5eea`) |
| 3.1 | UI surface / API consumer inventory | **done** (`b51d404d`) |
| 3.R | F-001 repair: Phase 2 web-gate range | **done** (`a1316319`) |
| 3.2 | Deterministic full-parity fixtures | not started |
| 3.3–3.18 | everything else | not started |

### Commits added by Phase 3 so far

```text
a1316319 fix(engagement): scope the Phase 2 web gate to Phase 2's own range (3.R, F-001)
8a32bc17 docs(engagement): open the Phase 3 findings ledger with F-001 and F-002
b51d404d feat(engagement): Phase 3 UI surface and API consumer inventory (3.1)
aafb5eea docs(engagement): Phase 3 input lock (3.0)
```

---

## The inventory (3.1) — what it decided, and why it matters downstream

`apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json`
is generated, never hand-edited. Contract:
`docs/contracts/engagement-current-ui-parity-v1.md`.

**13 surfaces · 23 consumer files · 146 requests · 110 routes (84 consumed, 26
`api_only`) · 53 read / 46 safe-local-write / 47 external.**

Three decisions the next sessions depend on:

1. **Classification comes from `@EngagementRuntimeAction`, not URL shape.** That
   decorator is what `engagement-api` consults to refuse a call in shadow mode,
   so the manifest cannot disagree with the runtime. 30 decorated handlers
   exist; 21 distinct external routes are reachable from the browser.

2. **`POST /outreach/send-batch` is a send route.** An end-anchored `/send$/`
   heuristic misses it — it matched `/send` and `/send-campaign` only. The
   pattern is `/send(-|$)/` and a test pins it. If you touch the heuristics,
   keep that case.

3. **`open-email` is NOT external, and this diverges from the plan.** The plan
   lists "provider-backed open-in-email" under Outreach external denial.
   `engagement.service.ts:2515` builds a `mailto:` URL locally and flips the
   record to `opened_in_email` — no provider call. It is classified
   `safe_local_write`. **3.7 must prove it as a shared safe write, not as a
   denial**, or it will "prove" a containment property the server does not have.

Two heuristic exemptions carry source citations (`open-email`,
`send-intents/:id/cancel`). 3.14 must re-read both.

---

## Findings ledger

`docs/plans/engagement-api/phase-3-findings-ledger.md` — **1 open, 1 closed.**

- **F-001 (P1, closed)** — Phase 2's "no product web change" gate compared
  `PHASE2_BASE..HEAD`, so it re-evaluated on every descendant and flagged Phase
  3's plan-specified fixture as a Phase 2 scope violation. Rescoped to Phase 2's
  own range. Only that gate was changed: the frozen-Compute-stack and migration
  gates share the shape but are correctly open-ended, since Phase 3 must not
  touch those either.

- **F-002 (P1, OPEN — blocks 3.3)** — `scripts/verify-engagement-web-no-preview-header.mjs`
  bans the literal `X-Capiro-Engagement-Preview` anywhere under `apps/web/src`,
  which is exactly the string 3.3 must introduce. **Repair it as part of 3.3**,
  not before: the fix narrows the ban to "only
  `apps/web/src/lib/engagement-api-preview.ts` may name the header," which
  requires that file to exist. Keep `VITE_ENGAGEMENT_API_URL` and the
  `localhost:4500` forms banned outright — Phase 3 routes through the existing
  base URL and the ALB preview rule, never at the service directly.

---

## Non-obvious notes for 3.2

Gathered while scoping it; none of this is written yet.

1. **`MeetingNote` requires `bodyCiphertext`, `iv`, and `authTag`.** Notes are
   encrypted at rest, so fixtures cannot insert plaintext note bodies. Find the
   service's encryption helper and use it, or the "notes encryption unavailable"
   edge state in 3.6 cannot be distinguished from a broken fixture.
2. **Required scalars are thinner than they look.** `Meeting` needs only
   `tenantId`, `subject`, `startsAt`, `endsAt`; `OutreachRecord` needs
   `tenantId`, `type`, `title`; `IntegrationConnection` needs `tenantId`,
   `provider`. Most other columns default.
3. **Phase 0's seed uses raw `$executeRawUnsafe` with fixed UUIDs**
   (`apps/api/scripts/seed-engagement-phase0-browser-fixtures.ts`). Prefer the
   typed Prisma client for 3.2 where RLS allows — `tsc` then catches schema
   mistakes without a database round-trip, which matters for a fixture set this
   size. Check `PrismaService.withTenant()` before assuming inserts pass RLS.
4. **The schema has CRLF line endings.** Regexes anchored with `^`/`$` over
   `schema.prisma` silently match nothing until you normalize `\r\n`. This cost
   two failed extraction attempts.
5. **`docker` is available with `pgvector/pgvector:pg16`**, and containers from
   other sessions are already running (`capiro-memory-phase2-pg`,
   `capiro-phase-pg-r82`). Use a distinct container name and port for Phase 3 so
   a parallel session's database is not reused or destroyed.
6. **`apps/web` has no Playwright or Puppeteer dependency.** Phase 1's browser
   harness is `apps/web/scripts/engagement-phase1-browser-parity.mjs` — read how
   it drives Chrome before choosing an approach for 3.5.

---

## What's next

**3.2 — deterministic full-parity fixtures.** Pure code plus a disposable local
database. No AWS. The fixture matrix in the plan is large (roughly 40 states
across users/tenants, meetings, Outreach v2, reports, integrations); budget a
full session for it and validate against a real Postgres rather than shipping
unvalidated SQL.

Then 3.3 (preview activation — and F-002 with it), 3.4, 3.5, and the parity
sessions 3.6–3.11.

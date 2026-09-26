# District Nexus R5 — orchestration handover (2026-09-26)

Everything in this document is verifiable from git and GitHub alone: commit SHAs, branch names, PR numbers, and
paths inside this repository. No local machine, host, or session state is referenced — if you're picking this up
fresh, `git fetch origin` and the PR links below are all you need.

## Mission (condensed from the governing plan)

District Nexus joins a client's verified federal/local footprint with district-level public context. It must
always preserve: verified client nexus vs public context; requested vs enacted/awarded money; a real zero vs
unknown data (null means unknown); complete vs partial source coverage. The R5 "Action Layer" adds five vertical
slices on top of the existing District Nexus product — District Brief, Meeting Preparation, Recommended Actions,
Meri District Tools, Proactive Alerts — each behind its own feature flag defaulting OFF, reusing existing
Prisma/RLS, client identity, change-ledger, Engagement, Meri tool registry, notification, and document services
(no parallel stores, no second ingest of a source). Full acceptance (WY-00, L3Harris/FL-08, Anduril/CA-47,
supplier coverage, navigation/isolation, the full R5 journey) and a controlled pilot rollout come after all five
slices exist and are individually reviewed.

## Status as of this commit

### Merged to `main` and confirmed live in production
| PR | Slice | Merge commit |
|---|---|---|
| [#1779](https://github.com/neo-capiro/capirov2/pull/1779) | R4 fix: CPF request list drill-through toggle + keyboard-accessible district table rows | `ae2a425a19e506484f178ff840a2617cdd5dcc09` |
| [#1780](https://github.com/neo-capiro/capirov2/pull/1780) | Idempotent CPF/CDS existing-row geography repair script (dry-run by default) | `6de047bc834e2ff68ced7cc2b61b9beb05c7c417` |
| [#1781](https://github.com/neo-capiro/capirov2/pull/1781) | **R5 foundation** + District Brief (slice 1) | `43e4083a12736c2752f0621e143a6d4b57c188f6` |
| [#1784](https://github.com/neo-capiro/capirov2/pull/1784) | Proactive district alerts (slice 5) | `1e4f7ef1f51ee82a2583d8f374ca7ee8c556018f` |

Verified live at commit `f20fe2ba46511c329c17b1b588776afffb1e3474` on the `capiro-dev-api` / `capiro-dev-web-vnext`
ECS services (2026-09-26, via `git merge-base --is-ancestor` against each merge commit above — all four confirmed
ancestors). `main` advances quickly on unrelated work; re-run that check before trusting it again.

A fresh read of the flag-state diagnostic against that live deployment shows **all five `district_nexus_r5_*`
flags OFF for every tenant** — nothing from R5 is exposed yet.

**Open risk:** #1784 adds an additive table (`district_nexus_alert_payload`, migration
`apps/api/prisma/migrations/20280924050000_district_nexus_alert_payload/`). Whether that migration has actually
been applied against the production database was **not confirmed** at handover time (no recent
`capiro-dev-api-admin-migrate` task run was found). The alerts flag is off, so nothing is broken today — but
**confirm or apply this migration before ever enabling `district_nexus_r5_alerts`.**

### Open PRs (implemented, not yet merged — branches pushed to `origin`, so `git fetch` finds them)

| PR | Slice | Branch | Gate status | Merge status |
|---|---|---|---|---|
| [#1872](https://github.com/neo-capiro/capirov2/pull/1872) | Meeting Preparation (slice 2) | `feat/dn-r5-meeting-prep` (`10e78e8d3`, `7abb6fa3b`, `ff1f65030`) | Verified against its own base: `apps/api` tsc exit 0, `apps/web` tsc exit 0, Jest 4/4, Vitest 3/3 | **CONFLICTING/DIRTY against current `main`** — needs a merge/rebase of `main` before it can land; resolve conflicts, re-verify, then merge |
| [#1873](https://github.com/neo-capiro/capirov2/pull/1873) | Meri District Tools (slice 4) | `feat/dn-r5-meri-district-tools` (`7ac556618`) | Verified against its own base: `apps/api` tsc exit 0, `apps/web` tsc exit 0, registration spec 15/15, core ledger spec 140/140, orchestrator registry spec 6/6 | **CONFLICTING/DIRTY against current `main`** — same as above |

Both PRs were cut from the tip of #1781 (`43e4083a1`); `main` has since advanced ~90 more commits from unrelated
work (business-development, defense-budget, etc.), producing real conflicts. **Do not force-merge** — pull
`main` into each branch, resolve conflicts by hand (the conflicting files are likely
`apps/api/src/district-nexus/district-nexus.module.ts` and similar registration points other slices also touch —
this exact class of conflict was already hit and resolved once for #1784, see that PR's merge commit for the
pattern), re-run the gate, then merge.

### Not yet a PR — needs rework first

**Recommended Actions (slice 3)**, branch `feat/dn-r5-district-actions`, pushed to `origin` at commit
`b2554ebfc9e486be731b2b5b3639d3fa48fea1e7`. This commit's own message says why: it's a safety checkpoint of work
left uncommitted by an interrupted worker session, **not a verified-green commit**. An earlier gate run against
an ancestor of this work reported 2 TypeScript errors in each of `apps/api` and `apps/web`; a fix was attempted
but never re-verified. **Before opening a PR for this branch:** re-run a full `apps/api`/`apps/web` typecheck plus
its Jest/Vitest specs from a clean state, fix whatever the gate actually reports (treat all of it as real, not as
pre-existing noise), only then open the PR. The new files are all under
`apps/api/src/district-nexus/r5-action-layer/r5-district-actions.*` and
`apps/web/src/vnext/pages/district-nexus/r5/DistrictActionsPanelVNext.*`, plus a new additive migration at
`apps/api/prisma/migrations/20280924040000_district_actions/`.

### Not started

**Stage E** (integrated acceptance across all five slices together, then a controlled internal pilot) has not
begun — it depends on all five slices being merged first.

## Design contract every R5 slice follows

Established in #1781 and binding for the remaining slices:

- **Placement:** API code under `apps/api/src/district-nexus/r5-action-layer/`, registered in
  `apps/api/src/district-nexus/district-nexus.module.ts`; web code under
  `apps/web/src/vnext/pages/district-nexus/r5/`, mounted into
  `apps/web/src/vnext/pages/district-nexus/DistrictNexusDrawerVNext.tsx`.
- **Flags:** one nested key per slice (`district_nexus_r5_brief`, `_meeting_prep`, `_actions`, `_meri_tools`,
  `_alerts`), gated by the shared `R5FlagGuard` / `@RequireR5Feature()` in
  `apps/api/src/district-nexus/r5-action-layer/r5-flag.guard.ts` — ON only with an explicit enabled
  `intel_feature_flag` row for BOTH the slice key and the master `district_nexus_v2`; any read error fails closed
  (404). No internal-tenant fallback, unlike some older District Nexus flags.
  All five keys are already added to `apps/api/scripts/diag-district-nexus-flag-state.ts`.
- **Single source of facts:** every slice reads district data through
  `R5DistrictContextService.getContext(tenantId, clientId, state, district)`
  (`apps/api/src/district-nexus/r5-action-layer/r5-district-context.service.ts`), which composes the existing
  District Nexus services and never queries a source a second way. A failed rail becomes a gap, never a fabricated
  zero. See the types (`R5Fact`, `R5Gap`, `R5DistrictContext`) in
  `apps/api/src/district-nexus/r5-action-layer/r5-types.ts` for the exact fact shape every fact must carry
  (source, as-of date/FY, unit, amount stage, geography scope/basis, freshness, coverage, caveats,
  verified-client-nexus-vs-public-context basis).
- **Invariants, tested in every slice:** Senate CDS requests stay statewide unless independently source-backed;
  requested and enacted amounts are separate facts, never merged; no automatic external outreach; tenant isolation
  (another tenant's client id returns 404, not data).

## Notable defects found and fixed during this run (worth knowing before touching this code again)

1. **CPF/CDS repair (now #1780) went through two real correctness fixes** before merge: an early version rewrote
   the raw source district token (e.g. `'FL08'`) to a normalized form (`'08'`) instead of leaving it
   byte-identical to what ingest persists — breaking the read path's own lookup. A later version inferred a
   requester's state from the *recipient/project* location column rather than only the source's own STDD token —
   which would have fabricated an attribution the source never made. Both are fixed in the merged version; read
   `apps/api/src/government-data/community-funding/community-funding.geography-repair.ts` and its spec before
   modifying this again.
2. **#1779's two fixes were found by re-running production QA a second time, more rigorously**, after a first
   pass had marked scenarios as PASS based on checks it hadn't actually captured (e.g. claiming tenant isolation
   was verified using unauthenticated requests that simply 401'd rather than proving no cross-tenant data leak).
   If re-running acceptance QA on this product, insist on literal per-scenario evidence, not summarized
   confidence.
3. **A prior R5 slice's tests all passed while its code did not typecheck** — its tests mocked the very services
   whose real shapes it had guessed wrong. Never trust a green test suite here without also running the real
   `apps/api`/`apps/web` TypeScript compiler over the changed files.

## Immediate next actions, in order

1. Confirm (or apply) the `district_nexus_alert_payload` migration in production before enabling
   `district_nexus_r5_alerts` — see "Open risk" above.
2. Resolve the `main`-conflicts on #1872 and #1873, re-verify, merge, re-ship both API and web.
3. Rework and re-verify `feat/dn-r5-district-actions` from scratch (do not trust its current state), then open
   its PR.
4. Re-run full live acceptance (WY-00 / L3Harris-FL-08 / Anduril-CA-47 / supplier coverage / navigation-isolation)
   against whatever commit is deployed at the time — the plan's Stage B/E acceptance matrix — before calling any
   gate closed.
5. Only after all five slices are merged, and under separate explicit rollout authorization: begin Stage E
   (integrated acceptance across the full R5 journey, then an internal pilot before any customer-facing
   expansion).

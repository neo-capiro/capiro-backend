# Program Elements Fargate service — Phase 8 handoff

What Phase 7 did to make a `apps/program-elements-service` extraction possible,
what it deliberately did not do, and what Phase 8 still has to decide.

**Phase 7 does not extract the service.** It makes the extraction a mechanical
move rather than a semantic rewrite. That was the whole point of the port/token
discipline below.

---

## What is already service-neutral

The promotion module is almost entirely free of framework coupling. Measured, not
asserted — across `src/defense-budget/promotion/*.ts`, excluding specs:

| Coupling                                    | Files                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| imports `@nestjs/*`                         | **1** — `manual-override.tokens.ts` (an injection token, nothing else) |
| imports `@prisma/client` or `PrismaService` | **1** — `manual-override-repository-prisma-v1.ts`                      |
| everything else                             | pure TypeScript over structural interfaces                             |

The pattern that achieved it: injection tokens live in their own `*.tokens.ts`
modules, so the contract file and the repository file never need to import Nest
to be wired. `snapshot-read-repository-v1.ts` and `snapshot-read-port.tokens.ts`
are the reference example — copy that split for anything new.

The Prisma-named repositories are named for the schema they target, not for a
Prisma dependency. `canonical-promotion-repository-prisma-v1.ts` takes a `pg`
`Client` directly; `snapshot-read-repository-prisma-v1.ts` and
`promotion-outbox-drain-repository-prisma-v1.ts` take structurally-typed
delegates. None of them require the Nest DI container to construct.

**Consequence for Phase 8:** the promotion engine, planner, mapping registry,
projectors, delta engine, outbox drainer, and snapshot read repositories can move
to a new package with import-path changes only. Do not treat that as licence to
change their semantics while moving them.

---

## What Phase 8 inherits, in the order it will hit them

### 1. The read services are the actual work

The engine moves cleanly. The _read path_ does not, because it is only partially
migrated — and it is blocked on things Phase 7 could not decide. From
[`PHASE-7-ARCHITECTURE-GAPS.md`](../defense-budget/PHASE-7-ARCHITECTURE-GAPS.md):

- **Gap 1** blocks six methods across `ProgramElementReadService` and
  `BudgetLinesReadService` — everything reading `canonical_stage_position` or
  `canonical_stage_action`, whose natural keys lead with `nativeIdentityHash`.
  Nothing in the repository produces that hash, and the whole Phase 6 →
  canonical chain has no producer at any link.
- **Gap 2** blocks `getContractors`, because `isNamedCompany` is a _selection
  filter_ and is absent from the Phase 4 performer projection. A null-and-backfill
  workaround does not exist for a filter — it returns every performer or none.

Both are upstream ownership decisions, not implementation work. Phase 8 should
not start the extraction expecting to finish these.

### 2. Six read methods have no canonical home at all

`getRelationships`, `getGraph`, `getIncumbents`, `listCapabilities`,
`getCapabilityRecommendations`, and `searchCapabilityLines` read
`program_element_intelligence_cache`, `federal_award`, `capability`, and
`capability_budget_line_match`. These are derived product data and external award
data — not defense-budget truth — and the mapping registry rightly has no
destination for them.

**The open decision Phase 8 must make, and Phase 7 explicitly did not:** three of
these would serve a single response built half from the active snapshot and half
from tables that are not snapshot-scoped. Invariant 22 forbids mixing two
_snapshots_ in one response; it says nothing about mixing snapshot data with
derived caches and external award data.

Someone has to rule on whether that is a legitimate partial cutover or whether
those surfaces stay on the legacy path until their inputs have canonical homes.
Until it is answered, migrating them is guesswork with a correctness label on it.

This decision also determines the service boundary: if those surfaces stay
legacy, `apps/program-elements-service` cannot own the full Program Elements HTTP
domain, and the split is by _capability_, not by _route prefix_.

### 3. Database, not database-per-service

Phase 7's non-goals forbid a separate Program Elements database, and that
constraint should survive Phase 8. Shared Aurora with distinct roles is the
boundary that is already enforced and rehearsed:

- `capiro_pe_promoter` — canonical writes, no DDL, no tenant data
- `capiro_app` — explicitly revoked from canonical writes
- parser / verifier / scheduled-ingestion roles — no canonical grants

A new service gets a new role, not a new database. Whether the data eventually
separates is a later decision, and should be made on operational evidence rather
than at extraction time.

---

## Checklist for the extraction itself

- [ ] New package `apps/program-elements-service` with its own ECR repository
- [ ] HTTP routing: preserve existing response contracts exactly. Additive
      versioned fields only.
- [ ] Identity/auth forwarding: tenant overlays must stay tenant-scoped and be
      joined _after_ global snapshot selection
- [ ] Shared-Aurora grants for the new service role
- [ ] Service discovery and independent scaling
- [ ] Move promotion, read, and outbox ports; do not move the Nest tokens —
      re-declare them in the new package
- [ ] Leave `ProgramElementWriterService` behind. It is legacy-write surface, and
      the cutover retires it rather than relocating it.

---

## What must not happen during extraction

1. **No semantic rewrite.** If a behaviour looks wrong while moving it, file it;
   do not fix it in the same change. A move plus a fix is unreviewable.
2. **No new canonical write path.** The promoter role and the activation service
   remain the only way canonical rows appear.
3. **No response-shape change.** The compatibility contract is the thing that
   made the cutover safe; breaking it during a move spends that safety on
   nothing.
4. **Do not extract before the cutover is accepted.** Moving code across a
   service boundary while the read path is still switching between legacy and
   snapshot means a shadow mismatch has two possible causes instead of one.

---

## Status of the thing you are inheriting

To set expectations honestly: Phase 7's promotion engine is well-proven against a
disposable PostgreSQL (229 checks, exit 0) and its cutover has **never run
anywhere real**. The `authorize` verb does not exist. No production-scale
rehearsal has been performed, because that requires measured production SLOs that
do not exist yet.

Phase 8 should not begin until Phase 7 has actually activated a snapshot
somewhere.

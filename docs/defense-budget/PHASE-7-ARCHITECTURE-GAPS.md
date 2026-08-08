# Phase 7 — open architecture gaps

**Status:** open as of session 8 (2026-08-07).
**Owner needed:** whoever owns Workstreams J and N.
**Why this file exists:** two of these gaps have now been rediscovered twice, by
two different sessions, each time by trying to build the thing they block. This
is the escalation artifact so the third rediscovery does not happen.

Each gap below is blocking, not cosmetic. None can be closed from inside
Workstream M or N — all three need a decision or a migration from the owner of
the workstream that was supposed to produce the missing thing.

---

## Gap 1 — the congressional-mark join has no producer or reader anywhere

**Reported by:** session 7, by attempting to migrate `getProgramElement`.
**Blocks:** `getProgramElement`, `getTimeline`, `listProgramElements` — the PE
profile's funding grid. All three are Meri-reachable.

`getProgramElement`/`getTimeline`/`listProgramElements` need HASC, SASC, HAC-D,
SAC-D, conference, NDAA, and enacted positions. Those live in Phase 6's
`canonical_stage_position`, keyed by `nativeIdentityHash`.

Session 7 checked all 767 local and remote branches: **nothing computes that
hash, and nothing resolves `peCode → nativeIdentityHash`, anywhere in the
repository.** The join the read path needs has neither a producer nor a reader.

This is a Workstream J/N gap, not an M gap. Workstream M cannot invent the
identity resolution — doing so would be exactly the source-semantic decision
Phase 7's non-goals forbid.

**To close:** decide where `peCode → nativeIdentityHash` resolution lives, and
ship the producer. Until then no congressional-mark surface can be migrated.

---

## Gap 2 — canonical performer rows do not carry `isNamedCompany`

**Reported by:** session 7, by attempting to migrate `getContractors`.
**Blocks:** `getContractors` (`namedPrimes`). Meri-reachable.

`getContractors` uses `isNamedCompany` as a **selection filter**, not a display
field — it decides which performers are named primes. The Phase 4 performer
projection does not carry it, or `publisher`, anywhere.

A display field could be served as null and backfilled later. A selection
filter cannot: without it the method either returns every performer or none,
and both are wrong answers rather than degraded ones.

**To close:** add `isNamedCompany` (and `publisher`, if the read contract still
needs it) to the Phase 4 performer projection and the canonical performer
mapping, then re-run the projection.

---

## Gap 3 — promotion eligibility is never persisted

**Found by:** session 8, by attempting to build
`authorize-defense-budget-promotion-v1`.
**Blocks:** `authorize-defense-budget-promotion-v1` — the only unbuilt verb of
the plan's eight. Transitively, it blocks any operator path to a promotion:
`execute` reloads an authorization, and today an authorization can only be
created by hand-written SQL.

There is **no eligibility table in any migration.** The Phase 7 schema ships
`defense_budget_promotion_plan`, `_authorization`, `_run`, `_item`,
`_activation`, `_outbox`, `_audit`, `_rollback_record`,
`_compatibility_projection_run`, `_side_effect_drain_pause`,
`_canonical_snapshot`, `_active_snapshot`, `_canonical_row`, `_canonical_delta`,
and `_manual_override`. It does not ship anywhere to put a
`DefenseBudgetPromotionEligibilityV1`, and `DefenseBudgetPromotionEligibilityServiceV1`
has no Prisma repository.

Why that blocks `authorize` specifically — from
`promotion-authorization-service-v1.ts`:

```ts
// Segregation evidence is derived from the eligibility record, never taken
// from the requester, so an authorizer cannot understate their involvement.
const segregation = deriveSegregationEvidenceV1(plan.eligibility, request.authorizerActorId);
```

`PromotionAuthorizationRepositoryV1.loadPlan()` must return
`StoredPromotionPlanV1`, which carries `eligibility: DefenseBudgetPromotionEligibilityV1` —
the whole record, not its hash. The service uses it for two things a hash cannot
support:

1. `promotionEligibilityHashV1(plan.eligibility)` recomputed and compared
   against the stored hash, to detect storage tampering;
2. `deriveSegregationEvidenceV1(...)`, which reads the candidate bindings to
   refuse an authorizer who reviewed — or, on a high-risk extraction method,
   extracted — the same scope.

**Building `authorize` anyway would require fabricating an eligibility record.**
That is not a shortcut with a cost elsewhere; it is the specific failure the
workstream exists to prevent. A synthesized record makes
`deriveSegregationEvidenceV1` vacuous, so authorizer-equals-reviewer and
authorizer-equals-extractor both silently pass. That defeats Workstream A's
acceptance criteria, cross-workstream invariant 3, and mandatory negative
controls 1, 2, and 3. Taking the record from the operator instead is refused by
the service's own contract — "never taken from the requester."

So `authorize` was left unbuilt, consistent with session 7's decision not to
ship unverified stubs for the other six verbs.

**To close:** this needs a migration and a repository, which is Workstream A/D
territory. The Phase 7 plan is explicit that A–D define the production trust
boundary and must not be split across parallel agents, so this should go back to
whoever executed session 1 rather than being bolted on from N. Specifically:

- a `defense_budget_promotion_eligibility` table storing the canonical
  eligibility document plus its hash, append-only, written when eligibility is
  evaluated;
- a foreign key from `defense_budget_promotion_plan.eligibility_hash` to it, so
  a plan cannot reference an eligibility that was never recorded;
- a `PrismaPromotionEligibilityRepositoryV1` implementing
  `PromotionEligibilityRepositoryV1`;
- a `PromotionAuthorizationRepositoryV1` whose `loadPlan` joins the two.

### Consequence already visible in the shipped CLIs

`plan-defense-budget-promotion-v1` requires `--eligibility-hash` as an operator
input rather than deriving it, for the same reason. The plan binds to whatever
hash it is given. Once Gap 3 closes, that flag should become a lookup and the
plan should refuse a hash with no stored eligibility behind it.

---

## What is _not_ blocked

Recorded so the next session does not re-derive it:

- `execute` and `rollback` are **not** blocked by Gap 3. They reload the plan,
  the authorization, and the projections, and only ever compare
  `eligibilityHash` as a string. Both shipped in session 8.
- `compare` is not blocked by anything. It shipped in session 8.
- `BudgetLinesReadService`'s 9 methods are not blocked by Gaps 1 or 2 — session
  7's snapshot-read pattern applies to them directly.

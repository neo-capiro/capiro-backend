# Phase 7 — open architecture gaps

**Status as of session 9 (2026-08-08):** Gap 3 is **closed**. Gap 2 is
**closed**. Gap 4 is **closed**. Gap 1 is **partially closed** — see its
update below for exactly which stages. Gap 4 was found while closing Gap 3
and closed later in the same session.
**Owner needed:** none of the four gaps still needs an owner decision before
code can be written — the decisions this file originally escalated (whether
Phase 6 persistence was deferred, and going back to the Workstream A/D owner
for Gap 3) were made in session 9: build the scoped subset for Gap 1, treat
Gap 3 as ordinary implementation work rather than something requiring a
separate design review given the plan was already fully specified, and build
Gap 4 as a ninth verb rather than a flag on `plan`.
**Why this file exists:** two of these gaps had been rediscovered twice, by
two different sessions, each time by trying to build the thing they block.
This is the escalation artifact that stopped the third rediscovery from
happening — keep it updated rather than deleting it once a gap closes, so the
history of what was actually verified survives.

Each gap below is blocking, not cosmetic. None can be closed from inside
Workstream M or N — all three need a decision or a migration from the owner of
the workstream that was supposed to produce the missing thing.

---

## Gap 1 — the native-identity join has no producer or reader anywhere

**Reported by:** session 7, by attempting to migrate `getProgramElement`.
**Widened by:** session 8 — it is not only about congressional marks.
**Blocks (6 methods, across two services):**

- `getProgramElement`, `getTimeline`, `listProgramElements` — the PE profile's
  funding grid, via `canonical_stage_position`;
- `getActions`, `getMovement`, `getWatchSignals` in `BudgetLinesReadService`,
  via `canonical_stage_action`.

All six are Meri-reachable.

Both destinations lead their natural key with `nativeIdentityHash`:

```text
canonical_stage_position → ['nativeIdentityHash', 'fiscalYear', 'stage', 'fundingField']
canonical_stage_action   → ['nativeIdentityHash', 'fiscalYear', 'stage', 'actionType', 'actionKey']
```

So the gap is not "the congressional-mark fields are missing"; it is that
**nothing can resolve a `peCode` to the key every Phase 6 canonical row is filed
under.** Any surface reading a Phase 6 destination hits it, marks and typed
actions alike.

Session 7 checked all 767 local and remote branches: **nothing computes that
hash, and nothing resolves `peCode → nativeIdentityHash`, anywhere in the
repository.** The join the read path needs has neither a producer nor a reader.

This is a Workstream J/N gap, not an M gap. Workstream M cannot invent the
identity resolution — doing so would be exactly the source-semantic decision
Phase 7's non-goals forbid.

### Session 8: the diagnosis above is a symptom, and the fix it implies would not work

Session 8 went looking for the identity resolver, on the theory that
`nativeIdentityKeyV1({ lineKind: 'RDTE_PE', peCode })` returns
`` `RDTE_PE:${peCode}` `` — a pure function of the peCode, needing no semantic
decision at all — so the gap might be unwired rather than undecidable.

It is neither. **The entire Phase 6 → canonical promotion chain has no
production producer, at any link.** Every one of these was checked across `src`
and `scripts`, excluding `.spec.ts`:

| Link                                                             | Producer in production code        |
| ---------------------------------------------------------------- | ---------------------------------- |
| Constructs a `Phase6NativeProjectionV1`                          | **none** — only spec fixtures      |
| Computes `nativeIdentityHash` (required, sha256)                 | **none, anywhere**                 |
| Calls `Phase6AuditProjectionRepository`                          | **none** — the class has no caller |
| Connects to the `phase6-projection` Prisma client                | **none at all**                    |
| Calls `projectPhase6ProjectionsV1` (Phase 7's Phase 6 projector) | **none**                           |

The `phase6-projection` database has a schema, migrations, and a generated
client. Nothing in the application or any script ever opens it.

So the read-side join is not the blocker; it is downstream of the blocker.
**There is nothing to join to, and there would still be nothing if
`peCode → nativeIdentityHash` were solved tomorrow** — the resolver would point
at a table that no code path can ever populate. Shipping the fix as session 7
scoped it produces a resolver over permanently empty storage.

### What this raises, which is above this file's pay grade

Phase 7's mandatory prerequisite 7 requires Phase 6 "merged and green"
_including_ "verified stage/action/provision projections". Phase 6's suite is
genuinely green — 780 tests and 24/24 negative controls, confirmed in session 8.
But green tests over contracts and projectors whose production wiring does not
exist is a different claim from a working projection pipeline, and Phase 7's
prerequisite was accepted on the former. Someone who owns Phase 6 needs to say
which was intended: that persistence is deliberately deferred to a later
workstream, or that a producer was expected to exist and does not.

**To close:** not "ship the identity resolver". First decide whether Phase 6
projections are meant to be produced and persisted at all, and by what. The
identity-hash question (hash the natural key, or key the registry by the plain
`nativeIdentityKeyV1` string the stage emissions already carry) is a small
representation choice that only matters once something produces rows.

### Session 9: partially closed, for a real subset

The decision this section asked for was made: persistence was not deliberately
deferred, it was simply never wired. Session 9 built the producer —
`phase6-projection-builder-v1.ts` (`nativeIdentityHashV1`,
`buildStagePositionProjectionV1`, `buildStageActionProjectionV1`), a Prisma
persistence adapter for `Phase6AuditProjectionRepository`
(`phase6-audit-projection-repository-prisma-v1.ts`), a `persist-phase6-audit-
projections-v1` command, and a `committee` family added to
`PrismaPromotionProjectionSourceV1` that reads persisted rows back and calls
`projectPhase6ProjectionsV1`. Proven end to end against a real disposable
Postgres (`phase6-producer-rehearsal.sh`, 16/16 checks): build → certify →
persist → read back → project, with exact money surviving the NUMERIC round
trip and a real `nativeIdentityHash`, not a placeholder.

**This closes the gap only for:** `stage_position` from HASC, SASC, HAC-D,
SAC-D, NDAA conference, and appropriations conference — i.e., everything
`emitStageRowsV1` produces — plus `stage_action` for identity-scoped actions
(one native line, not a package/account scope or a transfer pair).

**Still open, each for a specific reason, not merely "not gotten to":**

- `public_law` / `continuing_resolution` positions (the `enacted` field) —
  need to link an `EnactmentProofV1` from `stages/enacted/`, which the builder
  never received. Building it without that would mean fabricating proof
  linkage or promoting an enacted value with none.
- `reprogramming` / `execution` positions — their source module
  (`stages/post-enactment/reprogramming-execution-v1.ts`) has a different
  output shape nobody has read yet; `execution` additionally needs a metric/
  as-of-date/cumulative decision the builder cannot make from a bare
  `StagePositionV1`.
- Package-scope, account-scope, and transfer-pair actions — no single native
  identity, so `nativeIdentityHash` has no defined value for them. This is
  exactly the kind of decision this file exists to stop someone from guessing
  at under time pressure.
- `vehicle_proof`, `native_line_binding`, `provision_link`, `enactment_proof` —
  not attempted.

So `getProgramElement`/`getTimeline`'s funding grid can now be migrated for
the authorization and non-enacted-appropriations stages specifically. Enacted
marks, reprogramming, and execution remain blocked exactly as before.

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

### Session 9: closed

The existing heuristic in `scripts/sync-jbook-performers.ts` was extracted,
verbatim, into a shared pure module (`r3-named-company-classifier.ts`,
10 unit tests), so the legacy loader and the real Phase 4 R-3 extractor now
share one implementation instead of two that could drift apart. Wired into
`r3-table-extractor-v1.ts`'s row construction, threaded through
`r3-artifact-builder-v1.ts`'s assertion metadata (the same `metadata` bag
`roleExplicit` already rides in — no Phase 1 contract/schema-version change
needed), and read by `rdte-projection-planner-v1.ts`'s performer case into
`values.isNamedCompany`, defaulting to `null` ("unknown") rather than a
guessed boolean when an older artifact carries no classification. The
snapshot diff comparator was updated to notice a changed classification.
Full `verify:pe-budget-phase-4`: 317/317 tests.

`publisher` remains unaddressed — the gap's own text already called it
optional ("if the read contract still needs it"), and it is a display field,
not a selection filter, so it carries none of Gap 2's urgency.

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

### Session 9: closed

Built exactly the recipe this section specified, plus the one thing it noted
as a follow-on:

- migration `20260903010000_pe_budget_phase7_promotion_eligibility` — the
  `defense_budget_promotion_eligibility` table (append-only, same
  `enforce_promotion_ledger_append_only` trigger every other promotion ledger
  table uses), and the foreign key from
  `defense_budget_promotion_plan.eligibility_hash` to it;
- `PrismaPromotionEligibilityPersistenceRepositoryV1` (insert/findByHash,
  content-addressed, idempotent on hash, re-validates on read rather than
  trusting storage) and `PrismaPromotionAuthorizationRepositoryV1`
  (`loadPlan` now genuinely joins plan → eligibility document) —
  `promotion-eligibility-authorization-repository-prisma-v1.ts`, 9 unit tests;
- `authorize-defense-budget-promotion-v1.ts`, wired into `entrypoint.sh`
  under the serve-role group (not execute/rollback's promoter group — the
  authorization service's own documented boundary is that it runs under
  `capiro_app` and can reach nothing else).

**This is not a hash-comparison shortcut.** `PrismaPromotionAuthorizationRepositoryV1.loadPlan`
returns the real `DefenseBudgetPromotionEligibilityV1` document, re-parsed
through its own schema and re-hashed to catch tampering — the exact thing
this section said a bare hash could not support, because
`deriveSegregationEvidenceV1` needs the candidate bindings themselves, not
their hash.

**Proven against a real disposable Postgres**
(`pe-budget-phase7-gap3-authorize-rehearsal.ts`, run from
`pe-budget-phase7-migration-rehearsal.sh`): the foreign key genuinely refuses
a plan filed against an unrecorded eligibility hash; the real CLI issues a
real authorization from a real persisted eligibility record; a reused
authorization ID is refused; and — the check that matters most — an
authorizer who is also the reviewer named in a **real** eligibility record's
own candidate list is refused with `segregation_violation`, derived from
actual data rather than a test double.

Two things intentionally **not** done, both out of Gap 3's own scope:

1. **`PromotionEligibilityRepositoryV1` (the fact-computing read port
   `DefenseBudgetPromotionEligibilityServiceV1.evaluate()` uses) still has no
   Prisma implementation.** That is a different, much larger repository —
   reading real candidates from Phase 2's verification tables, certifications
   from Phase 6, projection plans from Phase 4/5/6, conflicts, and the active
   snapshot — and building it was not attempted. Consequently, an eligibility
   record must still be assembled by an operator or a future script and handed
   to `PrismaPromotionEligibilityPersistenceRepositoryV1.insert()` directly;
   nothing yet _derives_ a fresh eligibility evaluation from live data. This
   is the honest limit of "Gap 3 closed": the storage and the authorize verb
   are real; automatic eligibility computation is not.
2. **`plan-defense-budget-promotion-v1`'s `--eligibility-hash` was not changed
   into a lookup**, as this section's own note suggested it should become.
   Left alone deliberately: see Gap 4 below — the CLI doesn't file a plan row
   at all, so changing how it treats the flag wouldn't yet be exercised by
   anything real.

---

## Gap 4 — nothing files a promotion plan into the database

**Found by:** session 9, while building the Gap 3 rehearsal, from
`plan-defense-budget-promotion-v1.ts`'s own header: _"the plan is filed by a
separate authorized step, not by this command."_ That separate step does not
exist.

**Blocks:** the operator path from `plan` to `authorize`/`validate`/`execute`
end to end. Not new — this predates Gap 3 and predates session 9 — but it was
never written down.

`plan`, `validate`, `execute`, and now `authorize` all read
`defense_budget_promotion_plan` expecting a row to already be there
(`.findUnique`, or `loadPlan`'s raw-SQL equivalent). Checked across `src` and
`scripts`, excluding rehearsal/test code: **no production code path ever
inserts one.** Every rehearsal that exercises `validate`/`execute`/`authorize`
seeds the plan row directly with `$executeRawUnsafe`/raw `psql`, from the
operator's own already-computed plan document and hash — which is a
reasonable way to _test_ the downstream verbs, but is not a "file the plan"
capability an operator can actually run.

**Why this wasn't caught by Gaps 1–3's own review:** each of those gaps was
found by trying to build one specific verb and hitting a wall immediately in
front of it. Gap 4 is one layer upstream of all of them — `validate` and
`execute` were already written against a plan row that "just exists," so
nobody building them needed to ask where it came from.

**To close:** a `file-defense-budget-promotion-plan-v1` verb (or an
`--file`/`--commit`-style flag on `plan` itself) that takes a computed plan
document, inserts it into `defense_budget_promotion_plan`, and refuses a
duplicate `plan_id` with a different hash. It should run under the serve
role, matching `plan`'s own credential. Whether it belongs on the existing
`plan` CLI or as a ninth verb is a design call for whoever picks this up —
not resolved here, and deliberately not decided under time pressure while
closing an unrelated gap.

### Session 9 (continued): closed

Built as a ninth verb — `file-defense-budget-promotion-plan-v1.ts` —
rather than a flag on `plan`, to keep `plan` itself pure/read-only (its own
header's claim, now actually true rather than aspirational). Takes the full
plan document `plan-defense-budget-promotion-v1` already prints (either its
whole report, reading the nested `.plan`, or a bare plan object), recomputes
`promotionPlanHashV1` over it, and inserts one row. Dry run by default,
`--commit` to write. Refuses a `plan_id` already filed under a different
hash (`plan_id_conflict`); accepts a byte-identical refile as a replay,
matching every other content-addressed table in this schema. Runs under the
serve role — filing what `plan` already computed carries no promotion
authority of its own. Wired into `entrypoint.sh` alongside `plan`/`validate`/
`authorize`, and into `tsconfig.phase7.json`.

**One real bug caught before this ever ran against a database:**
`promotionPlanHashV1`'s parameter type is `Omit<DefenseBudgetPromotionPlanV1,
'planHash'>` — but `Omit` is erased at runtime. The loaded plan document
already carries a `planHash` field (attached by `buildPromotionPlanV1`
*after* computing the hash over the field-less object), so recomputing the
hash directly on the loaded object hashes a different value than the
original every time and refuses every plan as tampered. Fixed by destructuring
`planHash` out before recomputing — the same erased-`Omit` shape mismatch as
the missing `::uuid`/`::timestamptz` casts found in Gap 3, just at the
TypeScript layer instead of the SQL layer: a type that claims a runtime
guarantee it cannot actually enforce.

**Proven against a real disposable Postgres**, replacing the raw-SQL
plan-filing step in `pe-budget-phase7-plan-rehearsal.ts` with a real spawn of
this CLI: the plan produced by `plan-defense-budget-promotion-v1` is filed
through the actual verb, read back by `validate-defense-budget-promotion-v1`,
and the append-only trigger refuses a later `UPDATE` to it — exercised as
part of the full `pe-budget-phase7-migration-rehearsal.sh` run, 103/103
checks passing.

The operator sequence is now, in full, real commands rather than partly
described and partly raw SQL:

```text
plan-defense-budget-promotion-v1
  -> file-defense-budget-promotion-plan-v1 --commit
  -> validate-defense-budget-promotion-v1
  -> authorize-defense-budget-promotion-v1
  -> execute-defense-budget-promotion-v1
```

All nine verbs now have real, wired, rehearsed CLIs. What remains open is
not a missing verb: it is `PromotionEligibilityRepositoryV1`'s fact-computing
side (Gap 3's note 1 — an eligibility record must still be assembled and
handed to the persistence repository by an operator or script, nothing yet
derives one from live Phase 2/4/5/6 data), Gap 1's remaining scope (enacted
positions, reprogramming/execution, package/account/transfer-pair actions),
and everything outside this file's scope entirely: measured production SLOs
and a human-authorized canary.

---

## What is _not_ blocked

Recorded so the next session does not re-derive it:

- `execute` and `rollback` are **not** blocked by Gap 3. They reload the plan,
  the authorization, and the projections, and only ever compare
  `eligibilityHash` as a string. Both shipped in session 8.
- `compare` is not blocked by anything. It shipped in session 8.

---

## Correction — `BudgetLinesReadService` is not the easy next target

The session-7 handoff recommends "migrate `BudgetLinesReadService`'s 9 methods
(pattern from this session applies directly)" as unblocked work, and an earlier
revision of **this file repeated it**. Checked properly in session 8 by mapping
every method to the tables it reads and every table to its canonical entity:
**not one of the nine migrates cleanly.**

| Method                         | Reads                        | Canonical status                      |
| ------------------------------ | ---------------------------- | ------------------------------------- |
| `getActions`                   | `budgetAction`               | **Gap 1** — `canonical_stage_action`  |
| `getMovement`                  | `budgetAction`, PE, cache    | **Gap 1** + cache                     |
| `getWatchSignals`              | `budgetAction`, PE, tenant   | **Gap 1** + tenant overlay            |
| `getRelationships`             | relationship, PE, cache      | canonical, **+ cache**                |
| `getGraph`                     | relationship, PE, cache      | canonical, **+ cache**                |
| `getIncumbents`                | `federalAward`, performer    | performer canonical, **award is not** |
| `listCapabilities`             | `capability`                 | **no canonical entity**               |
| `getCapabilityRecommendations` | capability, match, PE, cache | **no canonical entity**               |
| `searchCapabilityLines`        | PE, cache, embeddings        | **no canonical entity**               |

Two distinct reasons, neither of them time:

1. **Three methods read `budget_action`**, which maps to `canonical_stage_action`,
   whose natural key is `['nativeIdentityHash', 'fiscalYear', 'stage',
'actionType', 'actionKey']`. It leads with `nativeIdentityHash`, so these are
   blocked by **Gap 1** for exactly the same reason `getProgramElement` is.
   Gap 1 is therefore wider than session 7 recorded: it blocks actions, not just
   congressional marks.
2. **Six methods read tables with no canonical entity at all** —
   `program_element_intelligence_cache`, `federal_award`, `capability`,
   `capability_budget_line_match`. These are derived product data and external
   award data, not defense-budget truth, and the mapping registry rightly has no
   destination for them.

What _is_ reachable, for the record: `canonical_rdte_program_element` is keyed
`['peCode']`, `canonical_rdte_performer` is keyed
`['peCode', 'projectCode', 'performerName', 'performerRole']`, and
`canonical_budget_line_relationship` is keyed by `fromNaturalKey`/`toNaturalKey`
— which for an RDT&E line _is_ the peCode. So the identity, performer, and
relationship halves are all queryable by `peCode` without Gap 1's hash.

**The open question this raises is a plan-owner decision, not an implementation
one:** `getRelationships`, `getGraph`, and `getIncumbents` would each serve a
single response built half from the active snapshot and half from tables that
are not snapshot-scoped at all. Invariant 22 forbids mixing two _snapshots_ in
one response; it says nothing about mixing snapshot data with derived caches and
external award data. Someone has to decide whether that is a legitimate partial
cutover or whether those surfaces stay on the legacy path until their inputs
have canonical homes. Until that is answered, migrating them is guesswork with a
correctness label on it.

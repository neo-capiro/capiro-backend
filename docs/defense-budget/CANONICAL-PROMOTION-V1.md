# Canonical promotion V1

How verified defense-budget projections become canonical production data, and
what stops them when they shouldn't.

**Status:** the promotion engine is implemented and proven against a disposable
PostgreSQL. **It has never run against a real database.** See
[What is not done](#what-is-not-done) before treating any of this as
operational.

Companions:

- [`docs/runbooks/defense-budget-promotion-v1.md`](../runbooks/defense-budget-promotion-v1.md) — running a promotion
- [`docs/runbooks/defense-budget-snapshot-rollback-v1.md`](../runbooks/defense-budget-snapshot-rollback-v1.md) — undoing one
- [`docs/runbooks/defense-budget-legacy-cutover-v1.md`](../runbooks/defense-budget-legacy-cutover-v1.md) — retiring the legacy writers
- [`PHASE-7-ARCHITECTURE-GAPS.md`](./PHASE-7-ARCHITECTURE-GAPS.md) — remaining gaps (Gaps 2, 3, and 4 closed in session 9; Gap 1 partially closed)

---

## 1. The one-sentence version

Phase 2 says a number is _true_; Phase 7 says a number is _published_ — and the
two are deliberately different decisions, made by different people, recorded in
different tables.

Everything below follows from that split. If you only remember one thing:
**`VERIFICATION_PASSED` grants no canonical authority whatsoever.** Neither does
`REVIEW_ACCEPTED`. A human `capiro_admin` has to authorize a specific plan hash
against a specific expected snapshot, and that authorization is single-use and
expires.

---

## 2. Why snapshots instead of mutable rows

The pre-Phase-7 canonical tables (`program_element`, `program_element_year`, …)
are mutable and are written row-by-row by loaders. That design has three
properties this phase had to remove:

1. **No atomic annual cycle.** A partially-loaded FY is directly observable by
   users — the read path cannot tell "loading" from "this program lost its
   funding".
2. **No rollback that isn't destructive.** Undoing a bad load means editing
   financial history back to a state nobody recorded.
3. **No provenance at the row.** A value's authority came from a caller-supplied
   source string, so two writers disagreeing produced a last-wins result with no
   evidence trail.

Snapshot-scoping fixes all three with one idea: canonical rows are immutable and
belong to exactly one snapshot, and exactly one snapshot is _active_ at a time.
Publishing is a pointer move. Rollback is the same pointer move backwards.
Correcting is a new snapshot, not an edit.

```text
verified projections
        ↓  (mapping registry — no semantic reinterpretation)
deterministic promotion plan          ← read-only, hashed, reproducible
        ↓  (independent human authorization, one-use, expiring)
snapshot-scoped staging               ← invisible to production reads
        ↓  (pre-activation integrity proof)
atomic activation                     ← one small transaction, pointer move
        ↓
promotion outbox → deltas, caches, alerts   ← replayable, cannot fail the commit
```

---

## 3. Schema

Sixteen tables, all additive, in four migrations:

| Migration                                                    | Adds                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `20260822010000_pe_budget_phase7_canonical_promotion`        | the 12 core tables, the `capiro_pe_promoter` role, grants, and every append-only trigger     |
| `20260822020000_pe_budget_phase7_manual_override_queue_link` | `defense_budget_manual_override` ↔ reconciliation-queue link                                 |
| `20260902010000_pe_budget_phase7_outbox_drain`               | `defense_budget_side_effect_drain_pause`                                                     |
| `20260903010000_pe_budget_phase7_promotion_eligibility`      | `defense_budget_promotion_eligibility`, plus the FK from the plan table's `eligibility_hash` |

```text
defense_budget_canonical_snapshot        one row per annual cycle attempt
defense_budget_active_snapshot           the pointer. One row per domain.
defense_budget_canonical_row             every promoted row, snapshot-scoped
defense_budget_canonical_delta           snapshot-to-snapshot generic deltas

defense_budget_promotion_eligibility     an eligibility evaluation, content-addressed
defense_budget_promotion_plan            what a promotion *would* do
defense_budget_promotion_authorization   a human's one-use permission
defense_budget_promotion_run             one execution attempt
defense_budget_promotion_item            per-row operation + alert disposition
defense_budget_promotion_activation      the activation ledger (append-only)
defense_budget_promotion_outbox          downstream effects, created in the
                                         activation transaction
defense_budget_promotion_audit           append-only attempt log
defense_budget_rollback_record           forward pointer transitions

defense_budget_manual_override           governed human overlay
defense_budget_compatibility_projection_run
defense_budget_side_effect_drain_pause
```

### Invariants the database enforces, not the comments

These are triggers and constraints. Application bugs cannot get past them:

| Guard                                             | Enforces                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `enforce_active_snapshot_preconditions`           | new snapshot is `READY`; previous active matches the expected ID; required scopes complete |
| `enforce_active_snapshot_no_delete`               | the pointer row is never deleted                                                           |
| `enforce_canonical_snapshot_immutable_identity`   | a snapshot's identity fields never change after creation                                   |
| `enforce_canonical_row_boundary`                  | rows of an activated snapshot cannot be updated or deleted, by any role                    |
| `enforce_promotion_authorization_append_only`     | authorizations are insert-only                                                             |
| `enforce_promotion_run_authorization_match`       | a run's plan hash and scope match its authorization                                        |
| `enforce_authorization_not_expired_on_activation` | expiry is checked at activation, not only at issue                                         |
| `enforce_promotion_ledger_append_only`            | activation and rollback records are insert-only                                            |
| `enforce_manual_override_lifecycle`               | overrides are superseded or revoked, never deleted                                         |
| `enforce_audit_append_only`                       | the audit table has no `DELETE`/`TRUNCATE` path                                            |
| `enforce_promotion_ledger_append_only` (reused)   | eligibility records are insert-only, same rule as plans/activations/rollbacks              |
| `defense_budget_promotion_plan_eligibility_fkey`  | a plan cannot reference an eligibility hash that was never recorded                        |

### Database roles

`capiro_pe_promoter` is the only role that may write canonical rows.

- **Reads:** verified projections and required reference tables (conditionally
  granted, so a fresh migration of a database without Phase 4–6 tables still
  applies).
- **Writes:** promotion, canonical, and outbox tables only.
- **Denied:** DDL, role creation, migration privileges, tenant user data.

`capiro_app` (the serve role) is explicitly `REVOKE`d from
`INSERT/UPDATE/DELETE/TRUNCATE` on canonical tables. This matters more than it
looks: migration `20260130…` runs `GRANT ALL ON ALL TABLES IN SCHEMA public TO
capiro_app`, so a canonical table protected _only_ by omission would silently
become writable by the API. The revokes are the actual boundary.

The promoter task reads `PROMOTER_DATABASE_URL` and **never** falls back to the
composed `DATABASE_URL` — `execute` and `rollback` skip `compose_database_url`
in `scripts/entrypoint.sh` for exactly this reason.

---

## 4. The lifecycle

```text
PLAN_CREATED → PLAN_VALIDATED → AWAITING_AUTHORIZATION → AUTHORIZED
  → STAGING → STAGED → READY → ACTIVATING → ACTIVE
  → SIDE_EFFECTS_PENDING → COMPLETED

FAILED_PRECOMMIT                      no canonical change occurred
COMMITTED_WITH_SIDE_EFFECT_FAILURE    snapshot IS active; downstream is behind
SUPERSEDED                            a later snapshot took the pointer
ROLLED_BACK                           the pointer moved back; nothing deleted
```

Terminal statuses are immutable. Changing a plan requires a new plan ID and a
new authorization — an authorizer can never edit what they are approving.

`COMMITTED_WITH_SIDE_EFFECT_FAILURE` is the status people misread. It does not
mean the promotion failed. It means the canonical truth is published and correct,
and the deltas/caches/alerts are behind. The fix is `resume`, never a rollback.

---

## 5. Promotion modes and alert dispositions

The mode is an **operator declaration**, not an inference. Nothing tries to guess
"this looks like a hydration because a lot of rows changed".

| Mode                 | Meaning                                                          | Default alerting |
| -------------------- | ---------------------------------------------------------------- | ---------------- |
| `baseline_hydration` | first load of existing production data into a snapshot           | all suppressed   |
| `new_cycle`          | a genuinely new budget cycle                                     | eligible         |
| `correction`         | fixing a bad extraction, via corrected source + new verification | suppressed       |
| `rollback`           | pointer moved back                                               | suppressed       |

Every item carries an alert disposition that says _why_ it is or isn't alertable:

```text
eligible                     a real, official, material change
none                         nothing changed
suppressed_hydration
suppressed_correction
suppressed_rollback
suppressed_not_alertable     this entity kind never alerts
```

The distinction between `none` and `suppressed_*` is deliberate: it lets an
operator tell a deliberately quiet run from an entity that would never have
alerted anyway.

## 6. Plan operations and block reasons

| Operation    | Meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `INSERT`     | new canonical row                                               |
| `SUPERSEDE`  | prior active row replaced by a new-snapshot row                 |
| `UNCHANGED`  | identical row hash; carried forward                             |
| `CORRECTION` | supersedes under a `correction` mode run                        |
| `BLOCKED`    | **stops the promotion.** Never dropped, never silently skipped. |

`BLOCKED` reasons:

```text
unsupported_mapping           duplicate_natural_key
conflicting_duplicate_values  active_row_drift
missing_dependency_row        manual_override_collision
candidate_identity_link       missing_enactment_proof
```

An unsupported projection kind is a blocking item, not an omission. That is the
single most important difference between this planner and the legacy loaders.

---

## 7. Reads

Read mode is a four-step ladder, defaulting to `legacy`:

```text
legacy → shadow → snapshot_canary → snapshot
```

In `shadow`, the legacy response is served, the snapshot response is computed,
volatile fields are normalized, and deterministic digests are compared. Only
digests and mismatch classifications are logged — never response bodies.

Two read rules that are easy to violate:

- **One response never mixes two snapshots.** Tenant overlays (watches,
  relevance, feedback) are joined _after_ the global snapshot is selected.
- **Legacy writes are refused once any tenant is served from a snapshot**, even
  with `PE_LEGACY_BUDGET_WRITES=allow`. A legacy writer mutating compatibility
  tables under a live shadow comparison makes the dashboard an operator is using
  to decide whether to proceed untrustworthy. The read mode can veto the
  override; the override cannot veto the read mode.

---

## 8. Operator verbs

All eight of the plan's own verbs, plus a ninth — `file-defense-budget-promotion-plan-v1`,
closed in session 9 as Gap 4 — are wired in `scripts/entrypoint.sh`:

| Verb                                              | Writes?                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `plan-defense-budget-promotion-v1`                | no — read-only                                                            |
| `file-defense-budget-promotion-plan-v1`           | writes only the one plan row it was given; dry run unless `--commit`      |
| `validate-defense-budget-promotion-v1`            | no — read-only                                                            |
| `status-defense-budget-promotion-v1`              | no — read-only                                                            |
| `compare-defense-budget-canonical-reads-v1`       | no — read-only                                                            |
| `authorize-defense-budget-promotion-v1`           | writes only an immutable, one-use authorization record                    |
| `execute-defense-budget-promotion-v1`             | promoter role; dry run unless `--commit --confirm <env>`                  |
| `rollback-defense-budget-snapshot-v1`             | promoter role; dry run unless `--commit --confirm <env>`; deletes nothing |
| `resume-defense-budget-promotion-side-effects-v1` | writes only this scope's drain-pause row                                  |

`authorize-defense-budget-promotion-v1` was the last of the original eight,
closed in session 9 (Gap 3 in
[`PHASE-7-ARCHITECTURE-GAPS.md`](./PHASE-7-ARCHITECTURE-GAPS.md)). It runs
under the general serve role, reloads a plan's full eligibility record via
`PrismaPromotionAuthorizationRepositoryV1`, and derives segregation-of-duties
evidence from that record's real candidate bindings rather than from the
caller.

**There is now a full operator path from `plan` to a promotion.** Gap 4 (also
found and closed in session 9) was that nothing filed a plan into
`defense_budget_promotion_plan` — every rehearsal that exercised
`authorize`/`validate`/`execute` seeded that row directly with SQL, and there
was no operator-facing equivalent. `file-defense-budget-promotion-plan-v1`
closes it: it takes the plan document `plan` already printed, recomputes its
hash to prove it was not altered in transit, and inserts it. The full sequence
— `plan` → `file-defense-budget-promotion-plan-v1 --commit` → `validate` →
`authorize` → `execute` — is now real commands throughout, proven against a
real disposable Postgres.

---

## 9. What is not done

Stated plainly, because a green test run does not distinguish these from done:

| Item                                                        | State                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Promotion engine, planner, mapping, schema, roles, triggers | implemented; proven on disposable PostgreSQL                                                                                                                                                           |
| Disposable PostgreSQL rehearsal                             | 103 checks (Phase 7's own), plus passing rehearsals for RDT&E, non-RDT&E, and committee/Phase 6 ingestion, exit 0                                                                                      |
| `authorize` verb                                            | **closed** (Gap 3) — real eligibility storage, real segregation-of-duties evidence, proven against a real database                                                                                     |
| Filing a plan into the database                             | **closed** (Gap 4) — `file-defense-budget-promotion-plan-v1`, proven against a real database                                                                                                          |
| Phase 6 → canonical stage positions/actions                 | **partially closed** (Gap 1) — HASC/SASC/HAC-D/SAC-D/NDAA/appropriations-conference positions and identity-scoped actions now flow real; enacted/reprogramming/execution/package-scoped actions do not |
| `getContractors` / named primes                             | **closed** (Gap 2) — `isNamedCompany` now flows from extraction through to the projection                                                                                                              |
| `PromotionEligibilityRepositoryV1` (fact-computing side)     | **not built.** An eligibility record must still be assembled by an operator or a script, not derived from live data                                                                                    |
| Production-scale rehearsal                                  | **not run.** Requires measured production SLOs; the plan forbids inventing thresholds                                                                                                                  |
| Canary acceptance matrix                                    | **not run.** Requires a separate authorization and a human operator                                                                                                                                    |
| Any activation against a real database                      | **never happened, in any environment**                                                                                                                                                                 |

The honest summary: the promotion engine is well-proven, all four
architecture gaps that were blocking read-side migration, `authorize`, and
plan-filing are now closed or substantially narrowed, every data family's
ingestion pipeline has been independently proven against a real disposable
Postgres, and the cutover has still never run anywhere real.

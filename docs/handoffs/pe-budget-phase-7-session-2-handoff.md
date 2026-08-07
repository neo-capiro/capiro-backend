# Phase 7 handoff — Session 2 → Session 3

**Mission for the next session: implement Phase 7 Workstream E, then F, G, H.**

Workstreams **A, B, C, and D are complete and demonstrated**. E is the transaction
and security boundary and must pass independent review before any family
projector (F–H) is accepted.

Authoritative spec: `phase-7-verified-canonical-promotion-production-cutover-v1.md`.
This handoff records repository reality, not a substitute for that plan.

> **Scope note.** The plan's own guidance is not to run more than four
> implementation workstreams in one session. E–H is four. E alone is the
> riskiest single workstream in Phase 7 — it owns staging, the atomic activation
> transaction, retry semantics, and rollback. If context gets tight, ship E
> properly and hand F–H forward rather than rushing the activation path.

---

## 1. Repository state

| Item                     | Value                                                     |
| ------------------------ | --------------------------------------------------------- |
| Branch                   | `agent/pe-budget-canonical-promotion-cutover-v1` (pushed) |
| Branch HEAD              | `f2d264492994a6c04f8bf1dd73e9f780d57175ab`                |
| `origin/main` at handoff | `5c42167da` — "Merge pull request #780"                   |
| Behind main              | 0 commits (main merged this session at `337d332d1`)       |
| Working tree             | clean                                                     |
| Open Phase 7 PR          | none yet                                                  |

### Commits added this session

```text
f2d264492  feat(pe): Phase 7 WS A closeout — eligibility service, append-only audit, guarded authorization surface
e5a82fed2  feat(pe): Phase 7 WS D — canonical snapshot schema, promotion ledger, DB role isolation
fb751720e  feat(pe): Phase 7 WS C — deterministic promotion planner and canonical diff
52c8ee037  feat(pe): Phase 7 WS B — canonical mapping registry V1
337d332d1  Merge remote-tracking branch 'origin/main'
```

### First four commands

```bash
git -C <clone> fetch origin && git -C <clone> merge origin/main --no-edit
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@capiro/shared --filter=@capiro/meriv2-core --filter=@capiro/auth --filter=@capiro/strategy-verifier
pnpm --filter @capiro/api exec prisma generate   # and the three projection schemas — see §5
```

`main` moves several times a day. Re-merge before starting and again before any
acceptance run.

---

## 2. What Workstreams A–D delivered

All of it lives in `apps/api/src/defense-budget/promotion/`.

| WS  | Files                                                                                                                                                         | Tests             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| A   | `promotion-eligibility-v1.ts`, `promotion-authorization-v1.ts`, `promotion-eligibility-service-v1.ts`, `promotion-authorization-service-v1.ts`                | 81                |
| B   | `canonical-mapping-registry-v1.ts`                                                                                                                            | 44                |
| C   | `promotion-planner-v1.ts`                                                                                                                                     | 37                |
| D   | `prisma/migrations/20260822010000_pe_budget_phase7_canonical_promotion/`, models in `prisma/schema.prisma`, `scripts/pe-budget-phase7-migration-rehearsal.sh` | 33 + 60 DB checks |

**195 jest tests across 6 suites, plus a 60-check disposable-PostgreSQL
rehearsal.**

### The seven properties E–H must not break

1. **Verification is not promotion.** Eligibility is built only from persistence;
   the request surface carries no hashes, IDs, or assertion lists. A refusal
   never produces an eligibility hash, so there is nothing for an authorization
   to bind to.
2. **Authorization is exact, immutable, expiring, and one-use** — enforced in the
   contract schema, by a partial unique index, and by an append-only trigger
   that permits only the consumption transition.
3. **Every projection kind has exactly one canonical destination.** 30 kinds
   across three namespaced unions. An unsupported kind returns a discriminated
   refusal, never `undefined`.
4. **No float money anywhere.** Canonical decimal strings in TypeScript,
   `NUMERIC(24,9)` in PostgreSQL, and the money triple (printed value, unit,
   normalized millions) is all-or-nothing at the database level.
5. **The planner writes nothing and is deterministic.** Reordered equivalent
   inputs produce a byte-identical plan hash, verified against a 500-item
   fixture.
6. **Canonical rows are writable only by `capiro_pe_promoter`, and immutable once
   their snapshot leaves `STAGING`** — enforced by a BEFORE row trigger, not by
   grants.
7. **Activation is one pointer row.** One active snapshot per
   domain/environment is a `UNIQUE` constraint; activation refuses incomplete
   scopes, a non-READY snapshot, a stale predecessor, and an expired
   authorization.

### Canonical destinations are a new vocabulary

WS B introduces `canonical_*` logical entities rather than reusing the mutable
`program_element*` table names. Binding canonical truth to those names would
re-create the identity conflation WS G and H exist to remove — most visibly
`program_element_procurement_line`, which files a procurement BLIN inside RDT&E
Program Element identity space.

WS D stores them in **one snapshot-scoped table**,
`defense_budget_canonical_row`, discriminated by `canonical_entity`. Read the
rationale at the top of the migration before changing it: the short version is
that immutability, hashing, provenance, and the writer boundary are uniform
across families, so expressing them once makes them provable once, while the
typed value axes stay separated at the column level.

---

## 3. Plan-vs-repository substitutions recorded this session

| Plan reference                               | Repository reality                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Phase 5 target `BudgetLineSourceObservation` | Physical model `NonRdteBudgetLineSourceObservation`                                                  |
| Phase 5 target `BudgetLineRelationship`      | Physical model `NonRdteBudgetLineRelationship`                                                       |
| "Phase 4–6 canonical tables"                 | They are **projection** tables in three separate Prisma clients, none snapshot-ready                 |
| Phase 6 projection tables                    | Created by a **separate migration chain** at `prisma/phase6-projection/migrations`, not the main one |
| `capiro_pe_promoter`                         | Created by migration; secret + task definition deferred to WS N                                      |

---

## 4. Baselines — measure against these, do not "fix" them

| Check                                 | Baseline on this branch                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @capiro/api typecheck` | **6 errors**: 4× TS6059 `rootDir` (specs importing from `scripts/`), 1× TS1470 `import.meta`, 1× TS2493 tuple |
| `prettier --check` on defense-budget  | Hundreds of pre-existing violations. **Format only files you create.**                                        |
| GitHub Actions                        | **Dead repo-wide** — see §6                                                                                   |

**The documented 10-error baseline is now 6.** The four
`Cannot find module '@makegov/tango-node'` errors are gone: they were resolved by
the P18 funding-opportunities work that arrived from `main`. Any _new_ typecheck
error is blocking.

---

## 5. Environment gotchas that cost time this session

- **A fresh worktree needs three setup steps, not one.** `pnpm install` alone
  leaves ~hundreds of phantom errors (`Cannot find module '@capiro/shared'`,
  `Property '$queryRaw' does not exist on type 'PrismaService'`). You also need
  to build the workspace packages **and** generate all four Prisma clients.
  Diagnosing those errors as real code defects wastes an hour.
- **Four Prisma schemas, not two:** `prisma/schema.prisma`,
  `prisma/rdte-projection/`, `prisma/non-rdte-projection/`, and
  `prisma/phase6-projection/`. Generate all four after every merge.
- **All four files are named `schema.prisma`.** A `Select-String` result's
  `.Filename` cannot distinguish them — this produced a false "model exists in
  the main schema" reading that took a second pass to catch. Compare full paths.
- **The rehearsal image must be `pgvector/pgvector:pg16`.** The first migration
  in the chain installs the `vector` extension; plain `postgres:16-alpine` fails
  at migration 1.
- **`DATABASE_URL` must be set** for `prisma validate`, and therefore for
  `verify:pe-budget-phase-6`. It never connects. Use
  `postgresql://u:p@localhost:5432/capiro?schema=public`.
- **PowerShell:** `git commit -F -` does not pipe — write the message to a file.
  Native-command stderr surfaces as a `NativeCommandError` even on success;
  check `$LASTEXITCODE`, not the red text.
- **Bash:** a helper that calls `exit` still exits the shell when invoked inside
  `|| true`. Combined with `2>/dev/null` that produces a silent exit 1 with no
  diagnostic. This cost a debugging cycle in the rehearsal script.

---

## 6. CI is unavailable — plan around it

Unchanged from Session 1: the most recent workflow runs across the whole repo are
`startup_failure` at 0s on every branch, last success 2026-07-31, signature of an
org-level Actions billing block rather than a workflow defect. Every "green"
claim must be **locally reproduced** and reported with exact commands, exit
codes, and test counts.

---

## 7. Workstream briefs — E through H

### E — Transactional staging, activation, retry, rollback

`DefenseBudgetCanonicalPromotionServiceV1`, service-neutral. Follow the port
pattern A.7 and A.10 already established: narrow repository interfaces, injected
`now`, no Nest or Prisma import in the service module. That is what will let
Phase 8 relocate it, and it is what makes it testable with in-memory fakes.

**Most of the safety is already in the database.** WS D put activation
preconditions, one-use authorization, plan-hash matching, blocked-plan refusal,
row immutability, and the writer-role boundary into constraints and triggers.
E's job is to drive them correctly and to fail cleanly when they fire, **not** to
re-implement them in TypeScript and certainly not to work around them.

Concretely:

- Reload eligibility, plan, authorization, registry, and projections from trusted
  persistence. `buildExecutionExpectationsV1(plan)` in the planner gives you the
  exact authorized row set with the hash each row must reproduce — staging must
  write that set and nothing else.
- Acquire one domain/cycle advisory lock. Stage in deterministic chunks that are
  invisible (they belong to a `STAGING` snapshot, so reads cannot see them and
  the trigger permits writes). Chunk retries verify row hashes.
- Pre-activation proof: every authorized item accounted for, no extra staged row,
  hashes match the plan, required scopes complete, referential integrity intact,
  no drift, no blocking items.
- Activation is **one small transaction**: lock the active-snapshot row, recheck
  the expected previous snapshot, mark new active, mark prior superseded, record
  activation, write outbox rows, mark authorization used, mark run committed.
  **No deltas, alerts, cache refresh, or compatibility rebuild inside it.**
- `activation_key` is unique, so activation is exactly-once. An ambiguous commit
  result is resolved by **reading the activation ledger**, never by blind retry.
- Rollback is a forward audited pointer transition with alert suppression. The
  promoter holds no `DELETE` anywhere and every snapshot reference is
  `ON DELETE RESTRICT`, so "rollback never deletes history" is already a
  database fact — do not add application code that tries to enforce it again.

The order the rehearsal script performs activation in is a working reference
implementation of the happy path; read
`scripts/pe-budget-phase7-migration-rehearsal.sh` before writing the service.

**E must pass independent review before F–H are accepted.**

### F — RDT&E projector

Map PE identity/metadata, request and current-cycle values, FYDP positions,
projects, project-year funding, performers, milestones, source observations to
the `canonical_rdte_*` entities the registry names. **Do not call
`ProgramElementWriterService`.** Do not derive authority from a source string. Do
not invoke legacy reconciliation to reinterpret verified decisions. Project codes
stay scoped to the parent PE; performer role classification is preserved (it is
part of the natural key, so promotion cannot relabel a performing activity as a
prime contractor); milestone planned/actual/as-of semantics are preserved.
Baseline hydration emits **no alerts** — the planner already classifies that, and
the outbox `CHECK` refuses an un-suppressed hydration row, so this is belt and
braces. Add an architecture test asserting no legacy-writer import.

### G — Procurement projector

Promote account/component/base-vs-AP scoped BLIN, yearly funding, quantity, unit
cost, P-40 resource summary, distribution lines, P-5/P-5A/P-21/P-3A detail, and
PE cross-references as typed relationships. **Never collapse BLIN identity into
RDT&E** and never create or update an RDT&E row for a procurement identity —
the registry has no mapping that would let you, and a WS B test asserts no
`non_rdte:*` kind routes to a `canonical_rdte_*` entity. Base and advance
procurement stay distinct (`advanceProcurement` is in the natural key). Quantity
and money are different columns; unit cost is dollars, not millions.

### H — O&M projector

Promote account/component/SAG-scoped identity preserving BA/BAG hierarchy,
yearly funding, verified OP-5 detail, workload metrics, change drivers, and
narratives with evidence. Money, workload, and narrative stay separately typed —
`canonical_om_detail_fact` carries money, quantity, and text axes for exactly
this reason. Preserve the exact O-1↔OP-5 reconciliation result. **No O&M row
enters the RDT&E identity space.** Add no-double-counting aggregate tests: detail
and summary rows must not both land in a product total, which is why
`canonical_om_detail_fact` is marked non-alertable and excluded from roll-ups.

---

## 8. Invariants — never weaken to make something pass

Verification is not promotion. Review acceptance is not promotion. Authorization
is immutable, exact, expiring, one-use. Canonical promotion uses the dedicated
promoter role; API serve, parser, verifier, and scheduler roles cannot promote.
No raw artifact is promotable. Every promoted row binds to exact projection,
verification, artifact, source, mapping, and plan hashes. No float money. No
title-only identity. No silently dropped projection. No last-wins conflict
resolution. No in-place mutation of an active snapshot. Users never see partial
staging. Activation and rollback are atomic pointer switches. Rollback never
deletes history. Hydration sends no client alerts; corrections and rollback
suppress by default. Downstream failure never undoes activation. One response
never mixes snapshots. Tenant overlays stay tenant-isolated.

If a test fails, fix the implementation. If a gate fires, fix the code or fix the
gate's precision — never loosen the assertion to get green.

---

## 9. Traps found this session — expect them again

1. **`ALTER DEFAULT PRIVILEGES` silently re-arms the serve role.** Migration
   `20260502020000` grants `capiro_app` full DML on _every future table_, and the
   ops script `scripts/sql/2026-07-19-rls-role-hardening.sql` re-runs
   `GRANT ALL ON ALL TABLES`. A canonical table protected only by `REVOKE` becomes
   writable again the next time either runs. **Any new canonical table needs both
   a REVOKE and trigger enforcement.** This is the single most important thing to
   carry into F–J.
2. **A hard `GRANT` on a table from another migration chain breaks a fresh
   migration.** The Phase 6 projection tables are not in the main chain; their
   grant had to be wrapped in a `to_regclass` guard. Check which chain a table
   belongs to before referencing it.
3. **`as const` + `satisfies` is a type error when the target has mutable
   arrays.** `as const` makes nested arrays `readonly`, which does not satisfy
   `string[]`. Drop `as const` and let `satisfies` provide the contextual type.
4. **`noUncheckedIndexedAccess` is on.** `plan.items[0].operation` is a type
   error in specs. Use a checked accessor helper rather than `!`.
5. **Substring assertions on stringified JSON are not assertions.** Phase 6's NC11
   checked `toContain('20')` and passed against `"120"`. Assert exact values on
   parsed structures. This still matters enormously for WS O's 32 negative
   controls.
6. **`canonicalJsonStringify` refuses `undefined`,** and zod preserves an optional
   key passed as `undefined`. Apply `stripUndefinedProperties` via `.transform()`
   on any new schema whose output gets hashed.

---

## 10. Boundaries — do not cross without separate authorization

Neo has authorized merging to `main` and shipping from AWS MCP. That does **not**
extend to the production canonical actions the plan reserves:

- production baseline snapshot creation
- production canonical promotion
- active-snapshot switch
- production rollback
- enabling production read flags
- enabling client alert fan-out
- applying Phase 7 migrations to any shared database

**Migration `20260822010000` has been applied only to disposable containers that
were destroyed afterwards.** It has never touched a shared database.

### Deferred to Workstream N — OPERATOR ACTION, REQUIRES SEPARATE AUTHORIZATION

`capiro_pe_promoter` exists in the migration with an unusable placeholder
password. To make it usable someone must:

1. Create a Secrets Manager secret for the promoter (mirroring the app DB
   secret).
2. Add `PROMOTER_USER` / `PROMOTER_PASSWORD` to the `ApiBootstrapRolesTaskDef`
   container in `infra/cdk/lib/compute-stack.ts` (the script already reads them
   and refuses half-supplied credentials).
3. Run the `bootstrap-roles` task.

Until then the promoter cannot authenticate, which is the intended fail-closed
state. Standing environment note: `capiro-dev` AWS mutations are pre-authorized;
**production requires Neo's explicit sign-off.**

No test may call a paid parser or provider, touch production data, or use a
shared database.

---

## 11. Commit and PR policy

Coherent commits per workstream, named `feat(pe): Phase 7 WS <X> — <summary>`.
Keep the branch fast-forwardable; no force-push. Open **one** Phase 7 PR and keep
it as the running record — do not merge it until A–H acceptance is reviewed.
Record every plan-vs-repository substitution in the PR body (§3 has the ones
found so far).

---

## 12. Definition of done for the next session

E, and then each of F–H: production code implemented, focused tests written and
passing, relevant regression suites run, typecheck compared against the
**6-error** baseline, formatting applied to new files only, architecture gates
passing, disposable-PostgreSQL rehearsal extended to cover the new behaviour
(E especially — staging, activation, ambiguous-commit recovery, and rollback need
a real database), and a coherent commit landed. Then re-run
`verify:pe-budget-phase-1` through `-6` to prove Phase 7 still breaks nothing.

Report exact commands, exit codes, and test counts. A workstream is done when it
is demonstrated, not when the files exist.

# Phase 7 handoff — Session 1 → Session 2

**Mission for the next session: close out Phase 7 Workstreams A through H.**

Workstream A is already implemented and passing; the next session verifies it still holds and implements **B, C, D, E, F, G, H** to the plan's acceptance criteria.

Authoritative spec: `phase-7-verified-canonical-promotion-production-cutover-v1.md`. This handoff records repository reality, not a substitute for that plan.

> **Scope note.** A–H spans the plan's Session Group 1 (A–D) and Session Group 2 (E–H). The plan itself says "Do not execute more than four implementation workstreams in one session" and that E must pass independent review before any family projector (F–H) is accepted. A–H in one context may need to split at the D/E boundary. Split rather than rush: D and E are the transaction and security boundary.

---

## 1. Repository state

| Item                         | Value                                                     |
| ---------------------------- | --------------------------------------------------------- |
| Branch                       | `agent/pe-budget-canonical-promotion-cutover-v1` (pushed) |
| Branch HEAD                  | `3afafae63071bd0e5eaa07d9bacfe4b26a8d0d58`                |
| `origin/main` at handoff     | `ffb21812` — "Merge pull request #768"                    |
| Branch is behind main by     | **2 commits — merge main first**                          |
| Phase 6 merge commit on main | `ede7ebc5` (PR #777)                                      |
| Working tree                 | clean                                                     |
| Open Phase 7 PR              | none yet                                                  |

### First three commands

```bash
git -C <clone> fetch origin && git -C <clone> merge origin/main --no-edit
pnpm install --frozen-lockfile
pnpm --filter @capiro/api exec prisma generate
```

`main` moves several times a day. Re-merge before starting and again before any acceptance run — a stale base is how the Phase 6 split happened in the first place.

---

## 2. Prerequisites — all satisfied

Phases 1–6 are **all merged to `main`**. Phase 6 landed this session as PR #777 after being reconciled from two divergent branches and having six real defects fixed. `verify:pe-budget-phase-1` through `-6` all exist and pass.

Read `docs/defense-budget/PHASE-7-PRE-IMPLEMENTATION-DEPENDENCY-MAP.md` on this branch **before** writing code. It already contains the mandatory current-state dependency map — the 41 canonical-write call sites across 30 files, the service inventory, the plan-vs-repository substitutions, and each workstream's entry condition. Do not re-derive it.

---

## 3. What Workstream A delivered (commit `3afafae6`)

`apps/api/src/defense-budget/promotion/`

| File                                             | Contents                                                                                                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promotion-eligibility-v1.ts`                    | `defenseBudgetPromotionEligibilityV1Schema`, `promotionScopeV1Schema`, `promotionCandidateBindingV1Schema`, `promotionEligibilityHashV1`, `evaluatePromotionEligibilityV1`, `isHighRiskExtractionMethodV1` |
| `promotion-authorization-v1.ts`                  | `defenseBudgetPromotionAuthorizationV1Schema`, `promotionSegregationEvidenceV1Schema`, `evaluatePromotionAuthorizationV1`, `deriveSegregationEvidenceV1`, `promotionAuthorizationHashV1`                   |
| `promotion-eligibility-authorization-v1.spec.ts` | 29 tests, all 14 plan-required WS A cases                                                                                                                                                                  |

Properties WS B–H must not break:

- Only `VERIFICATION_PASSED` / `REVIEW_ACCEPTED` may enter eligibility.
- Open conflicts and unsupported mappings **block**; they are never dropped.
- Eligibility hashing is order-independent — every ID collection is sorted and de-duplicated during parse.
- Expected-active-snapshot ID and hash travel together; both `null` means baseline.
- Authorization is exact, immutable, expiring, one-use, and bound to eligibility hash + plan ID + plan hash + scope + expected snapshot.
- Segregation of duties is enforced **inside the contract schema**, not in a service, so no caller can bypass it. High-risk extraction = `manual`, `paddleocr`, `llamaparse`.
- `evaluatePromotionAuthorizationV1` takes an injected `now` and an injected `alreadyUsed` — keep it pure and replayable. Do not reach for `Date.now()` inside it.

**Still owed for A:** the eligibility _service_ that independently reloads the trusted records from persistence (plan A.7), the append-only audit record for eligibility/authorization attempts (A.9), and the guarded admin/CLI surfaces (A.10). The contracts and policy are done; the loading layer is not. Do this as part of closing A, and note that A.10 must come **after** D exists, because the admin surface must not be able to write canonical rows.

---

## 4. Baselines — measure against these, do not "fix" them

| Check                                                           | Baseline on `main`                                                                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @capiro/api typecheck`                           | **10 errors**: 4× TS6059 `rootDir` (specs importing from `scripts/`), 4× `Cannot find module '@makegov/tango-node'`, 1× TS1470 `import.meta`, 1× TS2493 tuple                       |
| `pnpm --filter @capiro/web test`                                | 1 failed file — `src/components/chat/meri-prompt.test.ts`, `vi.mock` hoisting bug. 183/184 files, 1716/1716 tests pass                                                              |
| `prettier --check apps/api/src/defense-budget apps/api/scripts` | Hundreds of pre-existing violations. CI scopes prettier to MeriV2 + `packages/shared` only, by documented decision in `ci-pr.yml`. **Format only files you create**, never the tree |
| GitHub Actions                                                  | **Dead repo-wide** — see §6                                                                                                                                                         |

Any _new_ typecheck error is blocking. Verify by checking out `origin/main` in the same tree and re-running, exactly as was done this session.

`@makegov/tango-node` is genuinely missing from the lockfile and breaks `src/external/tango/*`. It arrived from main and is someone else's to fix — flag it, don't absorb it.

---

## 5. Environment gotchas that cost time this session

- **`DATABASE_URL` must be set** for `prisma validate`, and therefore for `verify:pe-budget-phase-6`. It never connects. Use `postgresql://u:p@localhost:5432/capiro?schema=public`.
- **Two Prisma schemas.** `prisma/schema.prisma` and `prisma/phase6-projection/schema.prisma`. Generate both. Re-run `prisma generate` after every merge from main or you will chase phantom "property does not exist on PrismaClient" errors.
- **On Windows/PowerShell:** `node_modules/.bin/*.CMD` is not directly invocable from `apps/api`; use `pnpm --filter @capiro/api exec <tool>`. `git commit -F -` with a here-string does not pipe — write the message to a file and use `git commit -F <file>`. Native-command stderr surfaces as a PowerShell `NativeCommandError` even on success; check `$LASTEXITCODE`, not the red text.
- `git grep` exiting 1 means "no matches", which is usually the result you wanted.

---

## 6. CI is unavailable — plan around it

The **100 most recent workflow runs across the whole repo** are `startup_failure` at 0s: `main`, feature branches, merged branches, both `push` and `pull_request`. Last success anywhere: 2026-07-31. Repo private, Actions enabled, not archived, permissions `all` — the signature is an org-level Actions billing/spending-limit block, not a workflow defect. Neo has confirmed they are not using GitHub Actions.

Consequences:

- Every "green" claim must be **locally reproduced** and reported with exact commands, exit codes, and test counts.
- No workflow runs `verify:pe-budget-*` at all today. Wiring them up is Workstream O work, deferred until Actions is restored.
- Merges happen without CI. That is why Phase 6 shipped six defects that had never been compiled together — assume nothing is green until you run it.

---

## 7. Workstream briefs — B through H

Dependency order is strict: **B → C → D → E**, then F, G, H may proceed in parallel once E is accepted.

### B — Canonical mapping registry V1

Add a versioned `DefenseBudgetCanonicalMappingRegistryV1` translating every supported Phase 4–6 projection kind to exactly one canonical destination. **Phase 7 makes no new semantic decisions** — it only routes decisions Phases 4–6 already made.

Each mapping carries: canonical table/model, natural key, snapshot ownership, source-observation destination, money/unit conversion rule, field authority, supersession behaviour, compatibility-projection behaviour, alert/delta classification.

Must cover: RDT&E PE identity and funding/FYDP; R-2A projects and project-year funding; R-3 performers; R-4 milestones; procurement BLIN identity, yearly funding, quantity, unit cost, distribution, P-5/P-5A/P-21/P-3A detail; O&M SAG identity and yearly funding/detail; MILCON project identity/year/detail; HASC; SASC; NDAA conference; HAC-D; SAC-D; appropriations conference; enacted with proof; reprogrammed; executed; actions/transfers/rescissions; provisions/directives; package/vehicle positions; typed cross-line relationships.

Hard rules: preserve the original decimal string and original unit; **no JavaScript `number` for money**; never infer a mapping from a name, title, or magnitude; unsupported kinds **block**, never drop; a registry change requires a new version + hash and invalidates existing plans. Add a static exhaustiveness check against every Phase 4–6 projection union — that check is what stops a new projection kind from silently going unmapped.

### C — Deterministic promotion planner

Pure, read-only `DefenseBudgetPromotionPlanV1`. Operations: `INSERT`, `SUPERSEDE`, `UNCHANGED`, `CORRECTION`, `BLOCKED`. Each item carries source projection ID/hash, canonical natural key, operation, prior active row hash, proposed row hash, reason, alert classification, compatibility effect.

Detect: duplicate natural keys, same-key conflicting values, active-row drift, missing dependencies, manual-override collisions, candidate/conflicting identity links, unsupported mappings, missing enactment proof.

Alert classification: initial hydration → suppress; unchanged → none; correction → suppress by default; new official material change → eligible; rollback → suppress by default.

**Reordered equivalent inputs must produce the same plan hash** — reuse the sorted-collection approach from WS A. The planner performs **no writes** and needs no canonical DB role; add an architecture test asserting no Prisma `create`/`update`/`upsert` appears in planner source.

### D — Snapshot schema, promotion ledger, DB role isolation

Additive models: `DefenseBudgetCanonicalSnapshot`, `DefenseBudgetActiveSnapshot`, `DefenseBudgetPromotionPlan`, `DefenseBudgetPromotionAuthorization`, `DefenseBudgetPromotionRun`, `DefenseBudgetPromotionItem`, `DefenseBudgetPromotionActivation`, `DefenseBudgetPromotionOutbox`, `DefenseBudgetCompatibilityProjectionRun`, `DefenseBudgetRollbackRecord`.

Every canonical row carries snapshot ID, promotion run ID, canonical natural key, canonical row hash, source projection ID, verification candidate/run IDs, artifact/source hashes, mapping registry hash, created timestamp. **Active rows are immutable** — corrections arrive via a new snapshot.

Database-level constraints (not comments): one active snapshot per domain/environment; active snapshot must be `READY`/`ACTIVE`; no activation with incomplete required scopes; authorization plan/hash/scope must match the run; used authorization cannot be reused; activated rows cannot be updated or deleted; previous active snapshot must match expectation; enacted rows require enactment proof; candidate identity links cannot be active. Append-only triggers on authorization, activation, rollback, proof records.

**The role mechanism already exists — extend it, do not rebuild it.** `infra/cdk/lib/compute-stack.ts` defines `ApiBootstrapRolesTaskDef` (family `capiro-<env>-api-bootstrap-roles`, command `bootstrap-roles`) which already provisions `capiro_app`/`capiro_app_role`, `capiro_admin`, and `capiro_defense_budget_parser` from separate master and app secrets. Add `capiro_pe_promoter` there: reads verified projections, writes promotion/canonical/outbox tables, **no** migration privilege, **no** role creation, **no** unrestricted DDL. The general API role must be unable to write canonical rows; parser/verifier/scheduler roles likewise.

Rehearse on **disposable PostgreSQL only** — fresh chain, upgrade from pre-Phase-7, role/grant denials, append-only, activation constraints, rollback pointer, one-use authorization. Dispose afterwards. **Never** apply these migrations to a shared database.

### E — Transactional staging, activation, retry, rollback

`DefenseBudgetCanonicalPromotionServiceV1`, service-neutral (keep Nest and Prisma out of the port where practical — Phase 8 extracts this).

Reload eligibility, plan, authorization, registry, and projections from trusted persistence. Acquire a domain/cycle advisory lock. Stage in deterministic chunks that are invisible to reads, idempotent, and hash-verified on retry. Run pre-activation proof: every authorized item accounted for, no extra staged row, hashes match plan, required scopes complete, referential integrity intact, no active-snapshot drift, no blocking items.

Activation is **one small transaction**: lock the active-snapshot row, recheck the expected previous snapshot, mark new active, mark prior superseded, record activation, write outbox rows, mark authorization used, mark run committed. **No deltas, alerts, cache refresh, or compatibility rebuild inside it.**

Activation is exactly-once by unique key. An ambiguous commit result is resolved by **reading the activation ledger**, never by blind retry. Rollback is a forward audited pointer transition to a prior immutable snapshot with alert suppression — it never deletes history.

E must pass independent review before F–H are accepted.

### F — RDT&E projector

Map PE identity/metadata, request and current-cycle values, FYDP positions, projects, project-year funding, performers, milestones, source observations. **Do not call `ProgramElementWriterService`.** Do not derive authority from a source string. Do not invoke legacy reconciliation to reinterpret verified decisions. Project codes stay scoped to the parent PE; performer role classification is preserved (a performing activity is not a prime contractor); milestone planned/actual/as-of semantics are preserved. Baseline hydration emits **no alerts**. Add an architecture test asserting no legacy-writer import.

### G — Procurement projector

Promote account/component/base-vs-AP scoped BLIN, yearly funding, quantity, unit cost, P-40 resource summary, distribution lines, P-5/P-5A/P-21/P-3A detail, PE cross-references as typed relationships. **Never collapse BLIN identity into RDT&E** and never create or update an RDT&E row for a procurement identity. Base and advance procurement stay distinct. Short line numbers keep their appropriation/account namespace. Quantity and money are different types. Do not use `peCode` as the canonical natural key unless the Phase 5 contract explicitly defines it as a compatibility key.

### H — O&M projector

Promote account/component/SAG-scoped identity preserving the BA/BAG hierarchy, yearly funding, verified OP-5 detail, workload metrics, change drivers, and narratives with evidence. Money, workload, and narrative stay separately typed. Preserve the exact O-1↔OP-5 reconciliation result. **No O&M row enters the RDT&E `program_element` identity space.** Add no-double-counting aggregate tests — detail and summary rows must not both land in a product total.

---

## 8. Invariants — never weaken to make something pass

Verification is not promotion. Review acceptance is not promotion. Authorization is immutable, exact, expiring, one-use. Canonical promotion uses the dedicated promoter role; API serve, parser, verifier, and scheduler roles cannot promote. No raw artifact is promotable. Every promoted row binds to exact projection, verification, artifact, source, mapping, and plan hashes. No float money. No title-only identity. No silently dropped projection. No last-wins conflict resolution. No in-place mutation of an active snapshot. Users never see partial staging. Activation and rollback are atomic pointer switches. Rollback never deletes history. Hydration sends no client alerts; corrections and rollback suppress by default. Downstream failure never undoes activation. One response never mixes snapshots. Tenant overlays stay tenant-isolated.

If a test fails, fix the implementation. If a gate fires, fix the code or fix the gate's precision — never loosen the assertion to get green. Every one of the six Phase 6 defects fixed this session was found by exactly that discipline.

---

## 9. Traps found this session — expect them again

1. **`canonicalJsonStringify` refuses `undefined` values,** and zod preserves an optional key explicitly passed as `undefined`. Any object built as `{ field: maybe ?? undefined }` crashes hashing. `stripUndefinedProperties` now exists in `contracts/canonical-json.ts`; apply it via `.transform()` on any new schema whose output gets hashed or embedded in an artifact. WS B–E will hit this constantly.
2. **`Array.prototype.filter` does not narrow a discriminated union.** Reading `.value` off a filtered assertion list is a type error. Use `(a): a is Extract<DefenseBudgetAssertionV1, { assertionKind: 'document_fact' }> =>`.
3. **Over-broad architecture-gate regexes produce false positives.** The Phase 6 `prisma_dml` gate matched any `.update(` and flagged `createHash('sha256').update(...)`. Anchor DML verbs to an identifier receiver.
4. **Substring assertions on stringified JSON are not assertions.** Phase 6's NC11 checked `toContain('20')` and passed against a `referenceValue` of `"120"` — the control was dead. Assert exact values on parsed structures. This matters enormously for the 32 negative controls in WS O.

---

## 10. Boundaries — do not cross without separate authorization

Neo has authorized merging to `main` and shipping from AWS MCP. That does **not** extend to the production canonical actions the plan reserves:

- production baseline snapshot creation
- production canonical promotion
- active-snapshot switch
- production rollback
- enabling production read flags
- enabling client alert fan-out
- applying Phase 7 migrations to any shared database

For each of these, produce the exact command, preconditions, expected output, stop/go criterion, rollback command, and evidence to capture — then stop and label it **OPERATOR ACTION — REQUIRES SEPARATE AUTHORIZATION**. Continue completing all dark-shippable code around it.

Standing environment note: `capiro-dev` AWS mutations are pre-authorized; **production requires Neo's explicit sign-off.** When "ship it" is ambiguous about environment, ask.

Also: no test may call a paid parser or provider, touch production data, or use a shared database.

---

## 11. Commit and PR policy

Coherent commits per workstream, named `feat(pe): Phase 7 WS <X> — <summary>`. Keep the branch fast-forwardable; no force-push. Open **one** Phase 7 PR and keep it as the running record — do not merge it until A–H acceptance is reviewed. Record in the PR body every substitution where the plan's paths differ from repository reality.

---

## 12. Definition of done for this session

A–H each: production code implemented, focused tests written and passing, relevant regression suites run, typecheck compared against the 10-error baseline, formatting applied to new files only, architecture gates passing, disposable-PostgreSQL rehearsal run where applicable (D, E), and a coherent commit landed. Then `verify:pe-budget-phase-1` through `-6` re-run green to prove Phase 7 broke nothing.

Report exact commands, exit codes, and test counts. Do not claim completion while anything is outstanding — a workstream is done when it is demonstrated, not when the files exist.

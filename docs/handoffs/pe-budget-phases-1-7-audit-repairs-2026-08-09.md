# Defense Budget Phases 1–7 Audit Repairs — Handoff

**Date:** 2026-08-09
**Branch:** `agent/pe-budget-phase7-eligibility-read-repo`
**Scope:** Repairs from the independent Phase 1–7 design-vs-main audit.
**Release posture:** **CODE REPAIRS ONLY — NOT DEPLOYED, NOT LIVE-ACCEPTED.**

No AWS mutation, shared-database migration, production/staging data write, paid parser call, canonical promotion, snapshot activation, rollback, canary enablement, merge, or deployment was performed while making these repairs.

---

## 1. What this repair closes

### A. Phase 3 container closeout no longer certifies build-only images

`verify-pe-budget-phase-3-closeout.ts --include-containers` now proves each `table`, `layout`, and `ocr` image at runtime, not only with `docker build`:

- production ENTRYPOINT executes `version --json`;
- process runs as UID 1001;
- `/app/.venv` is writable by the runtime user;
- OCR cache is writable for the OCR image;
- target parser imports succeed (`pdfplumber`, `camelot`, `docling`, `paddleocr` as applicable).

This closes the defect class where a Docker target built successfully while the runtime user could not update the venv and optional engines were absent.

---

### B. Phase 6 certification now binds the exact projection set

A Phase 6 certification now includes:

- `projectionSetSha256`;
- `projectionCount`.

The hash is computed over the sorted full projection contents, not summary counts.

Persistence adds an immutable association:

```text
phase6_cycle_certification
        ↓ exact content SHA
phase6_cycle_certification_projection
        ↓ exact projection IDs + ordinal
phase6_audit_projection
```

Historical certifications created before this repair remain valid audit history but are **unbound and not promotable**. They cannot be retrofitted with guessed projection IDs.

The Phase 6 plan builder now requires `--certification-sha256` and loads only the exact projection IDs bound to that certification. It refuses:

- cycle/FY mismatch;
- historical unbound certification;
- missing association rows;
- projection-count mismatch;
- projection-set hash mismatch;
- a certification whose bound rows changed after certification.

It no longer constructs a committee plan from “all non-superseded rows for FY X.”

---

### C. Phase 6 deterministic IDs and duplicate composition are canonical-order safe

Two separate `JSON.stringify` defects were repaired:

1. authorization provision link/review IDs now use canonical JSON hashing;
2. Phase 6 duplicate-content comparison now canonical-hashes `{ fundingField, money, payload }`.

Equivalent objects with different JavaScript key insertion order therefore cannot:

- produce different provision/review IDs; or
- manufacture a false duplicate conflict.

---

### D. Direct legacy canonical loader commits can no longer bypass Phase 7 through raw `pnpm` / `tsx`

The dispatcher kill switch was not sufficient because the scripts are directly executable.

The shared exact-SHA loader posture now applies the Phase 7 legacy-write policy inside the script boundary:

```text
--commit
  ↓
PE_LEGACY_BUDGET_WRITES must equal allow
  ↓
PE_SNAPSHOT_READ_MODE must not be snapshot_canary/snapshot
  ↓
exact approved artifact SHA must match
  ↓
existing artifact quality gate must pass
```

Default is fail closed.

The generalized `ingest-defense-budget` command had its own posture resolver and was a separate bypass; it now uses the same Phase 7 policy.

`parse-defense-approps-public-law.ts` remains permanently inspect-only and rejects its legacy enacted commit path.

The Phase 7 permanent safety scan now inventories all known exact-SHA dollar loaders and fails if direct invocation stops routing through the guarded posture.

---

### E. Snapshot canary routing now uses the real authenticated tenant

The migrated read wrapper historically called `PeSnapshotGateService.resolve(null)`, making `snapshot_canary` unable to match a configured tenant.

`PeSnapshotGateService` now resolves:

```text
explicit tenant argument
  else verified TenantContextStore request tenant
  else null
```

An explicit tenant always wins.

A dedicated `PE_SNAPSHOT_ENVIRONMENT` override is also supported so the activation environment key can be identical to the serving task’s environment key even when `NODE_ENV` uses a generic value such as `production`.

---

### F. Producer plans named by eligibility are now load-bearing through planning and execution

The previous production projection source re-read mutable producer tables by fiscal year after eligibility/authorization. That meant the persisted producer-plan IDs/hashes could be correct while planning or execution assembled a different row set.

New source:

`PrismaEligibilityBoundProjectionSourceV1`

Authority chain:

```text
persisted eligibility hash
  → exact projectionPlanIds + projectionPlanHashes
  → immutable defense_budget_projection_plan rows
  → rederive plan record + family content hash
  → family projector
  → promotion planner / execution
```

It verifies:

- eligibility document still hashes to its storage key;
- every exact producer plan ID exists;
- no extra producer plan is accepted;
- exact producer-plan hash set matches eligibility;
- stored denormalized plan metadata agrees with the immutable plan document;
- family plan’s own content hash recomputes correctly;
- producer-plan cycle/FY exactly matches eligibility;
- producer-plan family set exactly matches eligibility.

Supported persisted MVP families:

- RDT&E;
- Procurement;
- O&M;
- MILCON;
- Committee / Phase 6.

For the committee family, the source additionally proves:

```text
producer plan
  → exact Phase 6 certification ID/hash
  → exact certification→projection bindings
  → recomputed projection-set hash
  → plan sourceProjectionIds account for exactly that certified set
```

No committee projection is reassembled from fiscal year alone.

Both critical commands now use this source:

- `plan-defense-budget-promotion-v1`;
- `execute-defense-budget-promotion-v1`.

The Phase 7 safety gate fails if either critical command imports the former broad FY projection source.

---

### G. Planning is bound to the persisted eligibility record, mapping registry, and exact active snapshot

`plan-defense-budget-promotion-v1` now:

1. reloads and rehashes persisted eligibility;
2. reruns the deterministic eligibility policy;
3. requires CLI scope to equal eligibility scope exactly;
4. requires the current mapping-registry version/hash to equal the values eligibility evaluated;
5. reloads the live active snapshot ID **and hash**;
6. requires both to equal eligibility’s expected active snapshot ID/hash;
7. loads exact producer plans through the new source;
8. blocks on projector refusals;
9. loads prior canonical rows only from that exact expected active snapshot.

The command can no longer silently rebase a promotion onto a newer snapshot that activated after eligibility was evaluated.

---

### H. Authorization now re-evaluates whether the persisted eligibility is actually eligible

Previously authorization recomputed the eligibility hash but did not rerun the eligibility policy.

That allowed this theoretical bypass:

```text
real persisted eligibility with open conflict
  + hand-filed promotion plan claiming blockedCount = 0
  → authorization service only checks plan.blockedCount + eligibility hash
```

Authorization now runs `evaluatePromotionEligibilityV1(plan.eligibility)` and refuses with `eligibility_not_eligible` before inserting an authorization row.

A regression test pins a hand-filed clean plan pointing at a genuine eligibility record with `openConflictCount=1`.

---

### I. Least-privilege DB roles can execute the exact-plan path without gaining evidence mutation authority

The old role design predated persisted eligibility/projection plans, so `capiro_pe_promoter` lacked the reads required by the repaired execution path.

Forward migrations now provide:

**Promoter — SELECT only**

- `defense_budget_promotion_eligibility`;
- `defense_budget_projection_plan`;
- `phase6_audit_projection`;
- `phase6_cycle_certification`;
- `phase6_cycle_certification_projection`.

No INSERT/UPDATE/DELETE is granted on producer evidence.

**Serve role — new Phase 6 association only**

- SELECT;
- INSERT;
- no UPDATE/DELETE/TRUNCATE.

The association itself has immutable update/delete/truncate triggers.

Migration ordering is handled both ways because main and Phase 6 have separate migration chains.

A new disposable-Postgres rehearsal uses real `SET ROLE` statements to prove the permissions rather than only inspecting ACL metadata.

---

### J. Governed manual overrides now obey the two-person lifecycle and are actually applied to snapshot reads

Two defects were repaired.

#### Lifecycle bug

The previous overlay chose the highest version first, then asked whether that version was in force. A proposed v2 therefore suppressed an approved v1, meaning one administrator could affect the user-visible result merely by proposing a replacement.

Now:

- proposed replacement is invisible and the approved predecessor remains active;
- future-dated approved replacement leaves predecessor active until `effectiveFrom`;
- active highest approved version applies;
- revoked newest decided version terminates the chain;
- expired newest decided version terminates the chain;
- revoked/expired replacement never resurrects an older correction.

#### Read-path gap

The shared snapshot read port now loads every governed override version whose target exactly matches the already-selected canonical rows.

Target identity is:

```text
canonicalEntity
+ canonicalNaturalKey
+ fiscalYear (null-safe)
+ fundingField (null-safe)
```

`PeSnapshotGateService.loadRows()` now:

1. loads canonical rows;
2. proves every row belongs to the requested snapshot;
3. loads exact-target override versions;
4. resolves the in-force lifecycle;
5. applies the overlay;
6. preserves the official canonical money as `officialMoney`;
7. preserves visible `manual_override` provenance;
8. fails visibly if an override returned by the exact-target port cannot match a row.

Existing snapshot method code that still calls `applyOverrideOverlayV1(rows, [])` no longer erases a centrally applied overlay.

---

## 2. Permanent / reproducible validation added

### Unified audit-repair closeout

```bash
cd apps/api
npx tsx scripts/verify-pe-budget-phases-1-7-audit-repairs.ts
```

The runner includes:

- Phase 3 full closeout **with container runtime smoke**;
- Phase 4 full closeout;
- Phase 5 full closeout;
- Phase 6 permanent gate;
- Phase 6 exact certification/projection PostgreSQL rehearsal;
- Phase 6 exact producer persistence rehearsal;
- Phase 7 permanent gate + 32 negative controls;
- Phase 7 canonical migration fresh/upgrade rehearsal;
- Phase 7 exact-plan least-privilege role rehearsal;
- Phase 6 strict TypeScript;
- Phase 7 strict TypeScript;
- `git diff --check`.

It explicitly blanks vendor/AWS credentials and keeps legacy writes off.

### Important evidence status

**The code for these gates is committed, but this GitHub-connector session did not execute the Docker/PostgreSQL/TypeScript matrix.**

Do not convert “runner exists” into “runner passed.”

At the time of this handoff, the branch head had no GitHub commit statuses or workflow runs registered for the latest repair commit. Run the command above from a clean exact-head checkout with Docker available before treating the code repair as accepted.

---

## 3. Remaining true blockers — not papered over

### Blocker 1 — product read cutover is still incomplete

Most Program Elements product reads are still served from legacy compatibility tables.

Known examples include:

- catalog/list;
- primary PE detail/funding grid;
- sources/proof pack;
- deltas/needs-attention;
- relationships/graph;
- incumbents/contractors;
- procurement lines;
- portions of legislative/profile surfaces.

Only a subset of methods currently has a snapshot implementation, including projects and budget-position/PB-comparison paths.

**Phase 7 cannot be called product-cutover complete until the remaining eligible reads are migrated and shadow/canary accepted.**

### Blocker 2 — migrated snapshot methods still perform some legacy existence checks first

Several migrated methods still check `program_element` by `peCode` before selecting legacy vs snapshot behavior.

A canonical-only row can therefore 404 if compatibility storage is stale even when the active snapshot contains the row.

Correct repair requires changing the large `ProgramElementReadService` so existence is resolved from the selected source:

```text
legacy decision   → legacy identity lookup
snapshot decision → canonical snapshot identity lookup
```

This was not rewritten through the GitHub Contents API because the service is a large change-controlled file and replacing the entire file remotely would create disproportionate regression risk. Use a local checkout/patch-capable coding session for that read migration.

### Blocker 3 — four Phase 6 projection kinds have contracts/projectors but still lack source-object producers

Still not produced by the Phase 6 source builder:

- `vehicle_proof`;
- `native_line_binding`;
- `provision_link`;
- standalone `enactment_proof` projection.

The generic canonical projector can represent these kinds, but that is not the same as having a governed producer from real source objects.

Do not fabricate payloads merely because the destination mapping exists. These require an explicit source→projection producer contract and fixtures.

### Blocker 4 — RDT&E relationship production is incomplete

`canonical_budget_line_relationship` has a non-RDT&E producer, but the known PE↔PE relationship path still lacks a complete RDT&E canonical producer. Graph/relationship reads therefore cannot be declared snapshot-ready merely by changing their query.

### Blocker 5 — R-3 performer money has no canonical money axis

`canonical_rdte_performer` intentionally carries identity/text semantics and no money axis. Therefore the R-3 performer `totalCostM` currently has no honest canonical destination.

The existing contractor response correctly labels this as `legacy_compatibility`; do not relabel it `canonical_snapshot` until the Phase 4 performer projection gains an explicit governed money axis.

### Blocker 6 — PE↔BLIN cross-family traversal needs a reviewed crosswalk

Do not reintroduce `peCode → BLIN` identity conflation.

The governed relationship substrate still needs review-state metadata before it can serve as a trusted crosswalk. Until that data-curation/review mechanism exists, affected cross-family reads remain compatibility-only.

### Blocker 7 — live/operational Phase 7 acceptance remains undone

Still requires separate authorization and a real operator:

- measured production SLO thresholds;
- production-scale staging/activation rehearsal;
- shadow acceptance matrix;
- live internal tenant canary;
- real Aurora promoter-role execution proof;
- real snapshot activation;
- downstream outbox/delta/cache proof;
- rollback rehearsal;
- independent human review of segregation-of-duties, grants, append-only triggers, and activation transaction.

No code-only session can truthfully mark these passed.

---

## 4. Lower-severity follow-ups

- `ProgramElementReadService.getContractors()` still contains stale explanatory copy in `evidenceNote` describing the old combined R-3 + USAspending “accepted_direct” metric even though the structured response correctly separates the two measures. Fix when editing that large service for snapshot cutover.
- Current repo-wide API typecheck previously had inherited failures outside the repaired scope. The exact-head closeout must record whether those remain and must not call a red full typecheck green by relying only on `tsconfig.phase7.json`.

---

## 5. Required acceptance order from here

1. Fetch/reset a clean worktree to `origin/agent/pe-budget-phase7-eligibility-read-repo`.
2. Confirm no unrelated local changes.
3. Run:

   ```bash
   cd apps/api
   npx tsx scripts/verify-pe-budget-phases-1-7-audit-repairs.ts
   ```

4. Fix every attributable failure; do not lower gates.
5. Independently review the trust-boundary code.
6. Complete the remaining Program Elements snapshot read migration.
7. Implement/accept the missing Phase 6 producer kinds rather than synthesizing them.
8. Re-run the exact-head matrix.
9. Only then schedule internal/staging operational acceptance.
10. Do not begin Phase 8 service cutover until Phase 7 product-read and live acceptance gates are complete.

---

## 6. Safety confirmation

During this repair session:

- no merge;
- no PR creation/update;
- no AWS mutation;
- no deployment;
- no shared migration application;
- no production/staging DB mutation;
- no canonical promotion;
- no active-snapshot pointer change;
- no rollback;
- no canary enablement;
- no vendor/paid parser call.

All repository writes were committed only to `agent/pe-budget-phase7-eligibility-read-repo`.

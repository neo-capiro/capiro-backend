# CleanUp2 — Remove duplicate code (tests preserved and repointed)

**Status:** not started
**Depends on:** CleanUp1 complete and its gate green. CleanUp1's committed baselines are this plan's acceptance evidence.
**Gate:** every duplicate **production** code group is gone, every unit test passes, and every UI test pixel-matches the CleanUp1 baseline. No test file and no test case is deleted by this plan.
**Feeds:** CleanUp3, which removes the duplicated *tests* this plan deliberately preserves. CleanUp4 (`docs/plans/CleanUp4.md`) generalises the canonical modules this plan extracts into data-driven registries.

---

## 1. Interpretation decisions (correct these if wrong)

The brief says: *remove all duplicate code; any unit tests need to be modified to point at something else for removal later; duplicate tests not removed.*

Read as three separate rules:

| Rule | Meaning here |
|---|---|
| **Remove duplicate code** | Production code only: TypeScript under `apps/api/src`, scripts under `apps/api/scripts`, Python under `apps/defense-budget-parser`, the CDP tooling under `apps/web/scripts` (§6), and duplicated build config. Also production logic that happens to sit inside a test file when it is a copy of a production helper. |
| **Repoint tests** | Where a spec imports a duplicate being deleted, change the import to the canonical module. **Assertions are untouched.** |
| **Duplicate tests not removed** | The duplicated *test* helpers and duplicated spec files stay, byte-for-byte, until CleanUp3. Expected residue: ~258 groups / ~3,682 lines. Not a gate failure. The gate counts **production** groups. |

---

## 2. Evidence is a snapshot — re-validation protocol

> **Read before using any number below.**

All counts were measured against commit **`67bab09`** — the commit every `graphify-out/*/graph.json` records as `built_at_commit`, with a clean tree. It is an expectation, not a fact about your execution day.

**R1 — Re-derive before you act.** Every wave begins by regenerating the inventory (§4.1). The live tree wins over this document.

**R2 — Anchor on identities, not positions.** This plan deliberately **omits line numbers**. A duplicate is identified by `(symbol name, source_file)`. Line numbers move under edit and were already stale the moment this was written; never grep for one.

**R3 — Counts are expectations with tolerance.** A few percent difference needs an explanation. >10% means another author worked in that area: stop and re-scope the wave.

**R4 — A vanished group is "already merged", not "error".** If a group is absent from the regenerated inventory, mark it `obsolete` with the commit that removed it. Never recreate duplication to satisfy a plan.

**R5 — Never resolve a conflict by reverting another author.** If a target changed underneath you, re-read and re-run the affected verification. `git checkout --theirs` or wholesale revert inside this plan is forbidden.

**R6 — The graph is a snapshot; the source is truth.** The inventory scripts read `graphify-out/01-api/graph.json`, so a stale graph silently reproduces stale findings. Rebuild (`graphify` `--update`, or the subject-build script) before generating a wave's inventory. Also note the graph has known blind spots: symbol nodes whose `source_file` is empty (decorator/annotation kinds) were excluded from every scan, and `*.e2e.spec.ts` bodies are excluded by pattern.

**R7 — Guard against silent scope loss.** If a module, file or helper named here has been renamed or removed, record it in the status file and state whether it is in or out of scope. Never let scope shrink by omission.

**R8 — Claim your scope.** Append `claimed_by / started_at` to `docs/plans/cleanup2-progress.md` before starting a wave. Two people must not merge the same helper on a shared workspace.

**R9 — The inventory is generated; the status is human.** Never hand-edit the generated inventory (§4.2). Human state lives in a separate file keyed by stable id, so regeneration cannot clobber decisions.

---

## 3. Inventory to be eliminated

> **Re-validated at `c816b240c`.** The mirror grew from 378 to **730** mirrored `.ts` files (refreshed
> below). The **ledger totals** here are stamped `generated_from_commit: 67bab09` and are now stale —
> they predate 984 commits. Regenerate (§4.1) before quoting any count.

The ledger is **generated**, not transcribed: `docs/plans/cleanup2-dup-inventory.generated.md`
plus `cleanup2-dup-inventory.json`, produced by `.graphify_ledger.py` across all eight code
subject graphs. Re-run it (§4.1) rather than reading numbers out of this section.

Totals from the generation at `67bab09`:

| | groups | wasted lines | STRICT-identical |
|---|---:|---:|---:|
| all areas | 1,559 | 20,856 | 1,309 |
| **production (this plan)** | **1,071** | **12,266** | 942 |
| test-area (to CleanUp3) | 488 | 8,590 | 367 |

By subject — note that **`02-web` is larger than `01-api`**:

| subject | groups | wasted lines | STRICT-identical |
|---|---:|---:|---:|
| `02-web` (`apps/web`) | 591 | 8,620 | 498 |
| `01-api` (`apps/api`) | 625 | 8,188 | 527 |
| `08-platform` (root `scripts/`, `packages/shared`, `infra/`) | 147 | 2,044 | 116 |
| `03-defense` (`apps/defense-api`, `apps/defense-budget-parser`) | 68 | 740 | 57 |
| `04-meri` | 54 | 535 | 45 |
| `05-strategy` | 34 | 465 | 29 |
| `06-intel` | 19 | 138 | 19 |
| `07-workspace-onboard` | 21 | 126 | 18 |

By wave and by language:

| wave | groups | wasted lines | | language | groups | wasted lines |
|---|---:|---:|---|---|---:|---:|
| `1` (STRICT) | 907 | 9,362 | | TypeScript/JS | 1,515 | 20,200 |
| `2` (LOOSE-only) | 119 | 2,247 | | Python | 44 | 656 |
| `3` (Python) | 44 | 656 | | | | |
| `5` (config) | 1 | 1 | | | | |
| `CleanUp3` (test) | 488 | 8,590 | | | | |

**Two verification levels**, used throughout:

* **STRICT-identical** — identical after comment/whitespace normalization *with string and
  number literals preserved*. Merging is a provably behaviour-preserving extraction. Do not
  agonize; do not write a test per copy.
* **LOOSE-only** — identical only after masking literals. A human reads the diff first.
  Verified examples: `parseAesKey` (identical logic; the thrown message names
  `NOTES_ENCRYPTION_KEY` in one copy and `OAUTH_TOKEN_ENCRYPTION_KEY` in the other),
  `canonicalDecimal` ×3 (zod message wording), `.assertEnabledForTenant()` ×2 (genuine body
  difference), and `errorMessage()` ×16 in `apps/web` (byte-identical body, differing
  fallback string).

### 3.1 The ledger's known blind spots

State these in the completion statement rather than implying coverage that does not exist:

* **SQL, shell and YAML have no symbol bodies** and are not fingerprinted. The `~55`
  basename-sharing `migration.sql` files are handled manually (§11).
* **Config-file duplication is tracked separately** (§9), because `tsconfig*.json` has no
  function bodies; the ledger shows only 1 config group.
* Nodes whose `source_file` is empty (decorator/annotation kinds — `Injectable`, `Controller`,
  `Body`) were excluded from every scan. At `67bab09` that was ~2,230 nodes in subject 01 alone.
* `*.e2e.spec.ts` bodies are excluded by pattern, so e2e test bodies are under-counted.
* Subject graph paths needed repair: **2,170 paths rewritten** (subject 07 drops the `apps/`
  prefix; ~34 subject-02 nodes record `.js` for a file that is really `.tsx`). The ledger
  reports unresolved paths as a counter — it must read **0**.

### 3.2 Mirror obligations — read this before editing anything under `defense-budget`

`apps/defense-api/runtime-source/**` is a **deliberate, byte-identical copy** of parts of
`apps/api`, created as the Phase 8 Session 4 "strangler" slice. `scripts/verify-phase8-session4.mjs`
enforces it by **git tree-SHA equality** and is wired into 8 CI workflows.

| source | mirror | check |
|---|---|---|
| `apps/api/src/defense-budget/` | `apps/defense-api/runtime-source/defense-budget/` | tree SHA equality |
| `apps/api/src/program-element/snapshot/` | `…/runtime-source/program-element/snapshot/` | tree SHA equality |
| `apps/api/src/program-element/source-document/` | `…/program-element/source-document/` | tree SHA equality |
| `apps/api/src/program-element/deltas/` | `…/program-element/deltas/` | tree SHA equality |
| `apps/api/src/program-element/program-element-change-outbox.service{,.spec}.ts` | mirror equivalent | blob content equality |
| `apps/api/scripts/{phase6-stage-cycle,plan-defense-budget-promotion-v1,status-defense-budget-promotion-v1}.ts` | `apps/defense-api/runtime-source/operators/…` | blob content equality |

Verified at `67bab09`: **378 mirrored `.ts` files byte-identical, 0 differing, 0 missing.** Re-verified at `c816b240c`: **730** mirrored `.ts` files byte-identical across the gated subtrees (the mirror grew substantially).

**Three consequences for this plan:**

1. **This duplication is not removable here.** `apps/defense-api/src/runtime` is forbidden from
   importing anything under `apps/api` (the same verify script scans for that), so the two trees
   *cannot* share a module by design. The mirror's own README states deletion is forbidden until
   shadow, canary, rollback and decommission acceptance. → §11 waiver.
2. **Mirror-only groups are excluded from the inventory** (163 groups at `67bab09`). Editing the
   mirror is never the fix; the fix lands in the source tree.
3. **176 groups carry a mirror obligation** — the change must land on **both** sides in the
   **same commit**, including *newly added* files such as a `table-kernel-v1.ts`. The ledger
   marks these `mirror=yes`. This bites Waves 1b, 1e, 1f and 2 hardest, plus the three
   `apps/api/scripts` blobs in Wave 1a.

The gate therefore includes `node scripts/verify-phase8-session4.mjs` (CleanUp1 §9). Without it,
a mirror-obligation miss is only caught by one of 8 path-filtered workflows.

## 4. Wave 0 — Pre-flight, ledger, guard

### 4.1 Regenerate the inventory

```bash
git rev-parse HEAD                 # record as RUN_SHA
git status --porcelain             # expect only this plan's own files
pnpm --filter @capiro/api exec jest --json --outputFile=/tmp/api-names-before.json   # CleanUp3 anchor

# one command, all eight code subjects, writes the ledger + status files
.graphify-venv/Scripts/python.exe .graphify_ledger.py

# supporting diagnostics (per-subject, optional)
.graphify-venv/Scripts/python.exe .graphify_redundancy_scan.py 01-api
.graphify-venv/Scripts/python.exe .graphify_dup_fidelity.py 01-api
.graphify-venv/Scripts/python.exe .graphify_dedup_readiness.py 01-api
.graphify-venv/Scripts/python.exe .graphify_pydups.py apps/defense-budget-parser
```

Check the generator's tail output: `unresolved nodes: 0` (§3.1), a reported count of mirror-only
groups excluded (§3.2), and a reported count of groups carrying a mirror obligation.

If the `.graphify-*` scripts are missing (another author may clean them up), they are
reconstructible: the procedure is documented in `graphify-out/INDEX.md` — fingerprint every
extracted definition body via each node's `source_location`, normalize comments/whitespace, and
hash twice (literals masked = LOOSE, literals preserved = STRICT), slicing bodies by braces for
JS/TS and by **indentation for Python**. Rebuild the graph first (§2 R6). The generator's path
repair (§3.1) is not optional — without it, subject 07 contributes nothing.

### 4.2 Ledger design — stable ids, generated vs human

`.graphify_ledger.py` writes two artifacts and never mixes their ownership:

* **`docs/plans/cleanup2-dup-inventory.generated.md`** and **`cleanup2-dup-inventory.json`** —
  machine-owned, checked in, regenerated per wave. Columns: `group_id`, `wave`, `subject`,
  `symbol`, `copies`, `lines/copy`, `wasted`, `STRICT`, `mirror`, `anchor file`. A
  **Mirror obligations** section lists every group whose change must land in both trees (§3.2).
* **`docs/plans/cleanup2-dup-status.md`** — human-owned. Created once with every row `open`;
  never overwritten by regeneration. Columns: `group_id`, `status`
  (`open` | `merged` | `waived` | `obsolete`), `symbol`, `copies`, `wave`, `note`,
  `merged_in_commit`, `waived_reason`.

**`group_id = sha1(norm_symbol + '|' + first_file_sorted_alphabetically)[:12]`**

Why that formula: it is stable when a duplicate *grows* (a new copy appears → same id, higher
count, row stays open) and it disappears when the group is *merged* (only the canonical file
remains → no group → status goes obsolete). It is **not** stable if the anchor file is renamed
or moved; reconcile those by symbol name and record the remap.

**Reconciliation step, run after every regeneration:** any `open` id absent from the new
generation → set `obsolete` and record the commit that removed it (§2 R4). Any new id → `open`.
Any id whose `copies` dropped → note it; that may be another author's partial merge. Any id whose
anchor moved → remap by symbol.

### 4.3 Scope — all eight code subjects, already covered

This is **resolved**, not a decision to make later. The ledger covers every code subject graph:
`01-api`, `02-web`, `03-defense`, `04-meri`, `05-strategy`, `06-intel`, `07-workspace-onboard`,
`08-platform`. `09-docs` is markdown-only and excluded by construction (it has no code bodies).

Concretely, this means the plan now includes workstreams that the original brief did not
contemplate, and they are **not optional**:

* **`02-web` is the largest single subject** (591 groups / 8,620 lines) — bigger than `01-api`.
  See Wave 1 item **1g**.
* **`08-platform`** adds root `scripts/` (the `phaseN` families, Wave 1 item **1h**) plus `packages/shared`
  and `infra/`.
* **`04-meri`, `05-strategy`, `06-intel`, `07-workspace-onboard`** add smaller sets that are
  already in the ledger; work them in ledger order rather than by subject.

Blind spots remain and must be stated in the completion statement rather than glossed over:
see §3.1. If someone deletes a subject graph, the ledger silently shrinks — so the generator
reports the subject and node counts it scanned, and those must match §3 at the run SHA.

### 4.4 Add the ratchet guard *before* merging anything

`scripts/check-duplicate-helpers.mjs`, modelled on `scripts/check-context-plane-new-bypasses.mjs` (which diffs against `origin/main` and fails on **additions** only). It fails when a *new* local declaration of a migrated helper name appears outside its canonical module. Wire it into CI in the same change that creates the first canonical module.

Guard-name list must be **data, not code**: read it from a file (e.g. `scripts/duplicate-helper-names.txt`) so adding a helper is a one-line data edit and does not require touching the guard in a way that conflicts with another author's PR.

---

## 5. Wave 1 — Mechanically safe merges

Rule: merge without further review when the group is STRICT-identical. Each sub-wave is its own PR; the full `pnpm gate:cleanup1` runs before merge.

### 1a. `scripts/lib/cli.ts` — largest single win (~2,000 lines)

Helpers and their copy counts at `67bab09` (re-derive):

| Helper | Copies | Note |
|---|---:|---|
| `arg()` | 40 | STRICT-identical |
| `flagValue()` | 21 | STRICT-identical |
| `hasFlag()` | 16 | STRICT-identical |
| `argValue()` | 11 | STRICT-identical |
| `gitSha()` | 10 | STRICT-identical |
| `safeDate()` | 10 | STRICT-identical |
| `databaseHost()` | 9 | STRICT-identical |
| `sleep()` | 9 | STRICT-identical |
| `prismaservicefromclient()` | 6 | STRICT-identical |
| `usage()` | 8 | ⚠ 8 copies / 8 variants — different option lists. One renderer taking a spec object. |
| `required()` | 7 | mixed variants |
| `ok()` / `fail()` | 6 / 6 | ⚠ all variants differ — parameterize a label |
| `stringArg()` | 2 | STRICT-identical |

There is no `scripts/lib/cli.ts` today; the only `parseArgs`/`flagValue` references under `scripts/lib/` are incidental. Roughly 372 scripts define their own `main()` and 386 call `process.exit` (re-derive by grep).

Order: create `cli.ts` + its spec → repoint the `arg()` callers → `pnpm gate:cleanup1` → merge. Repeat per helper, never all at once.

### 1b. Non-RDT&E table-extraction kernel

STRICT-identical across the non-RDT&E extractor family:

| Helper | Copies | Sites (re-derive) |
|---|---:|---|
| `groupCellsByRow()` | 8 | `non-rdte/{c1,o1,op5,p1,p21,p3a,p40,p5}/*-extractor-v1.ts` |
| `findHeaderRow()` | 8 | same |
| `isTotalRow()` | 5 | subset |
| `rowsToText()` | 5 | subset |

Target: `apps/api/src/defense-budget/non-rdte/table-kernel-v1.ts`. These 17 extractors total ~9,511 lines and currently share only `identity-v1.ts` and `parseMoneyToken`.

### 1c. Type guards and small utils — nothing shared exists today

| Helper | Copies | Target |
|---|---:|---|
| `nonBlank` | 22 (7 STRICT) | `apps/api/src/common/guards.ts` |
| `asRecord()` | 18 (14 STRICT) | same |
| `isRecord()` | 15 | same |
| `uniqDomains()` | 7 | same |
| `normalizeEmail()` | 10 files | `apps/api/src/common/identity.ts` |
| `text()` | 10 | `guards.ts` |
| `normalize()` / `str()` / `dateOnly()` | 8 each | `guards.ts` |

Verified: no `asRecord`, `isRecord`, `nonBlank` or `normalizeEmail` export exists in `packages/shared` or `apps/api/src/common`. This is missing infrastructure, not a discipline problem — confirm it is still missing before creating a duplicate-of-the-fix (§2 R1).

### 1d. Context-plane adapter utilities

Respect the plane's boundary rule: `apps/api/src/context/context-plane.contract.ts` is a deliberately **types-only** boundary with a CI guard behind it. Helpers go beside it, never inside it.

`compare()` ×9, `compareStrings()` ×7, `uniqDomains()` ×7, `boundedJson()` ×5, `toTenantContext()` ×5, `securityEnvelope()` ×2.

### 1e. Service-level verbatim duplicates

| Symbol | Files (locate by symbol, not line) | Note |
|---|---|---|
| `mergeUserIdentity()` | `auth/clerk-provisioning.service.ts` ↔ `webhooks/clerk-webhook.service.ts` | STRICT-identical |
| `normalizeEmail()` | `auth/clerk-provisioning.service.ts` ↔ `tenant-admin/tenant-admin.service.ts` | identical incl. `BadRequestException('Email is required')` |
| `parseSections()` | `intelligence/alert-memo/alert-memo.service.ts` ↔ `intelligence/alert-memo/district-brief.service.ts` | STRICT-identical |
| `referenceInventory()`, `rowFingerprint()` | `hearing-discovery/florida-jlbc-alias-reconciliation.ts` ↔ `florida-openstates-alias-reconciliation.ts` | STRICT-identical |
| `mapCapabilityError()`, `capabilityContext()` | `outreach-v3/context/*context.service.ts` ↔ `outreach-v3/targets/*targets.service.ts` | STRICT-identical |
| `parseAesKey()` | `engagement/meeting-notes-crypto.service.ts` ↔ `engagement/microsoft/token-crypto.service.ts` | ⚠ LOOSE-only → Wave 2 |
| `.assertEnabledForTenant()` | `district-nexus/district-nexus-flag.guard.ts` ↔ `district-nexus-strategic-flag.guard.ts` | ⚠ LOOSE-only, real body difference → Wave 2 |
| `canonicalDecimal` | `stages/appropriations/actions/defense-budget-stage-action-v1.ts`, `promotion/manual-override-v1.ts`, `rdte/rdte-rounding-policy-v1.ts` | ⚠ LOOSE-only → Wave 2 |

### 1f. `defense-budget` projection and composer helpers

`stripComments()` ×2 (`non-rdte/*-phase5-gates-v1.ts` ↔ `rdte/gates/*-phase4-gates-v1.ts`), `mapOmissionReason()` ×3 (`p21`/`p3a`/`p5` artifact builders), `notPrintedSchema` ×2, `rules` ×2, `sourcePath()` ×2, `decimalEqual()` ×2, `dispositionForRole()` ×2, `nonBlankString` ×2, `sigmoid()` ×2.

**Severity note:** `rdte/projection/rdte-projection-planner-v1.ts` and `non-rdte/non-rdte-projection-planner-v1.ts` shared these helper names but had **already diverged by ~344 lines** at `67bab09` (1,181 vs 1,525). Merging the leaf helpers is in scope; merging the planners is **not** — see §8.

---

### 1g. Web SPA (`02-web`) — the largest single subject, ~4,580 production lines

Not in the original brief. `apps/web` carries **591 duplicate groups / 8,620 lines** (423 groups
/ 4,580 lines of production code, 380 STRICT-identical). The concentration is per-page
copy-paste, not per-component:

| location | production groups | wasted lines |
|---|---:|---:|
| `src/pages/**` | 332 | 3,351 |
| `src/components/**` | 46 | 749 |
| `src/vnext/**` | 27 | 191 |
| `src/lib/**` | 2 | 21 |

Highest-copy production helpers (verified by reading the source, not just the fingerprint):

| Helper | Copies | Lines/copy | STRICT | Modules |
|---|---:|---:|---|---|
| `errorMessage()` | 16 | 8 | **no** — differing fallback string | api-error handling in 16 pages (`AppShell`, `ClientProfilePage`, `CapabilityDrawer`, `McpServersCard`, `SkillsPage`, and 11 `vnext/` pages) |
| `sentence()` | 7 | 18 | yes | `pages/engagement/outreach/v3/**` |
| `formatDateTime()` | 6 | 40 | yes | `pages/engagement/**` |
| `record()` | 6 | 25 | yes | `pages/radar/live-hearings/**` |
| `uploadToS3()` | 5 | 28 | yes | `pages/admin/**` |
| `option()` | 5 | 4 | yes | `vnext/pages/legiwatch/**` |
| `initials()` | 4 | 33 | yes | `pages/directory/**` |
| `stringValue()` | 4 | 18 | yes | `pages/radar/live-hearings/**` |

Also present and worth folding in: chart-shape helpers duplicated between the chat chart card and
the funding/detail drawers (`cartesianAxes()`, `scatterVisual()`, `waterfallVisual()`,
`heatmapVisual()`, `detailsFor()`).

**Target homes:** `apps/web/src/lib/errors.ts` for `errorMessage()`, `apps/web/src/lib/format.ts`
for date/string formatting, `apps/web/src/lib/charts/` for the chart shapes. **Check
`apps/web/src/lib/` first** — the ledger shows only 2 existing duplicate groups there, so some of
this may already exist and merely not be imported.

**Mirror obligation:** none. `apps/web` is not mirrored.

### 1h. Root `scripts/` phase families (`08-platform`) — ~1,940 production lines

The `08-platform` subject covers root `scripts/`, `packages/shared` and `infra/`. Its duplication
is dominated by **one-file-per-phase families**, which is the same anti-pattern as the `phaseN`
directories noted in CleanUp2 §10:

| Family | Copies | Evidence |
|---|---:|---|
| `legiwatch-phaseN-upgrade.mjs` | 4 | `phase6/7/8` are 128/131/131 lines and differ by only **21-23 lines** |
| `legiwatch-phaseN-qualification.mjs` | 6 | by filename family |
| `verify-outreach-v3-phaseN-code.mjs` | 6 | by filename family |
| `verify-engagement-phaseN-scope.mjs` | 4 | by filename family |
| `run-engagement-phaseN-local.mjs` | 3 | by filename family |

Representative ledger rows: `results` ×3 (78 lines/copy) and `hash()` ×3, `migrate()` ×3 — all
within `legiwatch-phase{6,7,8}-upgrade.mjs`; `seedIdentity()` ×3 in
`verify-outreach-v3-phase2-db.mjs`; `here` ×4 in `validate-knowledge-plane-phase26.mjs`.

**Target:** one parameterized script per family taking the phase as an argument, or a shared
scaffold in `scripts/lib/`. Count the family members at execution time (`ls scripts/ | grep -oE
'^[a-z0-9-]*phase[0-9]+[a-z0-9-]*'`) rather than trusting the table above — this is exactly the
kind of list that grows while the plan sits unexecuted.

**Watch out:** several of these are referenced from CI workflows and root `verify:*` scripts, the
same hazard as the CDP scripts (§8). Run the reference check before deleting or renaming any of
them.

**Mirror obligation:** none, except the three `apps/api/scripts` blobs listed in §3.2, which
belong to Wave 1a.

## 6. Wave 2 — The LOOSE-only groups

Per group: read the diff → decide *parameterize* or *genuinely different* → write the test that pins the parameterized behaviour → merge.

| Group | Verdict |
|---|---|
| `parseAesKey()` ×2 | **Parameterize.** Take the env-var name as an argument. |
| `canonicalDecimal` ×3 | **Parameterize.** Pass the zod message in. |
| `usage()` ×8, `ok()`/`fail()` ×6 | **Parameterize.** Prefix/label is script-specific. |
| `.assertEnabledForTenant()` ×2 | **Review.** Genuinely different bodies. Extract the shared query or waive with a reason. |
| `.enabled()`, `.audit()`, `nextFindingId()`, `parseJsonObject()`, `errorCode()`, `markSyncError()`, `slugifyFilename()`, `assertNever()`, `.tryResolveCredential()`, `.revokeStalePendingInvitation()`, `.batchSize()`/`.maxAttempts()`, `validateSha()` | Case-by-case. Most are 3-8 line helpers that are the same thing with a different label — parameterize. |
| `errorMessage()` ×16 (`apps/web`) | **Parameterize.** Byte-identical 8-line body across 16 pages; the fallback
  string (`'Request failed'`) is what differs in at least one copy. One helper taking the fallback. |
| Test-area names (`ctx`, `run`, `apiRoot()`, `required()`, `target()`, `policy()`, …) | Deferred to CleanUp3. |

Every Wave 2 merge adds one test asserting the parameter values, so the parameterization is pinned rather than assumed.

---

## 7. Wave 3 — Python (`apps/defense-budget-parser`)

Surfaced by analysis; ~573 redundant lines / 37 groups, and **~98% of the repo's Python duplication**. CleanUp1 §7 puts its 283 existing pytest tests into CI first; this wave depends on that.

Measured file-pair similarity at `67bab09`:

| Pair | difflib ratio |
|---|---:|
| `stages/hacd/semantics.py` ↔ `stages/sacd/semantics.py` | 0.91 |
| `stages/hacd/extractor.py` ↔ `stages/hasc/extractor.py` | 0.85 |
| `stages/hacd/semantics.py` ↔ `stages/sasc/semantics.py` | 0.83 |
| `stages/sacd/semantics.py` ↔ `stages/sasc/semantics.py` | 0.80 |
| `stages/sacd/extractor.py` ↔ `stages/sasc/extractor.py` | 0.79 |

Duplicated private helpers: `_normalize_text` ×5, `_table_matrix` ×5, `_bbox` ×4, `_row_reference` ×4, `_first_code` ×4, `_table_context` ×4, `_heading_candidates` ×4, `_component` ×4, `_label_column_index` ×4, `_is_quantity_header` ×4, `_match_group` ×4, `_cells_for_row` ×4, `_detect_unit` ×3, `_fiscal_year` ×3, plus `_canonical_decimal`, `_package_scope`, `_row_semantic`, `_package_action_candidate`, `_line_family`, `_is_continuation_label`, `_build_result`, `_to_decimal_string`, `compute_config_sha256`, `validate_sha`.

**The shared kernel already exists and was bypassed:** `extractors/stages/common/congressional_table.py` (~197 lines). Extend that module; do not create a second home for the same idea.

Run the pytest suite before and after each merge. A merge that changes a fixture expectation is a **finding**, not an update — that is the whole reason CleanUp1 §7 runs first.

⚠ Whole files are 0.79-0.91 similar, so the real question is whether `hacd/hasc/sacd/sasc` should remain four near-identical extractors. That is the same decision as `rdte` vs `non-rdte` (§8) — raise the ADR, do not resolve it by find-and-replace.

---

## 8. Wave 4 — The CDP tooling (`apps/web/scripts`)

Surfaced by analysis, not in the original brief. `apps/web/scripts/` holds **20** CDP browser scripts; **10** carry their own `chrome-launcher` + hand-rolled CDP client; only **2** import the shared `phase19-cdp.mjs`. That is duplicated infrastructure with, in several cases, divergent flags — exactly the class of drift this whole exercise exists to stop.

**Do not treat these as deletable by default.** Classify each script into one of three categories and act accordingly:

| Category | Action |
|---|---|
| **Superseded** — CleanUp1 §8 re-expressed its targets as Playwright specs and the Playwright specs assert the same conditions | Delete, but only after the Playwright spec is committed and green, and the deletion is called out in the PR description |
| **Evidence trail** — a human-read capture or acceptance harness whose output is the deliverable | Keep. Consolidate onto one shared CDP module |
| **Referenced by automation** — invoked from a root `package.json` `verify:*` script or a CI workflow | Keep. Consolidate only; deletion is forbidden |

**Mandatory reference check before any deletion:**

```bash
# for each candidate script
grep -rn "$(basename "$SCRIPT")" --include=package.json --include=*.yml --include=*.yaml --include=*.mjs --include=*.js . \
  | grep -v node_modules | grep -v '^./apps/web/scripts/'
```

At `67bab09` several are referenced from root `verify:*` scripts and at least one from `.github/workflows/web-vnext-foundation.yml`. A deletion that breaks a `verify:*` target is a gate failure. Re-run the check at execution time (§2 R1) — references change.

These scripts are also **in the ledger** as duplication in their own right — `required()` ×7, `connectChrome()` ×5 and `safeName()` ×5 in `engagement-phase0/1` scripts, `.send()` ×4 in `engagement-phase3-browser-interactions.mjs`. Any script that survives consolidation must import the shared module rather than keep its private copy, or `check-duplicate-helpers.mjs` will fail it.

Target end state: one shared CDP module (either promote `phase19-cdp.mjs` or add a successor), with every kept script importing it, and zero scripts carrying a private client.

---

## 9. Wave 5 — Structural and config duplication

| Target | Detail |
|---|---|
| **~29 `tsconfig.*.json`** in `apps/api` | Introduce a base config and `extends`. `tsconfig.outreach-v3-phase4.json` and `-phase5.json` were **92% line-identical**. **Before deleting any variant, verify nothing references it** — `apps/api/package.json` `typecheck` chains many of them by name, and `tsconfig.json` may reference others via `references`/`extends`. Deleting an unreferenced file is safe; deleting a referenced one breaks typecheck. |
| **Break the `memory/` import cycle** | `memory-cleanup-outbox.service.ts → memory-ingest.service.ts → memory-store.service.ts → memory-cleanup-outbox.service.ts`. The only cycle found in 4,269 files. |
| **Any remaining duplicated CDP client** | See §8. |

**Explicitly out of scope:** the ~55 `migration.sql` files sharing a basename. Each is a distinct migration; identical basenames are not duplication.

---

## 10. The ADR this plan requires

`rdte/` and `non-rdte/` are mirrored trees that have already drifted (~344-line divergence in the planners; 6 vs 9 artifact builders at `67bab09`). And the same chamber fork exists in **two languages**: TypeScript `apps/api/src/defense-budget/stages/{appropriations,authorization}/{hacd,sacd,hasc,sasc}` and Python `apps/defense-budget-parser/.../extractors/stages/{hacd,hasc,sacd,sasc,ndaa_conference,provisions}`. A chamber-semantics change can require up to **10 edits across 2 languages**.

Write one ADR covering **both languages as a single decision**, before Wave 3 or Wave 1f touch either tree:

* **One pipeline, N profiles** — unify `projection-planner`, `canonical-projection-plan`, `cycle-bundle` (and their Python counterparts) behind a family/chamber profile: column identity, unit semantics and rounding policy are all data. Highest payoff, real migration cost, needs a phase-bounded exception ledger like the context plane's.
* **Two pipelines, one shared kernel** — accept the fork as a bounded-context split, extract only genuinely family-independent logic, and put a contract spec on the **seam** so the two cannot silently diverge in shared behaviour.

Until the ADR lands, Wave 1f merges leaf helpers only.

---

## 11. Deliberately NOT merged (record each with a reason in the status file)

Waiving with a written reason is a required deliverable, not an omission.

| Kept | Reason |
|---|---|
| The **8 per-product context-plane adapters** (meri, meetings, workspace, outreach, legiwatch, strategy, clients, engagement-meeting) | Deliberate seam. `context-plane.contract.ts` exists precisely so each product owns a thin adapter, with a CI guard enforcing it. Collapsing them would couple reasoning paths meant to evolve independently. Only their *helpers* (§5.1d) are merged. |
| **`rdte/` vs `non-rdte/` pipelines** | Needs the ADR (§10), not a merge. |
| The **12 `capabilities/*.capability.ts`** and per-feature NestJS modules | Legitimate bounded contexts. |
| The four/five **chamber composer specs** | Duplicate *tests*. CleanUp3 by the brief. |
| The **55 `migration.sql`** | Distinct migrations sharing a basename. |
| **`apps/defense-api/runtime-source/**` (the Phase 8 Session 4 strangler mirror)** | Deliberate byte-identical copy, enforced by `scripts/verify-phase8-session4.mjs` via git tree-SHA equality. Cannot be deduplicated by sharing code — `apps/defense-api/src/runtime` is forbidden from importing anything under `apps/api`. Removable only by decommissioning the strangler, which the mirror's README gates on shadow, canary, rollback and decommission acceptance. See §3.2. |

---

## 12. The repointing rule (how tests survive this plan)

```diff
- import { groupCellsByRow } from './c1-extractor-v1.js';
+ import { groupCellsByRow } from '../table-kernel-v1.js';
```

1. **Assertions do not change** — not values, count or order.
2. **Test names do not change.**
3. If an assertion fails after repointing, that is a **finding**: the copies were not equivalent for that case. Stop, move the group to Wave 2, parameterize properly. **Do not adjust the assertion to make it pass.**
4. No test file deleted, no `it()` case deleted, no `skip`/`only` added.

Verify (3) mechanically rather than by eye, using the name dumps CleanUp3 §7 formalises:

```bash
pnpm --filter @capiro/api exec jest --json --outputFile=/tmp/api-names-after.json
node scripts/diff-test-names.mjs --before /tmp/api-names-before.json --after /tmp/api-names-after.json
```

`removed` must be empty and `changed` must be empty. Only `added` is acceptable in this plan.

---

## 13. Gate criteria

- [ ] §4.1 pre-flight recorded; every divergence from §3 reconciled in writing.
- [ ] `cleanup2-dup-inventory.generated.md` regenerated at the run SHA; `cleanup2-dup-status.md` has **zero `open` rows for production code** — every row is `merged`, `waived` or `obsolete`.
- [ ] §10 waivers recorded for the context-plane adapters, the capabilities, the `migration.sql` basenames, and `rdte`/`non-rdte` pending the ADR.
- [ ] Scope decision from §4.3 recorded (extended to all subjects, or explicitly limited to 01-api + Python).
- [ ] `pnpm gate:cleanup1` green — every unit suite, every UI test, every guard.
- [ ] **Playwright: every baseline compares within threshold.** `git diff --stat apps/e2e/baselines/` is **empty** — no baseline regenerated, none added. A diff is a failure, not a new baseline.
- [ ] **Tests preserved:** `diff-test-names.mjs` reports zero `removed` and zero `changed` for `apps/api`, `apps/web`, `apps/workspace`, `apps/onboard-web` and `apps/defense-budget-parser`.
- [ ] The duplicate **test-area** groups remain, itemised in the status file as CleanUp3's input.
- [ ] `scripts/check-duplicate-helpers.mjs` runs in CI and passes.
- [ ] §8 reference check run for every deleted CDP script; no `verify:*` script or workflow references a deleted file (verify by re-running the greps, not by memory).
- [ ] §9 tsconfig deletions: every removed variant grepped for references first; `pnpm turbo run typecheck` green.
- [ ] Line-count delta recorded per package (expect roughly **−12,266 production lines** total at `67bab09`: `01-api` −4,223, `02-web` −4,580, `08-platform` −1,936, `03-defense` −1,412, Python −656, plus the smaller subjects). Re-derive rather than quoting these.
- [ ] **Every group the ledger marks `mirror=yes` was changed on both sides in the same commit** — proven by `node scripts/verify-phase8-session4.mjs` passing, not by inspection.
- [ ] `node scripts/verify-phase8-session4.mjs` is part of `pnpm gate:cleanup1` and passes.
- [ ] Coverage has not dropped below the CleanUp1 baseline for any package.
- [ ] The generator's own counters were checked at the end of the run: `unresolved nodes: 0`, and the scanned subject/node counts match §3.

## 14. Evidence to attach

1. The regenerated `cleanup2-dup-inventory.generated.md` + `cleanup2-dup-inventory.json`, and the closed `cleanup2-dup-status.md`, with waivers and obsoletes.
1b. The generator's tail output (subject/node counts, mirror-only exclusions, mirror-obligation count, unresolved paths).
2. `pnpm gate:cleanup1` log per wave.
3. The Playwright run showing zero diffs, plus proof `apps/e2e/baselines/` is untouched.
4. `diff-test-names.mjs` output per wave, per runner.
5. Before/after line counts per package.
6. The CDP reference-check greps for every deletion.
7. The `rdte`/`non-rdte` ADR (a proposal is acceptable; silence is not).
8. `cleanup2-progress.md` showing claimed scope.

## 15. Risks and rollback

| Risk | Mitigation |
|---|---|
| A "duplicate" is not actually equivalent | STRICT/LOOSE split; STRICT merges are mechanically safe; LOOSE gets a diff review; a failing repointed assertion stops the merge |
| Silent behaviour change in an untested file | CleanUp1 §6 adds tests for exactly the files that had none |
| Visual regression from a refactor | Nothing here should alter rendered output. A visual diff means the refactor was not behaviour-preserving — revert it |
| Scope creep into the `rdte`/`non-rdte` fork | §10: leaf helpers only until the ADR lands |
| Another author edits a target mid-wave | §2 protocol: re-derive, re-anchor by symbol, obsolete rather than recreate, never revert |
| Deleting a CDP script that automation needs | §8 mandatory reference check with greps, not memory |
| Deleting a referenced tsconfig | §9 reference check + `turbo run typecheck` |
| A wave grows too large to review | Wave 1 is split by helper and by module; each PR must stand alone |

Rollback: each wave is an independent PR. Reverting restores the duplicates and reopens the status row.

## 16. Out of scope

Duplicate **test** removal (CleanUp3). Any change to rendered output. Fixing latent bugs found in drifted copies — **record** them; a bug fix changes behaviour, and this gate requires behaviour to be unchanged.

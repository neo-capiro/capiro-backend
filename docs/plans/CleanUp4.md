# CleanUp4 — Architecture: data-driven registries, shared seams, and twin/God decomposition

**Status:** not started
**Depends on:** CleanUp1 (test foundation, visual baselines, coverage, Python CI) complete and green.
CleanUp2 (canonical helper modules) complete — CleanUp4 *generalises* what CleanUp2 extracted. Run
CleanUp3 first if convenient so the test inventory is settled, but CleanUp4 does not block it.
**Gate:** `pnpm gate:cleanup1` green **plus** `pnpm gate:cleanup4` (§10). Every conversion is
behaviour-preserving except for explicitly-declared default changes (§7), each of which carries its own
test. No Playwright baseline is regenerated.
**Evidence base:** `docs/plans/architecture_review.md` — 125 findings across all 13 `apps/*` folders, 9
cross-cutting themes. That document is to this plan what `cleanup2-dup-inventory.generated.md` is to
CleanUp2: the ledger. Re-derive from it; do not re-transcribe it here. Its findings were **re-verified
against `c816b240c`** (see that document's Re-validation section) — all 125 remain live, with counts,
sizes and several paths refreshed.
**Related:** `docs/security/SECURITY_REVIEW.md` owns the security items this plan deliberately does **not**
re-plan (§5.1).

---

## 1. What this plan is — and how it differs from CleanUp1–3

| plan | changes production code? | changes observable behaviour? | purpose |
|---|---|---|---|
| CleanUp1 | no | no | test foundation, visual baselines, coverage, CI holes |
| CleanUp2 | yes (extraction only) | **no** | remove *exact* duplicate production code |
| CleanUp3 | no (tests only) | no | remove duplicated *tests* |
| **CleanUp4** | **yes (structural)** | **no, except declared defaults (§7)** | data-driven registries, shared seams, twin/God decomposition |

CleanUp2's central rule — *"a bug fix changes behaviour, and this gate requires behaviour to be
unchanged"* — **cannot be carried over unchanged**, because CleanUp4's whole purpose is to change how the
code is structured. The replacement contract is:

1. **Observable behaviour is preserved** for every conversion. Evidence is not "the suite is green" (it
   was green before) but: existing tests + the CleanUp1 visual baselines + a **new characterization test
   per converted rule table** that pins the table's current decisions before the table is introduced
   (§10).
2. **Any changed default is declared in §7**, carries a one-line rationale and a test, and is the only
   category permitted to change behaviour. (Most likely candidates: fail-closed substitutions, a
   default that the security review already flags as wrong, or a timeout that becomes explicit.)
3. **No test is deleted.** CleanUp3's name-diff machinery is reused (§10) so a conversion that drops a
   case is caught mechanically.

## 2. Why this plan exists

`docs/plans/architecture_review.md` establishes that the repo is not thirteen architecture problems but
a small number of patterns repeated across thirteen apps. Ranked by surface touched:

* **T1** — business rules live in branch chains, not tables (agencies, exhibits, committees,
  jurisdictions, providers, budget semantics, weights, thresholds, cadences).
* **T2** — "twin" verticals copy-adapted instead of parameterised (HAC-D/SAC-D, Hill-Day/draft,
  legacy/vNext, rail-twin repos, batch/async coordinators, three Tango clients, five bill-id resolvers).
* **T3** — God modules (12.2k-line `EngagementService`, 5.2k `EngagementPage`, ~1,750-line `runTurn`, …).
* **T4** — no enforced persistence seam; raw SQL in services/controllers; tenancy by convention.
* **T5** — config and flags in up to four parallel mechanisms; `process.env` bypassing validated config.
* **T6** — no shared outbound HTTP client (21 `fetch` sites in `intel-api`, 12 in `workspace`, 9 URL
  copies in `meriv2`).
* **T7** — contracts re-declared, not shared (web DTO mirrors, eval mirrors, Python↔TS semantics).
* **T8** — unbuilt/ungated seams (`runtime-source`, parser extractors, the orchestrator, the eval).
* **T9** — ambient state and non-determinism instead of injection (ALS, monkey-patching, `new Date()`).

The security review independently argues the same design principle — *"the strongest controls are the
ones with a guard behind them… the fix pattern that works in this repo is a ratchet, not a guideline"*
(`SECURITY_REVIEW.md`, cross-cutting theme 2). CleanUp4 adopts that: every seam introduced here ships
with a ratchet guard (§8), not a convention.

## 3. Re-validation protocol

Carry CleanUp1 §2 / CleanUp2 §2 unchanged (**R1–R8**: re-derive before acting, anchor on identities not
positions, counts are expectations with tolerance, a vanished item is "already done", never resolve a
conflict by reverting another author, the graph is a snapshot, guard against silent scope loss, claim
your scope). Add:

* **R10 — the review's line numbers are stale by construction.** `architecture_review.md` gives
  `path:line` as a *locating hint*. Re-grep by symbol before acting; never search for a line number.
* **R11 — confirmed vs suspected.** Findings marked *suspected* in the review (at least `defense-api
  D3`, `web O3`) are hypotheses. Verify first-hand before scheduling; a disproved finding is closed, not
  forced.
* **R12 — deliberate decisions are not defects.** The clio-sandbox Windows passthrough, the workspace
  30-second membership cache, and `defense-parser-orchestrator`'s isolation are documented decisions.
  Change them only with the owning ADR in hand, and record the ADR reference.

### Step 0 — discovery (run first)

```bash
git rev-parse HEAD                                  # RUN_SHA
git status --porcelain                              # expect only this plan's own files
pnpm install --frozen-lockfile
pnpm gate:cleanup1                                  # must be green before any wave starts
node scripts/verify-phase8-session4.mjs             # mirror integrity before touching mirrored trees
.graphify-venv/Scripts/python.exe .graphify_ledger.py   # re-derive the duplication inventory
```

Re-derive from `docs/plans/architecture_review.md` the finding list for the app you are about to touch
and reconcile it against the live tree. Record divergences in `docs/plans/cleanup4-progress.md`.

---

## 4. Waves

Each item cites the finding IDs in `architecture_review.md`. Wave 0 is a decision gate; Waves 1–5 are
the work. Waves are ordered by leverage, not by app, because a single seam decision retires findings in
several apps at once.

### Wave 0 — Decide postures for the ungated seams (T8)

These read as "covered" today but nothing enforces or runs them. Decide one posture per item — *compile
it, wire it, gate it, or move it out* — and record the decision before any refactor. No code change is
required to complete this wave; the deliverable is a decision per item.

| item | finding | posture to decide |
|---|---|---|
| `apps/defense-api/runtime-source/` (~206k lines outside the build; port hashes fixtures) | `defense-api O1` | compile the mirror **or** move it out; make manifest provenance derived |
| `apps/defense-budget-parser/extractors/**` (reachable only from tests) | `defense-budget-parser O1` | add the dispatch command **or** relocate to tests |
| `apps/defense-parser-orchestrator` (not a workspace package; contracts unreachable; hardcoded CI `node --check` list) | `defense-parser-orchestrator A1` | add `package.json` + `@capiro/defense-contracts` dep; glob the CI check |
| `apps/api-strategy/eval` (never executes `MeriService.draft()`) | `api-strategy O4` | make the app path injectable so L2 grades the app |
| `apps/engagement-api` (packaging-only, ownership unresolved) | `engagement-api O1` | record shadow-only ownership in README/registry |

### Wave 1 — Shared seams that retire findings across many apps

One artifact each; the artifact is not complete until every listed call site uses it.

| seam | findings retired | target home |
|---|---|---|
| **Internal HTTP client** — base URL, secret, timeout, JSON/error mapping, policy hooks | `intel-api A3`, `workspace A2`, `meriv2 A1/A2/D5`, `api A2`, `defense-api O4` (timeouts) | new shared package (e.g. `packages/http-client`) consumed by apps |
| **Typed feature-flag registry + generic `FeatureFlagGuard` base** | `api A1/D5`, `web D4`, `workspace D3`, `intel-api O5`, `defense-api O4` | `packages/shared` (+ app-local wiring) |
| **Typed contract vocabulary** — `ViolationCode` union, shared DTOs | `api-strategy D4/A3`, `web A1`, `clio-sandbox A1` | `packages/strategy-verifier`, `packages/shared` |
| **Tenant-scoped data-access layer** — client extension or RLS | `workspace O2`, `api A4/O3`, `defense-api O3`, `intel-api O3` | per-app persistence layer (see §5.1 for the security-owned half) |
| **Entity-resolution / bill-key module** | `intel-api A1`, `api D4` | `packages/shared` |
| **Repository/port convention for reads** | `api A4/O3`, `defense-api O3`, `intel-api O3` | per app |
| **Injectable clock + RNG** | `api-strategy O3` | `packages/shared` time util |
| **Explicit required context** (replace ambient ALS) | `workspace O1`, `api-strategy O1` | per app |

**Ordering rule:** build the artifact in the *smallest* app that needs it (`clio-sandbox` for the
contract, `onboard-api` for a first client), prove it, then migrate outward. Never big-bang twelve apps.

### Wave 2 — Data-driven registries, per domain

Convert each branch chain (T1) into a table or typed registry. Work domain by domain; start where
correctness is most at stake (money and legal semantics). Each conversion carries a characterization
test pinning the current decisions first.

1. **Defense-budget semantics** — `api D1/D2`, `defense-api D1/A1/A2/A3`, `defense-budget-parser
   D1/D2/D3/A1/A2/A3`. Gated by the CleanUp2 §10 ADR (one pipeline / N profiles). **Mirror obligation
   applies** (§6).
2. **Intel/hearing provider registry** — `intel-api D1/D2`. Coordinate with security (§5.1): the
   host allowlist is a security control.
3. **Onboarding task + cadence tables** — `onboard-api D1/D2`, `onboard-web D2`. Coordinate with
   security (#26, §5.1).
4. **Workspace product registry** — `workspace D1/D2`.
5. **Web nav/route + Explorer source definitions** — `web D1/D2/D3`.
6. **Strategy context-template registry** — `api-strategy D1/D5`.
7. **Defense-api source catalogue** — `defense-api D2/D3`.
8. **MeriV2 recipe registry** — `meriv2 D1/D2/D3/D4`.
9. **Tool dispatch + scoring weights** — `api D3`, `intel-api D3`.

### Wave 3 — Break the twins and the Gods (T2, T3)

Highest effort, largest payoff, and the point at which test seams appear.

* **Twins → one parameterised path:** appropriations committee stages (`defense-api A1`); workspace
  draft vs Hill Day (`workspace A1`); web legacy vs vNext (`web A2/A3`); intel rail-twin repos
  (`intel-api A4`); the disabled batch coordinator (`defense-parser-orchestrator A2`); Tango clients
  (`api A2`, if not already done in Wave 1).
* **Gods → split behind the existing facade:** `api O1` (`EngagementService`, `meri-tools`,
  `intelligence`), `web O1`, `workspace O3`, `intel-api O3`, `meriv2 O1`, `onboard-api O2`,
  `defense-parser-orchestrator O1`. Splitting is also how Wave 1's injection (clock, model client,
  persistence) lands — injection replaces ALS and monkey-patching.

### Wave 4 — Determinism and ambient state (T9)

* `workspace O1` — make the generation boundary a required parameter / request-scoped provider, so an
  unwrapped call is a compile error rather than a silent downgrade.
* `api-strategy O1` — pass governed context explicitly; remove runtime method monkey-patching.
* `api-strategy O3` — thread the injectable clock; drop `Math.random()` jitter from grounding.

### Wave 5 — Config and flag consolidation (T5)

* One validated config surface per app; remove `process.env` reads that bypass it (`api D5`,
  `intel-api O5`, `defense-api O4`).
* One flag registry (under Wave 1) replacing the four parallel mechanisms (`workspace D3`, `web D4`).
* Remove repeated defaults (`meriv2 D5`, `defense-api O4`).
* Reconcile the env-mismatch item with security (cross-cutting theme 4, §5.1).

---

## 5. Already owned elsewhere — do not re-plan

### 5.1 Owned by `docs/security/SECURITY_REVIEW.md`

These were found by both reviews. The security document owns them; CleanUp4 must not create a second,
possibly divergent, remediation. Where CleanUp4's structural work touches the same code, it does so
**only after** the security fix lands, and it references the security finding rather than restating it.

| CleanUp4 finding | Security document reference | Relationship |
|---|---|---|
| `clio-sandbox O1` (no CDK service definition) | §8, ADR claim 1 — "Not verifiable in-repo — no CDK definition for the service, SG pair or task role exists" | **Security owns.** Do not codify IaC here; coordinate. |
| `clio-sandbox O2` (in-memory admission, noisy neighbour) | §3 — "Cost/DoS controls are per-process and coarsely shared — the sandbox cap is an in-memory `Map` per replica" | **Security owns** the control gap. Per-tenant fairness at the gateway is the residual CleanUp4 item if security leaves it. |
| `workspace A2` (shared `INTERNAL_SERVICE_SECRET`; missing deadlines) | Top-5 #1; §8 — "Two outbound internal calls in workspace carry no deadline" | **Security owns** credential scoping and deadline policy. CleanUp4 owns only the *client consolidation*, and must keep auth per-call-site explicit (review's own caveat). |
| `workspace O2` (`ws_*` tables have no RLS; tenancy by convention) | **Conflict** — §"What is in good shape" states tenancy is enforced with a build-gate spec. The review found `prisma/prisma.service.ts` documenting `ws_*` as excluded. | **Escalate to security.** The two documents disagree; a security owner must adjudicate before CleanUp4 builds a scoped layer that may already be planned. |
| `onboard-api O1` (IT-admin writes `onboard_setup_task` directly, bypassing CAS) | #26 — "Setup-task transitions accept any `from → to`" | **Security owns** the transition-graph enforcement. CleanUp4 owns the ownership refactor (route all transitions through one service); land security #26 first. |
| `onboard-api D1` (setup task machine defined in six places) | #26 (partial) | **Coordinate.** The table is CleanUp4's; the legal transition graph is security's. One table should carry both. |
| `defense-api O4` (unvalidated network-enabling env switch; env mismatch) | Cross-cutting theme 4 — `NODE_ENV=development` in the live capiro-dev deployment | **Escalate/coordinate.** Config consolidation is CleanUp4's; the guard-disabling mismatch is security's. |
| `intel-api D1` (host/provider classification duplicated in five modules) | §6 — `net-guard.ts` described as a real SSRF choke point | **Coordinate.** The registry is CleanUp4's, but the host allowlist is a security control — do not change its membership without a security review of the diff. |
| `workspace A2`/`api A2` (credential handling inside clients) | Top-5 #1 | **Security owns** the secret; CleanUp4 owns the transport. |
| `api A4` / `intel-api O3` (raw SQL in services) | §2 — all interpolated raw SQL was verified safe (corroborated and explained in `architecture_review.md` **Appendix A**) | **No security action needed**; architectural seam is CleanUp4's alone. Security's verdict is the reason this is not urgent. |

> **Rule for executors:** if a finding in this plan turns out to be a security control, stop and route it
> to `SECURITY_REVIEW.md` (label **R-numbers** there, R1–R20) instead of fixing it inside CleanUp4. Do not
> create a competing remediation.

### 5.2 Owned by CleanUp2 / CleanUp3

CleanUp4 depends on these; it does not repeat them.

| CleanUp4 finding | Owned by |
|---|---|
| `api A1` (four near-identical flag guards) | CleanUp2 Wave 1e (`.assertEnabledForTenant()` merge) — CleanUp4 then adds the base class |
| `api D1` / `defense-api A2` (per-exhibit table kernel) | CleanUp2 Wave 1b creates `table-kernel-v1.ts`; CleanUp4 Wave 2 makes it descriptor-driven |
| `defense-budget-parser A1/A2/D1/D2` | CleanUp2 Wave 3 (helpers) + CleanUp3 §5 (composer specs) |
| `api O2` (memory circular DI) | CleanUp2 §9 already lists "Break the `memory/` import cycle" |
| `web A1/A2/A4` (legacy/vNext duplication, local primitive copies) | CleanUp2 Wave 1g (canonical helpers); CleanUp4 Wave 3 parameterises the twins |
| Chamber composer specs | CleanUp3 §5 |

---

## 6. Mirror obligations — read before editing anything under `defense-budget`

Unchanged from CleanUp1 §3 / CleanUp2 §3.2. `apps/defense-api/runtime-source/**` is a **deliberate,
byte-identical copy** of parts of `apps/api`, enforced by **git tree-SHA equality** via
`scripts/verify-phase8-session4.mjs` in 8 workflows.

* **730** mirrored `.ts` files verified identical at re-verification (378 at the original review); **184** ledger groups carry a mirror
  obligation; **169** mirror-only groups are excluded from the inventory.
* **Both sides change in one commit**, including newly added files (e.g. a descriptor module introduced
  by Wave 2). A mirror miss is a gate failure, not a follow-up.
* `apps/defense-api/src/runtime` is forbidden from importing anything under `apps/api` — so the mirror
  cannot be "fixed" by sharing a module. See CleanUp2 §11 for the decommission gating.

Wave 2 items 1 and 7, and Wave 3's appropriations work, are the hardest hit. `node
scripts/verify-phase8-session4.mjs` is in the gate.

## 7. Declared default changes

**Empty at plan time.** A behaviour change is permitted **only** when it is added to this table with:
the finding ID, the old value, the new value, a one-line rationale, and the name of the test that pins
it. Anything not listed here must preserve behaviour. This cell exists so that a legitimate fail-closed
change (which the security review may require) is *declared* rather than smuggled in under a refactor.

| finding | old | new | rationale | test |
|---|---|---|---|---|
| _(none yet)_ | | | | |

## 8. Ratchet guards (the mechanism this repo actually uses)

Each new seam ships with a guard that fails on **additions** of the old pattern, modelled on
`scripts/check-context-plane-new-bypasses.mjs` and CleanUp2 §4.4 (`check-duplicate-helpers.mjs`). Guard
inputs are **data files, not code**, so adding a name is a one-line data edit.

| guard | fails when |
|---|---|
| `check-http-client-bypasses.mjs` | a new direct `fetch`/`axios` appears in an app that has the shared client |
| `check-config-env-bypasses.mjs` | a new `process.env.` read appears outside the app's config module |
| `check-flag-registry-bypasses.mjs` | a new raw feature-flag string literal appears outside the registry |
| `check-tenant-scope-bypasses.mjs` | a new unscoped query on a tenant-owned model (extends the existing tenant-scope spec) |
| `check-registry-ownership.mjs` | a new hardcoded domain vocabulary appears outside its registry (per-domain name list, data-driven) |

Wire each guard into CI in the **same change** that creates its seam. A seam without a guard is the exact
failure mode the security review identified.

## 9. Waivers

Record each with a reason in `docs/plans/cleanup4-progress.md`, keyed by finding ID.

| Candidate | Likely verdict |
|---|---|
| `clio-sandbox` Windows passthrough | Keep — deliberate, documented (R12) |
| `workspace` 30 s membership cache | Keep the window; only the *shape* may change |
| `defense-parser-orchestrator` isolation | Keep — offline evidence tool by design unless Wave 0 decides otherwise |
| `defense-api/runtime-source` mirror | Not removable here (CleanUp2 §11) |
| `rdte`/`non-rdte` and chamber forks | Pending the CleanUp2 §10 ADR |

---

## 10. Gate criteria

- [ ] §3 Step 0 recorded; `pnpm gate:cleanup1` green before Wave 1 began.
- [ ] Wave 0: one recorded posture decision per item, in `cleanup4-progress.md`.
- [ ] Every Wave 1 seam exists, every listed call site uses it, and its ratchet guard (§8) is wired and passing.
- [ ] Every Wave 2 conversion has a characterization test pinning the pre-conversion decisions, and the test is green **before** the registry is introduced.
- [ ] No `docs/plans/architecture_review.md` finding marked *suspected* was actioned without first-hand verification (R11).
- [ ] **Security-owned items untouched or already fixed:** `git log` shows no CleanUp4 commit as the fix for any item in §5.1; each is resolved by a security-document (R-number) change or explicitly deferred.
- [ ] `node scripts/verify-phase8-session4.mjs` passes; every `mirror=yes` group changed on both sides in the same commit.
- [ ] `pnpm gate:cleanup1` green, including `gate:cleanup1:python`.
- [ ] **Playwright baselines byte-identical:** `git diff --stat apps/e2e/baselines/` is empty.
- [ ] **Test-name diff clean** (`scripts/diff-test-names.mjs`, CleanUp3 §7): zero unexplained `removed`, zero unmapped `changed`, any `scope-changed` acknowledged.
- [ ] Coverage ≥ the CleanUp1 baseline for every package.
- [ ] §7 lists every behaviour change; the list is either empty or every row has its test named.
- [ ] `.graphify_ledger.py` re-run at the end: production duplication has not **increased** (new canonical modules must not add duplicate groups).
- [ ] `pnpm gate:cleanup4` runs all of the above plus the §8 guards.

Suggested root scripts:

```json
"gate:cleanup4": "pnpm gate:cleanup1 && node scripts/check-http-client-bypasses.mjs && node scripts/check-config-env-bypasses.mjs && node scripts/check-flag-registry-bypasses.mjs && node scripts/check-tenant-scope-bypasses.mjs && node scripts/check-registry-ownership.mjs",
"gate:cleanup4:python": "pnpm gate:cleanup1:python"
```

## 11. Evidence to attach

1. §3 Step 0 log, and the reconciliation of `architecture_review.md` findings against the live tree.
2. Wave 0 posture decisions.
3. Per seam: the artifact, the migrated call sites (`grep` output), and the guard's output.
4. Per registry: the characterization test and the pre/post decision table.
5. `pnpm gate:cleanup4` log.
6. Mirror verification output.
7. CleanUp3 name-diff output per wave.
8. Before/after duplication-ledger summary (must not increase).
9. `cleanup4-progress.md` (claimed scope, waivers, declared defaults).

## 12. Risks and rollback

| Risk | Mitigation |
|---|---|
| A "refactor" silently changes behaviour | Characterization test pinned before each conversion; §7 declares any real change; baselines must not move |
| Twin decomposition loses an edge case | Name diff + characterization tests; the CleanUp2 §10 ADR bounds how far a twin may be merged |
| A new registry becomes the new duplication | `check-registry-ownership.mjs` + the ledger must not grow |
| Migrating twelve apps at once | Wave 1 ordering rule: prove in the smallest app, migrate outward |
| Touching a security control as an "architecture" change | §5.1 rule: if it is a control, route it to the security document |
| Mirror miss on `defense-budget` | `verify-phase8-session4.mjs` in the gate; both sides in one commit |
| Another author edits a target mid-wave | §3 R1–R8 protocol carried from CleanUp1/2 |
| A God module split becomes an unbounded project | Split behind the existing facade, one capability per PR; tests must stay green at every step |

Rollback: each seam, registry and split is an independent PR. Reverting restores the prior structure; the
duplication ledger and the ratchet guards go back to their previous state.

## 13. Out of scope

* **Security remediation** — owned by `docs/security/SECURITY_REVIEW.md` (§5.1). This plan only touches
  the same code when the structural change is orthogonal to the control, and only after the security fix.
* **Security vulnerability discovery** — out of scope entirely.
* **Fixing product bugs** found along the way — record them; do not absorb them into a refactor.
* **Exact-duplicate removal** (CleanUp2) and **duplicated-test removal** (CleanUp3).
* **The `rdte`/`non-rdte` and chamber-fork decision** — the CleanUp2 §10 ADR, not a find-and-replace.

## 14. Completion statement

When this gate closes:

* every branch chain in T1 has a data table or registry behind it, with a characterization test and a
  ratchet guard;
* every seam in T5–T7 exists once and is used everywhere, guarded against re-fragmentation;
* the twins of T2 are one parameterised path, and the Gods of T3 are decomposed behind their facades;
* the ungated seams of T8 have a recorded posture — compiled, wired, gated, or removed;
* the ambient state of T9 is replaced by injection;
* the security-owned items remain owned by `docs/security/SECURITY_REVIEW.md`, untouched here;
* no user-visible behaviour changed except where §7 declares it — proven by unchanged baselines and a
  clean test-name diff.

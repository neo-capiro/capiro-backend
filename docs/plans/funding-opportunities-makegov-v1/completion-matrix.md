# Completion matrix — Funding Opportunities + MakeGov/Tango

One row per micro-phase. A phase is complete only when every column that applies to
it carries evidence, per plan §6.3.

## How to fill a row

| Column | What counts as evidence |
|---|---|
| **Code** | Merge SHA of the phase branch. Not "done" — a SHA. |
| **Tests** | Suite/test counts after the phase, and the floors in `funding-opportunities-ci.yml` if they moved. |
| **Review** | `PASS` / `PASS WITH NON-BLOCKING NOTES` / `FAIL` from an independent tester working from the executor's final SHA, per §6.2. A tester who trusted the handoff has not reviewed. |
| **Migration** | Migration directory name, plus `clean` (fresh replay) and `ordered` (upgrade from the prior FO schema) both rehearsed. `n/a` if the phase has none. |
| **Deploy** | Task-definition revision or image digest actually running, or `n/a` for a code-only phase whose behavior is unchanged. |
| **Live acceptance** | The phase-specific acceptance evidence from its own section. Naming the artifact is the evidence; "verified" is not. |
| **Rollback** | The rehearsed rollback, or the reason none is needed. |

Status vocabulary: `not started`, `in progress`, `awaiting review`, `merged`,
`deployed`, `accepted`, `blocked`.

**Rules that survive contact with schedule pressure:**

- A `FAIL` is not overwritten. Add a row beneath with the remediation SHA.
- A lowered test floor requires a written reason in this file *and* in the PR.
- `Deploy` is `n/a` only when behavior genuinely did not change. A user-visible or
  schema-bearing phase with `n/a` here is an error, not a shortcut.
- Do not deploy `Capiro-dev-Compute`. It is drifted. This applies during rollback too.

---

## Phases

| Phase | Deliverable | Status | Code (SHA) | Tests | Review | Migration | Deploy | Live acceptance | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| P00 | Freeze the baseline and release gate | in progress | *pending commit* | api 20/584, web 26/79, 0 skipped. Floor raised 19/500 → **20/575** | *pending* | n/a | n/a — no production code changed | Three mutations verified to fail a boundary test: `totalAmount` (required → compile error; optional → 2 assertion failures), null money → `0` (2 failures), internal-tenant flag fallback (1 failure). Zero skipped/todo in scope. | Revert the docs/tests/fixture commit and restore the 19/500 floor. No data rollback. |
| P01 | One shared client-opportunity profile builder | in progress | *pending commit* | api 21/641, web 26/79, 0 skipped. Floor raised 20/575 → **21/630** | *pending* | n/a | n/a — schedules still disabled, dry-run still default | Byte-equivalent profile JSON + fingerprint proven across the read path and the batch producer read for 5 client shapes (thin, defense, grant, multi-entity, no-history). **One deliberate behavior change** — see below. | Revert the three new modules and restore the inline builders. No data rollback: nothing is persisted by this phase. |
| P02 | UEI-first award-history identity and labeled name fallback | in progress | *pending commit* | api 22/672, web 26/79, 0 skipped. Floor raised 21/630 → **22/660** | *pending* | n/a | n/a — schedules still disabled | Score changes enumerated below. **Zero existing golden/fixture assertions changed**, because no pre-P02 fixture held a UEI and a name-bearing mapping at once — which is itself the reason the defect survived. | Revert code. No persisted human decision is touched; derived scores return to prior behavior on the next run. |
| P03 | Complete grant producer keyset walk | not started | | | | n/a | | 4,001-grant / 501-client fixtures reach the last row; resume without skip or duplicate | Revert producer; persisted suggestions intact |
| P04 | Complete SAM producer keyset walk | not started | | | | n/a | | Same boundary fixtures; informational notices never enter the scored set | Revert producer; no data deletion |
| P05 | Mapping governance hardening | not started | | | | conditional | | Body `id` rejected; bulk actions cannot touch an award-bearing mapping | Revert code; new audit columns are additive |
| P06 | Deterministic recommendation contract | not started | | | | n/a | | Full truth table; stable under input ordering | Revert additive response fields |
| P07 | Human decision and next-action persistence | not started | | | | **required** | | Clean + ordered replay; 4 RLS policies and FORCE intact | Roll back code, leave additive nullable columns |
| P08 | Atomic review/pursuit task action | not started | | | | n/a | | Failure at either step rolls back both; retry creates one task | Revert UI to prior endpoint |
| P09 | Human-readable match explanations | not started | | | | n/a | | No raw camelCase signal key in default card text | Revert web display |
| P10 | Cross-client triage API | not started | | | | n/a | | Cursor pagination neither repeats nor skips; query count stays bounded | Revert route/service |
| P11 | Client-first triage UI | not started | | | | n/a | | Route refresh restores state; existing deep links still valid | Turn off `funding_opportunities_client_inbox` |
| P12 | Deep-linkable opportunity detail shell | not started | | | | n/a | | Drawer and page render the same component; no Tango call | Turn off inbox flag or revert route |
| P13 | Generic opportunity source identity bridge | not started | | | | **required** | | Old code reads new rows and vice versa during rolling deploy | Roll back code; keep expanded columns |
| P14 | Tango provider adapter and fixture harness | not started | | | | n/a | | Import-boundary test fails if FO imports the SDK directly; API boots with no key | Revert dependency and adapter |
| P15 | Tango snapshot, crosswalk, checkpoint, usage schema | not started | | | | **required** | | Duplicate same-hash snapshot is a no-op | Leave additive tables |
| P16 | Optional config and Secrets Manager wiring | not started | | | | n/a | | CDK synth proves the key is absent from serve/migrate and present only in sync | Remove optional ARN/config |
| P17 | Read-only capability and tier probe | not started | | | | n/a | | Sanitized report attached to handoff; no DB timestamp changed | Revert command |
| P18 | Rate-limit, usage, retry, health controls | not started | | | | conditional | | Fake-clock retry/breaker proof; a 400 attempted once | Disable Tango commands |
| P19 | Reviewed-UEI entity shadow sync | not started | | | | **required** | | A name-only client produces no entity fetch | Stop command; snapshots unused |
| P20 | Client profile enrichment review workflow | not started | | | | **required** | | Rejection durable across syncs; no "accept all" for certifications | Revert code |
| P21 | Versioned Federal Business Profile | not started | | | | n/a | | | |
| P22 | Relevant vehicles and past-performance sync | not started | | | | **required** | | | |
| P23 | Acquisition-position scoring and UI | not started | | | | n/a | | | |
| P24 | Agency forecast schema and incremental sync | not started | | | | **required** | | | |
| P25 | Forecast recommendation and lifecycle rules | not started | | | | n/a | | | |
| P26 | Forecast early-signal UI | not started | | | | n/a | | | |
| P27 | Tango↔SAM crosswalk and parity ledger | not started | | | | **required** | | | |
| P28 | Normalized notice history and material-change timeline | not started | | | | **required** | | | |
| P29 | Attachment metadata and secure archive | not started | | | | **required** | | | |
| P30 | Tier-aware extracted-text ingestion | not started | | | | conditional | | | |
| P31 | Evidence-bound requirement extraction artifact | not started | | | | **required** | | No attachment-derived claim without source evidence | |
| P32 | Full opportunity assessment drawer | not started | | | | n/a | | | |
| P33 | Government Landscape composer | not started | | | | n/a | | | |
| P34 | Stakeholder routes and deterministic action plan | not started | | | | n/a | | | |
| P35 | Pursuit pipeline stages and Kanban | not started | | | | **required** | | | |
| P36 | Outcome capture and governed learning candidate | not started | | | | conditional | | | |
| P37 | Typed local Meri opportunity tools | not started | | | | n/a | | | |
| P38 | Structured Meri assessment and artifacts | not started | | | | conditional | | | |
| P39 | Research-only Tango MCP connector | not started | | | | conditional | | MCP is research-only; no production decision path | |
| P40 | DIBBS schema and sync | not started | | | | **required** | | | |
| P41 | DIBBS matching and UI | not started | | | | n/a | | | |
| P42 | SBIR/STTR schema and sync | not started | | | | **required** | | | |
| P43 | SBIR/STTR matching and UI | not started | | | | n/a | | | |
| P44 | Budget beta context in shadow mode | not started | | | | **required** | | Labeled beta | |
| P45 | Protest and exclusion risk context | not started | | | | **required** | | | |
| P46 | Verified Tango webhook receiver | not started | | | | **required** | | Signature verified before JSON is trusted | |
| P47 | Dry-run-first webhook alert reconciler | not started | | | | conditional | | | |
| P48 | Event fan-out, materiality, quiet alerts | not started | | | | **required** | | Second run over unchanged notices is quiet | |
| P49 | Internal tenant canary and browser acceptance | not started | | | | n/a | | | |
| P50 | Controlled schedule and webhook enablement | not started | | | | n/a | | | |
| P51 | General availability and closeout | not started | | | | n/a | | | |

---

## P02 — enumerated score changes

Required by P02's own acceptance rule: *"score changes are explicitly enumerated;
no unexplained golden update is accepted."* No test fixture changed, so this list is
the enumeration.

Before P02 one SQL predicate OR'd exact UEIs with reviewed names. Each rail now
reads under exactly one basis. Four categories of client are affected:

| # | Client shape | Change | Direction |
|---|---|---|---|
| 1 | Has own UEI **and** contracting/assistance mappings whose names matched other entities | Name-matched rows are no longer read | history **shrinks** |
| 2 | Has contracting mappings whose `federal_contractor.uei` is populated | The verified UEI is now read — it never was, because `externalId` is a `federal_contractor` UUID and was fed to a UEI check that always failed | history **grows** |
| 3 | Only contracting mapping has `matchBasis` of `fuzzy_name` or `legacy_unrecorded` (or null), **and** no resolvable `federal_contractor.uei` | Contributes nothing | history **empties** |
| 4 | Contract rail UEI-identified, assistance rail name-identified (or vice versa) | Each rail is labeled independently instead of sharing one unlabeled channel | provenance only |

**Category 3 is the one to watch before enabling any schedule.** `matchBasis` is
nullable and, per its own schema comment, *every* row predating the column is
unrecorded — so a large share of existing confirmed `contracting` mappings may have
a null basis. Those lose their name fallback. The mitigating fact is that the same
rows carry a `federal_contractor` id, so any of them whose contractor row has a UEI
moves to category 2 and gets *better* evidence instead. The split between 2 and 3
cannot be predicted from the code; it needs a dry-run comparison on real data,
which the runbook already requires before a schedule is enabled.

Nothing scores *differently on the basis itself* yet — `identityBasis` is carried on
the profile and rendered in P09. Changing signal strength is a scoring change and
was deliberately kept out of an identity phase.

## Out-of-scope observations

Recorded, not acted on. The same OR'd UEI/name award-history predicate P02 removed
from Funding Opportunities still exists in:

- `apps/api/scripts/generate-grant-opportunity-candidates.ts` (District Nexus
  compatibility producer — explicitly a separate rail)
- `apps/api/src/district-nexus/district-nexus.service.ts`
- `apps/api/src/district-nexus/district-nexus-relationships.service.ts`
- `apps/api/src/intelligence/intelligence.service.ts`

Each has the same weakness: a reviewed name acts as an equal-strength identifier.
Out of this program's scope, but they will disagree with Funding Opportunities about
a client's award history until they are changed.

## Deviations from the plan

Recorded here rather than discovered later.

| Date | Deviation | Reason | Consequence |
|---|---|---|---|
| 2026-08-06 | P00–P10 are being executed as **sequential commits on one branch** (`agent/fo-p00-baseline-freeze`), not one PR per phase as §6.1 requires. | Explicit user instruction. | The per-phase independent-review gate (§6.2, §6.3) cannot run between phases, so a defect introduced in an early phase is not caught before later phases build on it. Review is deferred to one review of the whole range. The `Review` column stays empty for P00–P10 until that happens — it is not satisfied by this branch's CI being green. |
| 2026-08-06 | P00's boundary tests are largely **pre-existing**. `funding-opportunities.boundaries.spec.ts` (75 tests) already covered the flag, portal denial, migrations and RLS before this program began. | Prior remediation work (PR #692) built them. | P00 added the frozen *contract* fixture and the shapes/vocabularies/floor checks that were missing, rather than duplicating what existed. |
| 2026-08-06 | **P01 changes producer behavior.** Its two acceptance criteria — "byte-equivalent grant/SAM profile" and "existing scoring tests pass unchanged" — could not both hold, because the three profile sites did not agree at the baseline. Resolved on explicit user decision: unify on the **read path**. | The SAM producer built contract award-history identity from confirmed `contracting` mapping UEIs only and never selected `Client.uei`; the read path used both. So a client holding its own UEI with no confirmed contracting mapping had prior-agency history on screen that the nightly job could not reproduce, and the producer would decline to suggest a notice the page scored highly. The read path is what a user sees, so the producer was the side that was wrong. | The SAM producer now resolves more prior-agency history, so **more notices clear the suggestion floor and a future run will create more suggestions**. No data impact yet: all four schedules remain `enabled: false` and dry-run is still the default. Both producers also now issue 2 bounded award-history queries per client instead of 1, because each builds the whole versioned profile so the three sites are byte-comparable. |
| 2026-08-06 | P01 did **not** touch `apps/api/tsconfig.funding-opportunities.json`, though the plan lists it. | The three new modules live under `src/`, which the ordinary `apps/api` typecheck already covers, and the producers pull them in transitively. That config exists only because `apps/api/tsconfig.json` excludes `scripts`; no new script was added. | If a later phase adds a new *script*, it must be appended to that `include` list or nothing typechecks it. |

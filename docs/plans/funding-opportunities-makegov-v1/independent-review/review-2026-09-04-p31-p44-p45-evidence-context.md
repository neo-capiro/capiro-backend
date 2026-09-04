# Band B — the evidence / context composition cluster (P31, P44, P45)

**Review type:** independent §6.2 review, per the convention in
`docs/runbooks/phase-2-independent-live-validation.md` — a different reviewer than the
implementer, read-only verification, a verdict that is exactly one of two strings per
phase plus one for the cross-phase seam, and a dated approval record.

**Reviewer:** Claude, general-purpose subagent (runtime reports model `claude-fable-5-1`).
Did not implement P31, P44 or P45; did not author decision-log D-82, the completion-matrix
rows for these phases, `HANDOFF-2026-08-19-closeout.md`, or any prior review in
`independent-review/`.

**Commit under review:** `origin/main` @ `1c7ed27fa82e171b7d9259f6c94d49e360cae985`, read
from the worktree `C:\dev\capiro-review-p31p44p45`. `git rev-parse HEAD` matched the pin and
`git status --short --untracked-files=all` was empty before the review and again at the end
(§8). Every `file:line` below is against that SHA. Implementer branches
`origin/agent/fo-p31-requirements` (`77605577b`), `origin/agent/fo-p44-budget-context`
(`f32d7e91e`) and `origin/agent/fo-p45-risk-context` (`34cddb7c3`) were read for lineage
only; nothing was checked out from them.

**Read-only.** No source edit, no commit, no push, no PR, no AWS write, no flag change, no
secret value read or printed. The only AWS actions were `describe-tasks`,
`logs get-log-events`, and **one** `ecs run-task` of the standing read-only diagnostic
task-def `capiro-dev-api-diag:8`, whose override runs `SELECT`s only inside one
transaction (transcript in §7). `pnpm install --frozen-lockfile --prefer-offline` and
`prisma generate` were run in the worktree so the phase specs could execute; both write
only to gitignored paths (`.gitignore:2 node_modules/`), and the tree was re-verified clean.
**No browser automation was available to this reviewer** — every UI statement below is
reasoned from component source and the component tests, not from a rendered page, and is
labelled as such.

**Scope.** Three phases the 2026-08-13 banded review did not cover, clustered by the wave
plan as "evidence / context composition": **P31** (evidence-bound requirement extraction
artifact, flag `funding_opportunities_documents`), **P44** (Tango budget beta context,
flag `funding_opportunities_budget_context`), **P45** (protest and exclusion risk context,
flag `funding_opportunities_risk_context`). The brief's specific questions — D-82's four
claims, the PR #1115 gate, web↔API agreement on which sources support requirements, the
provenance contract, tenant safety, and whether any phase has a live-verifiable success
assertion — are each answered in §3.

---

## 1. Verdicts

```
P31_REJECTED
P44_INDEPENDENTLY_APPROVED
P45_REJECTED
BAND_B_EVIDENCE_CONTEXT_SEAM_REJECTED
```

The permitted strings are `P<nn>_INDEPENDENTLY_APPROVED` / `P<nn>_REJECTED` per phase and
`BAND_B_EVIDENCE_CONTEXT_SEAM_INDEPENDENTLY_APPROVED` / `_REJECTED` for the seam.

**P31 is rejected on scope and on a false matrix claim, not on the quality of the code that
exists.** The code that exists is the best-designed of the three (a CHECK constraint ties the
excerpt to its span; the review table is live under FORCED RLS with all four policies; every
empty state names its kind). But the plan's named primary deliverable
`apps/api/scripts/extract-opportunity-requirements.ts` has **never existed on any branch**,
nothing else writes `opportunity_requirement`, the table holds **0 rows live**, the plan's
"review/accept/reject" work item has no write path, and the matrix row's rollback cell
("Flag `funding_opportunities_documents` off") is **false live** — the flag is `enabled=true`
for 7 of 8 tenants against a P29→P30→P31 chain that has never produced one row (F-1, F-2,
F-3).

**P44 is approved as code, in the state D-82 describes: dark, data-blocked, flags off for
every tenant.** Every plan acceptance line has a passing test behind it, the empty-catalog
state is the honest `not_synced`, the flag-off state renders nothing and issues no request,
the matrix row is accurate on every fact this review could check, and D-82's four claims all
hold (§3.1). This approval is a verdict about the code and its dark posture. **It is not a
live validation of the panel — no such validation is possible (§3.9).**

**P45 is rejected on one Medium seam defect that is invisible from inside P45 and obvious
the moment it is read against P44:** the risk service has no "never synced" state. With the
flag on and its two tables at 0 rows — the exact state they are in today — it answers
`state: 'available'`, exclusion `none_observed`, `protests: []`, and the panel prints
"Capiro has observed no protest naming this client's UEI", which is the sentence D-82's own
rationale says an analyst will read as "Capiro looked" (F-4). The budget service two files
away contains a comment that says these are "TWO different facts, and they must not
collapse." Everything else in P45 is well built and tested, and the flag is off everywhere,
so there is no live exposure today; the rejection is narrow and the fix is ~20 lines plus
one test.

**The seam is rejected on the same finding**, because it is a seam property: three panels
compose three different provenance vocabularies (§3.6) and only one of them models the
fact that matters most in a program whose data has not arrived.

| # | Sev | Phase | One line |
|---|-----|-------|----------|
| **F-1** | **High** | P31 | The plan's extraction script never existed; there is no writer of `opportunity_requirement` anywhere; 0 rows live. The "canary one document" ship step was never possible. |
| **F-2** | **High** | P31 | Matrix row says the documents flag is off. Live: `enabled=true` for 7/8 tenants (all but `abramoff`), bulk-created 2026-08-24, against `opportunity_attachment`=0, `opportunity_document_text`=0, `opportunity_requirement`=0. No decision-log entry records the enablement. |
| **F-3** | **Medium** | P31 | "Add review/accept/reject for high-impact requirements" is not implemented: no POST/PATCH route, no write verb in the service; the RLS'd review table has no writer. |
| **F-4** | **Medium** | P45 (seam) | No `not_synced` analogue. An empty catalog collapses into `none_observed` / "observed no protest" — the collapse P44 explicitly refuses and P33 separates as `not_wired` vs `empty`. Spec `:435` tests the caveat but never asks whether the catalog was ever populated. |
| **F-5** | **Low** | P31 (seam) | "Which sources support requirements" is a bare `'sam_gov'` literal in three files (pages `:71`, vnext `:39`, API `:118`), with no shared constant and no API-side test of the 400 refusal. Drift would surface as the exact "Requirements failed to load" PR #1115 fixed. |
| **F-6** | **Low** | all three | The three `apps/web/src/vnext/**` panels have **zero tests**; the 41 panel tests all target `apps/web/src/pages/**`. PR #1115 had to apply the same fix twice — the duplication is the drift vector. |
| **F-7** | **Low** | P44 | Plan work item "Store provider federal-account × fiscal-year snapshots" has no implementation; the mapper is pure and has no caller outside its spec. Not a defect in what exists — the scope gap D-82 records, stated here as a finding so the matrix carries it. |

---

## 2. What was and was not trusted

- **Trusted after verification:** the pin SHA; the file inventory; the guard, controller,
  service, panel and migration source read directly; the test names and (§6) test results;
  live `capiro-dev` row counts, RLS state, flag rows and tenant list from one read-only
  diagnostic.
- **Treated as claims and tested:** D-82's four assertions (§3.1); the completion-matrix
  rows for P31/P44/P45 (§3.1, F-2); `HANDOFF-2026-08-19-closeout.md` §2 (superseded by this
  review — its "0 rows / no ingestion path" observation is confirmed, its "code is real and
  tested" is confirmed for P44 and qualified for P45 by F-4); the brief's own premises (§2.1).
- **Not trusted and not used:** any rendered UI — none was observable; every UI statement
  is from source + component tests. Prose comments in code were read as intent, never as
  evidence that the intent holds.

### 2.1 Correcting the brief's premises

1. **"P44/P45 compose vendor data into the opportunity detail view."** Partly. The panels
   *mount* on the opportunity detail page (pages `FundingOpportunityDetail.tsx:343,350`;
   vnext `:274,279`) but the API routes and services are **keyed on the client, not the
   opportunity** — `GET /intelligence/clients/:clientId/budget-context` and
   `/risk-context` (`funding-opportunities.controller.ts:748,769`), with the controller
   comment stating there is no source-backed key from a notice to a Treasury account. The
   `clientId` comes from the detail page's `?clientId=` query param (`:568`). So these are
   client-posture panels shown beside an opportunity, and every response says so
   (`noticeLinkage.linked: false`).
2. **"P31 may have a live-verifiable success assertion — a real SAM.gov opportunity with
   extracted requirements in capiro-dev."** **No.** `opportunity_requirement` has 0 rows
   live, and there is no code anywhere at the pin (or on any branch) that could create one
   (F-1). P31 is data-blocked in the same sense as P44/P45 — more so, because P44/P45 at
   least have mappers ready for a producer, while P31 has no extractor at all.
3. **"Flags must be off for every tenant" (P44/P45).** Confirmed, and stronger than stated:
   there is **no row at all** for either feature in `intel_feature_flag` for any of the 8
   tenants, and the guard requires an explicit `enabled=true` row per tenant including
   `capiro-internal` (`funding-opportunities-flag.guard.ts:178-181, 223`), so absence is
   off.
4. **The brief's file path `apps/api/src/funding-opportunities/**requirements**`** exists
   (`requirements/opportunity-requirement.{schema,service,spec}.ts`); the API "agrees" with
   the web on `sam_gov` — but by independent literal, not by shared contract (F-5).

---

## 3. Findings in detail

### 3.1 D-82's four claims — all four hold

| D-82 claim | Result | Evidence |
|---|---|---|
| Four tables at 0 rows | **Confirmed live** | diag: `tango_budget_account`=0, `tango_budget_vendor_flow`=0, `tango_procurement_protest`=0, `tango_entity_exclusion`=0 (§5) |
| No ingestion path anywhere in the codebase | **Confirmed by repo search** | Only 5 non-test files mention the four models/tables: `external/tango/tango-budget.mapper.ts`, `tango-risk.mapper.ts` (pure — `import type { Prisma }` only, no client), `opportunity-budget-context.service.ts`, `opportunity-risk.service.ts` (readers), `scripts/diag-funding-opportunities-makegov.ts:194-195` (row counts). Zero `.create/.upsert/.createMany`, zero `INSERT INTO`, zero mentions in `infra/cdk/lib/*.ts`, no `entrypoint-dispatcher.inc` verb. |
| Flags off for every tenant | **Confirmed live** | 0 rows for `funding_opportunities_budget_context` or `funding_opportunities_risk_context` across 8 tenants; guard `:223` 404s on `!enabled`; web `useIntelFeature` returns `Boolean(data?.[feature])` → `false` (`apps/web/src/lib/intel-feature-flags.ts:57`) |
| Code-complete, tested, wired | **Confirmed for P44; qualified for P45 by F-4** | §6 test runs; controller routes `:748-754, :769-775`; panels mounted (§2.1 item 1) |

D-82 also says "Nothing about the implementation is wrong." **F-4 corrects that for P45.**
D-82 remains correct as a *decision*: the flags must stay off, and F-4 adds one code
precondition to "turning them on requires building ingestion first."

### 3.2 F-1 (High, P31) — no producer, 0 rows, the canary was never possible

- Plan §P31 "Primary files" lists `apps/api/scripts/extract-opportunity-requirements.ts NEW`
  and "Ship and rollback: Migration then canary one document."
- `ls apps/api/scripts | grep -i requirement` → nothing.
  `git log --oneline --all -- apps/api/scripts/extract-opportunity-requirements.ts` →
  nothing: the file has never existed on any ref.
- `git show --stat 77605577b` (the P31 implementer commit) lists 16 files: migration,
  schema, guard, controller, module, `requirements/*.{schema,service,spec}.ts`, the pages
  panel + test + api client + css, and a CI workflow. **No script.**
- Repo-wide writer search: `opportunityRequirement.(create|upsert|createMany|update)`,
  `opportunityRequirementReview.(create|upsert|update)`, `INSERT INTO "?opportunity_requirement`
  → nothing outside migrations/specs. `opportunity-requirement.service.ts` contains no
  `create`/`upsert`/`update(`.
- Live: `opportunity_requirement`=0, `opportunity_requirement_review`=0. Upstream:
  `opportunity_attachment`=0 (P29), `opportunity_document_text`=0 (P30). P29
  (`sync-tango-opportunity-attachments.ts`) and P30 (`sync-tango-opportunity-text.ts`, per
  `git show --stat ec329ff4d`) do have runnable verbs, but nothing in
  `infra/cdk/lib/ingestion-schedule.ts` mentions attachments or document text, and neither
  has ever produced a row.
- Consequence: the plan's acceptance items that need data ("re-extraction on unchanged
  bytes is idempotent", "a changed attachment invalidates prior active candidates") are
  proven only at the schema level (spec `:352`, migration CHECKs), never by an extraction.

### 3.3 F-2 (High, P31) — the matrix's rollback cell is false live

- `completion-matrix.md:102` (P31 row), last cell: "Flag `funding_opportunities_documents`
  off". Same for P29 (`:100`, "shared with P30/P31").
- Live `intel_feature_flag` rows for `funding_opportunities_documents`, joined to `tenants`
  on `t.id::text = f.tenant_id`: `enabled=true` for **c2-strategies, victory-six-advisors,
  revere, dualsight, maven, prospering-solutions, capiro-internal** — 7 of 8 tenants; only
  `abramoff` has no row. All created `2026-08-24T13:02:1x Z` within one second of each other
  (a bulk enablement). `grep -n funding_opportunities_documents decision-log.md` → no entry.
- What an analyst sees, from source: the panel calls the API (flag on, `source==='sam_gov'`),
  the API finds 0 archived attachments and answers `coverage: 'no_documents'` with "No
  documents have been archived for this solicitation, so nothing has been read. This is not a
  statement that it has no requirements." (`opportunity-requirement.service.ts:180-184`),
  rendered at pages `:110-114` / vnext `:78-82`. **This is the honest empty state** — better
  than D-83's forecast case. But it is the D-82/D-83 shape exactly: a flag on for seven
  tenants in front of a pipeline that has never produced one row, and a matrix that says
  the opposite. The matrix is the document the wave told reviewers to read; a reader of
  `:102` would conclude the flag flip is still ahead.

### 3.4 F-3 (Medium, P31) — review/accept/reject has no write path

Plan §P31 Work: "Add review/accept/reject for high-impact requirements." The migration
creates `opportunity_requirement_review` with FORCED RLS and four policies (migration
`:236-267`; **live-confirmed** `relrowsecurity=true, relforcerowsecurity=true, policies=4`).
The only controller mention of "review" is a comment (`funding-opportunities.controller.ts:636`);
the only route is `GET opportunities/:source/:id/requirements` (`:639`). The service's only
review access is `readReviews` → `findMany` (`opportunity-requirement.service.ts:255-259`).
`grep -rn opportunityRequirementReview apps/api/src` excluding reads → nothing. The
RLS-protected table therefore has no legitimate writer; the four INSERT/UPDATE/DELETE
policies protect nothing that can happen.

### 3.5 F-4 (Medium, P45 + seam) — the risk service cannot say "never synced"

Budget service (`opportunity-budget-context.service.ts:190-208`):

```ts
if (flows.length === 0) {
  // TWO different facts, and they must not collapse. If the catalog has
  // never been populated the answer is "not synced"; if it has and this
  // client appears nowhere in it, the answer is "no flows found".
  const anyAccount = await this.prisma.withSystem((tx) => tx.tangoBudgetAccount.count({ take: 1 }));
  return anyAccount === 0 ? this.empty('not_synced', 'Capiro has not synchronized federal budget accounts yet, …') : this.empty('no_flows', …);
```

Risk service: `RISK_STATES = ['available','disabled','denied','no_client_identity']`
(`opportunity-risk.service.ts:47`) — no `not_synced`. The read at `:161-170` does
`findFirst({ where: { uei } })` and `findMany({ where: { protesterUei: uei } })` and proceeds
straight to `deriveExclusion(exclusionRow, asOf)` (`:171`). With `!row` that returns
`state: 'none_observed'`, "Capiro has not observed an exclusion record for this client. This
is not a clearance." (`:272-282`), and the top-level result is `state: 'available'` (`:175`).
The panel then renders the Exclusion tag + that sentence, and for protests "Capiro has
observed no protest naming this client's UEI. This is not a statement that none exists."
(pages `OpportunityRiskPanel.tsx:190-201`).

Both sentences are literally true. Neither distinguishes "Capiro has never asked the
provider" from "Capiro asked and the provider reported nothing" — the distinction P44 calls
two facts that must not collapse, P33 encodes as `not_wired` vs `empty`, and D-82's
rationale rests on ("it reads as 'Capiro looked and this client has no protests'"). The spec
comes close and stops: `opportunity-risk.spec.ts:435` "a client with no observation and no
protests still says 'not a clearance'" asserts the caveat, never the catalog's population.
The budget spec has the assertion P45 lacks: `opportunity-budget-context.spec.ts:406` "an
unsynced catalog says Capiro has not looked".

No live exposure today (flag off everywhere, §3.1). The day ingestion lands and the first
partial sync populates one table but not the other, this is the surface that misreports.
**Remediation:** add `not_synced` to `RISK_STATES`, mirror the `count({ take: 1 })` probe on
both tables before deriving, and add the `:406`-shaped test. Then re-review is a one-file
diff.

### 3.6 F-5 / F-6 (Low, seam) — one contract or three?

**Three.** No type in `packages/shared` describes any of these responses; each phase
defines its own in `apps/web/src/pages/intelligence/opportunities/funding-opportunities-api.ts`
(budget `:1077-1120`, risk `:1134+`) mirrored by hand from the API's service types:

| | P31 | P44 | P45 |
|---|---|---|---|
| Provenance unit | per-row citation: excerpt + span + document + version + method + confidence band | per-account: source label, `lastSyncedAt`, attribution status/confidence | per-record: provider flag verbatim, `observedAt`, `sourceUrl`, outcome caveat |
| Empty vocabulary | `coverage`: `available / no_documents / no_text / read_none_found` | `state`: `available / disabled / denied / not_synced / no_client_identity / no_flows` | `state`: `available / disabled / denied / no_client_identity`; exclusion sub-state `none_observed / active / expired / unverified` |
| "Never synced" | `no_documents` (a Capiro gap, stated) | `not_synced` (stated) | **absent** (F-4) |
| Flag off, UI | explicit sentence, `fo-requirements-not-enabled` (pages `:95-100`) | returns `null` — no card, no request (`:157`; test `:235`) | returns `null` (`:131`; test `:274`) |
| Flag off, API | guard 404 | guard 404 **and** service re-checks and answers `state:'disabled'` (`:148-153`) | guard 404 **and** `state:'disabled'` (`:132-137`) |
| Source-support contract | `'sam_gov'` literal ×3 (F-5) | n/a (client-keyed) | n/a (client-keyed) |

They agree in *spirit* — every empty says which kind of empty — and disagree in *shape*.
The two P44/P45 "flag off → render nothing" choices are deliberate and tested ("not an empty
card"), and defensible under D-82; P31's "flag off → say so" is also deliberate and tested
(`:158`). The inconsistency is recorded, not penalised. F-4 is the one place the shape
difference changes what an analyst is told.

F-5 evidence: `OpportunityRequirementsPanel.tsx:71` (pages), `:39` (vnext), and
`opportunity-requirement.service.ts:118-124` (`if (source !== 'sam_gov') throw new BadRequestException`)
are independent literals. `OPPORTUNITY_SOURCES = ['grants_gov','sam_gov']` exists at
`funding-opportunities.types.ts:53` but there is no "supports requirements" subset anywhere
(`grep -rn "REQUIREMENT.*SOURCE|SOURCES_WITH_REQUIREMENTS|supportsRequirements"` over
`apps/api/src`, `packages/shared/src` → only the two panels). The API spec never mentions
`sam_gov`, `grants_gov`, `BadRequest` or `getRequirements` — the refusal the web relies on
(test `:166` says so in a comment) is untested on the side that owns it.

F-6 evidence: `grep -rl "OpportunityRequirementsPanel|OpportunityBudgetContext|OpportunityRiskPanel" apps/web/src/vnext --include=*.test.tsx` → nothing.

### 3.7 PR #1115 gate — verified at the pin

`96355d3ca` is an ancestor of the pin (`git merge-base --is-ancestor` → yes). Both panels
carry `const supportsRequirements = source === 'sam_gov'`, gate the query with
`enabled: flag.ready && flag.enabled && supportsRequirements`, and render
`fo-requirements-not-supported` before `isPending`/`isError` (pages `:71,79,92-99`; vnext
`:39,47,60-67`). Order matters and is correct: `!flag.ready` → skeleton; `!flag.enabled` →
not-enabled sentence; `!supportsRequirements` → not-supported sentence; then pending/error;
then `requirements.length===0` → coverage sentence. The pages test `:166` asserts the
not-supported path never calls the API and never shows the error alert.

### 3.8 Tenant safety — nothing unsafe found

- **P44/P45:** actor tenant → `readVisibleClientIds` under `withTenant`
  (budget `:159-160`, risk `:142-143`); a client outside the visible set gets `denied` with
  the same sentence a missing one gets (tests budget `:451`, risk `:444`); the client's UEI is
  read under `withTenant` (`:277-278`, `:149-150`); only then do the global reads run under
  `withSystem`, keyed on that UEI alone (tests budget `:483`, risk `:122`). The four tango
  tables have no `tenant_id` and no RLS **by design** (migration comments `:27` / `:54`,
  "WHY GLOBAL, WITH NO tenant_id AND NO RLS") — **live-confirmed** `rls=false, policies=0` on
  all four, and they hold public provider-catalog data only. Portal users are denied before
  any client read (budget `:444`).
- **P31:** `opportunity_requirement` is global by design (public-document facts, no
  tenant_id — live `rls=false`); `opportunity_requirement_review` is tenant-scoped —
  **live** `tenant_id` present, `rls=true, force=true, policies=4`. A requirement with no
  review for this tenant reads `pending` (controller comment `:636-637`; `readReviews` under
  `withTenant` `:257`).

### 3.9 Does each phase have ANY live-verifiable success assertion?

| Phase | Success assertion (positive, live) | Structural / negative assertions that ARE live-verifiable and were made |
|---|---|---|
| **P31** | **None.** 0 rows, no producer (F-1). | Review table FORCED RLS + 4 policies (live); requirement table global (live); documents flag row per tenant (live, F-2). An authenticated `GET …/opportunities/sam_gov/<id>/requirements` on a documents-enabled tenant *should* answer `coverage:'no_documents'` — a live-verifiable **empty**-state assertion this reviewer could not execute (no auth/browser path) and reasons from `:180-184`. |
| **P44** | **None, and none possible** (0 rows, no ingestion). | Tables exist (`to_regclass`, live); 0 rows (live); no flag row for any tenant (live) ⇒ guard 404 on every tenant; `not_synced` is the answer the service would give if the flag were on (`:196-202`). |
| **P45** | **None, and none possible.** | Same as P44; plus F-4 — the answer it *would* give with the flag on is `available`/`none_observed`, not a not-synced state. |

---

## 4. Plan acceptance, line by line

**P31** (plan `:2036-2043`): schema rejects evidence-less assertions — spec `:75,:327`,
migration CHECK `:137-152` (`length(source_excerpt) = excerpt_end - excerpt_start`) ✔;
adversarial instruction changes nothing — spec `:216` ✔; quotes bounded and match — spec
`:141,:153,:162`, CHECK `:152` ✔; idempotent re-extraction — spec `:352` (by construction,
never by extraction) ◐; changed attachment invalidates — schema/spec only ◐; RLS/audit
tests — spec `:359,:367,:373` ✔ and live ✔. Work items: extraction script ✘ (F-1);
review/accept/reject ✘ (F-3). Ship: "canary one document" ✘ never possible.

**P44** (plan `:2724-2731`): forbids canonical PE writers — spec `:139` ✔; cannot overwrite
Capiro budget values — spec `:154` ("no write verb at all") ✔; null and stale visible — spec
`:189,:458` ✔; account/FY mismatches fail closed — spec `:336,:361` ✔; UI separates
federal-account execution from PE — pages test `:122` ("Program Element appears only in the
sentence denying it") ✔. Ship: "canary shadow panel only" ✘ never possible (F-7).

**P45** (plan `:2775-2782`): same-name entities don't inherit — UEI-only, spec `:122,:130,:138`
✔; expired never active — spec `:171,:181` ✔; protest outcome source-backed — spec `:284,:292`
✔; no legal-advice wording — spec `:367`, pages test `:96` ✔; migration/RLS/provenance —
spec `:399,:419` ✔. Plan Work line "absence of exclusion evidence is not proof of good
standing" ◐ — the caveat is present, the never-synced fact is not (F-4).

---

## 5. Live diagnostic — facts

One read-only Fargate task (`capiro-dev-api-diag:8`, task `beee935c413b4ba2975b8104e9974817`,
exit 0, log stream `/capiro/dev/api` `diag/db-inspect/beee935c413b4ba2975b8104e9974817`),
one transaction, `set_config('app.bypass_rls','on',true)` then SELECTs only:

- `exists` (via `to_regclass`): all of `tango_budget_account`, `tango_budget_vendor_flow`,
  `tango_procurement_protest`, `tango_entity_exclusion`, `opportunity_requirement`,
  `opportunity_requirement_review`, `opportunity_document_text`, `opportunity_attachment`,
  `intel_feature_flag`, `tenants`, `clients`.
- `counts`: **all eight data tables = 0.**
- `rls`: `opportunity_requirement_review` rls=true force=true policies=4; the other five
  rls=false policies=0.
- `tenant_id` columns: only `opportunity_requirement_review`.
- `intel_feature_flag` columns: `id text, feature text, tenant_id text, enabled boolean, created_at timestamp`.
- 8 tenants: abramoff, c2-strategies, capiro-internal, dualsight, maven,
  prospering-solutions, revere, victory-six-advisors.
- `funding_opportunities_budget_context` / `funding_opportunities_risk_context`: **0 rows.**
- `funding_opportunities_documents`: `enabled=true` for 7 tenants (all but abramoff).
- FO features present in the table: `funding_opportunities`, `_client_inbox`, `_documents`,
  `_forecasts`, `_government_landscape`, `_meri_v2`, `_notice_history`, `_pipeline_v2`,
  `_sbir`, `_vehicle_fit`. (Neither P44 nor P45's flag has ever had a row.)

---

## 6. Test health at the pin

**API** — `pnpm --filter @capiro/api exec prisma generate` (exit 0) then
`pnpm --filter @capiro/api exec jest src/funding-opportunities/requirements/opportunity-requirement.spec.ts src/funding-opportunities/opportunity-budget-context.spec.ts src/funding-opportunities/opportunity-risk.spec.ts --forceExit`:
**3 suites, 100 tests, 100 passed, 0 failed** (11.3 s). Two lines
`Error: 42883 operator does not exist: text = uuid` appear in the log between suites; they
are console output from the deliberate "a throwing flag read fails closed" tests (budget
`:439`, risk `:444`) exercising the path the guard comment at `:164-172` describes, not
failures.

**Web** — `pnpm --filter @capiro/web exec vitest run src/pages/intelligence/opportunities/OpportunityRequirementsPanel.test.tsx src/pages/intelligence/opportunities/OpportunityBudgetContext.test.tsx src/pages/intelligence/opportunities/OpportunityRiskPanel.test.tsx --pool=forks --no-file-parallelism`:
**3 files, 41 tests, 41 passed, 0 failed** (77.5 s; Requirements 11, Budget 15, Risk 15).
All 41 target `apps/web/src/pages/**`; none renders a `vnext/**` panel (F-6).

Nothing in this review is a failing test. Every finding is a gap in what exists (F-1, F-3,
F-7), in what the tests assert (F-4, F-5, F-6), or in a document's claim about live state
(F-2).

---

## 7. Reproducible transcript (abridged; every command read-only)

```bash
# pin + cleanliness
git -C C:/dev/capiro-review-p31p44p45 rev-parse HEAD            # 1c7ed27fa82e171b7d9259f6c94d49e360cae985
git -C C:/dev/capiro-review-p31p44p45 status --short --untracked-files=all   # (empty)
git merge-base --is-ancestor 96355d3ca HEAD && echo ancestor   # ancestor

# P31 producer / writer search (all empty except readers, mappers, one diag counter)
ls apps/api/scripts | grep -i requirement
git log --oneline --all -- apps/api/scripts/extract-opportunity-requirements.ts
grep -rn "opportunityRequirement\.\(create\|upsert\|createMany\|update\)\|INSERT INTO \"\?opportunity_requirement" apps packages | grep -v "spec\|test\|migrations/"
grep -rn -i "tangoBudgetAccount\.\(create\|upsert\|createMany\)\|tangoProcurementProtest\.\(create\|upsert\)\|tangoEntityExclusion\.\(create\|upsert\)\|tangoBudgetVendorFlow\.\(create\|upsert\)" apps packages infra
grep -rl -i "tango_budget_account\|tangoBudgetAccount\|tango_procurement_protest\|tangoProcurementProtest\|tango_entity_exclusion\|tangoEntityExclusion\|tango_budget_vendor_flow" apps packages infra scripts | grep -v "node_modules\|spec\|test\|migrations/\|schema.prisma"
grep -rn -i "attachment\|extracted-text\|document" infra/cdk/lib/ingestion-schedule.ts

# contract literals
grep -rn "supportsRequirements" apps/web/src apps/api/src
grep -n "sam_gov" apps/api/src/funding-opportunities/requirements/opportunity-requirement.service.ts
grep -n "sam_gov\|grants_gov\|BadRequest\|getRequirements" apps/api/src/funding-opportunities/requirements/opportunity-requirement.spec.ts   # (empty)
grep -rl "OpportunityRequirementsPanel\|OpportunityBudgetContext\|OpportunityRiskPanel" apps/web/src/vnext --include=*.test.tsx            # (empty)

# live (profile capiro-dev, us-east-1) — the only run-task; SELECT-only JS in the override
aws ecs run-task --cluster capiro-dev --task-definition capiro-dev-api-diag:8 --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}' \
  --overrides file://<scratchpad>/diag-override.json
aws ecs describe-tasks --cluster capiro-dev --tasks <arn> --query 'tasks[0].[lastStatus,stoppedReason,containers[0].exitCode]'   # STOPPED  Essential container in task exited  0
aws logs get-log-events --log-group-name /capiro/dev/api --log-stream-name diag/db-inspect/beee935c413b4ba2975b8104e9974817 --start-from-head
```

The override's JS (verbatim; it prints no env value):

```js
(async()=>{
 process.env.DATABASE_URL=`postgresql://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASSWORD)}@${process.env.DB_HOST}:${process.env.DB_PORT}/capiro?schema=public`;
 const {PrismaClient}=require('@prisma/client'); const p=new PrismaClient(); const out={};
 await p.$transaction(async(tx)=>{
   await tx.$queryRawUnsafe(`SELECT set_config('app.bypass_rls','on',true)`);
   const tables=['tango_budget_account','tango_budget_vendor_flow','tango_procurement_protest','tango_entity_exclusion','opportunity_requirement','opportunity_requirement_review','opportunity_document_text','opportunity_attachment','intel_feature_flag','tenants','clients'];
   out.exists={}; for(const t of tables){ const r=await tx.$queryRawUnsafe(`SELECT to_regclass($1)::text AS r`,'public.'+t); out.exists[t]=r[0].r; }
   out.counts={}; for(const t of tables.slice(0,8)){ if(out.exists[t]){ const r=await tx.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "${t}"`); out.counts[t]=r[0].c; } }
   out.rls=await tx.$queryRawUnsafe(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policies pp WHERE pp.tablename=c.relname) AS policies FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('tango_budget_account','tango_budget_vendor_flow','tango_procurement_protest','tango_entity_exclusion','opportunity_requirement','opportunity_requirement_review') ORDER BY 1`);
   out.tenant_id_cols=await tx.$queryRawUnsafe(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN (...same six...) AND column_name IN ('tenant_id','tenantId') ORDER BY 1`);
   out.ff_cols=(await tx.$queryRawUnsafe(`SELECT column_name||':'||data_type AS c FROM information_schema.columns WHERE table_name='intel_feature_flag' ORDER BY ordinal_position`)).map(x=>x.c);
   out.flags_fo=await tx.$queryRawUnsafe(`SELECT f.*, t.slug AS tenant_label FROM intel_feature_flag f LEFT JOIN tenants t ON t.id::text=f.tenant_id WHERE f::text ILIKE '%funding_opportunities_%' ORDER BY 1`);
   out.tenant_count=(await tx.$queryRawUnsafe(`SELECT count(*)::int AS c FROM tenants`))[0].c;
   out.tenants=await tx.$queryRawUnsafe(`SELECT id::text AS id, slug AS label FROM tenants ORDER BY 2`);
 });
 console.log('DIAG_OK '+JSON.stringify(out,(k,v)=>typeof v==='bigint'?Number(v):v)); await p.$disconnect();
})().catch(e=>{console.error('DIAG_ERR',String(e&&e.message||e));process.exit(1);});
```

---

## 8. Recommended matrix edits (for the wave owner — this review edits nothing)

- **P31 row (`:102`)** Review cell → `P31_REJECTED` (this file). Rollback cell → replace
  "Flag `funding_opportunities_documents` off" with the live fact (on for 7/8 tenants since
  2026-08-24; honest `no_documents` empty state; no extractor exists). Add F-1/F-3 to the
  Deviations table. Consider a decision-log entry recording who enabled the documents flag
  and why, or turning it back off under the D-82 rationale.
- **P44 row (`:115`)** Review cell → `P44_INDEPENDENTLY_APPROVED (as code; dark; D-82)`.
- **P45 row (`:116`)** Review cell → `P45_REJECTED` (F-4, narrow). Add F-4's fix to D-82's
  preconditions for ever enabling the flag.
- **§6.2 gap row (`:123`)** remove P31, P44, P45 from the uncovered list.
- **D-82** append: "Independent review 2026-09-04 confirmed all four claims live and by repo
  search; found one implementation gap in P45 (no not-synced state) that must be fixed
  before the flag is ever enabled."

---

## 9. Approval record

| Field | Value |
|---|---|
| Date | 2026-09-04 |
| Reviewer | Claude, general-purpose subagent (`claude-fable-5-1`); not the implementer of P31, P44 or P45 |
| Pin | `1c7ed27fa82e171b7d9259f6c94d49e360cae985` (`origin/main`) |
| Worktree | `C:\dev\capiro-review-p31p44p45` — `git status --short --untracked-files=all` empty at start and at end; `git rev-parse HEAD` unchanged. No probe file was written inside the worktree; the diagnostic JS and override JSON live only in the session scratchpad. `node_modules/` and the generated Prisma client are gitignored. |
| Live access | `capiro-dev`, `us-east-1`, profile `capiro-dev`: one `ecs run-task` of `capiro-dev-api-diag:8` (SELECT-only), `describe-tasks`, `logs get-log-events`. No write of any kind; no secret value read into this transcript. |
| Disposable Postgres | none created — every schema fact needed was read from the migration SQL or confirmed live. `docker ps -a --filter name=capiro-p31p44p45-review-pg` → empty. |
| Browser | none available; UI behaviour reasoned from source and component tests only, and labelled so throughout. |
| Verdicts | `P31_REJECTED` · `P44_INDEPENDENTLY_APPROVED` · `P45_REJECTED` · `BAND_B_EVIDENCE_CONTEXT_SEAM_REJECTED` |
| Tests at pin | API 3 suites / 100 passed; web 3 files / 41 passed (§6) |
| Supersedes | the informal P44/P45 check in `HANDOFF-2026-08-19-closeout.md` §2 |

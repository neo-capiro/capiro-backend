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
| P00 | Freeze the baseline and release gate | merged | `21d267db` (PR #769) | api 20/584, web 26/79, 0 skipped. Floor raised 19/500 → **20/575** | *pending* | n/a | n/a — no production code changed | Three mutations verified to fail a boundary test: `totalAmount` (required → compile error; optional → 2 assertion failures), null money → `0` (2 failures), internal-tenant flag fallback (1 failure). Zero skipped/todo in scope. | Revert the docs/tests/fixture commit and restore the 19/500 floor. No data rollback. |
| P01 | One shared client-opportunity profile builder | merged | `21d267db` (PR #769) | api 21/641, web 26/79, 0 skipped. Floor raised 20/575 → **21/630** | *pending* | n/a | n/a — schedules still disabled, dry-run still default | Byte-equivalent profile JSON + fingerprint proven across the read path and the batch producer read for 5 client shapes (thin, defense, grant, multi-entity, no-history). **One deliberate behavior change** — see below. | Revert the three new modules and restore the inline builders. No data rollback: nothing is persisted by this phase. |
| P02 | UEI-first award-history identity and labeled name fallback | merged | `21d267db` (PR #769) | api 22/672, web 26/79, 0 skipped. Floor raised 21/630 → **22/660** | *pending* | n/a | n/a — schedules still disabled | Score changes enumerated below. **Zero existing golden/fixture assertions changed**, because no pre-P02 fixture held a UEI and a name-bearing mapping at once — which is itself the reason the defect survived. | Revert code. No persisted human decision is touched; derived scores return to prior behavior on the next run. |
| P03 | Complete grant producer keyset walk | merged | `21d267db` (PR #769) | api 23/709, web 26/79, 0 skipped. Floor raised 22/660 → **23/700** | *pending* | n/a | n/a — schedule still `enabled: false`, dry-run still default | 4,001 grants x 501 clients: last row of BOTH dimensions evaluated, `completion=COMPLETE`, 2,004,501 pairs, zero errors. Resume starts strictly after the cursor. Query count bounded per page, and unchanged when the notice count doubles. No source text says "raise the cap". | Revert producer + producer-pagination.ts. Persisted suggestions intact; nothing is deleted. |
| P04 | Complete SAM producer keyset walk | merged | `21d267db` (PR #769) | api 23/717, web 26/79, 0 skipped. Floor raised 23/700 → **23/710** | *pending* | n/a | n/a — schedule still `enabled: false`, dry-run still default | 4,001 notices x 501 clients: last row of both dimensions evaluated, `completion=COMPLETE`, 2,004,501 pairs. Informational notices excluded at every page boundary (interleaved fixture, not just edges). Never orders by `responseDeadline`. Same completion vocabulary as P03, asserted. `SAM_OPPORTUNITY_SCAN_CAP` / `SAM_CANDIDATE_CLIENT_CAP` removed. | Revert producer. No data deletion; persisted suggestions intact. |
| P05 | Mapping governance hardening | merged | `21d267db` (PR #769) | api 24/748, web 26/81, 0 skipped. Floor raised 23/710 → **24/740** | *pending* | **n/a — no migration needed.** Every review/audit column already exists (`reviewStatus`, `reviewedBy`, `reviewedAt`, `rejectionReason`, `matchBasis`, `matchTier`, `relationshipType`, `rollUpAwards`). | API + web deploy together — the web fix and the DTO gate are two halves of one change | Body `id` rejected (DTO validation + web behavioural test, mutation-verified). Award-bearing confirm requires explicit relationship + roll-up **on the request**; reject requires a written reason. PATCH now `user_admin`; portal AND standard user denied. Cross-tenant → 404, no write. Prune script no longer erases rejections. | Revert API + web together. No schema change to roll back. Any mapping already confirmed keeps its recorded relationship/roll-up. |
| P06 | Deterministic recommendation contract | merged | `21d267db` (PR #769) | api 25/798, web 26/81, 0 skipped. Floor raised 24/740 → **25/790** | *pending* | n/a | API may deploy before web — the field is additive and nothing in the UI reads it yet | 2,304-row exhaustive sweep: every combination yields a valid result, and BOTH hard invariants hold on every row (closed/informational never `pursue`; unresolved eligibility never `pursue`). Stable under signal reordering. Reads the supplied `asOf`, never the wall clock. No raw camelCase key in any output string. | Revert the additive `recommendation` field and restore the P05 fixture keys. Nothing persisted, so no data rollback. |
| P07 | Human decision and next-action persistence | merged | `21d267db` (PR #769) | api 26/847, web 27/81, 0 skipped. Floor raised 25/790 → **26/840** | *pending* | `20260819010000_funding_opportunity_decisions` — **clean** replay from verified-empty pgvector:pg16 AND **ordered** upgrade from the prior FO schema, both green. Retry-as-no-op verified by re-running the SQL by hand. | Migration first, then API. Web unchanged (no UI reads it yet). | 6 additive nullable columns, no DEFAULT, no backfill. All 3 CHECKs proven against real Postgres to reject: an out-of-vocabulary decision, a machine state as a decision, a decision with no actor, a decision with no timestamp, an actor/timestamp with no decision, and a due date with no action. RLS still ENABLED + FORCED with exactly 4 policies. Pre-P07 API insert (omitting all 6 columns) still succeeds → rolling deploy safe. | Roll back code; LEAVE the columns. They are additive and nullable, the previous code ignores all six, and dropping them would destroy any decision already recorded. |
| P08 | Atomic review/pursuit task action | merged | `21d267db` (PR #769) | api 27/870, web 27/85, 0 skipped. Floor raised 26/840 → **27/865** | *pending* | n/a | **API and web MUST deploy together** — the page now calls a route that only exists after this commit | Rollback proven in both directions: a failing decision write discards the task, and a failing task insert never reaches the decision. Retry returns the SAME task (`reused: true`) and creates none. `review` and `pursuit` are separate keys. A non-pursuable notice is refused BEFORE any write, so no orphan task, and can still get a review task. Owner-outside-tenant rejected before any write. Task due date and opportunity next-action date are the same value. | Revert API + web together. Tasks already created keep their `sourceType`/`sourceId` tags and remain valid. |
| P09 | Human-readable match explanations | merged | `21d267db` (PR #769) | api 28/911, web 32/109, 0 skipped. Floors raised **28/905** (api) and **30/105** (web) | *pending* | n/a | Web may deploy after API — the API change is a new pure module nothing else calls yet | A test sweeps EVERY signal key both scorers can emit and asserts none appears as visible card text; a second sweep asserts each has a label and each label names the matched value. Weak generic tokens read "Weak fit" even at relevance 99. Fit band comes from the strongest signal, not a count. Screen-reader label distinguishes fit from eligibility from workflow. Thin profile asserts no invented absence. | Revert the web card + mirror and the API module. No data or schema change. |
| P10 | Cross-client triage API | merged | `21d267db` (PR #769) | api 29/958, web 32/109, 0 skipped. Floor raised 28/905 → **29/950** | *pending* | n/a | API only; ships behind `funding_opportunities_client_inbox` which stays OFF | Ethical wall proven fail-closed: a walled client with no grant contributes no rows, and with no visible clients the row query is never issued at all. Compound `(sort, id)` cursor asserted as data — three disjuncts on an ASC deadline sort, the undated-region degeneration, strict `gt` never `gte`. Query count bounded and unchanged when rows double. Unreadable counts degrade to −1 with a reason, never to 0. Portal users denied. | Revert route + service + the inbox flag guard. The flag was never enabled, so nothing to turn off. |
| P11 | Client-first triage UI | merged | *pending commit* | api 29/971, web 41/155, 0 skipped. Floors raised **29/965** (api) and **40/150** (web) | *pending* | n/a | **API and web deploy together** — the inbox route gained two query parameters the new UI sends. Both flags stay OFF, so nothing is user-visible from the deploy itself. | Flag OFF is proven byte-identical to P10: no view switcher, no inbox request issued at all (asserted over every recorded GET). Flag ON lands on the inbox, not the catalog. Six queues render with counts; a −1 count renders `?`, never `0`. Every row names its client. Empty state distinguishes four causes (nothing anywhere / client filter / source filter / other queue full) from counts the API already returns. Error state is an explicit failure with retry, never an empty inbox. Tab, filter, page, queue, source and cursor all restored from the URL after a remount; changing a filter resets the page, changing a client drops a stale cursor. Server echoes the applied `clientId`, and a walled id is dropped rather than 404'd, so the chip cannot confirm a client the reader may not see. | Turn off `funding_opportunities_client_inbox`. The shell falls back to Explore even for a stale `?view=inbox` link, so no bookmark breaks. No data or schema change. |
| P12 | Deep-linkable opportunity detail shell | merged | *pending commit* | api 29/971 (unchanged — P12 is web-only), web 50/211, 0 skipped. Floor raised 40/150 → **49/205** (web) | *pending* | n/a | Web only. The detail route reads the existing `GET /opportunities/:source/:id`, which has been deployed since before P00. | Drawer and full page render the SAME component — the eight sections are asserted in both frames from one list. Every pending section states "Not yet available" and names what it will hold; the acquisition panel is asserted NOT to contain "cannot bid"/"not eligible"/"no access". Source gaps say "Not provided" (a source fact) and are asserted distinct from "Not yet available" (a product gap). Exactly one endpoint is called, asserted by URL equality, and a regex sweep proves no Tango/forecast/vehicle/attachment call. 404 ≠ transport failure: only the transport case offers Retry. Bad source in the path is refused with zero requests. Ref round-trip covers a record id containing `:` and `/`. Route registration asserted against the `/intelligence/*` catch-all, both directions. Escape, close button, focus containment, Back, and full-width-below-md all covered. | Revert the route and the two components. No data, schema or flag change; the endpoint they read predates this program. |
| P13 | Generic opportunity source identity bridge | merged | *pending commit* | api 29/1019, web 50/211, 0 skipped. Floor raised 29/965 → **29/1010** (api) | *pending* | `20260820010000_funding_opportunity_generic_source` — **clean** replay from a verified-empty pgvector:pg16 (0 tables before, asserted) AND **ordered** upgrade from the populated prior FO schema, both green. Retry-as-no-op verified by re-running the whole file by hand: 0 errors, state unchanged. | Migration first, then API. No web change. Both flags irrelevant — this is invisible. | **A real defect was found and fixed by the rehearsal** (decision-log D-18): the first CHECK admitted a row with a `source_record_key` and a NULL `source_record_type`, because `NULL = 'x'` is NULL and Postgres treats a NULL CHECK as satisfied. All 14 branches then re-proven by attempting the actual writes — 5 pass, 9 refused: cross-typed row, key-without-type, type-without-key, legacy source without its pointer, both pointers at once, future source with a pointer, future source without generic identity, source outside the vocabulary, duplicate generic identity. The same key on a different rail is correctly a different record. Ordered upgrade backfilled all 3 pre-P13 rows exactly (`source_record_key = legacy pointer`, 0 mismatches, 0 nulls) and left a `pursue`/`pursuing` human decision untouched. Old-code insert (no generic columns) succeeds both before and after the migration. | Roll back code; **leave the columns**. They are additive and nullable, old code ignores both, and the legacy pointers it reads were never touched. Dropping them would destroy the only identity a future-source row has. |
| P14 | Tango provider adapter and fixture harness | merged | *pending commit* | api 32/1116, web 50/211, 0 skipped. Floor raised **30/1015 → 32/1115** (api) | *pending* | n/a | No live call path exists; `TangoModule` registers unconditionally and boots identically with or without `TANGO_API_KEY`. | Import-boundary test proves the SDK is referenced in exactly one file (`tango.client.ts`) and reached through no other, sweeping both `src` and `scripts` and stripping comments so a doc comment mentioning the SDK cannot fail it. API boots and every method throws `TangoNotConfiguredError` (not an auth error) with no key. Every request shape audited against the SDK's real `explicitSchemas` — validated live, not asserted: the SDK rejects an invented field before issuing the request, so `tango.client.spec.ts` drives the actual SDK end-to-end with a fake `fetchImpl`, not a hand-rolled double. Every response mapper allow-lists to its shape (an unrequested field cannot enter a normalized object) and refuses to invent (money null-vs-zero, absence collapses to one representation, unparseable dates are null). Every error classified into 7 kinds with correct retryability; credential redaction proven against 5 leak shapes plus a depth-bomb; the raw SDK error is non-enumerable so no serializer can walk back to it. | Revert the dependency, the adapter directory, the jest transform carve-out, and the `TangoModule` import in `app.module.ts`. No data, schema, secret, or flag involved. |
| P15 | Tango snapshot, crosswalk, checkpoint, usage schema | merged | *pending commit* | api 33/1182, web 50/211, 0 skipped. Floor raised **32/1115 → 33/1180** (api) | *pending* | `20260821010000_tango_source_substrate` — **clean** replay from a verified-empty pgvector:pg16 (0 tables before) AND **ordered** upgrade from the populated prior schema, both green; retry-as-no-op verified by re-running the whole file by hand (0 errors, table count unchanged). | Apply migration; no code path writes until P19+. `TangoStoreService` is registered in `TangoModule` but called by nothing yet. | 4 new tables, all confirmed to carry no `tenant_id` and no RLS (same category as `federal_grant`/`sam_opportunity`) — the "no tenant RLS falsely claimed" criterion, both the positive case (RLS off) and its converse (RLS off is *correct* here, not a gap) proven against real Postgres. 23-case constraint proof by actual INSERT: the versioned-head partial-unique index blocked a direct attempt to create two active rows for one resource; the link table's local-type CHECK refused a tenant table by name; a rejected link's actor+timestamp CHECK refused an unattributed rejection; duplicate natural keys refused on all three unique-keyed tables. Service-level: an exact-repeat snapshot is a true no-op (byte-identical row, nothing written); changed content correctly supersedes the old head and versions up; `proposeLink` never resurrects a rejected link while `reviewLink` (an explicit human action) may reverse one — the durability-vs-correction distinction stated as a passing/failing test pair. A pre-existing CI gap (D-19, from P13) was found to still apply to this migration's own directory name and fixed before merging, not after. | Leave the four additive tables. Revert `tango-store.service.ts`/`tango.module.ts`'s registration of it if required — nothing depends on it yet. |
| P16 | Optional config and Secrets Manager wiring | merged | *pending commit* | api 34/1199 (this gate's scope; config.schema.spec.ts +9), infra-cdk 5/5 (new package, wired into ci-pr.yml), web unchanged. Floor raised **33/1180 → 34/1199** (api) | *pending* | n/a | Merged code only. The real `tango` secret ARN (created 2026-08-06, provided out-of-band) is now IN config.ts, but `cdk deploy` was not run this session — per the plan's own Ship note, live task-definition wiring waits until P17 is ready to use the key. | `infra/cdk`'s FIRST test suite (it had none): a real `Template.fromStack` synth proves `TANGO_API_KEY` is absent from every task definition when unconfigured, and present on the sync-jobs task ONLY (never serve/web/workspace/migrate/Meri) when the ARN is set — plus a regression check that the same is still true of the pre-existing LEGISTORM_API_KEY/CENSUS_API_KEY placement, proving the harness itself is trustworthy before trusting it on the new case. `TANGO_API_BASE_URL` rejects HTTP the same way every other provider URL in this schema does. App boots with the key unset (already proven in P14; unchanged by this phase). No secret value — only an ARN reference — appears anywhere in the synthesized template. | Remove the optional `TANGO_*` schema keys and `externalSecretArns.tangoApiKey`; revert compute-stack.ts's conditional injection. The real secret in AWS is untouched either way — this phase never read it. |
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

## P07 — migration rehearsal evidence

Run locally against `pgvector/pgvector:pg16` (Postgres 16.14), which is the same
image the CI gate provisions.

| Rehearsal | Result |
|---|---|
| Clean replay from a verified-empty database | 226 migrations applied, P07 included |
| Ordered upgrade from the prior FO schema | applied P07 only, nothing re-run |
| Retry after apply (re-ran the SQL by hand) | no-op, exit 0, only `already exists, skipping` notices |
| RLS after migration | ENABLED + FORCED, exactly 4 policies |
| Legacy columns after migration | `grant_opportunity_id`, `sam_opportunity_id`, `workflow_status` all intact |
| Pre-P07 API insert omitting all 6 columns | succeeds, row lands with `human_decision IS NULL` |

Constraint behaviour, proven by attempting each write:

| Attempted | Outcome |
|---|---|
| `human_decision` in (pursue, monitor, pass) with actor + timestamp | accepted |
| `human_decision = 'reviewing'` | **rejected** |
| `human_decision = 'suggested'` (a machine state) | **rejected** |
| decision with no actor | **rejected** |
| decision with no timestamp | **rejected** |
| actor + timestamp with no decision | **rejected** |
| all three NULL (undecided row) | accepted |
| `next_action_due_at` with no `next_action` | **rejected** |
| `next_action` with no due date | accepted |

**Process note.** During this rehearsal I started a container with a host port that
was already taken, suppressed the error, and read `$?` after a pipe — so a failed
start looked like success and one `migrate deploy` ran against an unrelated
leftover scratch container (`capiro-phase-pg-r82`). That database was empty: no
migrations, no data, and afterwards its only rows were the 226 migration-bookkeeping
rows. Nothing was overwritten and nothing was lost. Recorded here because a
migration reaching a database nobody intended is exactly the class of event this
program's rules exist to prevent, whether or not it did damage. The fix for the
habit: verify the port is free, confirm the target database is empty, and never
read an exit code through a pipe.

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

## P06 — frozen-contract amendment

P00's fixture is edited by hand, in the diff, with a reason — which is the whole
point of it being a fixture rather than a snapshot. P06 adds:

- `FundingOpportunity.recommendation` (additive, nullable)
- the `OpportunityRecommendationView` shape
- `MACHINE_RECOMMENDATIONS` and `RECOMMENDATION_CONFIDENCES`

`recommendation` is **null on the unscoped catalog read**, not a `needs_review`
placeholder: a recommendation is always relative to a specific client, and
inventing one for a read where nobody named a client would be a claim about
nothing.

It is **computed on every read and never persisted**, per P06's own instruction.
That is not laziness — a stored recommendation goes stale the moment the client
profile changes, and there is no mechanism yet that would notice.

`recommendationConfidence` is evidence quality. The fixture records the invariant
explicitly, and a test asserts no confidence value is named like a probability,
because "high" next to a dollar figure invites exactly the win-rate reading the
contract forbids.

## Deviations from the plan

Recorded here rather than discovered later.

| Date | Deviation | Reason | Consequence |
|---|---|---|---|
| 2026-08-06 | P00–P10 are being executed as **sequential commits on one branch** (`agent/fo-p00-baseline-freeze`), not one PR per phase as §6.1 requires. | Explicit user instruction. | The per-phase independent-review gate (§6.2, §6.3) cannot run between phases, so a defect introduced in an early phase is not caught before later phases build on it. Review is deferred to one review of the whole range. The `Review` column stays empty for P00–P10 until that happens — it is not satisfied by this branch's CI being green. |
| 2026-08-06 | P00's boundary tests are largely **pre-existing**. `funding-opportunities.boundaries.spec.ts` (75 tests) already covered the flag, portal denial, migrations and RLS before this program began. | Prior remediation work (PR #692) built them. | P00 added the frozen *contract* fixture and the shapes/vocabularies/floor checks that were missing, rather than duplicating what existed. |
| 2026-08-06 | **P01 changes producer behavior.** Its two acceptance criteria — "byte-equivalent grant/SAM profile" and "existing scoring tests pass unchanged" — could not both hold, because the three profile sites did not agree at the baseline. Resolved on explicit user decision: unify on the **read path**. | The SAM producer built contract award-history identity from confirmed `contracting` mapping UEIs only and never selected `Client.uei`; the read path used both. So a client holding its own UEI with no confirmed contracting mapping had prior-agency history on screen that the nightly job could not reproduce, and the producer would decline to suggest a notice the page scored highly. The read path is what a user sees, so the producer was the side that was wrong. | The SAM producer now resolves more prior-agency history, so **more notices clear the suggestion floor and a future run will create more suggestions**. No data impact yet: all four schedules remain `enabled: false` and dry-run is still the default. Both producers also now issue 2 bounded award-history queries per client instead of 1, because each builds the whole versioned profile so the three sites are byte-comparable. |
| 2026-08-06 | P01 did **not** touch `apps/api/tsconfig.funding-opportunities.json`, though the plan lists it. | The three new modules live under `src/`, which the ordinary `apps/api` typecheck already covers, and the producers pull them in transitively. That config exists only because `apps/api/tsconfig.json` excludes `scripts`; no new script was added. | If a later phase adds a new *script*, it must be appended to that `include` list or nothing typechecks it. |

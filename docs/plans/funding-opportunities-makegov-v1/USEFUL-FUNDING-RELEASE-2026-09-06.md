# Useful Funding Opportunities — implementation and release checks

Implementation based on main `e285db425c91b2a833424085db7d91c1922f5f73`, checked September 6, 2026.

Publication incorporates main `b83e884826d3efeb1f889095db62b349c10ad181`. Its intervening changes do not overlap this feature and are preserved.

## Delivered behavior

The native vNext module has three entry points: Recommended for new client matches, Browse for one selected feed, and Tracking for saved, watched, and pursued work. Existing `view=inbox|explore|pipeline` links remain valid. Tracking starts with a list; the existing pursuit board is optional. A client is required for client work, not for source research.

Browse supports federal grants, federal contracts, agency forecasts, DIBBS, and SBIR/STTR. The first two retain their catalog implementation. The three Tango feeds use thin paginated adapters over existing tables. Source-specific filters reset on feed changes; old combined grants/contracts URLs retain an explicit compatibility view. Errors, unavailable capabilities, empty results, and stale or unverified ingestion history have distinct states. Forecast dates remain estimates and never become response deadlines.

Details put source facts, client fit, and team actions before optional analysis. All supported feeds offer client-scoped actions, with source/lifecycle restrictions enforced by the server. Expired, passed, or completed work cannot be silently reopened; Save/Watch cannot demote active pursuits. Source URLs are shown only when available and valid. Forecasts have no fabricated source URL or bid/apply action.

Grant matching requires substantive fit: generic eligibility or repeated broad terms cannot create strong matches by themselves. Prior Assistance Listing evidence and specific capability plus independent topical/agency evidence remain useful. The shared scorer also serves District Nexus. Candidate refresh preserves human decisions and history.

The Tango forecast producer reuses the existing categorical relevance rules, source identities, flags, and task infrastructure. Forecast sync resumes interrupted pages without skipping an unfinished time window. DIBBS/SBIR/forecast runs now distinguish complete success from partial work and errors in the existing run ledger. Lifecycle processing follows all five feeds, includes historical watched records, silently establishes its initial baseline, and deduplicates subsequent changes. Forecast estimate changes are updates, never closing-soon alerts.

## Action persistence

| UI action | Existing backend state | Task behavior |
|---|---|---|
| Save | Saved workflow; preserves decisions and active/terminal work | No task |
| Watch | Monitor decision and saved workflow | No task until the user requests a review |
| Pursue | Pursue decision, pursuing workflow, existing valid stage behavior | One task per client/source/record/intent |
| Create review task | Review follow-through while preserving an existing pursuit/outcome | Idempotent review task; nonempty next action |
| Pass / Restore | Audited dismissal / explicit restoration; history retained | Existing work is not deleted |
| Edit next action | Explicit owner/text/date edits without replacing decision metadata | Updates the matching linked task atomically |

Follow-up dates are supplied by the team. A source deadline is never copied into them. Task reuse preserves existing human work; explicit edits use the edit form. Legacy task identities are reused only after checking the actual client. Source predicates apply before counts and pagination. Client walls apply to alternate action and read routes as well as vNext.

## Provider authority and legacy compatibility

- Tango/MakeGov remains the ingestion provider for forecasts, DIBBS, and SBIR/STTR. Forecasts are published agency plans, not a new Capiro prediction model.
- Direct Grants.gov and SAM remain the canonical grants/contracts paths. Tango's general opportunity comparison is still a shadow comparison; there is no second canonical SAM writer or silent failover.
- Legacy routes continue to use compatible shared APIs/types. Their visible triage tabs retain the original set. The simplified navigation and new detail hierarchy are native vNext changes, not a legacy redesign.
- Source flags, task correctness, scoring, and API protections affect both UIs. Shared helpers located under the legacy-named directory remain shared.
- The hidden source-freshness strip was a vNext prototype style issue. No general legacy theme collision was established.
- Client-profile Opportunities uses actual counts, honest loading, and links into the same client scope. Its compact summary explicitly covers grants/contracts; it does not claim a five-feed aggregate.

## Validation and remaining release gates

Validation passed: 1,988 backend tests across 54 suites, 116 funding frontend tests across 5 suites, the full web typecheck, and the focused API typecheck. The final additive forecast team-plan read was subsequently verified with 57 forecast-read tests and the focused API typecheck. The isolated preview builds the actual vNext components (122 modules) with fixture APIs. Browser visual QA remains unverified: this browser blocks access to the local preview URL. No authenticated production walkthrough was possible.

The following have **not** been executed in this environment: live AWS revision/flag inventory, actual provider backfill, migrated Postgres concurrency, real-client rescoring review, production deployment, or a customer canary. No live source authority or customer capability was changed. These remain release gates, not assumed successes.

### 1. Confirm live deployment and source state

Record deployed web/API revisions, current capability flags, latest source/candidate/lifecycle runs, table counts, ECS task definitions, image availability, and actual EventBridge targets. Compare live targets with infrastructure declarations before changing a stack. The September 4 execution log documents out-of-band live targets and disabled declarations; a broad stack deploy could undo live fixes. Do not deploy the Compute stack as a shortcut.

The last recorded SAM failure was an invalid API key on September 4. Verify whether it is still failing. If so, the SAM account owner must rotate the key and update the configured SAM secret through the existing secure deployment process. Do not infer that a code deploy repairs credentials.

### 2. Prove task constraints on disposable Postgres

Use the existing funding-opportunities CI Postgres service or a migrated disposable local database. The script refuses non-local hosts and requires an explicit disposable-database opt-in:

```sh
ALLOW_P08_CONCURRENCY_DB=1 pnpm --filter @capiro/api test:funding-opportunity-action-concurrency
```

Verify one task for same-client retries, separate tasks for two clients sharing a notice, dated review creation, legacy identity reuse, preservation of existing owner/date, and explicit task edits. Do not run this fixture-creating script against production.

### 3. Backfill and review internally

Run the following through the configured ingestion job image with normal managed credentials. These are command names/arguments for the existing dispatcher, not instructions to expose credentials locally:

```text
sync-tango-forecasts --commit
generate-forecast-opportunity-candidates --tenant <internal-tenant-id>
generate-funding-grant-candidates --tenant <internal-tenant-id>
```

The first forecast sync performs an idempotent backfill when there is no complete checkpoint; capped or interrupted work remains partial until completed. Review roughly 30–50 candidate pairs across 3–5 varied clients before the corresponding `--commit` producer run. Do not delete/rebuild workflow tables. Confirm saved, passed, owned, and pursued records survive rescoring.

Verify the existing grants/SAM and Tango DIBBS/SBIR incremental and full-reconciliation jobs against their real records. Source feed health without a complete ledger record is unknown, not healthy. Retain valid source data through failed updates.

### 4. Activate only after the internal walkthrough

The new forecast schedule declarations are daily sync at **12:50 UTC** and candidate generation at **13:05 UTC**. Deploy or reconcile those scoped rules only after validating their image/dispatcher and live-target drift. Customer forecast activation remains independently controlled by existing master/source flags.

For each of the five feeds, trace one real record from ingestion to Browse, relevant Recommended results, details, client action, and Tracking. For a forecast, use Watch and a user-set review date. Verify one subsequent scheduled ingestion/candidate cycle and one deduplicated material update. Compare title, agency, lifecycle, amount meaning, timing, and any source URL with the actual source.

Check keyboard navigation, drawer Escape/focus return, narrow layouts, source-failure retry, pagination after filtering, authoritative client scope, and task edits after reload. Have 2–3 representative users attempt the find → assess → save/watch/pursue → follow-up flow before widening activation. This usability result cannot be established by unit tests.

### 5. Roll out and recover

Release internally, then to a small representative customer canary. Record revisions, flags, sample results, and the next scheduled cycle before widening. If a feed is blocked, expose its unavailable/stale state and keep activation limited. Roll back the affected deployment or capability while preserving workflows, tasks, and history.

## Deliberately bounded scope

No new CRM, prediction engine, proposal writer, automatic forecast-to-solicitation linker, combined five-feed ranking, saved-search email system, or grant compliance engine was added. Existing unfinished advanced capabilities remain subject to their existing gates and require a live flag audit before customer activation. A code review does not certify the older program's unrelated dark/internal features.

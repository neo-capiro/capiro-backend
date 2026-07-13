# Phase 0 Verification Checklist — "Flip the Switches"

**Source:** [`docs/plans/2026-07-12-capiro-strategic-blueprint-execution-plan.md`](2026-07-12-capiro-strategic-blueprint-execution-plan.md) §3, Phase 0.
**Purpose:** for each of the 4 Phase 0 items, a precise current-state finding (code-verified 2026-07-12), success criteria, and concrete test cases Ninja can run personally.
**Note:** two items turned out to need slightly more than "flip a switch" once verified against actual code — flagged inline where that's true.

---

## Item 1 — Wire the persisted alert-relevance score into `TrackerFeedPanel`

### Current state (verified)
- `TrackerFeedPanel.tsx:315` hardcodes `const order: FeedOrder = 'date';` exactly as the blueprint describes.
- The backend is **fully built and already live** — `FeedOrder = 'date' | 'score'` (`intel-feed-api.ts:117`), and `apps/intel-api/src/feed/feed.service.ts` has real, index-backed `order=score` support (dedicated composite indexes for both per-client and tenant-wide score-ordered pagination, keyset cursors that carry the score).
- The score itself is a genuine weighted composite, not a placeholder: `alert-scorer.ts` computes `0.35·relevance + 0.25·materiality + 0.20·urgency + 0.10·political + 0.10·clientPriority − confidence_penalty`, clamped to [0,1], with critical bill-status changes (`bill_enacted`/`bill_to_president`/`bill_failed`) floored to a "High" band regardless of the other factors.
- **One honest caveat to know before flipping:** the scorer's own doc-comment says the `relevance` factor is currently a **keyword-match proxy** (semantic `fit` matching, §6.1 MatchEngine, isn't built yet) — the score is real and meaningfully ranks alerts today, but it isn't the final/full-fidelity version. Worth knowing so a "why did X rank below Y" question isn't a surprise.
- This really is a one-line frontend change — the backend needs nothing.

### Success criteria
- [ ] `TrackerFeedPanel.tsx` requests `order=score` (either hardcoded to `'score'`, or exposed as a user toggle — decide which; the blueprint implies just flipping the default).
- [ ] The feed visibly reorders: a lower-severity item with a recent date no longer outranks a higher-materiality/higher-urgency item with an older date.
- [ ] No regression to pagination (keyset cursors still work scrolling past page 1 in score order).
- [ ] No regression to the per-client vs. tenant-wide ("Radar" global) feed views — both use the same `order` param.

### Test cases
1. **Static check:** open `TrackerFeedPanel.tsx`, confirm the `order` variable is no longer hardcoded to `'date'` (or confirm a toggle exists and defaults sensibly).
2. **Visual reorder check:** open the Tracker/Radar feed for a client with ≥10 alerts spanning different severities. Note the current (date) order. After the flip, reload — a `critical` severity item from several days ago should now rank above a `notable`/`info` item from today, unless the critical item is stale enough that urgency's recency decay outweighs it (check `urgencyFactor`: `≤1 day→1.0, ≤7 days→0.7, ≤30 days→0.4, else→0.1`).
3. **Network check:** open browser dev tools → Network tab → confirm the request to `/intel-api/clients/:id/feed` (or `/intel-api/clients/_all/feed`) now carries `?order=score` instead of `?order=date`.
4. **Pagination check:** scroll to load a second page; confirm no duplicate or skipped items (keyset cursor correctness under score ordering — the cursor now encodes `{score, createdAt, id}` instead of just `{createdAt, id}`).
5. **Regression check:** confirm the tenant-wide "Radar" roll-up view (all clients) also reorders correctly, not just the per-client view.

---

## Item 2 — Schedule `emit-clio-alerts` and `generate-meeting-briefings` via EventBridge

### Current state (verified) — this needed more digging than "just add a cron rule"
Both scripts exist and do real work, but they are **not equally close to schedulable**:

| Script | Entrypoint verb wired? | Scheduled anywhere? | What it does |
|---|---|---|---|
| `generate-meeting-briefings.ts` | **Yes** (`entrypoint.sh:181-183`, case statement exists) | **No** — absent from `infra/cdk/lib/ingestion-schedule.ts`'s 62-job list, and not called by any other scheduled script | Daily proactive meeting-prep briefings per user into the in-app inbox (`clio_proactive_alert`); own docstring literally says "Intended cadence: once daily via the scheduled-task runner." |
| `emit-clio-alerts.ts` | **No** — there is no `emit-clio-alerts)` case in `entrypoint.sh` at all; the script exists on disk but the container has no way to invoke it as a verb today | **No** | Quiet-client (30+ days no contact) + upcoming-meeting-without-prep detection, writing `clio_proactive_alert` rows; docstring: "Intended cadence: every 30-60 min via the existing scheduled-task runner (same mechanism as sync-*)." |

Neither script is invoked by `run-clio-scheduled-tasks.ts` (checked directly — that script imports a different set of Meri-tool/AI-credential modules, unrelated to these two). So this item is genuinely two separate small pieces of work, not one: **(a)** add the missing `entrypoint.sh` case for `emit-clio-alerts`, mirroring the existing `generate-meeting-briefings` pattern; **(b)** add both to `infra/cdk/lib/ingestion-schedule.ts`'s `INGESTION_JOBS` list (or an out-of-band `aws events put-rule`, matching the pattern already used for `refresh-memory-graph`).

### Success criteria
- [ ] `emit-clio-alerts` has an `entrypoint.sh` case statement (currently missing — must be added, not just scheduled).
- [ ] Both scripts have a live EventBridge rule: `emit-clio-alerts` every 30–60 min per its own docstring; `generate-meeting-briefings` once daily.
- [ ] Both rules target the correct task definition/container (mirror the existing `refresh-memory-graph`/`run-clio-scheduled-tasks` out-of-band rules — same role, same task def, per the established pattern).
- [ ] Running each manually (or observing the first scheduled run) produces new `clio_proactive_alert` rows with `status='pending'` for tenants that actually have qualifying meetings/stale clients — not zero rows across the board (a 0-row run on a tenant known to have a stale client would indicate a bug, not success).
- [ ] Re-running either job doesn't duplicate alerts (both have their own dedup: `emit-clio-alerts` dedupes per `(tenant, sourceType, sourceId, status=pending)`; `generate-meeting-briefings` dedupes per `(tenant, user, day)`).

### Test cases
1. **Confirm the verb gap, then confirm the fix:** `grep -n "emit-clio-alerts)" apps/api/scripts/entrypoint.sh` should return nothing today; after the fix, it should show a case statement analogous to the `generate-meeting-briefings)` one at line 181.
2. **Manual dry run (before scheduling):** run each script directly against a real (non-prod, or read-carefully) tenant: `pnpm --filter @capiro/api exec tsx scripts/emit-clio-alerts.ts` and `pnpm --filter @capiro/api exec tsx scripts/generate-meeting-briefings.ts`. Confirm rows appear in `clio_proactive_alert` (or `SELECT count(*) FROM clio_proactive_alert WHERE status='pending' AND created_at > now() - interval '5 minutes'`).
3. **Verify against a known fixture:** pick one client you know hasn't had a meeting/engagement logged in 30+ days; confirm `emit-clio-alerts` produces a `sourceType`-matching row for that client specifically (not just "some rows appeared somewhere").
4. **Confirm the schedule is live in AWS**, not just in code: `aws events list-rules --name-prefix capiro-dev` (or the equivalent for whichever naming convention is used) — look for the two new rule names; then `aws events list-targets-by-rule --rule <name>` to confirm it targets the right task def/container/command. **Do not rely on grepping the CDK file alone** — several existing jobs in this system (e.g. `refresh-memory-graph`) were deployed as out-of-band `aws events put-rule` calls never reflected in `infra/cdk/lib/ingestion-schedule.ts`, so the code and the live AWS state can diverge.
5. **Observe a real scheduled firing:** after the rule is live, wait for one real cron firing and check CloudWatch logs (`/capiro/dev/api`, filtered for the task) for a clean exit (exit code 0, no exception) and a nonzero "created" count logged.
6. **Dedup check:** run the same script twice in a row within the same day; confirm the second run creates 0 new rows for the same source (proving the dedup key works, not just that the script ran).
7. **In-app visibility:** confirm the new alerts actually surface where the docstring says they should — the dashboard intel inbox / `GET /api/clio/alerts` for `emit-clio-alerts`; the in-app inbox for `generate-meeting-briefings`.

---

## Item 3 — Decide the PE alert email canary (`PE_ALERT_EMAIL_TENANTS`) and flip it for `capiro-internal`

### Current state (verified) — this is genuinely the simplest item; the job is already running
- `send-pe-alert-emails.ts` is **already scheduled and running today** (per the PE Watch project's own status: all 6 EventBridge rules enabled and producing output) — it computes the digest and stamps client-watchlist relevance on every run **regardless** of the canary flag.
- The gate is exactly one env var: `PE_ALERT_EMAIL_TENANTS` — comma-separated tenant UUIDs, or the literal string `'all'`. **Unset or empty = fully dark: zero emails sent, but the watchlist-stamping half of the job still runs.**
- It has a `--commit` vs. dry-run distinction (dry run just prints who *would* get what) and a watermark (`runWithSyncRun`) so a same-day re-run can't double-email.
- User-level opt-out already exists too: `pe_alert_email_pref` (`off | daily | daily_plus_critical`; no row = `daily`).
- **This item is a pure config/env change** — no code change needed, unlike Item 2.

### Success criteria
- [ ] `PE_ALERT_EMAIL_TENANTS` is set to the `capiro-internal` tenant's UUID (not `'all'` — this is explicitly a canary, one tenant only, per the blueprint's own framing) on whichever task definition runs this scheduled job.
- [ ] The next scheduled run (or a manual `--commit` run) sends real emails to `capiro-internal` users who have ≥1 `program_element_watch` and haven't opted out (`pe_alert_email_pref != 'off'`).
- [ ] No emails go to any other tenant (the whole point of a canary).
- [ ] A user who set `pe_alert_email_pref='off'` receives nothing, proving the per-user opt-out still works once the tenant-level gate is open.

### Test cases
1. **Confirm current dark state first:** `aws ecs describe-task-definition` (or equivalent) for the task running this job — confirm `PE_ALERT_EMAIL_TENANTS` is currently unset/empty, matching the "fully dark" expectation, before making any change.
2. **Dry run before flipping:** run `send-pe-alert-emails` (no `--commit`) against prod data with the env var NOT yet set to confirm what the digest *would* look like — "print who would get what" per the script's own header.
3. **Flip the env var** (out-of-band task-def revision, per this repo's established pattern — do not `cdk deploy` the Compute stack) to `capiro-internal`'s tenant UUID.
4. **Manual commit run:** invoke with `--commit` once, watch for a clean exit and the expected count of emails "sent" in the log output (should match the dry-run count from step 2, for that one tenant only).
5. **Verify delivery:** confirm at least one real `capiro-internal` user with an active PE watch actually receives the email (check an inbox, not just logs — SES can accept a send that doesn't land).
6. **Negative check:** confirm zero emails were sent to any tenant other than `capiro-internal` — spot-check the SES send log or the job's own per-recipient log line for any non-`capiro-internal` tenant id.
7. **Opt-out check:** find (or create) one `capiro-internal` user with `pe_alert_email_pref='off'`; confirm they receive nothing on the next run while other `capiro-internal` users do.
8. **Idempotency check:** run the job a second time shortly after; confirm the watermark prevents re-sending the same digest (no duplicate emails for the same window).

---

## Item 4 — Route the memory-governance helper functions to real API endpoints

### Current state (verified)
- `apps/api/src/memory/memory-governance.helpers.ts` contains `selectForPurge`, `selectForClientPurge`, `selectForUserPurge`, `selectForLegalHold`, `redactSections`, and `toManifestRow` — all correct, tested pure functions.
- **Zero callers anywhere in `apps/api/src` outside the function file's own spec** — confirmed by a repo-wide grep. `memory.controller.ts` has exactly 10 routes today (`catalog`, `items`, `items/:type/:slug/markdown`, `.../sections`, `interview/*`, `graph`, `graph/client/:clientId`, `graph/path`, `backfill`) — none are purge/export/forget.
- **Scope note vs. the fuller Phase 1 plan:** the blueprint's own Phase 0 framing is deliberately lighter than [Phase 1's](2026-07-12-capiro-phase-1-memory-ledger-deployment-plan.md) candidate-lifecycle/RLS-upgrade work — Phase 0 just wants these *existing* pure functions reachable via a real route, using today's data model as-is (no new schema, no candidate table). Treat this as a minimal, fast route addition; do not accidentally build Phase 1's fuller machinery here.

### Success criteria
- [ ] At least one real route exists calling `toManifestRow` (an export endpoint) and at least one calling a `selectFor*` + a delete/redaction action (a forget/purge endpoint) — the blueprint's own framing: "first real forget/export user actions."
- [ ] The new route(s) are properly tenant-scoped (`withTenant`) and role-gated appropriately (e.g., client-purge/legal-hold likely admin-only; personal export likely any authenticated user for their own data).
- [ ] Calling export returns a real manifest for a real memory item, matching `ExportManifestRow`'s shape exactly.
- [ ] Calling forget/purge on a real item actually removes it (or marks it appropriately) and is reflected in a subsequent `GET /memory/items` call.
- [ ] This ships without waiting on Phase 1's RLS/candidate-lifecycle work — that's explicitly not a prerequisite for this minimal wiring.

### Test cases
1. **Static check:** `grep -rn "selectForPurge\|selectForClientPurge\|selectForUserPurge\|selectForLegalHold\|redactSections\|toManifestRow" apps/api/src/memory/memory.controller.ts` — should return nothing today; after the fix, should show at least one real call site.
2. **Export test:** call the new export endpoint for a client/user with ≥1 real memory item; confirm the response is a JSON array of objects matching `ExportManifestRow` (`id, type, clientId, ownerUserId, visibility, source, sourceRef, provenance, createdAt, updatedAt`).
3. **Forget/purge test:** call the new forget/purge endpoint for one specific item; confirm (a) the call succeeds, (b) a subsequent `GET /memory/items` no longer returns that item, (c) nothing else in that tenant's memory disappeared (scope correctness).
4. **Auth/role test:** confirm a non-admin cannot purge another user's or the firm's shared memory (whatever role gate is chosen) — attempt the call as a `standard_user` against a firm-scope item and confirm it's rejected.
5. **Tenant-isolation test:** confirm a user from Tenant A cannot export or purge a memory item belonging to Tenant B (basic cross-tenant negative test, should already be guaranteed by `withTenant`, but worth a concrete check given this is the first real caller of these functions).
6. **Legal-hold test:** if `selectForLegalHold` is wired into the export path (broad, preserving), confirm a legal-hold export returns *more* items than a normal client-scoped export for the same client — the plan's own note: "the selection is intentionally broad (hold preserves; it does not delete)."

---

## Cross-cutting note

Items 1 and 3 are true one-line/one-env-var flips, exactly as the blueprint promised. Items 2 and 4 both turned out to need a small amount of real (if minimal) code — Item 2 because one of its two scripts was never wired into `entrypoint.sh` at all, and Item 4 because there is genuinely no route today, just unwired pure functions. Worth setting expectations accordingly: "Phase 0" is mostly true to its "near-zero net-new code" framing, but not entirely — flag this to whoever is scoping the sprint so Item 2/4 aren't estimated as pure config work.

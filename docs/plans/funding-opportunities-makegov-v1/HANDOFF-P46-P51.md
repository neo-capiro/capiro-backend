# Funding Opportunities — Handoff, P46 through P51

**Written:** 2026-08-08. **Status:** P46–P51 merged to `main`; migrations applied to `capiro-dev`.
**The program is NOT complete.** See §6 for exactly what remains and who owns it.

Continues [`HANDOFF-P36-and-capiro-dev-recovery.md`](./HANDOFF-P36-and-capiro-dev-recovery.md).

> **This handoff is COMMITTED, unlike its predecessors.** Every prior handoff in this program was
> written and left untracked, which means each one exists only on whichever machine wrote it —
> `HANDOFF-P11-P25`, `-P26-P35`, `-P37-P45` and `-P36-and-capiro-dev-recovery` are all absent from
> `main`. Nothing gitignores them; it was incidental, not policy. A program whose institutional
> memory lives on one laptop has no institutional memory, so this one is in the repo. **Recovering
> the earlier four from whoever holds them is worth doing.**

---

## 1. What shipped

| Phase | PR | Merge | Migration |
|---|---|---|---|
| P46 verified webhook receiver | [#825](https://github.com/neo-capiro/capirov2/pull/825) | `12eb8cb3` | `20260905010000_tango_webhook_deliveries` — **applied** |
| P47 dry-run-first alert reconciler | [#826](https://github.com/neo-capiro/capirov2/pull/826) | `c937c97d` | none |
| P48 event fan-out and quiet alerts | [#827](https://github.com/neo-capiro/capirov2/pull/827) | `33b25f11` | `20260906010000_tango_event_outbox` — **applied** |
| P49 canary diagnostic + runbook | [#828](https://github.com/neo-capiro/capirov2/pull/828) | `a87de936` | none |
| P50 enablement runbook | [#829](https://github.com/neo-capiro/capirov2/pull/829) | `22a0f393` | none |
| P51 product doc + closeout | [#830](https://github.com/neo-capiro/capirov2/pull/830) | `9b23dc89` | none |

Both migrations applied to `capiro-dev` via `capiro-dev-api-migrate:54` (image built from `main`
`9b23dc89`), verified **246 → 248**, `"Database schema is up to date!"`.

Follow-up fixes, all merged: [#833](https://github.com/neo-capiro/capirov2/pull/833) status,
[#834](https://github.com/neo-capiro/capirov2/pull/834) batch deliveries + contract probe,
[#835](https://github.com/neo-capiro/capirov2/pull/835) alert INSERT,
[#836](https://github.com/neo-capiro/capirov2/pull/836) diagnostic queries,
[#837](https://github.com/neo-capiro/capirov2/pull/837) list pagination,
[#838](https://github.com/neo-capiro/capirov2/pull/838) dispatcher syntax gate.

Test floors: api **78 / 2454**, web **109 / 412**. Both scopes 0 failures, 0 skipped, 0 todo.

---

## 2. Read this before you trust a migrate run

**23 of the 27 EventBridge rules targeting the `capiro-dev-api-migrate` task-definition family are
revision-UNPINNED, and 16 of those are ENABLED.** Measured, not inferred; the enumeration command is
in rollout runbook §30.

An unpinned target runs whatever revision is latest at fire time. So **registering a migrate revision
— which every migration deploy does — silently changes the container image for 16 scheduled jobs**,
including `sync-sam-opportunities`, `enrich-grant-details`, `sync-federal-award`,
`refresh-memory-graph` and both clio jobs.

Two consequences:

1. **A migrate task exiting 0 may not be your run.** Check `startedBy` before believing an exit code.
2. **Registering a migrate revision deserves the care of a deploy**, not of a config change.

The prior handoff described this as "two clio rules." It is 23. Do not fix it by pinning revisions
casually — a pinned rule stops receiving migrations. The real fix is repointing them at the existing
`capiro-dev-api-sync-jobs` family, which is a reconciliation with its own blast radius.

---

## 3. Six defects found, and the one technique that found them

Every one came from **executing code that had only ever been tested against doubles.**

| Defect | Would have caused | Fixed in |
|---|---|---|
| `ON CONFLICT ON CONSTRAINT` against a unique **index** | P48 writing **zero** alerts, ever — every event retried 5× then quarantined | #835 |
| Batch deliveries rejected | authenticated events answered 400 and never retried — lost permanently | #834 |
| Three phantom diagnostic queries | broken measurements rendering as "no data" to a canary reviewer | #836 |
| Failure indistinguishable from absence | the flaw that hid those three | #836 |
| Webhook lists truncated to page 1 | duplicate subscriptions proposed at the provider | #837 |
| Web gate misdiagnosed for 3 sessions | gate red on a bug that was never Engagement's | (in #830's branch) |

**The lesson, which generalises beyond this program:** unit specs here drive services against
in-memory port doubles. That is the right way to test branching, but it means `$queryRaw` /
`$executeRaw` can be merged **having never run once**. Schema assertions do not substitute — the
migration rehearsal asserted *"the index exists"* while the statement referencing it threw on every
call. **Assert by EXECUTING the statement, not by asserting the objects it references exist.**

The CI migration job now executes P48's alert INSERT twice and requires 1 row then 0.

### The web-gate correction specifically

Three handoffs recorded the two `App.funding-opportunities-nav.test.tsx` failures as
"`EngagementPreviewBoundary` calls `useQueryClient()` outside a provider — PR #813's, not our code."
Half right about the mechanism, **wrong about the owner**. The component is fine; `App` began
*requiring* a `QueryClientProvider` when #813 mounted it, and two tests in this program's own file
still rendered `<App />` bare while a helper supplying one sat directly above them.

*"Reproduced with only pre-existing files"* correctly showed our change did not **cause** it. It never
showed the fix belonged to someone else. The handoff collapsed those into one finding, and it cost
three sessions.

---

## 4. Design decisions worth not re-litigating

- **One provider alert per DATASET, never per client.** A per-client subscription would leak the
  client roster into MakeGov's system where no RLS policy reaches it, tie onboarding to a provider
  write, and multiply provider objects by tenant growth. A structural test greps the shipped filters
  for `tenant|client|uei|cage|duns`.
- **Dedupe is a unique index, not application logic.** Replay and out-of-order delivery are normal
  for an at-least-once sender; only the database collapses them under concurrency. The fingerprint is
  computed from the **change**, never the delivery — which is why P46 stores `payload_sha256`
  separately from `delivery_id`.
- **Alerts are quiet in four independent ways**: first observation baselined silently; unchanged
  source produces nothing; informational severity never interrupts; only rows a human engaged with
  alert at all. The last matters most in practice — `workflow_status` defaults to `suggested`, which
  maps to no stage, so the producer's backlog is silent by construction.
- **Deletion is never implied by absence.** Two guards: without `--allow-delete` an undesired alert
  is reported, not acted on; and even with it, an alert lacking the `capiro-managed/` prefix is never
  proposed for deletion.
- **The canary diagnostic states no verdict.** A canary that prints PASS is a canary that gets waved
  through.

---

## 5. Known limitations, named rather than implied

- **P40–P43 (DIBBS, SBIR/STTR) are blocked on the provider.** Verified first-hand:
  **zero** occurrences of `dibbs`/`sbir`/`sttr` anywhere in `@makegov/tango-node@1.1.0` — code,
  types, README, CHANGELOG, `docs/` — across all **100** client methods, and there is **no generic
  request escape hatch**. This is not a scheduling choice and no engineering unblocks it.
- **The webhook write tier is unresolved.** P17 recorded `webhook_write_apis` as `not_attempted`
  because every one of those methods mutates a live subscription. P47's reconciler is built to
  discover the answer: a tier refusal exits 3 after exactly one attempted write.
- **P46's signature header is still an assumption.** `x-tango-signature` comes from the plan
  document. Run `diag-tango-webhook-contract` (read-only, one GET) before canary step 14 — it
  compares the provider's own stated `signature_header` against P46's constant and exits 1 on a
  mismatch. Getting this wrong means every delivery is 401'd and never retried.
- **The batch-envelope handling is inferred from the SDK's model**, not from a live delivery. The
  same probe confirms it.
- **Vehicle changes do not raise webhook alerts** — the provider states no vehicle on a notice.
  **Requirement changes surface as an attachment count**, which is informational and does not alert.
- **The event drain reads what P28's notice sync holds**, rather than fetching inline. Schedule the
  sync first; otherwise a change is picked up a cycle late. It never invents one.
- **No phase in this program has had an independent review.** Every completion-matrix row is
  *self-verified only*. §6.2's gate has never run, for P00–P51.

---

## 6. What remains, and who owns it

Nothing below is waiting on code.

| Item | Owner | Why it cannot be automated |
|---|---|---|
| Independent review of P46–P51 | a reviewer | §6.2 requires a context that did not write the code |
| Webhook endpoint + `capiro/dev/tango-webhook-secret` | Neo | MakeGov console; the secret must not pass through an agent |
| Resolve the webhook write tier | Neo | one deliberate `--commit`, or MakeGov confirming |
| Canary (P49) | Neo | live key, per-flag enablement, human browser + accessibility walk |
| Schedule enablement (P50) | Neo | out-of-band; the Compute stack is drifted |
| GA (P51) | Neo | acceptance is a judgement, not a test |
| DIBBS / SBIR (P40–P43) | MakeGov | no API surface exists |

**Suggested order when you have the key:**

1. `diag-tango-webhook-contract` — confirm the signature header before anything else.
2. Create the endpoint in the console; store the secret; set `externalSecretArns.tangoWebhookSecret`.
3. `reconcile-tango-webhook-alerts` dry run. **Exit 3 answers the tier question.**
4. Canary steps 1–16 in `funding-opportunities-makegov-canary.md`. **Step 16's two quiet passes are
   the acceptance most likely to fail and the most worth having.**
5. Only then P50's enablement, one job at a time, alarms first.

---

## 7. Operational notes

- **API key rotation** needs no code change and no serve redeploy — the key is injected only into the
  ephemeral sync task. Update the secret, restart the task.
- **Webhook secret rotation DOES need a serve roll**, and in-flight deliveries 401 during the window
  while the provider retries. Rotate quietly, or pause the provider alerts first.
- **Provider outage**: local data stays readable and is labelled stale. No product read blocks on
  MakeGov.
- **Rollback**: flags off first (every capability fails closed with a 404), then roll API/web to the
  prior immutable digests. Additive data remains; no phase in this program ships a destructive
  migration.

## 8. Repo hazards found in passing, neither filed

- **`deploy-dev.sh` migrates via `capiro-dev-api-admin-migrate`**, whose revision 9 carries a
  hand-rolled inline command running `prisma migrate resolve --rolled-back <name> || true` before
  every deploy — auto-resolving the ledger, the exact behaviour the entrypoint's Phase A hardening
  removed. Prefer `capiro-dev-api-migrate` with command `["migrate"]`.
- **`@makegov/tango-node@1.1.0` is internally inconsistent**: `listWebhookEndpoints` takes `limit`,
  `listWebhookAlerts` takes `pageSize`. Passing the wrong one **compiles** — excess-property checks
  do not fire through a variable — and is silently ignored at runtime.
- **Multiple Prisma schemas share one `_prisma_migrations` ledger**, so `migrate status` reports ~50
  "migrations from the database not found locally". That is the architecture, not drift.
  One row, `20260524010000_add_program_element`, exists in no schema at all.

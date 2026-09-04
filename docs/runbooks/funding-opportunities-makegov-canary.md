# Funding Opportunities + MakeGov — internal tenant canary

**Phase:** P49. **Scope:** the internal tenant only. **Nothing here enables a schedule.**

This runbook proves the complete system against live data without broad rollout.
Every mutating step is performed by Neo; an implementation agent runs the
read-only diagnostic and reads the results.

> **The one rule.** Enable **one capability at a time**, and run the diagnostic
> between each. A canary that turns on six flags and then looks at the result
> cannot tell you which one broke anything.

---

## 0. Before anything

The diagnostic is SELECT-only, needs no MakeGov key, and states no verdict:

```bash
diag-funding-opportunities-makegov
```

Run it **now**, before enabling anything, and keep the output. It is the
baseline every later step is compared against. Without it, "12 alerts" is a
number with no meaning.

---

## 1–3. Readiness

| # | Step | How it is proven |
|---|---|---|
| 1 | Snapshot/restore readiness | Aurora automated backup window covers the canary; a restore has been rehearsed at least once. |
| 2 | Migrations verified | `migration-status` on the migrate task reports **no pending migrations** and no failed row. Do **not** read `migrate deploy`'s exit code as proof — see the warning below. |
| 3 | Immutable image digests | API and web task definitions reference an image **digest** resolved from the merge SHA, not `:latest`. Record both digests in the P49 handoff; they are what a rollback returns to. |

> **A migrate task that exits 0 may not be your run.** Two EventBridge rules
> (`capiro-dev-emit-clio-alerts`, `capiro-dev-run-clio-scheduled-tasks`) target
> the `capiro-dev-api-migrate` task **family** without pinning a revision, so
> registering a new revision makes them pick it up and run their own scripts.
> Always check `startedBy` before trusting an exit code:
>
> ```bash
> aws ecs describe-tasks --cluster capiro-dev --tasks <id> \
>   --query 'tasks[0].{StartedBy:startedBy,TaskDef:taskDefinitionArn,Exit:containers[0].exitCode}'
> ```
>
> A `startedBy: events-rule/...` task sharing your family is not your run.

---

## 4. Tango health and capability

```bash
diag-tango-capabilities        # read-only; records supported/tier-gated/error per family
diag-tango-health              # reads the persisted usage log; no provider call
```

Attach the sanitized capability report to the handoff. Two entries decide what
the rest of this canary can even attempt:

- `webhook_write_apis` — recorded `not_attempted` by P17, deliberately. Whether
  this tier permits webhook writes is **unresolved**, and step 14 is where it
  finally gets answered — but only via the **commit** invocation now spelled out
  there. A bare dry run cannot reach the write-tier branch at all.
- DIBBS and SBIR/STTR — **no longer blocked.** This bullet used to read
  "P40–P43 are blocked on the provider … there is nothing to entitle," on the
  strength of `@makegov/tango-node@1.1.0` exposing no method for either. D-64
  established that the SDK is not the provider: both datasets have a documented
  REST surface (`/api/dibbs/*`, `/api/sbir/*`), and Capiro now has clients and
  sync verbs for both. D-65 answered `dibbs: supported` from a real probe, and
  D-71 captured live records from `/api/sbir/topics` and
  `/api/sbir/solicitations`. Both are walkable — see steps 13a and 13b.

---

## 5–13. Capability walk

Enable **one flag**, run the relevant sync **bounded and dry-run first**, then
re-run `diag-funding-opportunities-makegov` and compare against the baseline.

Two rows have no flag to enable (5 and 13a). Do those steps one at a time
anyway — the rule is one capability per diagnostic comparison, and a step whose
only containment is its command line needs that isolation more, not less.

| # | Capability | Flag | Command |
|---|---|---|---|
| 5 | Entity shadow, one reviewed client | *(none — see "Step 5 has no tenant-level flag" below)* | `sync-tango-entities --client=<id> --limit=50` |
| 6 | Vehicles for that client | `funding_opportunities_vehicle_fit` | `sync-tango-vehicles --client=<id> --limit=50` |
| 7 | Forecast bounded sync | `funding_opportunities_forecasts` | `sync-tango-forecasts` |
| 8 | Opportunity parity and history | `funding_opportunities_notice_history` | `sync-tango-opportunity-shadow`, then `sync-tango-opportunity-notices` |
| 9 | One attachment + requirement artifact | `funding_opportunities_documents` | `sync-tango-opportunity-attachments --limit=1` |
| 10 | Government Landscape | `funding_opportunities_government_landscape` | UI only |
| 11 | Meri local assessment | `funding_opportunities_meri_v2` | UI only |
| 12 | Optional MCP | `funding_opportunities_tango_mcp` | **last** — the first real test of the MCP host and header, neither of which P17 could confirm |
| 13 | Risk / budget context | `funding_opportunities_risk_context`, `funding_opportunities_budget_context` | `sync` verbs, if entitled |
| 13a | DLA bid board (DIBBS) | *(none at any layer — see "The two rails this table used to omit" below)* | `sync-tango-dibbs --endpoint=rfq --limit=50` |
| 13b | SBIR/STTR | `funding_opportunities_sbir` — **web-only**, see below | `sync-tango-sbir --endpoint=solicitation --limit=50` |

After each: **counts should change only for the dataset you just enabled.**
Anything else moving means a flag is wider than it looks.

**Step 5 has no tenant-level flag.** This row used to name
`funding_opportunities_tango_shadow`. That flag was never wired to any code:
the only place the name appears outside this paragraph is a comment in
`20260821010000_tango_source_substrate/migration.sql`, which says so itself
("the flag that **will eventually** gate the sync jobs that DO call it — is
not read by anything this migration touches"). No guard, no service, no
constant. It has been removed from the table rather than left standing as a
false record of containment.

Row 6 keeps its flag, and it is a real one —
`funding_opportunities_vehicle_fit` is defined in
`funding-opportunities-flag.guard.ts` and read on the opportunity read path
(`funding-opportunities.service.ts`, P23) to gate the `acquisitionPosition`
field. But read what it gates: the tenant-visible FIELD, not the sync.
**Neither sync script in this pair consults `intel_feature_flag` at all.** `sync-tango-entities.ts` checks only that `TANGO_API_KEY` is
configured; nothing in it consults `intel_feature_flag`. Note also that
`infra/cdk/lib/ingestion-schedule.ts`'s `enabled: false` is **not** a
substitute gate: it governs the automatic EventBridge invocation only, and
every step in this canary is a manual `ecs run-task` that was never subject to
it. Containment for step 5 is entirely `--client=<id>` and `--limit=<n>` — do
not skip either.

**`--client` / `--tenant` are real flags now, and `--limit` is still required.**
Both sync scripts previously accepted only `--commit` and `--limit`; an
unrecognized `--client=<id>` was silently discarded and the run walked every
tenant. Both now implement:

- `--client=<uuid>` — one client.
- `--tenant=<slug-or-uuid>` — one tenant (`capiro-internal` works; so does its
  uuid). An unknown tenant is a usage error, not an empty walk.
- Anything else dash-prefixed now **exits 2 with usage** instead of being
  ignored. If a command in this runbook is ever wrong again, the script says so.

Each run echoes its own `scope` in the `TANGO_SYNC_DONE` /
`TANGO_VEHICLE_SYNC_DONE` summary — read it, and confirm it is what you meant.

Scoping narrows what is **written**, not what is **fetched per provider page**,
so `--limit` remains separately mandatory:

- `sync-tango-entities` is narrowed at the fetch layer too (it only fetches for
  clients the scoped query returned), but `--limit` is still what bounds the
  request budget of the run.
- `sync-tango-vehicles` is **not**. The provider's vehicle list has no
  awardee-UEI filter, so the outer walk pages the global catalog whatever the
  scope is — ~20,709 vehicles, the provider's own `count` (D-42; rollout
  runbook §2 quotes the same figure). Scoping only decides which
  `client_relevant_vehicle` rows may be written.
  **`--limit=50` is the only thing bounding this step's provider cost.**

**The two rails this table used to omit.**

- **DIBBS (13a) has no capability flag anywhere** — not in `apps/api`, not in
  `apps/web`, not in `intel_feature_flag`. That is a recorded decision, stated
  in `FundingOpportunityInbox.tsx`: the inbox has returned bid-board rows to
  every tenant since P41 part 2, so a web-only flag "would not gate anything;
  it would only hide a filter for rows the page is already showing." Nothing
  gates the rail. If it is dark, that is only because `client_funding_opportunity`
  holds no `source = 'dibbs'` rows yet: the producer's schedule ships
  `enabled: false` (`ingestion-schedule.ts`), so rows exist only where
  `generate-dibbs-opportunity-candidates --commit` has been run by hand. Confirm
  the count rather than assuming it
  (`SELECT count(*) FROM client_funding_opportunity WHERE source = 'dibbs'`).
  Treat it as a data accident with an expiry date: it ends the moment that
  producer is first run `--commit` for any tenant.
  **Do not run that producer with `--commit` during this canary**, and take the
  gap to whoever owns the "every tenant-visible capability is separately
  flag-gated" invariant (D-07) before it is run at all.
- **SBIR (13b)'s `funding_opportunities_sbir` is a presentation-layer flag.**
  It exists only under `apps/web`
  (`funding-opportunities-api.ts`), where it withholds the SBIR rail from the
  source filter and from deep links. The inbox API is **not** gated on it and
  will return `sbir_sttr` rows to any tenant that passes the inbox flags. So
  enabling it changes what the browser shows, and disabling it is not an API
  boundary — do not read a passing step 13b as evidence of server-side gating.

---

## 14. Webhook — test delivery only

**Do not register a production endpoint here.** P50 owns enablement.

1. Create the endpoint in the MakeGov console and store its secret as
   `capiro/dev/tango-webhook-secret` (see the rollout runbook §27 — the secret
   must never pass through a terminal you can scroll back).
2. Set `externalSecretArns.tangoWebhookSecret` and roll API serve.
3. Dry-run the reconciler. It writes nothing:

   ```bash
   reconcile-tango-webhook-alerts
   ```

   Read the exit code — rollout runbook §28 has the full contract:

   | Exit | Meaning |
   |---:|---|
   | 0 | desired state already matches, or the commit completed |
   | 2 | bad arguments; nothing attempted |
   | 3 | **tier or permission denied** — nothing left half-configured |
   | 4 | endpoint ambiguous or missing; nothing attempted |
   | 5 | drift exists, and this was a dry run |

   (The script's own header also lists `1`, "unexpected failure." It is not in
   rollout §28's table; it is a real code and it means neither of the above.)

   **On a fresh canary, exit 5 is the expected result**, not a failure —
   desired state has never been applied yet. Exit 4 is also reachable on a
   first dry run: `resolveEndpoint()` returns it when the account has more than
   one webhook endpoint and no `--endpoint-id` was given.

   **Exit 3 here means the provider refused the webhook READ APIs** (list
   endpoints / list alerts) on this account's tier — not the write APIs. That
   is the only place a dry run can reach `EXIT_TIER_DENIED` from, and the
   branch says so in its own message. It is still real signal (P17 recorded
   `webhook_event_types` and `webhook_endpoints_list` as supported, so a
   read-tier denial now is a change in entitlement), but it does **not** answer
   whether webhook **writes** are permitted.

   **Resolving `webhook_write_apis` — P17's actual open question, and the one
   §4 says this step answers — requires the commit path**, which the dry run
   above does not run:

   ```bash
   reconcile-tango-webhook-alerts --commit \
     --endpoint-id=<uuid-from-the-dry-run> \
     --confirm-callback=<the endpoint's actual callback_url, per the dry run>
   ```

   `--confirm-callback` must match the endpoint's real `callback_url` as the
   provider reports it; a mismatch returns exit 2 before anything is attempted.
   Exit 3 from **this** invocation is the one that settles the discrepancy —
   rollout §28: *"this account's tier does not permit webhook writes … do not
   retry it; take it to MakeGov."* Re-run the dry run afterwards; it must
   report no work (exit 0).

4. Send **one** provider test delivery. Confirm in the diagnostic that
   `verified webhook deliveries` incremented by exactly 1.
5. Drain it, dry-run first:

   ```bash
   process-tango-events              # dry run
   process-tango-events --commit
   ```

---

## 15. Browser acceptance

Performed by a person, on the internal tenant, against the canary data.

- **Desktop and mobile widths.** The inbox, the detail drawer, and the deep-linked
  detail page.
- **Accessibility.** Screen-reader names distinguish *recommendation*,
  *workflow stage*, and *eligibility* — three different things that must not
  read as one.
- **Stale and failure states.** Block the API and confirm a failed request
  renders as **failure**, not as an empty result. Confirm stale source data is
  labelled stale rather than presented as current.
- **Source links.** Every visible claim traces to a source URL that resolves.
- **One full workflow.** Pursue → task created → outcome captured. Then Monitor,
  then Pass, and confirm a passed row stops appearing in default recommendations
  without being mislabelled as source-closed.

---

## 16. The two quiet passes

**This is the acceptance step most likely to fail, and the one worth the most.**

This step used to run both processors twice with no `--commit` and no notice
sync, and asked for "no new alerts." That could not fail: both processors are
dry-run by default and write nothing, so pass 2 recomputed from byte-identical
state and always reported pass 1's number — and with no
`sync-tango-opportunity-notices --commit` first, `tango_opportunity_notice` was
empty, so both passes were quiet about nothing. The correct procedures already
exist in the rollout runbook, and they are different for the two processors.

### 16a. Event drain — rollout §29

Follow the identical procedure in
`docs/runbooks/funding-opportunities-rollout.md` §29 ("Drain webhook events
into alerts"), against `process-tango-events`:

1. Run the notice sync first — the drain reads what that sync holds and does
   not fetch inline:

   ```bash
   sync-tango-opportunity-notices --commit
   ```

2. Dry-run the drain: `process-tango-events`. Record `alertsWritten` and read
   `suppressions`. Rollout §29 has the full 8-row reason table, including why a
   nonzero `volume_capped` on a first drain over existing history is expected
   rather than a failure (D-58).
3. Dry-run it again, **no sync in between**: `process-tango-events`. The second
   run must report the **exact same `alertsWritten`** as the first, and write
   nothing new. Equal, not merely "no new alerts" — if pass 1 was nonzero,
   pass 2 must match that number precisely. If it grows, the fingerprint is not
   stable and the dedupe index will not save you — stop, and do not enable any
   schedule.
4. Commit: `process-tango-events --commit --limit=200`.
5. Dry-run once more. `alertsWritten` must now be `0`, and `alertsDeduped` must
   equal what step 4 committed.

### 16b. Lifecycle pass — rollout §16

`process-funding-opportunity-lifecycle` is **not** covered by rollout §29, and
its quiet-pass check has a different shape: it only persists a baseline
fingerprint inside `if (options.commit)`, so two dry runs prove nothing about
it.

1. `process-funding-opportunity-lifecycle --commit` — expect a large
   `baselined=` count and `alerts=0` on the first run. That is the intended
   silent-baseline behaviour, not a failure: a row with no stored fingerprint
   has never been observed by this pass.
2. Run it `--commit` again **on a separate day**. That second run is the one
   that must be quiet. A second run that emits alerts on unchanged notices is
   the old defect resurfacing, and the schedule must not be enabled.

This command does not emit `alertsWritten` at all — it prints
`alerts=<n> would create`. Do not watch for a field name it never produces.

---

## 17. Rollback rehearsal

Rehearse it; do not merely document it.

1. **Flags off first.** Every tenant-visible capability is separately flag-gated
   and fails closed with a 404.
2. **Then roll API/web to the prior immutable digests** recorded in step 3.
3. Additive data remains. No phase in this program ships a destructive
   migration, so there is nothing to un-migrate.

Record the exact disable command for each flag in the handoff.

---

## Acceptance checklist

- [ ] Baseline diagnostic captured before any flag was enabled
- [ ] Diagnostic shows freshness, counts, linkage, conflicts, missing enrichment, API usage, 429s, and alert quietness
- [ ] Every visible claim traces to a source
- [ ] No cross-client leakage observed
- [ ] **§16a: two dry drains report the SAME `alertsWritten`, after a committed
      notice sync** (equal, not "no new") — and the post-commit dry run reports `0`
- [ ] **§16b: a second `--commit` lifecycle pass, on a separate day, is quiet**
- [ ] Rollback flags and prior service revisions documented **and rehearsed**
- [ ] Canary evidence attached to the P49 handoff
- [ ] **No schedule enabled** — that is P50

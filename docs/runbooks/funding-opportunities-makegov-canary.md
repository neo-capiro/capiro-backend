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
  finally gets answered.
- DIBBS and SBIR/STTR — **P40–P43 are blocked on the provider.**
  `@makegov/tango-node@1.1.0` has no DIBBS method and no SBIR/STTR method
  anywhere in its client surface. Skip step 13 for those two datasets; there is
  nothing to entitle.

---

## 5–13. Capability walk

Enable **one flag**, run the relevant sync **bounded and dry-run first**, then
re-run `diag-funding-opportunities-makegov` and compare against the baseline.

| # | Capability | Flag | Command |
|---|---|---|---|
| 5 | Entity shadow, one reviewed client | `funding_opportunities_tango_shadow` | `sync-tango-entities --client=<id>` |
| 6 | Vehicles for that client | `funding_opportunities_vehicle_fit` | `sync-tango-vehicles --client=<id>` |
| 7 | Forecast bounded sync | `funding_opportunities_forecasts` | `sync-tango-forecasts` |
| 8 | Opportunity parity and history | `funding_opportunities_notice_history` | `sync-tango-opportunity-shadow`, then `sync-tango-opportunity-notices` |
| 9 | One attachment + requirement artifact | `funding_opportunities_documents` | `sync-tango-opportunity-attachments --limit=1` |
| 10 | Government Landscape | `funding_opportunities_government_landscape` | UI only |
| 11 | Meri local assessment | `funding_opportunities_meri_v2` | UI only |
| 12 | Optional MCP | `funding_opportunities_tango_mcp` | **last** — the first real test of the MCP host and header, neither of which P17 could confirm |
| 13 | Risk / budget context | `funding_opportunities_risk_context`, `funding_opportunities_budget_context` | `sync` verbs, if entitled |

After each: **counts should change only for the dataset you just enabled.**
Anything else moving means a flag is wider than it looks.

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

   **Exit 3 means the tier refuses webhook writes** — that finally resolves
   P17's open question, and nothing was left half-configured. Take it to
   MakeGov; do not retry.

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

Run the lifecycle and event processors **twice, with no source change between**:

```bash
process-funding-opportunity-lifecycle
process-tango-events
# …no sync in between…
process-funding-opportunity-lifecycle
process-tango-events
```

The second pass must report **no new alerts**. If `alertsWritten` grows on
unchanged data, the change fingerprint is not stable and the dedupe index will
not save you — stop, and do not enable any schedule.

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
- [ ] **Two manual passes are quiet on unchanged data**
- [ ] Rollback flags and prior service revisions documented **and rehearsed**
- [ ] Canary evidence attached to the P49 handoff
- [ ] **No schedule enabled** — that is P50

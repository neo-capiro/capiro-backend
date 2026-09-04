# Band A — P49 independent review: the canary runbook as a procedural artifact

**Artifact under review:** `docs/runbooks/funding-opportunities-makegov-canary.md` (185 lines).

**Convention:** `docs/runbooks/phase-2-independent-live-validation.md` §6.2 — a reviewer who was
not the implementer, read-only verification, a verdict that is exactly one of two strings, and a
dated approval record.

**Scope:** the runbook reviewed *as a procedure a human will execute against live `capiro-dev`*,
which serves `app.capiro.ai`. Not a code review of the phases it exercises.

**Pinned commit:** `d800dcfde5`. Every citation below was read via `git show d800dcfde5:<path>`
from `C:\dev\capirov2`. No working tree was touched, no AWS call was made, no database was read,
nothing was executed. Line numbers are as of this commit.

**Reviewer independence:** I did not implement, deploy, or author any part of this program or this
runbook.

---

## Verdict

```
P49_CANARY_RUNBOOK_REJECTED
```

Failing sections: **§4, §5, §6, §13, §14, §16, §17**, and the acceptance checklist.

The runbook is well-reasoned prose and its safety *instincts* are right — baseline first, one flag
at a time, dry-run first, rehearse the rollback. But as an executable procedure it fails on four
independent counts, each of which would strand or mislead an operator mid-run on live
infrastructure:

1. The first capability it enables is gated by a flag **no code reads** (§5).
2. The containment argument for its first live-data step rests on a CLI flag that **does not
   exist** and is **silently ignored** (§5, §6).
3. Its single most valuable tripwire — the two quiet passes — is **inert as written** and its
   stated pass criterion is one the code cannot produce (§16).
4. Its rollback returns to the **wrong digests** and leaves client-visible alerts in place (§17).

A fifth item is the one the brief asked me to confirm concretely, and I confirm it: the flag table
has **no row for DIBBS or SBIR**, `funding_opportunities_dibbs` **does not exist anywhere in the
repo**, and the runbook still tells the operator both datasets are blocked — while both syncs and
both matching producers are built and wired at this commit. **§4 and the §5–13 table need a new
section before P49 can be said to cover the current shippable surface.** See F8.

**Do not fix anything from this document in place.** Findings are queued below, severity-ranked,
each with the exact evidence a fixer needs.

---

## What passes

Stated first, because it is substantial and a rejection should not imply the document is worthless.

- **Every command name resolves.** I checked all 19 verbs the runbook names against
  `apps/api/scripts/entrypoint-dispatcher.inc` individually. All 19 exist as container verbs, all
  forward `"$@"`, and all point at a script file that exists at this commit. There is **no**
  renamed-or-never-built script in this runbook. That was the brief's first concern and it is
  clean.
- `migration-status` (§2) is the correct verb — `apps/api/scripts/entrypoint.sh:44`. Not
  `migrate-status`.
- §2's `startedBy` warning is accurate and load-bearing. Two EventBridge rules do target the
  `capiro-dev-api-migrate` family unpinned, and the `aws ecs describe-tasks` query given is correct.
- §0's claim about the main diagnostic is true: `diag-funding-opportunities-makegov.ts` is
  SELECT-only, makes no provider call, and deliberately does not read `TANGO_API_KEY`
  (script header, and `parseArgs` at `:59-71`).
- §14 step 4 is the one step in the document that is genuinely precise: `verified webhook
  deliveries` is a real, cumulative count (`diag-funding-opportunities-makegov.ts:215`, over
  `tango_webhook_delivery`), so "incremented by exactly 1" against the §0 baseline is checkable
  without improvisation.
- The "one rule" (one flag at a time, diagnostic between each) is the correct discipline. The
  findings below are about it not being executable, not about it being wrong.

---

## P0 — blocking

### F1. §5 enables a flag that no code reads (`funding_opportunities_tango_shadow`)

`git grep "tango_shadow" d800dcfde5` returns exactly **two** hits in the entire tree:

- `apps/api/prisma/migrations/20260821010000_tango_source_substrate/migration.sql:23`, in a comment
- `docs/runbooks/funding-opportunities-makegov-canary.md:79`, the runbook line itself

There is no constant, no guard subclass, no service read. The migration's own comment says so
plainly:

> `funding_opportunities_tango_shadow` — the flag that *will eventually* gate the sync jobs that DO
> call it — is not read by anything this migration touches, and stays off.

Consequences, all in the runbook's own terms:

- Step 5 is the *first* capability in the walk, and the "counts should change only for the dataset
  you just enabled" rule is evaluated against it. Any count change at step 5 is caused entirely by
  the sync run; attributing it to the flag is a false inference the runbook invites.
- §17.1's blanket claim — *"Every tenant-visible capability is separately flag-gated and fails
  closed with a 404"* — is false for this row. Turning it off in a rollback protects nothing.
- Compare the ten real guards enumerated in the peer review in this directory
  (`flag-ui-reconciliation.md` §4 Q3). `_tango_shadow` is not among them.

**Queue:** either delete the row, or replace it with the guard/flag that actually gates the entity
shadow path, or mark it explicitly as "reserved, reads nothing today — enabling it is a no-op" so
the operator does not draw a conclusion from it.

### F2. §5/§6's `--client=<id>` does not exist, is silently ignored, and both syncs are all-tenant

The runbook's commands:

| # | Runbook command | Reality |
|---|---|---|
| 5 | `sync-tango-entities --client=<id>` | `parseArgs` reads **only** `--limit` and `--commit` — `sync-tango-entities.ts:88-95` |
| 6 | `sync-tango-vehicles --client=<id>` | `parseArgs` reads **only** `--limit` and `--commit` — `sync-tango-vehicles.ts:87-94` |

Unknown arguments are not rejected — they are dropped. The operator gets no error, no warning, and
a summary that looks exactly like a successful scoped run.

And the scope is not the internal tenant. `sync-tango-entities.ts`'s own header:

> For every client with a UEI — **across ALL tenants** — fetches the Tango … keyed by that same UEI.

`sync-tango-vehicles.ts` is the same shape: `loadKnownUeisReal` (`:271-284`) does
`tx.client.findMany({ where: { uei: { not: null } } })` with no tenant predicate.

This directly contradicts the runbook's own first line — **"Scope: the internal tenant only"** — and
its step-5 label, "Entity shadow, **one reviewed client**". The containment story for the first
live-data step in the whole canary is fictitious. Add `--commit` (which the runbook says to do —
"dry-run first" — but never shows) and it is an unbounded, cross-tenant provider walk against a
rate-limited account.

**Queue:** either add real `--client`/`--tenant` narrowing to both scripts, or rewrite steps 5–6 to
state honestly that these syncs are global and bound them with `--limit`, or gate them behind a
tenant-scoped precondition. Do not ship a runbook whose containment claim is a flag the parser
throws away.

### F3. §16's two quiet passes cannot detect what they exist to detect

§16 is billed as *"the acceptance step most likely to fail, and the one worth the most."* As
written it is inert.

Both commands are **dry-run by default**, and §16 invokes neither with `--commit`:

```
process-funding-opportunity-lifecycle
process-tango-events
# …no sync in between…
process-funding-opportunity-lifecycle
process-tango-events
```

- `process-funding-opportunity-lifecycle.ts` builds `snapshotData` carrying `sourceFingerprint`
  at `:517-523`, and writes it **only** inside `if (options.commit)` at `:526`. A dry run persists
  no baseline.
- `process-tango-events.ts` performs no insert, no lease, and no status change without `--commit`
  (header, and `:558-562`).

So pass 2 recomputes from byte-identical state and reports the **same** number as pass 1. It is
never zero unless pass 1 was zero. The runbook's criterion — *"The second pass must report **no new
alerts**"* — is not a criterion the code can satisfy.

The rollout runbook states the correct dry-run criterion, at `funding-opportunities-rollout.md`
§29:

> run the dry run twice with no sync in between. The second run must report the **same**
> `alertsWritten` and write nothing new. If the number **grows**, the fingerprint is not stable.

Two concrete failure modes for an operator following §16 literally:

1. A healthy canary reports the same nonzero `alertsWritten` twice, the operator reads "no new
   alerts" as "zero", and **aborts a working canary** — §16 says "stop, and do not enable any
   schedule."
2. §16 omits the prerequisite rollout §29 states — *"Run the notice sync FIRST — the drain reads
   what that sync holds and does not fetch inline."* Without it `process-tango-events` finds nothing
   pending, both passes report 0, the box gets ticked, and **nothing was tested**. This is exactly
   the "silently did nothing" class the brief asked about.

§16 also omits the only version of this test that proves fingerprint stability across a persisted
write — rollout §29's `process-tango-events --commit --limit=200` followed by *"Re-run the dry run
afterwards. `alertsWritten` must be 0 and `alertsDeduped` should equal what the commit wrote."*

**Queue:** rewrite §16 against rollout §29: notice sync first; dry run twice and compare for
*equality*, not zero; then commit; then re-run and require `alertsWritten == 0` and
`alertsDeduped ==` what the commit wrote. State the expected numbers, not an adjective.

### F4. §14's exit-3 claim is wrong, and §14 therefore cannot answer the question it says it answers

§4 tells the operator that `webhook_write_apis` is unresolved and *"step 14 is where it finally gets
answered."* §14 step 3 then says:

> Dry-run the reconciler. It writes nothing:
> `reconcile-tango-webhook-alerts`
> **Exit 3 means the tier refuses webhook writes**

Reading `reconcile-tango-webhook-alerts.ts`:

- A **dry run** returns `EXIT_DRIFT` (**5**) when there is work, or `EXIT_OK` (**0**) when desired
  state already matches (`:225-233`). On a fresh canary, 5 is the *expected* result.
- Exit **3** on a dry run is reachable from exactly one place: `listWebhookEndpoints` /
  `listWebhookAlerts` throwing a tier denial (`:190-206`). That branch's own message says
  *"Provider refused the webhook **READ** APIs on this account tier … this is a change in
  entitlement, not an expected state."* That is the opposite of what §14 tells the operator it
  means.
- The **write** tier denial that would settle P17's question lives inside the commit loop
  (`:265-280`) and is unreachable without `--commit --endpoint-id=<uuid> --confirm-callback=<url>`.

§14 never gives that commit invocation. It also never mentions exits 2, 4, or 5, and omits rollout
§28's mandatory follow-up (*"Re-run the dry run afterwards. **It must report no work.**"*). The
rollout runbook has the full five-row exit table at §28; the canary compressed it to one row and
compressed it wrong.

A secondary trap: §14 invokes the reconciler bare. `resolveEndpoint` (`:137-161`) returns
`EXIT_ENDPOINT_UNRESOLVED` (**4**) when the account has more than one endpoint and no
`--endpoint-id` is supplied. The runbook does not mention this.

**Queue:** replace §14 step 3 with rollout §28's exit table verbatim; state that 5 is the expected
first-run result; either add the commit invocation and its interlocks, or delete §4's claim that
step 14 resolves `webhook_write_apis` — a write question cannot be answered by a read.

---

## P1 — must be fixed before this is executed

### F5. §17 rolls back to the wrong digests; the pre-canary state is never recorded

§3: *"API and web task definitions reference an image **digest** resolved from the merge SHA…
Record both digests in the P49 handoff; **they are what a rollback returns to**."*

The digests "resolved from the merge SHA" are the **canary's own**. §17.2 — *"Then roll API/web to
the prior immutable digests recorded in step 3"* — therefore points at the build you are trying to
back out of. Nothing anywhere in the runbook captures the **pre-canary** task-definition revision or
running digest.

Rollout §26 does this correctly, and by the mechanism ECS actually offers:

```
aws ecs update-service … --service capiro-dev-api --task-definition capiro-dev-api:<previous-rev>
```

Note also that "roll to a digest" is not an ECS operation — you roll to a *revision*. §17 gives an
operator a noun they cannot act on.

**Queue:** §3 must record the **currently live** revision and running digest for `capiro-dev-api`
and `capiro-dev-web` *before* the canary deploy, and §17.2 must name those revisions. Rollout §6's
warning applies and should be carried over: verify the *running* digest, not the task-definition
revision.

### F6. §17 has no remediation for alerts the canary produced

§17.3 says *"Additive data remains"* as reassurance. But the canary deliberately writes
client-visible rows: `clio_proactive_alert` (lifecycle, `process-funding-opportunity-lifecycle.ts:
532-548`) and `tango_event_alert` (drain). Turning flags off and rolling code back does not withdraw
an alert a user already received.

Rollout §26 covers exactly this — *"lifecycle alerts are deduped on `source_id`, so deleting a batch
is safe: the pass will not recreate them unless the source genuinely changed again"* — with the
query. §17 does not, even though §14 and §16 are the two steps most likely to generate them, and
`tango-event-processor.service.ts:286-294` warns that a first drain over an existing history could
"page a whole tenant."

**Queue:** add an alert-remediation step to §17 with rollout §26's dedupe reasoning and the
`source_id` scoping needed to delete only what the canary produced.

### F7. The flag table does not match the codebase, in both directions

The §5–13 table lists 10 flags. Against the code at this commit:

**In the table but read by nothing:** `funding_opportunities_tango_shadow` (F1).

**Defined in code, never mentioned by the runbook, and required by the runbook's own §15:**

| Flag | Defined at | Why §15 needs it |
|---|---|---|
| `funding_opportunities` (master) | `funding-opportunities-flag.guard.ts:6` | Class-level guard on the whole controller. Nothing in §15 is reachable without it; the runbook never says whether it is presumed already on. |
| `funding_opportunities_client_inbox` | `:16` | §15's first acceptance item is "The inbox." `FundingOpportunitiesInboxFlagGuard` 404s the inbox route when off. |
| `funding_opportunities_pipeline_v2` | `:94` | §15's "One full workflow. Pursue → … Then Monitor, then Pass." The guard's own docblock: *"Gates the pursuit pipeline board and every stage transition."* |
| `funding_opportunities_sbir` | `apps/web/…/funding-opportunities-api.ts:419` | See F8. |

So §15 — the human browser-acceptance section — depends on at least three flags that §5–13 never
turns on. The "one flag at a time" discipline silently breaks at the section where a person is
actually looking at the product.

**Queue:** reconcile the table against `funding-opportunities-flag.guard.ts` and
`meri-mcp.catalog.ts:168`, and state explicitly which flags are preconditions (already on before the
canary starts) versus which the canary itself enables.

### F8. DIBBS and SBIR: confirmed absent from the runbook, and the runbook's stated reason is stale

This is the item the brief asked me to confirm concretely. Confirmed, with the following specifics.

**The flags.**

- `git grep "funding_opportunities_dibbs" d800dcfde5` → **zero matches**, repo-wide, including docs.
  There is no constant to import, no guard, no web key. (The peer review in this directory reaches
  the same conclusion independently, `flag-ui-reconciliation.md` §3.)
- `funding_opportunities_sbir` exists in **`apps/web` only** —
  `apps/web/src/pages/intelligence/opportunities/funding-opportunities-api.ts:419`. Zero occurrences
  under `apps/api` or `apps/intel-api`.
- **Neither appears anywhere in the canary runbook.** The §5–13 table has no row for either.

**The runbook's stated reason is stale.** §4 says:

> DIBBS and SBIR/STTR — **P40–P43 are blocked on the provider.** `@makegov/tango-node@1.1.0` has no
> DIBBS method and no SBIR/STTR method anywhere in its client surface. Skip step 13 for those two
> datasets; there is nothing to entitle.

That sentence is quoted, essentially verbatim, from `diag-tango-capabilities.ts`'s header (`:19-23`).
It is a true statement **about the SDK's method surface** and a stale statement about **what is
shippable**. At `d800dcfde5`:

| Artifact | Exists | Wired as container verb |
|---|---|---|
| `apps/api/scripts/sync-tango-dibbs.ts` | yes | `entrypoint-dispatcher.inc:618` |
| `apps/api/scripts/sync-tango-sbir.ts` | yes | `:638` |
| `apps/api/scripts/generate-dibbs-opportunity-candidates.ts` | yes | `:545` |
| `apps/api/scripts/generate-sbir-opportunity-candidates.ts` | yes | `:548` |

All four are pinned by `apps/api/scripts/funding-opportunities-entrypoint.spec.ts`, which describes
the two producers as *"the ONLY path to visibility for DIBBS/SBIR."* The schema is applied:
`20260908010000_tango_dibbs` creates `tango_dibbs_solicitation` and `tango_dibbs_award`; the SBIR
migration creates `tango_sbir_solicitation` and `tango_sbir_topic`. Both syncs were written against
the published REST contract (`docs/plans/funding-opportunities-makegov-v1/dibbs-sbir-rest-contract.md`)
rather than the SDK, which is precisely why the SDK-surface argument no longer settles the question.

**Why the omission is urgent rather than cosmetic.** `sync-tango-dibbs.ts`'s own header:

> **NOTHING HERE HAS EVER SEEN A REAL RESPONSE** … A separately authorized live contract-validation
> run is still required before any of this is trusted, and any mismatch it finds is a CONTRACT UPDATE
> AND A NEW FIXTURE, never a permissive fallback here.

A first live contract-validation run against real provider data, bounded, on the internal tenant, is
*exactly* what a canary is for — and P49 has no step for it. Worse, the usual containment the canary
leans on does not exist here: per the peer flag/UI review, the DIBBS rail has **no gate at any
layer**, and its darkness today is an accident of blocked ingestion, not a control. The moment a
producer is run with `--commit`, bid-board rows appear in every user's inbox on that tenant with no
flag that could stop them.

**Also wrong in §4:** *"Skip **step 13** for those two datasets"* — step 13 is
`funding_opportunities_risk_context` / `_budget_context`, not DIBBS/SBIR. This is a stale
cross-reference to a renumbered step, and it points the operator at the wrong row.

**Queue — this is the "runbook needs a new section for X" item:**

1. Replace §4's DIBBS/SBIR paragraph. Keep the true part (the SDK exposes no such method) and
   correct the conclusion (both are implemented against the REST contract and are shippable).
2. Fix the "step 13" cross-reference.
3. Add capability rows to the §5–13 table for DIBBS and SBIR — with the honest note that
   `funding_opportunities_dibbs` **does not exist** and must either be created or explicitly
   excepted before that row can mean anything (see the peer review's recommendation 2), and that
   `funding_opportunities_sbir` is web-only with no API-side guard.
4. Add a dedicated section for the **first live DIBBS/SBIR contract-validation run** —
   `sync-tango-dibbs` / `sync-tango-sbir` dry-run, then bounded `--commit --limit=…`, with the
   `--full` semantics both headers document, and with an explicit expectation that a field mismatch
   is a contract update, not a canary failure.
5. Note the account-wide rate limit (25 req / ~31s, D-75–D-78) as a scheduling constraint on that
   section.

### F9. §14 step 2 points at a CDK deploy the program forbids, with no warning

> 2. Set `externalSecretArns.tangoWebhookSecret` and roll API serve.

That value is consumed at `infra/cdk/lib/compute-stack.ts:306-311` and injected at `:538-539`.
Getting it onto a live task definition normally means deploying `Capiro-dev-Compute` — which the
rollout runbook forbids in three separate places:

- line 52: *"**Do NOT run `cdk deploy Capiro-dev-Compute`.** That stack holds dead-ALB values"*
- §26: *"**Hard boundary, restated:** do not deploy the drifted `Capiro-dev-Compute` stack under any
  circumstances, including rollback."*
- §30: *"The tracked Compute stack is drifted; enabling live rules is an out-of-band operation until
  that drift is [resolved]."*

§14 says "roll API serve" with no mechanism, no cross-reference, and no warning — on the cluster that
serves `app.capiro.ai`. This is the single instruction in the document most likely to cause an
operator to do the forbidden thing, and the blast radius is user-facing.

Rollout §27 also carries a detail §14 drops: setting the ARN *before* the secret exists makes every
new serve task fail to start ("unable to pull secrets" → circuit-breaker rollback). §14 has the two
steps in the right order but does not say why the order matters.

**Queue:** state the out-of-band mechanism explicitly (hand-registered task-def revision, image
unchanged, prior revision retained), reproduce the hard boundary, and carry over rollout §27's
ordering warning.

---

## P2 — would force improvisation

### F10. No invocation form appears anywhere in the runbook

Every command is a bare container verb. That convention is real — all 19 resolve in
`entrypoint-dispatcher.inc` — but the runbook never states the task definition
(`capiro-dev-api-sync-jobs`), the cluster, `$NETCFG`, or the `aws ecs run-task --overrides` shape.
Rollout §28 supplies it. The canary cross-references the rollout runbook exactly **once**, in §14,
and only for the secret. An operator handed only this document cannot execute **step 0**.

### F11. The runbook never gives a flag enable or disable command — and the obvious script may be the wrong one

§5–13's entire premise is "enable one flag at a time." The mechanism is never named. §17 defers it:
*"Record the exact disable command for each flag in the handoff"* — so the rollback's first step has
no command in the document that will be read under time pressure.

There is a trap here the runbook does not flag. `apps/api/scripts/set-tenant-flag.ts` (dispatcher
verb at `:210`; usage `--slug <tenant-slug> --flag <flag.key> --value <true|false> [--commit]`,
dry-run by default) writes `tenants.settings_jsonb.clioFeatureFlags`. The Funding Opportunities
guards read the **`intel_feature_flag` table** —
`funding-opportunities-flag.guard.ts:139-152`, `withSystem`, no `::uuid` cast — which intel-api
owns. **Those are different stores.** An operator reaching for the one obvious flag script in the
repo would set a key nothing in this feature reads, see no change, and have no idea why. D-79 names
the correct instrument instead: *"the `enable-feature` verb on intel-api's task runner."*

**Queue:** name the correct verb and its full invocation for both enable and disable, once, in §5,
and repeat the disable form in §17. Confirm which store is authoritative before execution.

### F12. Three of the nine capability steps produce data the P49 diagnostic cannot see

`diag-funding-opportunities-makegov.ts` is the canary's only instrument. It reports freshness for 5
tables (`:191-196`) and counts for 7 (`:210-218`). A grep of the whole script for `vehicle`,
`attachment`, `dibbs`, `sbir` returns **nothing**.

| Step | Writes to | In the diagnostic? |
|---|---|---|
| 6 — vehicles | `client_relevant_vehicle` (migration `20260824010000`), `tango_resource_snapshot` | **no vehicle measurement** |
| 9 — attachments | attachment metadata + S3 objects | **no** |
| (F8) DIBBS / SBIR | `tango_dibbs_solicitation`, `tango_sbir_topic`, … | **no** |

So for those steps the rule "counts should change only for the dataset you just enabled" is
unenforceable: baseline and post-step output are **identical** whether the sync worked perfectly or
did nothing at all. (`tango_resource_snapshot` moves for the vehicle sync, but that is a shared
substrate count that also moves for entities — it cannot attribute.)

### F13. §4 mischaracterises `diag-tango-capabilities` as a harmless read

§0 primes the reader with *"The diagnostic is SELECT-only, needs no MakeGov key."* §4 then lists
`diag-tango-capabilities` under a `# read-only` comment. It is not that kind of read:

- It makes **live HTTP calls against the real MakeGov account** — *"makes ZERO database
  connections; its entire job is a handful of live HTTP calls against the real Tango account"*
  (script header).
- It requires `TANGO_API_KEY` and exits immediately without one (`:109`, `:142`).
- Its own header records the account's **measured** limit — 25 requests per ~31s, observed
  2026-08-08 — and describes a prior run that died mid-probe and *"looked, in the report, exactly
  like a broken capability."*

§4 gives no key-injection form (rollout §"P17" does: *"fetch and inject in one command"*), no
`--request-ceiling`, and no mention of the rate limit. Given D-75–D-78 record the account as
rate-limit-blocked, spending the window here silently can invalidate the rest of the session.

### F14. Purpose-built diagnostics the canary never runs

- `diag-tango-opportunity-parity` (dispatcher `:684`) — step 8 is literally titled *"Opportunity
  parity and history"* and never runs it.
- `diag-tango-webhook-contract` (dispatcher `:668`, and a registered package script) — §14 is the
  webhook section and never runs it.

### F15. `alertsWritten` is only emitted by one of the two commands §16 names

`process-tango-events` prints it — `ProcessSummary.alertsWritten`,
`tango-event-processor.service.ts:278`, rendered at `process-tango-events.ts:558-559`.
`process-funding-opportunity-lifecycle` prints `alerts=<n> would create`
(`process-funding-opportunity-lifecycle.ts:651-655`). There is **no field named `alertsWritten`** in
the lifecycle output. §16 tells the operator to watch a field that half the commands do not emit.

### F16. §16 omits `suppressions`, so "quiet" is not distinguishable from "swallowed"

Rollout §29 documents an 8-row `suppressions` reason table (`baselined_first_observation`,
`no_change`, `below_materiality`, `human_declined`, `terminal_stage`, `stage_not_engaged`,
`volume_capped`) and warns explicitly that a nonzero `volume_capped` on a first drain over an
existing history is **expected and not a failure** (D-58). §16 mentions none of it. Without it the
canary operator cannot tell "quiet because nothing changed" from "quiet because
`MAX_ALERTS_PER_EVENT_PER_CLIENT` swallowed it."

### F17. Step 13's command column is not a command

> | 13 | Risk / budget context | `funding_opportunities_risk_context`, `funding_opportunities_budget_context` | `sync` verbs, if entitled |

Two flags, no verb names, and an unexplained conditional. Contrast every other row, which names a
concrete verb.

---

## Mandatory question: would the acceptance checklist catch a step that silently did nothing?

**No.** Not in general, and not in the specific cases below. The checklist is eight boxes, and its
only evidentiary instrument is the P49 diagnostic. Four independent ways a no-op passes:

1. **§16, the flagship tripwire, is itself the clearest example.** Both processors are dry-run by
   default and §16 omits `--commit` (F3). Nothing is persisted on either pass, so the test compares a
   computation against itself. If §16's missing prerequisite is also missing at runtime — the notice
   sync that rollout §29 requires *first* — both passes report zero, the operator ticks
   *"**Two manual passes are quiet on unchanged data**"*, and the fingerprint stability that box
   exists to certify was never exercised. A checklist item that is satisfied *more easily* when the
   underlying step did nothing is worse than no item.

2. **Three capability steps are invisible to the only instrument (F12).** Steps 6 and 9 — and any
   DIBBS/SBIR step added per F8 — write to tables the diagnostic does not query. The box
   *"Diagnostic shows freshness, counts, linkage, conflicts, missing enrichment, API usage, 429s, and
   alert quietness"* will be truthfully tickable while a vehicle sync that returned zero rows and a
   vehicle sync that returned ten thousand look identical.

3. **A silently-ignored argument produces a confident wrong summary (F2).** `--client=<id>` is
   dropped by `parseArgs`, and the run prints a normal summary. The operator has positive evidence
   of a scoped run that never happened. Checklist item *"No cross-client leakage observed"* is
   ticked on the strength of a scope that was never applied.

4. **A no-op flag is indistinguishable from a working one (F1).** Enabling
   `funding_opportunities_tango_shadow` changes nothing, anywhere. The step "succeeds."

The one checklist item that *would* catch a no-op is the §14 webhook count — *"`verified webhook
deliveries` incremented by exactly 1"* — because it names a specific table, a specific delta, and a
baseline to compare against. That is the pattern the rest of the checklist needs: **a named
measurement, an expected number, and a baseline**, not an adjective like "quiet" or "documented."

**Queue:** rewrite the acceptance checklist so every box cites the diagnostic section and the
expected delta that satisfies it, and add a box that fails when the diagnostic has *no measurement*
for a step that was executed.

---

## Findings queue — summary

| # | Sev | §  | Finding |
|---|-----|----|---|
| F1 | P0 | 5 | `funding_opportunities_tango_shadow` is read by no code at this commit |
| F2 | P0 | 5, 6 | `--client=<id>` does not exist, is silently dropped; both syncs walk all tenants |
| F3 | P0 | 16 | Two quiet passes are dry-run-only; stated pass criterion is unachievable; prerequisite sync omitted |
| F4 | P0 | 4, 14 | Exit-3 claim is wrong; a write-tier question cannot be answered by a dry run; exits 2/4/5 and the commit form omitted |
| F5 | P1 | 3, 17 | Rollback targets the canary's own digests; pre-canary revision never recorded |
| F6 | P1 | 17 | No remediation for client-visible alerts the canary produced |
| F7 | P1 | 5–13, 15 | Flag table omits master, `_client_inbox`, `_pipeline_v2`, `_sbir`; §15 depends on flags never enabled |
| F8 | P1 | 4, 5–13 | **No DIBBS/SBIR section.** `funding_opportunities_dibbs` does not exist repo-wide; `_sbir` is web-only; §4's "blocked on the provider" is stale — both syncs and both producers are built and wired; "step 13" cross-reference is wrong |
| F9 | P1 | 14 | "Set `externalSecretArns…` and roll API serve" points at a forbidden CDK deploy, unwarned |
| F10 | P2 | all | No `aws ecs run-task` invocation form anywhere; cross-references rollout runbook once |
| F11 | P2 | 5–13, 17 | No flag enable/disable command; `set-tenant-flag` writes a different store than these guards read |
| F12 | P2 | 6, 9 | Diagnostic has no vehicle, attachment, DIBBS or SBIR measurement |
| F13 | P2 | 0, 4 | `diag-tango-capabilities` presented as a harmless read; needs a key, spends the rate-limit window |
| F14 | P2 | 8, 14 | `diag-tango-opportunity-parity` and `diag-tango-webhook-contract` exist and are never used |
| F15 | P2 | 16 | `alertsWritten` is not emitted by `process-funding-opportunity-lifecycle` |
| F16 | P2 | 16 | `suppressions` and the `volume_capped` caveat omitted |
| F17 | P2 | 13 | "`sync` verbs, if entitled" is not a command |

---

## Approval record

**Verdict: `P49_CANARY_RUNBOOK_REJECTED`** — 2026-08-13, by an independent reviewer who did not
implement, deploy, or author any part of this program or this runbook. Pinned to `d800dcfde5`.
Read-only throughout: no AWS call, no database read, no execution, no working tree touched, nothing
committed.

Failing sections: §4, §5, §6, §13, §14, §16, §17, and the acceptance checklist.

Re-review should be scoped to the queue above. The document's structure and reasoning are sound; it
is the executable layer — argument surfaces, exit codes, invocation forms, rollback targets, and the
flag inventory — that does not currently match the code it drives.

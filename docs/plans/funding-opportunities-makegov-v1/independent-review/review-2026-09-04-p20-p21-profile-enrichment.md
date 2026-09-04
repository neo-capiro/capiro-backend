# Band B — {P20, P21} client-profile enrichment cluster, independent §6.2 review

**Scope:** P20 (client profile enrichment review workflow) and P21 (versioned
Federal Business Profile) — with emphasis on the SEAM between them and on the
seam from both into the shared matching path
(`readClientProfileFactsMany` → `buildClientOpportunityProfile`,
`apps/api/src/funding-opportunities/client-opportunity-profile.*`).

**Reviewer:** Claude (general-purpose subagent; runtime-reported model
`claude-fable-5-1`). Did not implement, merge, or deploy P20 or P21. Read-only
against the repository at the pin; read-only against `capiro-dev` (no `put-*`,
no enable/disable; the only task launched was one `capiro-dev-api-diag:8`
`db-inspect` run executing SELECTs inside a transaction). No secret value was
read or printed. One throwaway jest spec was written inside the worktree to
exercise the real service, run once, and deleted; the worktree was verified
clean afterwards.

**Commit under review:** `origin/main` @ `1c7ed27fa82e171b7d9259f6c94d49e360cae985`,
checked out in worktree `C:\dev\capiro-review-p20p21` (verified `git rev-parse
HEAD` matches and `git status --short --untracked-files=all` is empty at start
and at end). All `file:line` references below are at this SHA.

**Implementer claims tested:** the P20/P21 sections of
`C:\Users\neoma\Downloads\funding-opportunities-makegov-shippable-microphase-plan.md`
(lines 1433–1535), the P20/P21 rows of
`docs/plans/funding-opportunities-makegov-v1/completion-matrix.md` at the pin
(lines 91–92), the implementer commits `b4ddd209f` (P20, PR #783) and
`882fd7f69` (P21), and decision-log entries D-37…D-40. Matrix, decision-log and
handoff prose were treated as CLAIMS to be tested, not as evidence.

**Trusted without re-derivation:** that `PrismaService.withTenant` sets
`app.current_tenant_id` and that `rls_bypass()` / `current_tenant_id()` behave
as documented (reviewed and proven live by earlier bands). **Not trusted:**
anything the matrix says about behaviour; the decision-log's "real service run
against real RLS" (D-39) — it proves what it ran, not the cases below.

**Verdict vocabulary** (per `docs/runbooks/phase-2-independent-live-validation.md`):
`PASS` / `FAIL` per phase, plus a cluster-level seam verdict.

---

## Verdict

| Item | Verdict |
|---|---|
| **P20** — client profile enrichment review workflow | **FAIL** — F-1, F-2 (High); F-4, F-5 (Medium) |
| **P21** — versioned Federal Business Profile | **FAIL** — F-3 (High): the phase as specified is not delivered; what exists is a correct but unconsumed diagnostic read view |
| **Cluster seam** P20 → P21 → `readClientProfileFactsMany` / `buildClientOpportunityProfile` | **FAIL** — the only seam is the flat `clients` columns; P21 sits beside it, not in it; provenance is destroyed at the moment a fact becomes score-affecting (F-2); and nothing on the path has ever executed in `capiro-dev` (F-6) |
| Live-verifiable success assertion, either phase | **NONE** (see "Live-verifiable success assertion?") |

What does hold, and is credited below: the new table is RLS-ENABLED + FORCED
with four policies both in the migration and live; every service method runs
inside `withTenant`; a cross-tenant candidate id is a `NotFoundException`;
accept and status-flip share one transaction; there is genuinely no bulk-review
method; array fields are additive-only and a null provider CAGE proposes
nothing. Those are the acceptance bullets that pass. They do not outweigh a
write path that can silently discard a human's edit and records no audit.

---

## Correcting the brief's premises

The brief asked four questions built on premises that do not match the code at
the pin. Recording the corrections so the answers below are read correctly.

1. **"Does an approved proposal land in the versioned profile (P21)?"** —
   P21 has **no persisted profile and no version table**. `882fd7f69` touched
   13 files, none of them a migration or `schema.prisma`
   (`git show --stat 882fd7f69`). `FederalBusinessProfileService.getProfile`
   (`apps/api/src/funding-opportunities/federal-business-profile.service.ts:74-119`)
   is a read-only aggregation: it re-reads `clients` (as `firstParty`), reads
   the GLOBAL P15 `tango_resource_snapshot` history (as `history` / `verified`),
   and lists pending P20 candidates. "Versioned" was reinterpreted to mean the
   Tango snapshot `version` column (decision-log D-40). So an approved proposal
   lands in **`clients`**, and P21 merely shows it back as first-party.
2. **"Is versioning append-only with a coherent current pointer, and does
   supersession behave?"** — those properties belong to P15's snapshot store,
   which P21 only reads. P21 derives `verified` from the `active` flag rather
   than array position (service.ts:114; spec line 119). Not re-reviewed here;
   there is no P21 versioning to review.
3. **"Is review/approval admin-gated server-side?"** — there is **no server
   surface at all**. The plan's `client-profile-enrichment.controller.ts` and
   `IntelligenceMappingsPage.tsx` changes (plan lines 1447–1452; the plan's
   surface table at line 353 says "Admin UI") were not delivered. Review happens
   only via the CLI `apps/api/scripts/review-tango-enrichment-candidate.ts`,
   dispatched as an ECS task (`apps/api/scripts/entrypoint-dispatcher.inc:648`).
   See F-5.
4. **`ingestion-schedule.ts` is not in `apps/api/src`** — the schedule entry is
   `infra/cdk/lib/ingestion-schedule.ts:696-704`, `enabled: false`.

---

## Findings

Severity: High = an acceptance bullet of the phase is violated or the phase's
stated goal is not met; Medium = a documented property is weaker than claimed
or a control is missing; Low = hygiene.

### F-1 (High, P20) — Accepting a candidate overwrites the LIVE client field with the proposal-time snapshot; concurrent human edits are silently discarded

`reviewCandidate` applies `candidate.proposedValueJsonb` directly:

```
apps/api/src/funding-opportunities/client-profile-enrichment.service.ts
276:      if (input.status === 'accepted') {
279:        await tx.client.update({
280:          where: { id: candidate.clientId },
281:          data: { [candidate.field]: candidate.proposedValueJsonb as never },
```

`proposedValueJsonb` is `unionPreservingOrder(current, incoming)` computed at
**proposal** time (service.ts:199-200, helper at 104-114). The migration's own
header (`apps/api/prisma/migrations/20260823010000_client_profile_enrichment_candidates/migration.sql`,
"WHAT A ROW IS") explains that `current_value_jsonb` is a snapshot "so a
reviewer sees exactly what would change even if the client's live value has
since moved on" — but nothing re-reads the live value or merges at accept time.
A candidate created on Monday and accepted on Friday replaces whatever a CRM
user added on Wednesday.

**Reproduced** against the real service with a hand-rolled Prisma fake (same
shape as the shipped spec's `fakePrisma`); probe file since deleted:

```
PROBE-1: client naics ['541511']; Tango entity naics ['541512']
  proposeCandidatesForClient -> 1 candidate, proposedValueJsonb ['541511','541512']
  (human edits CRM) client.naicsCodes = ['541511','541330']
  reviewCandidate(accepted) -> client.naicsCodes === ['541511','541512']   PASS
  -> '541330' is gone.
```

This is the phase's Goal inverted ("reviewable proposals rather than silent
client-profile edits", plan line 1441) and violates "Unknown or stale ... never
clear an existing Capiro value" (plan line 1461) — the stale thing here is the
candidate. For `cageCode` the same write replaces a scalar. The shipped spec
(`client-profile-enrichment.service.spec.ts:298`) only tests accept with an
unchanged client.

### F-2 (High, P20 + seam) — Acceptance writes no audit row, bypasses the platform's client update path, and destroys provenance at the exact point the fact becomes score-affecting

Plan (lines 1458, 1467): "Acceptance uses existing client update services and
writes audit + candidate transition atomically" / "Accepted value carries
provider/source provenance in audit." Code: a direct `tx.client.update`
(service.ts:279) and a candidate `update` (service.ts:285) — `grep -n -i audit`
over the service returns **zero** lines. The platform convention it bypasses is
real: `apps/api/src/clients/clients.service.ts:1625` writes `tx.auditLog.create`
with `action`, `actorRole`, `before` / `after` on client mutations.

**Reproduced:** PROBE-3 ran `reviewCandidate(accepted)` against a fake `tx`
that has **no** `auditLog` or `user` model at all; it succeeded and returned
`reviewedBy: 'not-a-user-anywhere'`.

Seam consequence: `clients.naics_codes` / `psc_codes` /
`set_aside_certifications` / `cage_code` are flat columns (schema.prisma:741-793).
The matching path reads exactly those
(`client-opportunity-profile.repository.ts:72-76` `CLIENT_PROFILE_SELECT` ->
`toClientProfileFacts` :190-224 -> `buildSamProfile` in
`client-opportunity-profile.builder.ts` -> `profileFingerprint` :141-149). So
the approved value DOES reach both producers and read-time — the seam
mechanically works — but once there, nothing can distinguish a Tango-sourced
code from a human-entered one. The only provenance is the candidate row's
`reviewed_by` UUID (unvalidated, F-5), joinable back only by matching JSON
values. This also falsifies P21's acceptance bullet "Approved NAICS/PSC/business
facts can affect scoring **with provenance**" (plan line 1527).

Side observation (pre-existing, P01 territory, not charged to this cluster):
`cageCode` enters the shared profile only as the boolean `hasCageCode` inside
`completeness` (builder.ts:100), which is **outside** `profileFingerprint`'s
input (`{grant, sam, identityBasis}`, builder.ts:141-149). An accepted CAGE
*change* therefore does not move the P01 fingerprint.

### F-3 (High, P21) — The phase as specified was not delivered; what shipped is a read-only diagnostic view consumed by nothing

Plan P21 (lines 1486–1533) specifies: `federal-business-profile.types.ts` with
`FederalBusinessProfileV1`; every field carrying origin / reviewed state /
as-of / confidence band; changes to `client-opportunity-profile.builder.ts`;
"profile fingerprint/version is used by read-time and both producers";
consumption by "reads, producers, recommendations, and Meri". At the pin:

- No `federal-business-profile.types.ts`; no `FederalBusinessProfileV1` symbol
  anywhere in `apps/`. Plan P25 (line 1720) says "Reuse
  `FederalBusinessProfileV1`" — there is nothing to reuse.
- `client-opportunity-profile.builder.ts` is untouched by `882fd7f69`
  (`git show --stat`). The fingerprint that producers use is P01's, unchanged.
- No per-field origin / reviewed / as-of / confidence. `FederalBusinessProfile`
  (service.ts:45-60) has `firstParty` (four raw arrays/scalar), `verified`
  (one Tango snapshot), `history`, `pendingEnrichment`, `syncStatus`.
- Consumers: `grep -rln "FederalBusinessProfileService\|federal-business-profile"
  apps/api/src` -> only the service itself, `funding-opportunities.module.ts`,
  and `apps/api/scripts/diag-federal-business-profile.ts`. No read endpoint, no
  producer, no recommendation, no Meri tool imports it.

Plan acceptance bullets: (1) "byte-parity" and (2) "unreviewed proposal cannot
change a score" hold **trivially** because the scoring path was not touched and
candidates live in a separate table; (3) "with provenance" fails (F-2);
(4) "profile version changes only when semantic source-backed fields change" —
no P21 version exists to test; (5) ethical-wall / tenant tests — the spec has
none by that name (`federal-business-profile.service.spec.ts` test list at
lines 72–164; tenant scoping is inherited from `withTenant`).

The matrix row (line 92) is candid — "pure read aggregation over existing
tables; nothing new persisted" — but records the phase as `merged` and names
`getSnapshotHistory` gaining its first caller as the achievement. That is a P15
feature gaining a caller, not P21. The read-only admin diagnostic bullet
(plan line 1516) is the one delivered item.

### F-4 (Medium, P20) — Rejection durability is keyed on the UNION, not the source delta; a rejected Tango addition is re-proposed whenever the client edits the same field

`contentHash = computeContentHash({source, field, proposedValue})`
(service.ts:305) where `proposedValue = union(current, incoming)`. Any change
to the client's own array — not to Tango's content — changes the hash and
creates a fresh pending candidate re-proposing the already-rejected code.

**Reproduced:**

```
PROBE-2: client ['541511'], Tango ['541512'] -> propose -> reject ("not our line")
  re-propose, client unchanged            -> proposed 0, alreadyExisted 1   (durable, as claimed)
  client edits own array -> ['541511','541330']; Tango UNCHANGED
  re-propose                              -> proposed 1                     (reopened)
  pending[0].proposedValueJsonb === ['541511','541330','541512']            PASS
```

Plan line 1460: "Rejection is durable across future syncs until **source**
content materially changes." The shipped spec's "THE ACCEPTANCE BAR" test
(spec:257) and D-39's real-DB run only exercise the unchanged-client case. The
migration header's "durability protects a SPECIFIC rejected suggestion" is the
right principle; hashing the union instead of the additions defeats it.

### F-5 (Medium, P20) — No server-side authorization exists on the review path; reviewer identity is an unvalidated free-text UUID

- No controller and no web change shipped (P20 `git show --stat`: 18 files,
  none under `apps/web` or `*.controller.ts`), contrary to plan lines 1447–1452
  and the plan's own surface table (line 353: "Admin UI").
- The CLI's `--reviewed-by=<userId>` (`review-tango-enrichment-candidate.ts:67`)
  flows straight into `reviewedBy` (service.ts:287). `reviewed_by UUID` has no
  FK (migration.sql:77; `grep 'REFERENCES "users"'` -> none). No role lookup
  anywhere in service or script (`grep -n -i "role\|admin"` -> nothing).
  PROBE-3 accepted `'not-a-user-anywhere'`.
- The CLI header itself says "reviewer-facing surface is a later phase's job"
  (script line 17); no later phase in the plan delivers one (`grep -n -i
  enrichment` over the plan outside lines 1433–1535 assigns it to nobody).

Plan acceptance "Standard/portal users cannot approve" (line 1465) is satisfied
only vacuously: nobody can approve through the product, and whoever can run an
ECS task with DB credentials can attribute an approval to any UUID. Not an
exploitable hole today; it is scope non-delivery plus an attribution-integrity
gap that becomes a real authorization gap the day a controller calls
`reviewCandidate` without adding the check the service does not have.

### F-6 (Medium, cluster) — Nothing on this path has ever executed in `capiro-dev`, and nothing is scheduled to; two tables on the path are empty in production

Live read-only diagnostic (`capiro-dev-api-diag:8`, task
`6acf8c5f55614bb9adbbb186a933eab6`, `app.bypass_rls` on, SELECT-only),
2026-09-04:

```
DIAG_OK {
 "migration":[{"migration_name":"20260823010000_client_profile_enrichment_candidates","finished_at":"2026-08-07 14:35:12.307485+00"}],
 "rls":[{"relrowsecurity":true,"relforcerowsecurity":true,"policies":4}],
 "candidatesByStatus":[],
 "candidatesTotal":[{"n":0,"latest":null}],
 "clientsUei":[{"with_uei":46,"synced":0,"attempted":0,"tenants":6}],
 "entitySnapshots":[{"rows":0,"heads":0,"max_version":null,"ueis":0}],
 "snapshotTypes":[],
 "auditEnrich":[{"n":508}]}
```

- `client_profile_enrichment_candidate`: **0 rows**, ever.
- `tango_resource_snapshot`: **0 rows of ANY resource type** — the P15 store is
  empty, so P20's propose step is `skipped` for every client
  (service.ts:176-179) and P21's `verified` / `history` is null / empty for
  every client (service.ts:112-114).
- 46 UEI-bearing clients across 6 tenants; `tango_entity_last_attempt_at` is
  null for all — the upstream P19 entity sync has never been attempted.
- EventBridge: no rule for `generate-tango-enrichment-candidates` under either
  live prefix (`aws events list-rules --name-prefix capiro-dev-generate-tango`
  -> none; `--name-prefix fo-dev-` -> 7 rules, all DIBBS / SBIR / events, none
  for entities, enrichment or vehicles). Sibling FO jobs DO get rules even when
  disabled (`capiro-dev-generate-sam-opportunity-candidates` exists in state
  `DISABLED`), so the `enabled: false` entry at
  `infra/cdk/lib/ingestion-schedule.ts:696-704` has simply never been
  synthesized to this account.
- `auditEnrich` 508 rows is noise from other features' `%enrich%` /
  `%candidate%` actions (LegiStorm, mapping candidates); with zero P20
  candidates none can be P20's. Included only to show the query ran.

Answer to the brief: **yes** — `client_profile_enrichment_candidate` and the
`entity` slice of `tango_resource_snapshot` are empty in production and have no
enabled producer wired to feed them.

### F-7 (Low, hygiene)

- Migration `20260823010000_...` was applied to `capiro-dev` on **2026-08-07**
  (live `finished_at` above): a future-dated migration name. Harmless for
  `migrate deploy`; misleading for anyone reasoning about order.
- `entrypoint-dispatcher.inc:970` usage string omits all three new verbs
  (`generate-tango-enrichment-candidates`, `review-tango-enrichment-candidate`,
  `diag-federal-business-profile`) although the `case` arms exist (lines
  644–651).
- Neither the P20 service nor the generate script checks
  `funding_opportunities_tango_entities` (`grep -n -i flag` -> nothing in
  either). The plan's rollback ("turn off entity flag", line 1478) therefore
  stops only the upstream P19 sync; already-active snapshots keep generating
  proposals. Low because propose never writes `clients`.

---

## What was verified as PASSING (credit where due)

| Claim | Evidence | Result |
|---|---|---|
| FORCE RLS + four policies | migration.sql:106-140 (4x `CREATE POLICY`); live `relrowsecurity=true, relforcerowsecurity=true, policies=4` | PASS |
| Cross-tenant candidate id -> not found | service.ts:264-267 `findFirst({id, tenantId})` inside `withTenant` -> `NotFoundException` | PASS (by reading) |
| Accept + status flip atomic | service.ts:263-291 single `withTenant` tx | PASS |
| No bulk accept | service has one `reviewCandidate(tenantId, candidateId, ...)`; spec:351 enumerates methods | PASS |
| Null provider values never delete | arrays are additive union (:104-114); `if (entity.cageCode && ...)` (:213) | PASS |
| Rejected identical evidence does not reopen | service.ts:304-309 + unique index; PROBE-2 step 2 | PASS **only while the client's own value is unchanged** (F-4) |
| Exact-UEI only, never name-fuzzy | service.ts:169-176 | PASS |
| Approved value reaches producers / read-time | `clients` -> `CLIENT_PROFILE_SELECT` (repository.ts:72-76) -> `buildSamProfile` -> fingerprint | PASS mechanically; provenance lost (F-2) |
| P21 `verified` from `active` flag, not position | service.ts:114; spec:119 | PASS |

---

## Live-verifiable success assertion?

**P20: none.** There is no candidate row of any status in `capiro-dev`, no
snapshot to propose from, no scheduled or ever-run generator, and no audit row
that could evidence an acceptance. The only live-provable facts are structural:
the migration is applied and RLS is forced with four policies.

**P21: none.** With zero Tango snapshots and zero pending candidates, the only
thing `diag-federal-business-profile` could return for any of the 46 UEI
clients is `{ firstParty, verified: null, history: [], pendingEnrichment: [] }`
— a re-read of `clients`. Nothing distinguishes a working P21 from an absent
one in production today.

The matrix's Review cells for both rows currently read `*pending*`; nothing
found here supports upgrading either.

---

## Reproducible transcript (abridged)

```
$ git -C C:/dev/capiro-review-p20p21 rev-parse HEAD
1c7ed27fa82e171b7d9259f6c94d49e360cae985
$ git status --short --untracked-files=all            # (empty)
$ git show --stat 882fd7f69 | grep -c "prisma\|migration"   # 0 -> P21 persists nothing
$ grep -n -i audit apps/api/src/funding-opportunities/client-profile-enrichment.service.ts   # (nothing)
$ grep -n 'REFERENCES "users"' apps/api/prisma/migrations/20260823010000_client_profile_enrichment_candidates/migration.sql   # (nothing)
$ grep -rln "FederalBusinessProfileService\|federal-business-profile" apps/api/src | grep -v spec
  client-profile-enrichment.service.ts  federal-business-profile.service.ts  funding-opportunities.module.ts
# throwaway probe (written, run once, deleted):
$ pnpm --filter @capiro/api exec jest src/funding-opportunities/__review_probe_p20.spec.ts --forceExit
  PROBE-1 lost update ... PASS   PROBE-2 rejection reopens ... PASS   PROBE-3 no audit / no reviewer validation ... PASS
  Tests: 3 passed, 3 total
$ rm apps/api/src/funding-opportunities/__review_probe_p20.spec.ts && git status --short --untracked-files=all   # (empty)
# live (read-only):
$ aws ecs run-task ... capiro-dev-api-diag:8 ... --overrides file://.../p20p21-override.json   -> task 6acf8c5f55614bb9adbbb186a933eab6
$ aws logs get-log-events --log-group-name /capiro/dev/api --log-stream-name diag/db-inspect/6acf8c5f55614bb9adbbb186a933eab6
  DIAG_OK {...as quoted in F-6...}
$ aws events list-rules --name-prefix capiro-dev-generate-tango   # (none)
$ aws events list-rules --name-prefix fo-dev-                     # 7 rules, none enrichment / entity / vehicle
```

No disposable Postgres was needed (the write-path defects reproduce against the
service's own transaction fake, and the live state was read directly), so no
`capiro-p20p21-review-pg` container was created.

---

## Approval record

| Field | Value |
|---|---|
| Date | 2026-09-04 |
| Reviewer | Claude (general-purpose subagent, `claude-fable-5-1`); did not implement P20 / P21 |
| Pinned SHA | `1c7ed27fa82e171b7d9259f6c94d49e360cae985` |
| P20 | **FAIL** |
| P21 | **FAIL** |
| Cluster seam | **FAIL** |
| Blocking | F-1, F-2, F-3 (High) |
| Non-blocking but must be tracked | F-4, F-5, F-6 (Medium); F-7 (Low) |
| Worktree state at end | clean (`git status --short --untracked-files=all` empty); probe file removed |
| AWS writes | none; one read-only `db-inspect` task |
| Containers | none created |

# Band B — {P37, P38} Meri tools cluster, independent §6.2 review

**Date:** 2026-09-04

**Scope:** P37 (Typed local Meri opportunity tools) and P38 (Structured Meri
assessment and artifacts), with emphasis on the SEAMS between them and between
the Meri tool path and the Funding Opportunities HTTP path: do the Meri tools
that read Funding Opportunities data honour the same feature-flag and tenant
gates as the HTTP routes; is the PR #1100 fix present and does any sibling tool
share its shape; is the P38 artifact tenant/client-scoped with evidence
provenance; does the manifest/catalog parity spec actually pin the tool list;
can any tool mutate what it shouldn't; and does either phase have ANY
live-verifiable success assertion.

**Reviewer:** Claude, general-purpose subagent, model `claude-fable-5-1` as
reported by the runtime. Did not implement, merge or deploy P37 (PR #804), P38
(PR #809) or the PR #1100 fix. Read-only against the repository and against live
`capiro-dev`: no source edits, commits, pushes, PRs; no AWS writes; the only
task launched was one SELECT-only `capiro-dev-api-diag:8` run (transcript in
§Live checks). No secret value was read or printed. No Postgres container was
created.

**Commit under review (pin):** `origin/main`
`1c7ed27fa82e171b7d9259f6c94d49e360cae985` (`docs(funding-opportunities): apply
independent-review verdicts to completion matrix; record D-80..D-85 (#1464)`).
Worktree `C:\dev\capiro-review-p37p38` verified at that SHA with an empty
`git status --short --untracked-files=all` before and after the review. All
`file:line` references below are at the pin.

**Verdict vocabulary** (per `docs/runbooks/phase-2-independent-live-validation.md`
§8 — exactly one string per phase, plus one for the cluster seam):

```
FO_P37_INDEPENDENTLY_APPROVED | FO_P37_REJECTED
FO_P38_INDEPENDENTLY_APPROVED | FO_P38_REJECTED
FO_BAND_B_MERI_TOOLS_SEAM_APPROVED | FO_BAND_B_MERI_TOOLS_SEAM_REJECTED
```

---

## Verdicts

**`FO_P37_REJECTED`** — on F-1, F-2, F-3 (F-6 is a seam finding outside P37's
files but bears on P37's acceptance line). The adapter code itself is in good
shape and every code-level acceptance item was verified (§Acceptance
walk-through); the rejection is about the phase as presented — two false
completion-matrix cells, a flag turned on for every customer tenant against the
plan's own ship rule, a flag-parity gap of the same class as #1100, and no
live-verifiable evidence the tools have ever run.

**`FO_P38_REJECTED`** — on F-1 (plan says "Internal Meri canary only"; the flag
is on for all seven tenants), F-2, F-4, F-5, and the fact that zero assessment
artifacts, zero compliance rows and zero claim rows exist live after ~6 weeks
with the route mapped and the flag on.

**`FO_BAND_B_MERI_TOOLS_SEAM_REJECTED`** — on F-3 (Meri gate ≠ HTTP gate for the
master and landscape flags) and F-6 (client-scope pin is refuse-on-mismatch on
two of the three chat paths and fill-only on the third).

What would flip each verdict is listed under §What would change the verdicts.

---

## Correcting the brief's premises

1. **Adapter path.** The brief names `apps/api/src/meri/meri-opportunity-tools.adapter.ts`.
   At the pin the adapter is `apps/api/src/funding-opportunities/meri-opportunity-tools.adapter.ts`
   (888 lines), exactly where the plan's "Primary files" puts it; `apps/api/src/meri/` holds
   only the consumer (`meri-tools.service.ts`, 8057 lines) and the specs.
2. **Implementer branches.** Only `origin/agent/fo-p38-meri-assessment` survives. The P37
   branch (`agent/fo-p37-meri-tools`, PR #804) is deleted; its commit `a25b18542` is reachable
   from the P38 branch and from `main`.
3. **The catalogs live in a different service.** The brief's "tool manifest/catalog parity
   spec" is two specs in two apps: `apps/api/src/meri/meri-tool-manifest.parity.spec.ts`
   (apps/api `TOOL_DEFINITIONS` ↔ `@capiro/shared` `MERI_TOOL_MANIFEST`) and
   `apps/meriv2-orchestrator/src/meri/full-chat-read-tools.catalog.spec.ts` (orchestrator
   catalogs ↔ the same manifest). The six P37 tools are OFFERED to the model by the
   orchestrator (`apps/meriv2-orchestrator/src/meri/full-chat-read-tools.catalog.ts:216-251`)
   and EXECUTED by apps/api via `POST /api/clio/tools/:name`. "Live" for P37 therefore means
   two images, not one — both checked in §Live checks.
4. **The previous reviewer's partial finding is CONFIRMED**, not refuted — see F-2.
5. **The matrix's P37 "Live acceptance" premise is false** — "Flag `funding_opportunities_meri_v2`
   has no row for any tenant". Live it has seven rows, all `enabled = true` — see F-1.

---

## What was and was not trusted

Treated as CLAIMS and tested: completion-matrix rows P37 (l.108) and P38 (l.109);
`HANDOFF-2026-08-19-closeout.md` §2 (the document itself says it does not count);
every docblock in the adapter and the assessment service; the brief's premises above.

Treated as evidence: file contents at the pin; `git merge-base --is-ancestor`
over `origin/main`; ECS/ECR/CloudWatch read-only state; the SELECT-only diag
task's output; jest results (jest does not typecheck — noted where relevant).

Not verified (out of budget or out of reach without user credentials): the web
surface (`apps/web/src/pages/intelligence/opportunities/MeriOpportunityAssessment.tsx`
exists at the pin but its live rendering was not exercised); the orchestrator's
catalog spec was not run locally (its assertions were read); whether the Meri V2
chat path (`chat-assistant.service.ts`) is still reachable from a live surface.

---

## Lineage facts (git, at the pin)

| Item | Commit (date) | Merge | Ancestor of pin `1c7ed27fa` | Ancestor of live `f2746744d` |
|---|---|---|---|---|
| P37 | `a25b18542` (2026-08-07) | `36c58ccc0` (PR #804) | YES | YES |
| P38 | `ae1200599` (2026-08-07) | `e4fb4aa9d` (PR #809) | YES | YES |
| #1100 forecast-flag bypass fix | `26db4fd66` (2026-08-14) | `373071239` (PR #1100) | YES | YES |

Live `f2746744d` is itself an ancestor of the pin; the pin is 2 docs-only commits
ahead of it (`445baba91`, `1c7ed27fa`). Nothing in those two commits touches code.

```
$ git -C C:/dev/capiro-review-p37p38 rev-parse HEAD
1c7ed27fa82e171b7d9259f6c94d49e360cae985
$ for c in 36c58ccc0 e4fb4aa9d 373071239; do git merge-base --is-ancestor $c f2746744d && echo YES; done
YES
YES
YES
$ git merge-base --is-ancestor f2746744d HEAD && echo YES
YES
$ git rev-list --count f2746744d..HEAD
2
```

---

## Live checks (read-only, `capiro-dev`, `us-east-1`, 2026-09-04)

### L-1 · Which commit is serving

```
$ aws ecs describe-services --cluster capiro-dev --services capiro-dev-api \
    --query 'services[0].{td:taskDefinition,deployments:deployments[].{td:taskDefinition,status:status,rollout:rolloutState}}'
td: .../task-definition/capiro-dev-api:281   PRIMARY  COMPLETED  (updated 2026-09-04T05:26:30-04:00)
$ aws ecs describe-task-definition --task-definition capiro-dev-api:281 --query 'taskDefinition.containerDefinitions[0].image'
967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:5c4a1c1756dc6f6ee5185b60656fb672a126ca6b2fdd5ea2c67e2108e6f22211
$ aws ecr describe-images --repository-name capiro/dev/api --image-ids imageDigest=sha256:5c4a1c17... --query 'imageDetails[0].imageTags'
["keep-api281-attested-source", "f2746744d274d3b6a161436f2da19fd5a2ae1e20"]     (pushed 2026-09-04T05:13:33-04:00)

$ aws ecs describe-services --cluster capiro-dev --services capiro-dev-meriv2-orchestrator --query 'services[0].taskDefinition'
.../task-definition/capiro-dev-meriv2-orchestrator:30
$ aws ecs describe-task-definition --task-definition capiro-dev-meriv2-orchestrator:30 --query 'taskDefinition.containerDefinitions[0].image'
.../capiro/dev/meriv2-orchestrator@sha256:bfffadc1f8512e4bc4af8d20447248a0b637695ef793271199c68ba4c4a81634
$ aws ecr describe-images --repository-name capiro/dev/meriv2-orchestrator --image-ids imageDigest=sha256:bfffadc1... --query 'imageDetails[0].imageTags'
["f2746744d274d3b6a161436f2da19fd5a2ae1e20"]     (pushed 2026-09-04T05:33:44-04:00)
```

Both serving images are built from `f2746744d`, of which P37, P38 and #1100 are
all ancestors. **P37, P38 and the #1100 fix are live on both the API and the
orchestrator.**

### L-2 · The P38 route is mapped by the CURRENT api tasks

```
$ aws ecs list-tasks --cluster capiro-dev --service-name capiro-dev-api
4c308a225fae4d4988e3fe4dfc96aee6
fbd77c81862347a9a0a91ddae8f12160
$ aws logs filter-log-events --log-group-name /capiro/dev/api \
    --log-stream-names api/api/4c308a225fae4d4988e3fe4dfc96aee6 api/api/fbd77c81862347a9a0a91ddae8f12160 \
    --filter-pattern '"assessment"' --limit 4
09/04/2026, 9:24:48 AM  [RouterExplorer] Mapped {/api/intelligence/opportunities/:source/:id/assessment, POST} route
09/04/2026, 9:24:49 AM  [RouterExplorer] Mapped {/api/intelligence/opportunities/:source/:id/assessment, POST} route
```

The same line appears in task startups on 2026-08-21 (streams
`api/api/379f1d4c…`, `73da146e…`, `396efdd2…`, `7b3dd06b…`), so P38 has been
deployed since at least that date.

### L-3 · Flag state, artifact rows, compliance rows, claim rows (one SELECT-only diag task)

Task `b88b72ca5b3041ef90f3b3ac166c7220` on `capiro-dev-api-diag:8`, container
`db-inspect`, `node -e` with the source in scratchpad
`p37p38-review-diag.js` (one `$transaction`, first statement
`SELECT set_config('app.bypass_rls','on',true)`, then SELECTs only; exit code 0;
output stream `/capiro/dev/api` `diag/db-inspect/b88b72ca…`). Abridged `DIAG_OK`:

```
fo_flags (intel_feature_flag, feature LIKE 'funding_opportunities%'):
  funding_opportunities                      rows=7 on=7  c2-strategies,capiro-internal,dualsight,maven,prospering-solutions,revere,victory-six-advisors
  funding_opportunities_government_landscape rows=7 on=7  (same seven)
  funding_opportunities_meri_v2              rows=7 on=7  (same seven)
  funding_opportunities_forecasts            rows=7 on=1  capiro-internal          (D-83 turned the other six off)
  funding_opportunities_client_inbox / _documents / _notice_history / _pipeline_v2 / _sbir / _vehicle_fit  rows=7 on=7
tenants: 8 (abramoff has no FO flag rows)
clio_artifacts WHERE kind='funding_opportunity_assessment':  n=0, first=null, last=null
clio_artifacts kinds present: word_document 74, research_report 54, meeting_brief 6, analysis_chart 6, excel_workbook 5, powerpoint_deck 2, ... (no assessment kind)
compliance_check WHERE trigger='funding_opportunity_assessment':  n=0
claim WHERE subject_type='funding_opportunity_assessment':       n=0
```

### L-4 · Has any P37 tool ever been invoked live?

```
$ aws logs filter-log-events --log-group-name /capiro/dev/api --start-time <now-14d> \
    --filter-pattern '?"build_opportunity_action_plan" ?"get_funding_opportunity" ?"explain_opportunity_match" ?"compare_funding_opportunities" ?"get_opportunity_government_landscape" ?"get_opportunity_client_context"' --limit 20
[]
```

No event in 14 days. (The adapter logs only on flag-read failure, so silence is
consistent with "never called" and with "called and worked"; but L-3's zero
artifacts and the absence of any metric/audit for the six read tools means there
is no positive evidence either way.)

---

## Findings

Severity: High / Medium / Low. Each has file:line at the pin.

### F-1 · High — `funding_opportunities_meri_v2` is ON for all seven tenants; the matrix says it has no rows; the plan says "internal canary only"; the decision log never records the enablement

- Live: L-3 — `funding_opportunities_meri_v2 rows=7 on=7`, including customer tenants
  (`dualsight`, `maven`, `revere`, `c2-strategies`, `prospering-solutions`, `victory-six-advisors`).
- Claim: `completion-matrix.md:108` P37 Live-acceptance cell — *"Flag `funding_opportunities_meri_v2`
  has no row for any tenant"*. False.
- Plan: P37 "Ship and rollback": *"Enable Meri flag only after tool tests and local UI context are
  stable"*; P38 "Ship and rollback": *"Internal Meri canary only."* The canary runbook
  (`docs/runbooks/funding-opportunities-makegov-canary.md:85`) lists step 11 "Meri local
  assessment — `funding_opportunities_meri_v2` — UI only".
- Record: `grep -n "meri_v2" docs/plans/funding-opportunities-makegov-v1/decision-log.md` → no
  match. No migration or seed inserts the flag (`grep -rl funding_opportunities_meri_v2
  apps/api/prisma/migrations apps/api/scripts scripts infra` → none). The enablement was done
  out-of-band and is unrecorded.
- Consequence: both phases are exposed to every tenant with zero recorded acceptance (L-3, L-4),
  and the "Rollback: Disable Meri flag" cell is now a live action, not a hypothetical.

### F-2 · High (process) — Both phases and the #1100 fix ARE deployed; both matrix Deploy cells are false; the previous reviewer's partial finding is confirmed

- Claim: `completion-matrix.md:108` and `:109`, Deploy column: *"not yet deployed to capiro-dev"*.
  The text was introduced on 2026-08-07 (`git log -S… -- completion-matrix.md` → `f1e4aea73`)
  and never touched since, including by the 2026-09-03 verdict pass (`445baba91`).
- Evidence: L-1 (both serving images tagged `f2746744d…`; `36c58ccc0`, `e4fb4aa9d`,
  `373071239` are all ancestors) and L-2 (the P38 route mapped by the current tasks, and
  already on 2026-08-21).
- Resolution of the contradiction: the matrix is wrong, the previous reviewer was right.
  P37 and P38 have been live since no later than 2026-08-21 (first log evidence found) and
  are live now on `capiro-dev-api:281` and `capiro-dev-meriv2-orchestrator:30`.

### F-3 · Medium (seam) — The Meri gate checks ONLY `funding_opportunities_meri_v2`; the HTTP gate stacks master + per-route flags. #1100 closed one leg of this class, not the class

HTTP side (`apps/api/src/funding-opportunities/funding-opportunities.controller.ts`):
- `:521-523` class-level `@UseGuards(RolesGuard, FundingOpportunitiesFlagGuard)` `@Roles('standard_user')`
  → EVERY route requires the master `funding_opportunities` flag
  (`funding-opportunities-flag.guard.ts:186-197`).
- `:663-664` `/landscape` and `:685-686` `/action-plan` add `FundingOpportunitiesLandscapeFlagGuard`
  (`funding_opportunities_government_landscape`, guard `:284-286`).
- `:719-720` `/assessment` adds `FundingOpportunitiesMeriFlagGuard` (`:300-302`) — i.e. HTTP
  assessment = master AND meri_v2.

Meri side (`apps/api/src/funding-opportunities/meri-opportunity-tools.adapter.ts`):
- `:181-197` `enabled()` reads exactly one flag, `FUNDING_OPPORTUNITIES_MERI_V2_FEATURE`.
- `:209-241` `gate()` = that flag → role ≥ `standard_user` → UUID shape → ethical wall
  (`readVisibleClientIds`). No master-flag read; no landscape-flag read.
- `:375-440` `getOpportunityGovernmentLandscape` and `:512-575` `buildOpportunityActionPlan`
  call `this.landscape.compose` / `composeActionPlan` after `gate()` only.
- Downstream does not compensate: `government-landscape.service.ts` reads no flag (grep for
  `isFundingOpportunitiesFeatureEnabled|_FEATURE` → only a comment at `:181`);
  `funding-opportunities.service.ts` reads only `FUNDING_OPPORTUNITIES_VEHICLE_FIT_FEATURE`
  (`:56`, `:1157-1160`).
- P38 inherits it: `meri-opportunity-assessment.service.ts:178-183` gates through
  `this.tools.getFundingOpportunity` (meri_v2 only) and then `:240-244` composes landscape
  and action plan regardless of the landscape flag. Via HTTP the assessment route requires
  master+meri_v2 but STILL not the landscape flag.

The #1100 fix (`:521-531`, `asOpportunitySource(input.source)` allowlist;
`OPPORTUNITY_SOURCES = ['grants_gov','sam_gov']` at `funding-opportunities.types.ts:53`)
is present at the pin and live. Siblings carry the same allowlist (`:255`, `:277`,
`:471`; the landscape tool restricts to `sam_gov` at `:385-392`), so **no sibling has
the #1100 source-shape bypass**. But #1100's own comment (`:523-526`) names the
problem as "bypassed the master funding_opportunities flag … this adapter never
passes through the NestJS HTTP guard pipeline" — and the master flag is still not
read here. The fix closed the `agency_forecast` symptom, not the parity gap.

Live exposure TODAY: none — L-3 shows master, landscape and meri_v2 all ON for the same
seven tenants. The gap becomes live the moment `funding_opportunities_government_landscape`
(or the master flag) is turned off for a tenant while `meri_v2` stays on: the UI's
landscape panel would 404 while Meri keeps answering landscape questions. Medium, not
High, precisely because it is latent; it is the same class as the D-83 forecast lesson.

### F-4 · Medium (P38) — `conversationId` is caller-supplied and never checked for ownership; the artifact's "scoped to the conversation that asked" provenance is unverified

- Controller DTO `funding-opportunities.controller.ts:446-451`: `@IsUUID() conversationId` — shape only.
- Service `meri-opportunity-assessment.service.ts:85-91` (design note), `:445-467` — `findFirst`
  and `create` use `input.conversationId` verbatim inside `withTenant(actor.tenantId)`; no read of
  `clio_conversations` anywhere in the file (grep `clioConversation` → none).
- RLS on `clio_artifacts` (`apps/api/prisma/migrations/20260510010000_clio_nanoclaw_workspace/migration.sql:119-123`)
  is tenant-only: `tenant_id = current_tenant_id()`. It blocks cross-tenant READ of the
  row, but an FK to another tenant's or another user's conversation is accepted (FK checks
  are not RLS-filtered).
- Effect: within a tenant, user A can attach an assessment for client X to user B's
  conversation. Today's artifact readers also filter `userId` (`governed-meri-tools.proxy.ts:67-75`,
  `meri-tools.service.ts:6199-6202`), so B would not see it through those paths — hence
  Medium, not High. But the audit artifact's own claim ("scoped to the Meri conversation
  that asked", controller `:712-714`) is not enforced, and the version chain (`:445-455`)
  is keyed on that unverified id.

### F-5 · Medium (P38) — Fail-open persistence misreports provenance; combined with zero live rows there is no external way to tell an assessment was ever produced

- `meri-opportunity-assessment.service.ts:484-491`: on any persistence error the method logs
  `warn` and returns `provenance.artifactVersion` (= `1`, set at `:207`), so the response
  carries `artifactVersion: 1` when no `clio_artifacts` row was written.
- `:506-523` `persistClaimsSafe` and `:541-556` `recordSafe` swallow errors by contract.
- The spec pins this as intended (`meri-opportunity-assessment.spec.ts:396-400`
  "persistence is fail-open").
- Plan "Work" line: *"Persist prompt/model/policy/compiler versions, packet ID, claim evidence,
  and artifact version."* The response cannot be used to confirm that happened, and L-3 shows
  it has NEVER happened live (0/0/0) despite the flag being on for seven tenants since before
  2026-08-21 and the handoff's 2026-08-19 probe reaching the handler. Either nobody has ever
  run an assessment, or every run failed to persist silently — the design cannot distinguish.

### F-6 · Medium (seam) — "A client-scoped conversation cannot override `clientId`" holds on two of three chat paths; the Meri V2 orchestrator path fills but does not refuse

- Legacy apps/api loop `apps/api/src/meri/meri.service.ts:1452-1466`: omitted → filled from
  the conversation; DIFFERENT → `scopeViolation` refusal. Enforced.
- Meri V3 orchestrator `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.ts:600-616`:
  same shape — supplied ≠ `dto.clientId` → "This conversation is pinned to a different client.
  I did not run the cross-client request." Enforced.
- Meri V2 orchestrator chat `apps/meriv2-orchestrator/src/meri/chat/chat-assistant.service.ts:676`:
  `if (dto.clientId && !isUuid(out.clientId)) out.clientId = dto.clientId;` — a DIFFERENT
  valid UUID passes straight through to `POST /api/clio/tools/:name` →
  `meri-tools.service.ts:1737-1743 executeFromAuthenticatedUser` → adapter, which enforces
  role and wall (`:213-241`) but has no notion of the session. The prompt hint at
  `chat-prompt.ts:381` is advisory.
- P37's own spec proves only that `clientId` is REQUIRED in all six schemas
  (`meri-tools.registration.spec.ts:165-172`) — the enforcement lives outside P37's files, which
  is why this is a seam finding. The ethical wall still applies, so this is a session-scope
  leak within the user's own visibility, not a cross-user one. Whether the V2 chat path is
  still reachable from a live surface was not determined.

### F-7 · Low (P38) — Untyped seam into the context compiler

`meri-opportunity-assessment.service.ts:318` passes the compile request `as never`; jest does
not typecheck, so a contract change in `ContextCompilerService.compile` would surface only as
the `warn` at `:321-326` and `compilerVersion: null`. Consistent with the "best-effort"
design but invisible to CI.

### F-8 · Low (docs) — HANDOFF §2 claims verified, one nuance

The handoff's "model transport genuinely wired … `.withCompletion(...)` with per-tenant BYOK"
is confirmed: `apps/api/src/meri/meri.module.ts:174-190` resolves
`aiCredentials.resolveProviderByTenantId(tenantId, 'anthropic')` and posts to
`https://api.anthropic.com/v1/messages` with `model: config.get('CLIO_RESEARCH_PLAN_MODEL')`.
Nuance: the P37 spec's `fetch(` ban (`meri-opportunity-tools.spec.ts:395`) covers the
adapter only; the model call lives in the module factory, as it should. The handoff's
404→400 probe proves handler reachability and nothing about output or persistence (L-3).

---

## Acceptance walk-through (code-level, at the pin)

P37 acceptance lines, each with where it was verified:

| Acceptance | Evidence | Result |
|---|---|---|
| Registration/schema/dispatch/implementation tests exist for every tool | `meri-tools.registration.spec.ts:110-115,167-172`; `meri-tools.service.ts:529-554` (defs), `:1441-1488` (schemas), `:1927-1963` (dispatch); `meri-opportunity-tools.spec.ts` (810 lines) | PASS (93/93 tests, see §Tests) |
| A client-scoped conversation cannot override `clientId` | F-6 | PARTIAL — enforced on 2 of 3 paths |
| Denied client and portal-user cases fail closed | adapter `:219-224` (`hasAtLeast(role,'standard_user')` → `denied`), `:235-239` (wall → `denied`); `denied` and `not_found` deliberately distinct `:88-101` | PASS |
| No tool can call Tango or retrieve a key | spec `:377-403` structural (no `external/tango`, no `TANGO_API_KEY`/`SecretsManager`/`getSecret`/`TangoGateway`/`TangoStoreService`, no `fetch(`, constructor arity 3) | PASS |
| Missing provider data is explicit | states `disabled/denied/not_found/unsupported_source/invalid_request` `:93-101`; landscape "Capiro does not compose it for them yet" `:391` | PASS |
| Tool output remains within size limits | `MERI_TOOL_CAPS` `:129-135`, `MERI_TOOL_MAX_CHARS = 24_000` `:147`, `cap()` `:878`, `truncated[]` `:116` | PASS |
| `build_opportunity_action_plan` returns proposals, not writes | `:551-556` "PROPOSALS ONLY"; spec `:614-620` bans `.create( .update( .upsert( .delete( .createMany( $executeRaw` in the adapter | PASS |
| Funding Opportunities does not import Meri | spec `:412-456`; `funding-opportunities.module.ts:107-121` | PASS |
| Flag off by default / enable only after stable | F-1 | FAIL |

P38 acceptance lines:

| Acceptance | Evidence | Result |
|---|---|---|
| Unsupported claims are held/rejected by assurance policy | spec `:152-226`; service `:542-556` counts `held`, compliance `WARN` | PASS |
| Prompt-injection attachments remain quoted untrusted evidence | spec `:228-275` (fence cannot be closed/opened early; label fenced too) | PASS |
| Empty/missing context → honest incomplete assessment | spec `:277-314` | PASS |
| Model failure leaves deterministic assessment available | `runModel` `:346-395` three states; spec `:316-356` | PASS |
| Evals cover grants, forecasts, sources sought, solicitation, amendment, thin client, conflict | spec `:453-530` | PASS (unit-level; no live eval) |
| Model cannot change deterministic recommendation | spec `:99-150` incl. hostile-model case (matrix `:109` Live-acceptance claim) | PASS |
| Persist versions/packet id/claims/artifact version | `:201-208` provenance, `:461-480` metadata, `:506-523` claims — but F-5 | PARTIAL |
| No send/task/memory/workflow write without explicit user action | spec `:377-392` structural ban list; service writes only `clioArtifact.create`, claims, compliance | PASS |
| Internal Meri canary only | F-1 | FAIL |

Tenant/client scoping of the artifact (brief question): `tenantId`/`userId` come from the
authenticated actor, `clientId` from input AFTER P37's gate has confirmed the client is
visible to that user (`:178-183` probe → `:461-467` write). Evidence provenance:
`packet.evidence` is built only from landscape items carrying an `evidenceRef` plus the
opportunity itself (`:249-265`); claims are numbered against that set and written with
`sourceIds` (`:506-523`). Correct as far as it goes; F-4 (conversation ownership) and F-5
(fail-open) are the two holes.

Can any tool mutate what it shouldn't (brief question): No. The adapter's three collaborators
are `PrismaService`, `FundingOpportunitiesService`, `GovernmentLandscapeService` (`:165-169`);
the spec bans every Prisma write verb in the adapter source (`:614-620`) and the tests pass.
The P38 service writes exactly three audit surfaces (`:58-62`, spec `:377-392`).

Does the manifest/catalog parity spec pin the tool list (brief question): Yes.
`meri-tool-manifest.parity.spec.ts:19-27` asserts `TOOL_DEFINITIONS` ↔ `MERI_TOOL_MANIFEST`
by exact `toEqual` AND count 81; the orchestrator's `full-chat-read-tools.catalog.spec.ts:54-94`
asserts the three catalogs ↔ the same manifest verbatim, count 81, and `FULL_CHAT_READ_TOOLS`
length 37 including the six P37 names. The six are present in
`packages/shared/src/index.ts:3537-3547`. The api-side spec passed locally; the orchestrator
spec was read, not run.

---

## Tests (run at the pin, no source changes)

```
$ pnpm --filter @capiro/api exec jest src/meri/meri-tool-manifest.parity.spec.ts src/meri/meri-tools.registration.spec.ts \
    src/funding-opportunities/meri-opportunity-tools.spec.ts src/funding-opportunities/meri-opportunity-assessment.spec.ts --forceExit
PASS src/funding-opportunities/meri-opportunity-assessment.spec.ts
PASS src/funding-opportunities/meri-opportunity-tools.spec.ts
PASS src/meri/meri-tool-manifest.parity.spec.ts
PASS src/meri/meri-tools.registration.spec.ts
Test Suites: 4 passed, 4 total
Tests:       93 passed, 93 total
```

Caveat: jest does not typecheck; `tsc` was not run (budget). Dedicated CI ("phase
exit: dedicated CI is green") could not be verified — repo-wide Actions have been in
`startup_failure` since 2026-07-31 per program memory; nothing at the pin contradicts that.

---

## Does each phase have ANY live-verifiable success assertion?

**P37 — No.** The code is provably in both serving images (L-1) and the flag is on for
seven tenants (L-3), but there is no artifact, metric, audit row or log line that any of
the six tools has ever been invoked (L-4). The only live-verifiable statement is "the tool
code is deployed and the flag is on", which is a precondition, not a success.

**P38 — No.** The route is provably mapped by the current tasks (L-2). Zero
`clio_artifacts` of kind `funding_opportunity_assessment`, zero `compliance_check` rows
with trigger `funding_opportunity_assessment`, zero `claim` rows with that subject type
(L-3), ever. The handoff's 2026-08-19 probe (404 → 400 on an invalid body) shows the
handler is reachable and, by design, wrote nothing. Because persistence is fail-open (F-5),
even a successful run would not necessarily leave a row — so the absence of rows cannot be
read as "never used", only as "never verifiably used".

---

## Resolution of the deployed-vs-matrix contradiction

The previous reviewer's aborted finding — *"P37, P38, and the #1100 fix are all deployed —
contradicting both completion-matrix rows"* — is **confirmed with evidence**:

1. `capiro-dev-api:281` → image digest `sha256:5c4a1c17…` → ECR tag `f2746744d274d3b6a161436f2da19fd5a2ae1e20` (L-1).
2. `capiro-dev-meriv2-orchestrator:30` → digest `sha256:bfffadc1…` → the same tag (L-1).
3. `git merge-base --is-ancestor` of `36c58ccc0` (P37), `e4fb4aa9d` (P38), `373071239` (#1100) against `f2746744d` → all YES.
4. `RouterExplorer` maps the P38 route on both current api tasks (09:24Z today) and on tasks from 2026-08-21 (L-2).
5. `completion-matrix.md:108-109` Deploy cells still read "not yet deployed to capiro-dev", unchanged since 2026-08-07 (`f1e4aea73`).

Both Deploy cells must be corrected to "deployed (live since ≤2026-08-21; api:281 / orchestrator:30 as of 2026-09-04)", and P37's Live-acceptance cell must drop the "no row for any tenant" sentence (F-1).

---

## What would change the verdicts

P37 → `FO_P37_INDEPENDENTLY_APPROVED` requires all of:
- Matrix `:108` Deploy and Live-acceptance cells corrected (F-2, F-1).
- A decision-log entry recording WHO enabled `funding_opportunities_meri_v2` for all seven tenants and WHY, or the flag reduced to `capiro-internal` per the plan's ship rule (F-1).
- Adapter `gate()` reads the master flag (and the landscape flag for the two landscape-derived tools), OR a recorded decision that `meri_v2` is a deliberate superset gate with the D-83 class of consequence acknowledged (F-3).
- One positive live invocation trace (a log line, metric or audit row for a read tool) so the phase has a success assertion at all.

P38 → `FO_P38_INDEPENDENTLY_APPROVED` requires all of:
- Matrix `:109` Deploy cell corrected (F-2); canary-only restored or the exception recorded (F-1).
- `conversationId` verified to belong to `actor.tenantId` (and, given the wall model, `actor.userId`) before write (F-4).
- Provenance reports persistence truthfully — e.g. `artifactVersion: null` / `persisted: false` on the fail-open path (F-5).
- One real assessment produced for `capiro-internal` with its `clio_artifacts` row, `compliance_check` row and `claim` rows visible (L-3 non-zero).

Seam → `FO_BAND_B_MERI_TOOLS_SEAM_APPROVED` requires F-3 and F-6 resolved (or F-6's V2 path shown unreachable live).

---

## Hygiene

- Worktree `C:\dev\capiro-review-p37p38`: `git rev-parse HEAD` = `1c7ed27fa…`; `git status --short --untracked-files=all` empty at start and at end. No probe files were written inside it.
- No Postgres container was created (none to remove). No other `capiro-*-review-pg` container touched.
- AWS: read-only calls only, plus one `run-task` of `capiro-dev-api-diag:8` whose command was SELECT-only (source retained in scratchpad `p37p38-review-diag.js`; output in `p37p38-review-diag-out.txt`). No secret value was read.

---

## Approval record

**Verdicts, 2026-09-04:**

```
FO_P37_REJECTED                      (F-1, F-2, F-3; F-6 bears on acceptance)
FO_P38_REJECTED                      (F-1, F-2, F-4, F-5; zero live artifacts)
FO_BAND_B_MERI_TOOLS_SEAM_REJECTED   (F-3, F-6)
```

Reviewer: Claude, general-purpose subagent (model `claude-fable-5-1`), independent of the
P37/P38/#1100 implementers. Pin `1c7ed27fa82e171b7d9259f6c94d49e360cae985`. Live state
observed against `capiro-dev-api:281` and `capiro-dev-meriv2-orchestrator:30`, both built
from `f2746744d`. Read-only throughout.

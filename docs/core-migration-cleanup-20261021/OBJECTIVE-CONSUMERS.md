# Objective migration consumer audit

Source `51e265bd5b5170abffb32a62ffc39a52a788fe60`; tree `4ac54093d3dc477e08249ded10bc7a07972637e6`. Exact FINISHED ledger count: 546.

Read-only objective-family Core runtime consumer and pending SQL dependency audit. All tracked files in all six Core production-closure roots are present and searched. All 23 pending SQL blobs inspected for reverse references. Other services/web are outside the Core image scope and were not fetched.

No SQL/DB calls, AWS, code edits, moves, dependency/default changes, commit, publication, merge or deploy performed. No dynamic database/startup claim. Preserve all FINISHED SQL.

Hold removal/movement of six migrations with reachable ungated consumers. Workload delegations is the sole move candidate in this subgroup for the Core default composition: all six compiled production roots searched, no alternative caller; no other pending SQL references its tables. None of these findings authorizes making source-only consumers runnable or enabling their flags.

## Shared mounting
- AppModule unconditionally imports ClientsModule and ObjectiveOperationalModule. [apps/api/src/app.module.ts:113–114](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/app.module.ts#L113-L114)
- ClientsModule unconditionally imports ClientObjectivesModule and ObjectiveWorkModule. [apps/api/src/clients/clients.module.ts:68–71](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/clients.module.ts#L68-L71)
- ObjectiveWorkModule unconditionally registers its REST controller, workload admission module and planner/strategy owner router. [apps/api/src/clients/objectives/work/objective-work.module.ts:8–16](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work.module.ts#L8-L16)

## 20281011010000_client_objectives

**HOLD removal: ungated consumer; runnable status still needs Fable reconciliation**

Header: no explicit source-only/reserved execution hold in header. SHA256 `cd6a1f08162b55b04325d7ef017fdabc23d1d28870fd1c6ce863789f70fca5e2`; blob `3c3bb03b6a237d8d779307cb8737aa88bb490c97`.

```sql
-- Standalone Objectives. Additive only; no existing client/strategy rows change.
CREATE TABLE client_objectives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
```

No Objective feature flag gates CRUD/transition controller. Roles, tenant/membership and client-wall checks are authorization/data protections, not a disabled preview feature.

Fable confirms public.client_objectives absent. This is a missing runtime relation for reachable Objective routes, not an existing-column collision. No missing-table workaround is proposed or applied.

Runtime evidence:
- Controller exposes GET/POST/PATCH/transition/delete under clients/:clientId/objectives with RolesGuard. [apps/api/src/clients/objectives/objectives.controller.ts:25–79](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/objectives.controller.ts#L25-L79)
- Authorized list executes Prisma clientObjective.findMany without select, so all scalar Objective columns are required; get likewise reads the model. [apps/api/src/clients/objectives/objectives.service.ts:81–97](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/objectives.service.ts#L81-L97) [apps/api/src/clients/objectives/objectives.service.ts:259–272](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/objectives.service.ts#L259-L272)
- Transition writes Objective and revision then directly invokes intent append and canonical reservation on confirm_ready. [apps/api/src/clients/objectives/objectives.service.ts:191–217](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/objectives.service.ts#L191-L217)

Direct pending SQL dependencies:
- None among the exact 23 pending migrations.

Other pending migrations referencing its created tables: 20281015010000_client_objective_work_intents, 20281015030000_client_objective_operational_links, 20281015050000_client_objective_work_reconsent, 20281017010000_client_objective_strategy_intake.

## 20281015010000_client_objective_work_intents

**HOLD removal: ungated consumer; runnable status still needs Fable reconciliation**

Header: no comment header / no explicit execution hold. SHA256 `9076f6e73462caed2006e97b22fdb9ce4ead47b718f0f6b0c0c09f16caea31db`; blob `c8870624c126ef5e1412f3d892358dd6ccec9b63`.

```sql
ALTER TABLE client_objective_revisions ADD CONSTRAINT client_objective_revisions_intent_scope_key
  UNIQUE (tenant_id, client_id, objective_id, id, version);

CREATE TABLE client_objective_work_intents (
```

No enable flag before confirm_ready append; generation GET also reads intents before owner reconciliation.

Fable confirms public.client_objective_work_intents absent. No exact live DDL for other companion objects is supplied; do not infer collisions or their absence.

Runtime evidence:
- Authenticated confirm_ready path calls appendObjectiveReadyIntent directly. [apps/api/src/clients/objectives/objectives.service.ts:204–216](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/objectives.service.ts#L204-L216)
- Append inserts and reads client_objective_work_intents. [apps/api/src/clients/objectives/objective-work-intent.ts:59–77](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/objective-work-intent.ts#L59-L77)
- Generation state resolves source intent, and root verifies joined source revision. [apps/api/src/clients/objectives/work/objective-work.service.ts:318–333](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work.service.ts#L318-L333) [apps/api/src/clients/objectives/work/objective-work.service.ts:357–361](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work.service.ts#L357-L361)

Direct pending SQL dependencies:
- 20281011010000_client_objectives: client_objective_revisions at [SQL:1](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281015010000_client_objective_work_intents/migration.sql#L1), client_objective_revisions at [SQL:20](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281015010000_client_objective_work_intents/migration.sql#L20)

Other pending migrations referencing its created tables: 20281015020000_client_objective_canonical_plans, 20281015050000_client_objective_work_reconsent.

## 20281015020000_client_objective_canonical_plans

**HOLD move: ungated consumer**

Header: source-only. SHA256 `475b56421caf9206124597d78bc44a1cb111361ba5d2ff6030dad11d1f3aba26`; blob `79223a80ab95fb63979d539208d21d4dfc07917b`.

```sql
-- Centrally allocated source-only canonical reservation. No migration executed.
ALTER TABLE client_objective_work_intents
  ADD CONSTRAINT client_objective_work_intents_canonical_scope_key
  UNIQUE (tenant_id, client_id, objective_id, id,
```

No flag before confirm_ready canonical reservation; generation GET state reads canonical table before planner/strategy reconciliation flags.

No exact live table/constraint definition supplied for this companion. It depends on two relations explicitly absent live. Source-only header conflicts with reachable consumers; escalate, do not invent a flag.

Runtime evidence:
- Unconditional confirm_ready consumer invokes reserveCanonicalObjectivePlan. [apps/api/src/clients/objectives/objectives.service.ts:204–216](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/objectives.service.ts#L204-L216)
- Canonical helper reads existing reservations and inserts/updates canonical plan. [apps/api/src/clients/objectives/objective-canonical-plan.ts:189–189](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/objective-canonical-plan.ts#L189) [apps/api/src/clients/objectives/objective-canonical-plan.ts:245–268](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/objective-canonical-plan.ts#L245-L268)
- Generation GET runs state before reconcile; state reads canonical table even for read-only/create=false. [apps/api/src/clients/objectives/work/objective-work-command.ts:489–505](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work-command.ts#L489-L505) [apps/api/src/clients/objectives/work/objective-work.service.ts:342–350](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work.service.ts#L342-L350)

Direct pending SQL dependencies:
- 20281015010000_client_objective_work_intents: client_objective_work_intents at [SQL:2](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281015020000_client_objective_canonical_plans/migration.sql#L2), client_objective_work_intents at [SQL:27](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281015020000_client_objective_canonical_plans/migration.sql#L27)

Other pending migrations referencing its created tables: 20281015050000_client_objective_work_reconsent.

## 20281015030000_client_objective_operational_links

**HOLD move: ungated consumer**

Header: source-only. SHA256 `3720dfa83dc0ad73c24cd0cfddcf0900ece56a59e3e1ef9290ddd9836f817422`; blob `0a5124859159669d6a6e15d683fe5afd5a87fbdb`.

```sql
-- Source-only, coordinated Objective lane. No resource row or permission is created.
CREATE TABLE client_objective_operational_states (
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
```

ObjectiveOperationalModule/controller always mounted. Guard checks native identity, role and impersonation only. OUTREACH_V3_STATE_ENABLED controls a specific resource observation, not the operational state/link/receipt queries.

No exact live companion definitions supplied. Source-only header conflicts with ungated routes. Do not move pending owner decision.

Runtime evidence:
- Operational module/controller expose read, command and receipt routes. [apps/api/src/clients/objectives/operational/objective-operational.module.ts:7–10](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/operational/objective-operational.module.ts#L7-L10) [apps/api/src/clients/objectives/operational/objective-operational.controller.ts:22–53](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/operational/objective-operational.controller.ts#L22-L53)
- Operational guard is identity/role/impersonation protection, with no feature enable flag. [apps/api/src/clients/objectives/operational/objective-operational.guard.ts:8–21](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/operational/objective-operational.guard.ts#L8-L21)
- Operational read queries set version and links after current scope checks. [apps/api/src/clients/objectives/operational/objective-operational.service.ts:186–205](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/operational/objective-operational.service.ts#L186-L205) [apps/api/src/clients/objectives/operational/objective-operational.store.ts:199–212](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/operational/objective-operational.store.ts#L199-L212)
- Receipt and command paths read/write companion receipt/link/state tables. [apps/api/src/clients/objectives/operational/objective-operational.store.ts:118–118](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/operational/objective-operational.store.ts#L118) [apps/api/src/clients/objectives/operational/objective-operational.store.ts:225–229](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/operational/objective-operational.store.ts#L225-L229) [apps/api/src/clients/objectives/operational/objective-operational.store.ts:256–256](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/operational/objective-operational.store.ts#L256) [apps/api/src/clients/objectives/operational/objective-operational.store.ts:296–296](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/operational/objective-operational.store.ts#L296)

Direct pending SQL dependencies:
- 20281011010000_client_objectives: client_objectives at [SQL:10](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281015030000_client_objective_operational_links/migration.sql#L10), client_objective_revisions at [SQL:34](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281015030000_client_objective_operational_links/migration.sql#L34), client_objective_revisions at [SQL:69](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281015030000_client_objective_operational_links/migration.sql#L69)

Other pending migrations referencing its created tables: none.

## 20281015050000_client_objective_work_reconsent

**HOLD move: ungated consumer**

Header: reserved. SHA256 `2eda48200f871d88afb40ae7556d45cd9efb2312f3977fbe9d34308c580bbafc`; blob `6a479d02c90063158dcccc32af6cdc34e0c94db7`.

```sql
-- Centrally reserved Objective lane. Consent/control records only; no dispatcher,
-- credential, output row, role, or current-authority grant is created here.
ALTER TABLE client_objective_work_intents
  ADD CONSTRAINT objective_work_intents_reconsent_scope_key
```

OBJECTIVE_PLANNER_CONTINUATION_ENABLED and OBJECTIVE_STRATEGY_INTAKE_ENABLED both default false unless literal true. They restrict owner behavior/fresh operations; generation reads and command recovery read state/receipts before those checks.

No exact live companion definitions supplied. Readable outer endpoints remain independent of owner feature flags; move requires resolution, not a new default or bypass.

Runtime evidence:
- Generation REST controller exposes commands, strategy-commands, confirm-pair, GET and outputs with RolesGuard but no feature flag. [apps/api/src/clients/objectives/work/objective-work.controller.ts:11–56](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work.controller.ts#L11-L56)
- GET readWorkGeneration checks current authority, optional receipt and state before reconcile. [apps/api/src/clients/objectives/work/objective-work-command.ts:489–505](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work-command.ts#L489-L505)
- State reads work_controls even create=false and reads consent when its ID exists; receipt lookup reads command receipts. [apps/api/src/clients/objectives/work/objective-work.service.ts:335–340](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work.service.ts#L335-L340) [apps/api/src/clients/objectives/work/objective-work.service.ts:370–398](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work.service.ts#L370-L398)
- Command recovery is performed in a read transaction before fresh-write transaction. [apps/api/src/clients/objectives/work/objective-work-command.ts:331–346](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work-command.ts#L331-L346)
- Planner/strategy owner flags default false but do not gate those outer service reads. [apps/api/src/clients/objectives/work/objective-planner-work-owner.ts:158–176](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-planner-work-owner.ts#L158-L176) [apps/api/src/clients/objectives/work/objective-strategy-work-owner.ts:46–59](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-strategy-work-owner.ts#L46-L59)

Direct pending SQL dependencies:
- 20281015010000_client_objective_work_intents: client_objective_work_intents at [SQL:3](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281015050000_client_objective_work_reconsent/migration.sql#L3), client_objective_work_intents at [SQL:106](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281015050000_client_objective_work_reconsent/migration.sql#L106), client_objective_work_intents at [SQL:178](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281015050000_client_objective_work_reconsent/migration.sql#L178)
- 20281015020000_client_objective_canonical_plans: client_objective_canonical_plans at [SQL:7](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281015050000_client_objective_work_reconsent/migration.sql#L7), client_objective_canonical_plans at [SQL:39](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281015050000_client_objective_work_reconsent/migration.sql#L39)
- 20281011010000_client_objectives: client_objective_revisions at [SQL:183](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281015050000_client_objective_work_reconsent/migration.sql#L183)

Other pending migrations referencing its created tables: 20281016010000_client_objective_workload_delegations, 20281017010000_client_objective_strategy_intake.

## 20281016010000_client_objective_workload_delegations

**SAFE CANDIDATE to move unchanged for Core preview composition; all six compiled production roots audited**

Header: source-only. SHA256 `dd762e2a5c721261525f36ac80f70b232b62fc09f0171fa3fbd5a12d4d442430`; blob `a500fe00745ce6fc59d5f324340ec4e45edc954f`.

```sql
-- Source-only Objective workload authority. The delegation table is DB-disabled:
-- this migration creates no issuer, signing key, service credential, enabled
-- grant or executable Objective route. Native transaction and privilege proof
-- is required before a later migration may remove the enabled=false fence.
```

Hard-closed production composition, not merely DB enabled=false: provider calls createObjectiveAdmissionRuntime() with no arguments. Runtime returns closed when enabled is absent, before reading bindings/Prisma/keys. No env switch at provider. Raw SQL adapters and unmounted retained reader do not run on import. CHECK(enabled=false) alone would not be sufficient.

No exact live workload table DDL supplied. All 23 pending SQL were searched: no other migration references any client_objective_workload_* relation. Own dependency on work_consents remains in retained reconsent migration. No SQL or generated client edits required to remove its deploy-directory entry.

Runtime evidence:
- Mounted module deliberately has no env/key enable switch and calls runtime factory without arguments. [apps/api/src/auth/workload-authority/objective-workload-admission.module.ts:5–12](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/auth/workload-authority/objective-workload-admission.module.ts#L5-L12)
- Factory inspects enabled own property then returns closed before bindings; Prisma factories only created later. [apps/api/src/auth/workload-authority/objective-workload-admission-runtime.ts:65–89](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/auth/workload-authority/objective-workload-admission-runtime.ts#L65-L89)
- SQL admission source itself defaults disabled and refuses before withSystem. [apps/api/src/auth/workload-authority/objective-workload-admission-source.ts:72–76](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/auth/workload-authority/objective-workload-admission-source.ts#L72-L76) [apps/api/src/auth/workload-authority/objective-workload-admission-source.ts:92–110](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/auth/workload-authority/objective-workload-admission-source.ts#L92-L110)
- Preacceptance loader refuses absent/false enable and missing policy before first SQL. [apps/api/src/auth/workload-authority/objective-workload-current.ts:115–128](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/auth/workload-authority/objective-workload-current.ts#L115-L128)
- Retained admission-read adapter has no production Core call site; SQL callbacks execute only through explicit function call. [apps/api/src/auth/workload-authority/objective-workload-admission-read-source.ts:43–62](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/auth/workload-authority/objective-workload-admission-read-source.ts#L43-L62) [apps/api/src/auth/workload-authority/objective-workload-admission-read-source.ts:153–153](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/auth/workload-authority/objective-workload-admission-read-source.ts#L153)
- Raw issuance port contains workload ledger SQL, but its only Core factory caller is after the production hard-close gate. [apps/api/src/auth/workload-authority/objective-workload-issuance-prisma.ts:40–49](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/auth/workload-authority/objective-workload-issuance-prisma.ts#L40-L49) [apps/api/src/auth/workload-authority/objective-workload-issuance-prisma.ts:72–82](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/auth/workload-authority/objective-workload-issuance-prisma.ts#L72-L82) [apps/api/src/auth/workload-authority/objective-workload-admission-runtime.ts:77–87](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/auth/workload-authority/objective-workload-admission-runtime.ts#L77-L87)
- Schema keeps five workload models; PrismaService construction derives in-memory DMMF names and startup only connects, not an all-model query. [apps/api/prisma/schema.prisma:17256–17385](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/schema.prisma#L17256-L17385) [apps/api/src/prisma/prisma.service.ts:84–98](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/prisma/prisma.service.ts#L84-L98)

Direct pending SQL dependencies:
- 20281015050000_client_objective_work_reconsent: client_objective_work_consents at [SQL:42](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281016010000_client_objective_workload_delegations/migration.sql#L42)

Other pending migrations referencing its created tables: none.

## 20281017010000_client_objective_strategy_intake

**HOLD removal: default-off writer does not close historical reads**

Header: no explicit source-only/reserved execution hold in header. SHA256 `06fa8b3039c8f97030eea1da811df67bf6b4e13c3c12ad3e4c11c71915fb0025`; blob `61013d54f708b073d6ceabf5b1f6b15b6a5e499b`.

```sql
-- Atomic selected-type companion to the unchanged v1 native retry receipt.
-- This is consistency storage, not a delegation, issuer, claim or effect grant.
-- Core inserts the intake before its fresh reserved job in ONE transaction.
-- Strategy owns sp_draft_job: deliberately no new cross-owner job FK or GRANT.
```

OBJECTIVE_STRATEGY_INTAKE_ENABLED literal true enables fresh intake; absent defaults off. bindStrategySelectionWithinTx intentionally gates write mode only, allowing historical recovery-read. Existing receipt/data condition is not a feature-disable gate.

No exact live intake table DDL supplied. Header describes consistency storage, not an execution hold. It also creates triggers on existing sp_draft_job, sp_strategy and sp_version; do not change or apply these without the stated task boundaries.

Runtime evidence:
- Strategy intake flag defaults off and only write mode is rejected before selection capture. [apps/api/src/clients/objectives/work/objective-strategy-work-owner.ts:46–61](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-strategy-work-owner.ts#L46-L61)
- V1 strategy retry chooses replay store; its receipt recovery executes SELECT from client_objective_strategy_intakes when a receipt exists, without checking enable flag. [apps/api/src/clients/objectives/work/objective-work.service.ts:100–105](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work.service.ts#L100-L105) [apps/api/src/clients/objectives/work/objective-work.service.ts:162–181](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work.service.ts#L162-L181)
- Selected strategy route recovery uses recovery-read and verifies intake for existing receipt before fresh writes. [apps/api/src/clients/objectives/work/objective-work.service.ts:118–134](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work.service.ts#L118-L134) [apps/api/src/clients/objectives/work/objective-strategy-selection-prisma.ts:16–24](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-strategy-selection-prisma.ts#L16-L24)
- Execute command attempts read-only recovery before the write transaction, making the recovery distinction material. [apps/api/src/clients/objectives/work/objective-work-command.ts:331–346](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/src/clients/objectives/work/objective-work-command.ts#L331-L346)

Direct pending SQL dependencies:
- 20281015050000_client_objective_work_reconsent: client_objective_work_consents at [SQL:56](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281017010000_client_objective_strategy_intake/migration.sql#L56), client_objective_work_command_receipts at [SQL:60](https://github.com/neo-capiro/capiro-backend/blob/51e265bd5b5170abffb32a62ffc39a52a788fe60/apps/api/prisma/migrations/20281017010000_client_objective_strategy_intake/migration.sql#L60)

Other pending migrations referencing its created tables: none.

## Compiled-root search receipt

rg across apps/api/src, apps/api/scripts, packages/shared, packages/meriv2-core, packages/defense-contracts, packages/defense-domain for workload table/model names, factory names and module filenames found production matches only within apps/api/src/auth/workload-authority. Specs/tests/fixtures excluded. Only provider mount is createObjectiveAdmissionRuntime() with no arguments; only admission/issuance source factory callers are inside that runtime after enabled gate.

| Root | Tracked | Missing |
|---|---:|---:|
| `apps/api/src` | 4266 | 0 |
| `apps/api/scripts` | 983 | 0 |
| `packages/shared/src` | 61 | 0 |
| `packages/meriv2-core/src` | 273 | 0 |
| `packages/defense-contracts/src` | 13 | 0 |
| `packages/defense-domain/src` | 66 | 0 |

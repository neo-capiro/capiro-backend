# Portfolio migration consumer audit

Pinned source `eecccecdc99620a25aed665578fc553938684e8a`; published equivalent `51e265bd5b5170abffb32a62ffc39a52a788fe60`; tree `4ac54093d3dc477e08249ded10bc7a07972637e6`.

These are source-level findings, not deployed reachability proof. No SQL was executed.

| Migration | Header | Decision |
|---|---|---|
| `20261014050000_user_portfolio_layout` | source-only | HOLD_UNGATED_CONSUMER |
| `20281011020000_portfolio_prospect_stages` | isolated-candidate | DEFAULT_OFF_CANDIDATE |
| `20281011030000_prospect_contacts` | source-only/unapplied | DEFAULT_OFF_CANDIDATE |
| `20281012010000_client_activity_commands` | source-preparation-only | HOLD_UNGATED_CONSUMER |
| `20281012020000_client_ordered_owners` | source-preparation-only | HOLD_UNGATED_CONSUMER_AND_COLLISION |
| `20281012030000_prospect_resource_origin` | source-only | HOLD_UNGATED_CONSUMER |
| `20281012060000_federal_register_effective_evidence` | source-only | HOLD_UNGATED_CONSUMER |
| `20281015040000_engagement_plans` | candidate-only/reserved | HOLD_UNGATED_CONSUMER |

## Limits

- Read-only static source audit at pinned tree; no SQL/DB execution, AWS calls, migration moves, runtime/flag edits or publication.
- Citations are exact source file and line locations. Source mounted routes plus lack of default-off gate do not prove deployed ingress reachability or a live successful request. Tenant/role/wall authorization remains required.
- A header marked source-only or reserved does not authorize moving a migration consumed by ungated code. Six rows HOLD; two rows are conditional default-off candidates for the inspected source paths.
- Initial broad git-object greps encountered scratch no-space errors. After root verified complete production closure source roots, follow-up rg succeeded across apps/api/src, apps/api/scripts, packages/shared, packages/meriv2-core, packages/defense-contracts and packages/defense-domain. Results below include alternate service callers, raw contact table strings, stage vocabulary and prospect write sites within those roots; other apps/deployed config remain outside this audit.
- PREVIEW_NATIVE_GETS_ENABLED/CORE_ROSTER_PREVIEW_ENABLED false defaults are not a universal REST-off switch: preview-native-read-mode.ts:35-39 returns unrelated for nonpreview Hosts; exact-path routing is at50. Global source AppModule remains mounted.

## 20261014050000_user_portfolio_layout

**HOLD_UNGATED_CONSUMER**. GET/PUT me/portfolio-layout are mounted with RolesGuard/standard_user, application authority and tenant/user checks. No default-off feature gate precedes the new table reads/writes in the inspected path.

Header: Source only: no migration/database execution is part of this change. (`apps/api/prisma/migrations/20261014050000_user_portfolio_layout/migration.sql:1`).

Live evidence: Fable explicitly reports user_portfolio_layouts absent. This is a source-level consumer plus exact catalog absence finding; no deployed request was tested.

Mounts:
- `apps/api/src/app.module.ts:107`
- `apps/api/src/users/users.module.ts:8`
- `apps/api/src/users/portfolio-layout.controller.ts:12-30`

Consumers:
- apps/api/src/users/portfolio-layout.controller.ts:33-39 (authority check then transaction)
- apps/api/src/users/portfolio-layout.transaction.ts:68-90 (SELECT at77-78; UPDATE/INSERT at84-90)

Dependencies:
- No SQL FK or function dependency on another pending migration found. Existing tenants/users and update timestamp helper are prerequisites.

Schema:
- apps/api/prisma/schema.prisma:666-678 (UserPortfolioLayout -> user_portfolio_layouts)

## 20281011020000_portfolio_prospect_stages

**DEFAULT_OFF_CANDIDATE**. Inspected new-stage REST writers are behind class BusinessDevelopmentFlagGuard. Guard reads tenant settings and rejects absent/false flag at business-development-flag.guard.ts:45-59. businessDevelopment.enabled defaults false at common/tenant-flags.ts:389-392. Meri alternate read path authorizes scope at meri-bizdev-tools.service.ts:163-191 and bizdev-meri-scope.service.ts:145-151 requires both BD and Meri prospect-tools flags.

Header: Isolated candidate; migration identity requires owner allocation before integration. (`apps/api/prisma/migrations/20281011020000_portfolio_prospect_stages/migration.sql:1`).

Live evidence: No live stage-CHECK definition was supplied. Ledger absence does not prove whether an equivalent CHECK exists or which nonlegacy stages are present. Do not claim full live schema compatibility.

Mounts:
- `apps/api/src/app.module.ts:156`
- `apps/api/src/business-development/business-development.module.ts:48-49`
- `apps/api/src/business-development/business-development.controller.ts:79-81,109-136`

Consumers:
- apps/api/src/business-development/prospect-stages.ts:3-24 (legacy plus new stage values)
- apps/api/src/business-development/business-development.dto.ts:154,237,301 (@IsIn union)
- apps/api/src/business-development/business-development.service.ts:440-447,573-588 (create/update stage)
- apps/api/src/meri/meri-bizdev-tools.service.ts:196-205 (alternate consumer reads context; no stage write there)
- apps/api/src/business-development/business-development.service.ts:399-404 (canonical create stage)
- apps/api/src/business-development/bizdev-watch.service.ts:216-219,327-330,336-339 (other prospect writes change watchRequested only)
- apps/api/scripts/ops/rehearse-bizdev-discover-filters.ts:326-332; apps/api/scripts/ops/rehearse-bizdev-watch-paging.ts:277-283 (manual rehearsal inserts use legacy researching)
- apps/api/scripts/business-development-phase1-postgres-acceptance.ts:18-22,142-146,199-213,238-239 (disposable-DB acceptance caller; creates omit stage, retaining legacy default)

Dependencies:
- No dependency on another pending migration found in the 10-line SQL. It alters an existing prospect stage constraint. Contacts/resource-origin have the existing prospect table as their FK target, not this widened CHECK.

Schema:
- Existing BusinessDevelopmentProspect stage is String; the new allowed-value union is application/SQL CHECK logic, not a new Prisma model.

Notes:
- Default-off move candidate based on completed production closure root search. Only production new-stage producers found are BusinessDevelopmentService create/update, invoked by its class-guarded controller; Meri alternate BusinessDevelopmentService use is reads only and independently gated. Watch writes do not write stage. Manual scripts found use legacy researching/default and do not need widened CHECK. Preserve stage mappings/legacy values and flags.

## 20281011030000_prospect_contacts

**DEFAULT_OFF_CANDIDATE**. Controller applies RolesGuard and BusinessDevelopmentFlagGuard at28. Independently, service currentScope calls prospectResourceScope before all listed operations; packages/shared/src/prospect-resource-scope.ts:40-45 rejects businessDevelopment.enabled absent/false. Default false is also explicit at common/tenant-flags.ts:391-392. The exported service therefore has an inspected internal scope gate as well as the controller gate.

Header: SOURCE-ONLY / UNAPPLIED; allocated root 20281011030000 after prospect stages. (`apps/api/prisma/migrations/20281011030000_prospect_contacts/migration.sql:1`).

Live evidence: NAME GAP: Fable reports prospect_contacts absent, but migration.sql:4 creates business_development_prospect_contacts. These are different exact names. No supplied catalog fact establishes actual business_development_prospect_contacts absence/presence; request exact-name confirmation, do not silently equate.

Mounts:
- `apps/api/src/app.module.ts:156`
- `apps/api/src/business-development/business-development.module.ts:48`
- `apps/api/src/business-development/prospect-contacts/prospect-contacts.module.ts:7-11`
- `apps/api/src/business-development/prospect-contacts/prospect-contacts.controller.ts:27-58`

Consumers:
- apps/api/src/business-development/prospect-contacts/prospect-contacts.service.ts:32-50 (scope before list SQL),59-81 (create),86-99 (update),102-112 (remove)
- apps/api/src/business-development/prospect-contacts/prospect-contacts.store.ts:66-74 (contact SQL)

Dependencies:
- SQL line3 requires existing Phase4 (tenant_id,id) unique key on business_development_prospects; FK at22. No hard dependency on pending stage CHECK migration; the header order is not a table dependency.

Schema:
- No matching Prisma contact model/map found in the inspected schema; service/store use raw SQL. Existing prospect scope remains a prerequisite.

Notes:
- Default-off move candidate based on completed production closure root search. Only ProspectContactsService production consumer found is its guarded controller; raw table use is confined to its service/store. requireContact store helper is called only after service currentScope in update/remove. No bypass caller was found in the six complete roots. Actual live table catalog name still needs exact confirmation.

## 20281012010000_client_activity_commands

**HOLD_UNGATED_CONSUMER**. Mounted clients/:clientId/activity-commands POST/GET/resume has RolesGuard/standard_user but no default-off flag. Planner origin check at46 is only for optional followUp; a request without followUp still queries new command storage at51.

Header: SOURCE PREPARATION ONLY; no migration/database execution. (`apps/api/prisma/migrations/20281012010000_client_activity_commands/migration.sql:1`).

Live evidence: Fable explicitly reports client_activity_commands absent. Source-level accessible path under valid authority; no live request/execution demonstrated.

Mounts:
- `apps/api/src/app.module.ts:113`
- `apps/api/src/clients/clients.module.ts:97`
- `apps/api/src/clients/activity-commands/activity-command.controller.ts:24-55`

Consumers:
- apps/api/src/clients/activity-commands/activity-command.service.ts:42-53 (optional followUp planner check then unconditional command lookup),66-71 (activity/command create),213-218 (command read)

Dependencies:
- SQL references existing tenants/clients; no FK dependency on another pending migration found. Activity/person/assignee references are historical scalars.

Schema:
- apps/api/prisma/schema.prisma:17114-17140 (ClientActivityCommand -> client_activity_commands)

## 20281012020000_client_ordered_owners

**HOLD_UNGATED_CONSUMER_AND_COLLISION**. New ordered-owner and existing team/account-owner routes mount without default-off feature flags. Role, membership and wall checks are authorization, not a source off-switch. New table is also consumed by existing routes.

Header: Source preparation only; not executed, including against ephemeral databases. (`apps/api/prisma/migrations/20281012020000_client_ordered_owners/migration.sql:1`).

Live evidence: Known exact collision: SQL line3 ADD COLUMN account_owner_version conflicts with live integer NOT NULL DEFAULT 0 column. Definition matches for the column only. SQL line4 named nonnegative CHECK is absent live. Fable reports client_ordered_owners absent and account_owner_user_id existing uuid nullable with users FK ON UPDATE CASCADE/ON DELETE SET NULL.

Mounts:
- `apps/api/src/app.module.ts:113`
- `apps/api/src/clients/clients.module.ts:99-101`
- `apps/api/src/clients/client-ordered-owner.controller.ts:8-24`
- `apps/api/src/clients/client-team.controller.ts:42-63`
- `apps/api/src/clients/client-account-owner.controller.ts:15-49`

Consumers:
- apps/api/src/clients/client-ordered-owner.access.ts:37-50 (reads/locks account_owner_version)
- apps/api/src/clients/client-ordered-owner.service.ts:49-65,97-100,132-135,162-168 (ordered rows)
- apps/api/src/clients/client-team.service.ts:52-70,96,172-181 (legacy team read/remove touches ordered rows)
- apps/api/src/clients/client-account-owner.service.ts:53-56,98-103 (legacy get/update delegate ordered service)

Dependencies:
- Header line2 reserves order after 20281011010000 objectives and 20281012010000 quick log, but SQL FK targets are existing clients/users; no hard FK to those pending tables found. Existing account_owner_user_id projection underlies consistency checks.

Schema:
- apps/api/prisma/schema.prisma:1006-1007 (Client fields);1224-1235 (ClientOrderedOwner mapping)

Notes:
- Proposal only: a separately approved reconciliation must retain the existing compatible column, establish/validate the missing CHECK, and review data/Primary-trigger/backfill compatibility before any execution. Do not treat ADD COLUMN IF NOT EXISTS alone as complete equivalence; no SQL edited or executed.

## 20281012030000_prospect_resource_origin

**HOLD_UNGATED_CONSUMER**. Mixed: prospect-specific intents are protected by prospectResourceScope default-off businessDevelopment.enabled. But ordinary authenticated GET engagement/attachments has no such feature gate and the service explicitly queries prospectId:null even with no prospect request. Thus disabling BD does not remove the added-column dependency. EngagementRuntimeGuard comment says global only in EngagementApiAppModule; AppModule unchanged (engagement/runtime/engagement-runtime.guard.ts:58), and no action metadata yields true at95-96.

Header: Source only; not executed or qualified against native/live databases. (`apps/api/prisma/migrations/20281012030000_prospect_resource_origin/migration.sql:1`).

Live evidence: Fable supplied no exact live catalog facts for engagement_attachments.prospect_id or prospect_attachment_upload_intents. Their status is unknown. Ledger absence alone does not establish absence. The source dependency is proven independently of catalog absence.

Mounts:
- `apps/api/src/app.module.ts:119`
- `apps/api/src/engagement/engagement.module.ts (EngagementController)`
- `apps/api/src/engagement/engagement.controller.ts:1979-1981,2897-2913`

Consumers:
- apps/api/src/engagement/attachments/prospect-attachment-access.ts:40-54,77-106,125-137 (prospect scope before new upload-intent table)
- apps/api/src/engagement/engagement.service.ts:7845-7890 (ordinary attachment listing unconditionally filters prospectId at7866; unlinked at7877),7964-7973 (strategy read prospectId:null)
- apps/api/src/engagement/generation/evidence-source.service.ts:799
- apps/api/src/engagement/outreach-send-intent.service.ts:1283,1377

Dependencies:
- SQL foreign key references existing business_development_prospects (tenant_id,id), and existing engagement_attachments. No hard dependency on pending stage/contact migrations. Shared domain is not equivalent to SQL dependency.

Schema:
- apps/api/prisma/schema.prisma:1629,1710-1718 (EngagementAttachment field/relation/index);17145-17164 (ProspectAttachmentUploadIntent)

## 20281012060000_federal_register_effective_evidence

**HOLD_UNGATED_CONSUMER**. Mounted effective-date-calendar read is under RolesGuard/standard_user with no default-off feature gate in inspected controller/service. Independently, ordinary invoked sync script uses writer without requiring --refresh-effective-dates; that CLI flag selects an extra refresh, not gating all new-column access. No script was run; scheduler/deployment configuration not assessed.

Header: Source only; no backfill or live migration execution. (`apps/api/prisma/migrations/20281012060000_federal_register_effective_evidence/migration.sql:1`).

Live evidence: Fable supplied no exact column/CHECK/index facts for this existing table. Unknown live compatibility; source dependency suffices for HOLD.

Mounts:
- `apps/api/src/app.module.ts:130`
- `apps/api/src/federal-register/federal-register.module.ts:5-9`
- `apps/api/src/federal-register/federal-register.controller.ts:90-92,114-116`

Consumers:
- apps/api/src/federal-register/federal-register.service.ts:105-162 (calendar uses evidence columns, notably138,149-150,153,159-160)
- apps/api/src/federal-register/federal-register-observation.ts:9-44 (SELECT and UPDATE new columns)
- apps/api/scripts/sync-federal-register.ts:20,25,189,236-239,311,396-400 (normal sync calls writer at311; optional refresh also189)

Dependencies:
- No pending-migration dependency found; alters existing federal_register_document.

Schema:
- apps/api/prisma/schema.prisma:6333-6335 (effectiveDateEvidence and effectiveDateObservedAt)

## 20281015040000_engagement_plans

**HOLD_UNGATED_CONSUMER**. Controller has RolesGuard/standard_user and tenant/client/ethical-wall authorization. No default-off feature flag guards mounted list/get/create/update/wave/review/history paths. Requiring a permitted client is not a default-off feature gate.

Header: CANDIDATE ONLY. Reserved: 20281015040000_engagement_plans. (`apps/api/prisma/migrations/20281015040000_engagement_plans/migration.sql:1`).

Live evidence: Fable explicitly reports engagement_plans absent. No exact catalog facts supplied for its child tables/functions; do not infer individual child absence from parent report. Source-level consumer finding only.

Mounts:
- `apps/api/src/app.module.ts:119`
- `apps/api/src/engagement/engagement.module.ts:111,113`
- `apps/api/src/engagement/plans/engagement-plans.controller.ts:32-56,59-82,113-136`

Consumers:
- apps/api/src/engagement/plans/engagement-plans.service.ts:71-85 (list reads plans after permitted client discovery),148-149,442-450 (optional objective validation)
- apps/api/src/engagement/plans/engagement-plan-store.ts:77,92,122,157 (read/create/update SQL)
- packages/shared/src/client-objective-destination.ts:57-100 (client_objectives read88-91; revisions96-100)

Dependencies:
- Explicit SQL header line3: coordinate with separate pending Objective 20281015030000 hunk before apply. SQL itself stores objective_binding JSON, with no FK into that pending hunk; FKs target tenants/clients and its own plan tables (SQL101-104,134,155,174).
- Conditional runtime dependency: non-null objective input invokes shared requireClientObjectiveDestinationRevision, which reads client_objectives/client_objective_revisions from pending 20281011010000. This path does not make ordinary plan reads safe when absent.

Schema:
- apps/api/prisma/schema.prisma:17390-17414 (EngagementPlan);17419 onward (wave/receipt/revision)

# Strategies vNext — Backend API Inventory

Source of truth: the existing strategy front-end HTTP client
`apps/web/src/pages/strategy/api.ts` and domain contract `types.ts`, cross-checked
against the NestJS controllers in `apps/api-strategy/src/*`. The strategy service is a
separate ECR/Fargate service mounted at `/strategy-api/*` on the shared ALB (global
prefix set in `apps/api-strategy/src/main.ts`; the ALB forwards the prefix without
stripping). Auth is the shared Clerk-authed axios client (`useApi()`); Bearer
`capiro-JWT` is attached by the shared interceptor. Server-side guards:
`TenantGuard + StrategyPlannerGuard` on the planner surface, plus `AgenticGuard` on
`/context/*` and `/agents/*`.

The new vNext module reuses these exact endpoints and the `['strategy', …]` react-query
key namespace so a mutation on either front-end invalidates the same records on the other.

## Endpoint inventory

| Screen · element | Method | Path | Params / body | Response type | Server controller | Query key |
| --- | --- | --- | --- | --- | --- | --- |
| Library · strategy table | GET | `/strategy-api/strategies` | — | `StrategyListItem[]` | `strategy/strategy.controller.ts` `@Get()` | `['strategy','strategies']` |
| Library · New strategy | POST | `/strategy-api/strategies` | `CreateStrategyInput` | `StrategyDetail` | `strategy.controller.ts` `@Post()` | invalidate `strategies` |
| Library · Draft with Meri | POST | `/strategy-api/strategies/draft` | `DraftStrategyInput` | `StrategyDetail` | `strategy.controller.ts` `@Post('draft')` | set `strategy`, invalidate `strategies` |
| Editor · detail payload | GET | `/strategy-api/strategies/:id` | — | `StrategyDetail` (meta+nodes+artifacts) | `strategy.controller.ts` `@Get(':id')` | `['strategy','strategy',id]` |
| Editor · meta edit | PATCH | `/strategy-api/strategies/:id` | `PatchStrategyInput` | `StrategyDetail` | `@Patch(':id')` | detail write handlers |
| Editor · add step | POST | `/strategy-api/strategies/:id/nodes` | `CreateNodeInput` | `StrategyDetail` | `@Post(':id/nodes')` | detail write handlers |
| Editor · edit step | PATCH | `/strategy-api/strategies/:id/nodes/:nodeId` | `UpdateNodeInput` | `StrategyDetail` | `@Patch(':id/nodes/:nodeId')` | detail write handlers |
| Editor · delete step | DELETE | `/strategy-api/strategies/:id/nodes/:nodeId` | — | `StrategyDetail` | `@Delete(':id/nodes/:nodeId')` | detail write handlers |
| Editor · step evidence back-link | POST | `/strategy-api/strategies/:id/nodes/:nodeId/artifacts` | `RecordArtifactInput` | `StrategyDetail` | `@Post(':id/nodes/:nodeId/artifacts')` | detail write handlers |
| History overlay · revisions | GET | `/strategy-api/strategies/:id/versions` | `?cursor=` | `VersionsPage` | `@Get(':id/versions')` | `['strategy','versions',id]` |
| History · restore impact | GET | `/strategy-api/strategies/:id/versions/:versionId/restore-impact` | — | `RestoreImpact` | `@Get(':id/versions/:versionId/restore-impact')` | `['strategy','restore-impact',id,vid]` |
| History · restore | POST | `/strategy-api/strategies/:id/versions/:versionId/restore` | — | `StrategyDetail` | `@Post(':id/versions/:versionId/restore')` | detail + change-sets + detached |
| Editor · detached steps | GET | `/strategy-api/strategies/:id/detached` | — | `DetachedSurface` | `@Get(':id/detached')` | `['strategy','detached',id]` |
| Editor · Meri conversation | GET | `/strategy-api/strategies/:id/conversations` | `?nodeId=` | `StrategyChatMessage[]` | `meri/meri.controller.ts` | `['strategy','conversation',id,nodeId]` |
| Editor · Meri edit | POST | `/strategy-api/strategies/:id/assistant` | `AssistantInput` | `AssistantResponse` | `meri.controller.ts` | detail + conversation |
| Editor · dismiss context gap | POST | `/strategy-api/strategies/:id/conversations/context-gaps/:messageId/dismiss` | — | `StrategyChatMessage` | `meri.controller.ts` | conversation |
| Library banner / timeline · firm phases | GET | `/strategy-api/firm-phases` | — | `FirmPhase[]` | `firm-phases/firm-phases.controller.ts` | `['strategy','firm-phases']` |
| Firm phases overlay · save | PUT | `/strategy-api/firm-phases` | `{rows: FirmPhaseInput[]}` | `FirmPhase[]` | `firm-phases.controller.ts` `@Put()` | set `firm-phases` |
| Timeline · reference layers | GET | `/strategy-api/reference-calendars` | — | `ReferenceCalendars` | `reference/reference.controller.ts` | `['strategy','reference-calendars']` |
| Reference · fork-on-edit | PUT | `/strategy-api/reference-calendars/:kind` | `{rows: ReferenceForkRow[]}` | `ReferenceCalendars` | `reference.controller.ts` | set `reference-calendars` |
| Reference · Meri assist rows | POST | `/strategy-api/reference-calendars/:kind/assist` | `{instruction, rows}` | `{reply?, rows}` | `reference.controller.ts` | — |
| Context library · documents | GET | `/strategy-api/context/documents?includeStale=true` | — | `ContextDocumentListItem[]` | `context/context.controller.ts` | `['strategy','context-documents']` |
| Context document · detail | GET | `/strategy-api/context/documents/:id` | — | `ContextDocumentDetail` | `context.controller.ts` | `['strategy','context-document',id]` |
| Context document · upload | POST | `/strategy-api/context/documents` | `UploadContextDocumentInput` | doc | `context.controller.ts` | set doc + invalidate list |
| Context document · archive | POST | `/strategy-api/context/documents/:id/archive` | — | doc | `context.controller.ts` | set doc + invalidate list |
| Context document · outline sections | GET | `/strategy-api/context/documents/:id/sections` | — | `ContextSection[]` | `context.controller.ts` | `['strategy','context-sections',id]` |
| Context document · locate lines | GET | `/strategy-api/context/documents/:id/locate?ref=` | — | `ContextLocateResult` | `context.controller.ts` | `['strategy','context-locate',id,ref]` |
| Context document · extract facts | POST | `/strategy-api/context/documents/:id/extract` | — | `ExtractFactsResult` | `steward.controller.ts` | steward invalidate |
| Steward · facts ledger | GET | `/strategy-api/context/facts` | — | `ContextFact[]` | `steward.controller.ts` | `['strategy','context-facts']` |
| Steward · conflicts | GET | `/strategy-api/context/conflicts` | — | `ContextConflict[]` | `steward.controller.ts` | `['strategy','context-conflicts']` |
| Steward · client health | GET | `/strategy-api/context/health?clientId=` | — | `ContextHealth` | `steward.controller.ts` | `['strategy','context-health',clientId]` |
| Steward · reject/restore fact | POST | `/strategy-api/context/facts/:id/reject` | — | — | `steward.controller.ts` | steward invalidate |
| Steward · resolve conflict | POST | `/strategy-api/context/conflicts/:id/resolve` | `ResolveConflictInput` | — | `steward.controller.ts` | steward invalidate |
| Steward · dismiss conflict | POST | `/strategy-api/context/conflicts/:id/dismiss` | — | — | `steward.controller.ts` | steward invalidate |
| Agent queue · change sets | GET | `/strategy-api/agents/change-sets?status=&strategyId=` | — | `ChangeSet[]` | `agents/agents.controller.ts` | `['strategy','change-sets',…]` |
| Agent queue · approve (subset) | POST | `/strategy-api/agents/change-sets/:id/approve` | `ApproveChangeSetInput` (`opIndexes`) | — | `agents.controller.ts` | agents invalidate |
| Agent queue · reject | POST | `/strategy-api/agents/change-sets/:id/reject` | — | — | `agents.controller.ts` | agents invalidate |
| Agent queue · apply (409 on moved base) | POST | `/strategy-api/agents/change-sets/:id/apply` | — | `StrategyDetail` | `agents.controller.ts` | detail + versions + agents |
| Agent queue · undo | POST | `/strategy-api/agents/change-sets/:id/undo` | — | `StrategyDetail` | `agents.controller.ts` | detail + versions + agents |
| Agent queue · firm-level runs | GET | `/strategy-api/agents/runs/firm-review` | — | `AgentRun[]` | `agents.controller.ts` | `['strategy','firm-review-runs']` |
| Agent queue · ack firm run | POST | `/strategy-api/agents/runs/:id/transition` | `{to}` | `AgentRun` | `agents.controller.ts` | firm-review + run |
| Agent queue · single run | GET | `/strategy-api/agents/runs/:id` | — | `AgentRun` | `agents.controller.ts` | `['strategy','agent-run',id]` |
| Watch layer · review state | GET | `/strategy-api/agents/watch/strategies/:id` | — | `WatchReviewState` | `agents.controller.ts` (watch) | `['strategy','watch-state',id]` |
| Watch layer · pending counts | GET | `/strategy-api/agents/watch/pending-counts` | — | `Record<string,number>` | `agents.controller.ts` (watch) | `['strategy','watch-pending-counts']` |
| Watch layer · accept/dismiss/accept-all | POST | `/strategy-api/agents/watch/...` | — | `WatchAcceptResult`/`WatchReviewState` | `agents.controller.ts` (watch) | watch invalidate |
| Execution · runs list | GET | `/strategy-api/agents/execution/runs?strategyId=` | — | `ExecutionRun[]` | `agents.controller.ts` (execution) | `['strategy','execution-runs',…]` |
| Execution · stage plan | POST | `/strategy-api/agents/execution/plan` | `PlanExecutionInput` | `ExecutionRun` | `agents.controller.ts` | execution invalidate |
| Execution · execute (STAGE only) | POST | `/strategy-api/agents/execution/runs/:id/execute` | — | `ExecutionRun` | `agents.controller.ts` | execution invalidate |
| Execution · resume | POST | `/strategy-api/agents/execution/runs/:id/resume` | `ResumeRunInput` | `ExecutionRun` | `agents.controller.ts` | execution invalidate |
| Execution · policy (allowed actions) | GET | `/strategy-api/agents/execution/runs/:id/policy` | — | `RunPolicy` | `agents.controller.ts` | `['strategy','run-policy',id]` |
| Execution · attempts | GET | `/strategy-api/agents/execution/runs/:id/attempts` | — | `ExecutionRun[]` | `agents.controller.ts` | `['strategy','run-attempts',id]` |
| Execution · approval status | GET | `/strategy-api/agents/execution/runs/:id/approval` | — | `RunApprovalStatus` | `agents.controller.ts` | `['strategy','run-approval',id]` |
| Execution · approve exact draft | POST | `/strategy-api/agents/execution/runs/:id/approve` | `{contentHash}` | `RunApprovalStatus` | `agents.controller.ts` | execution + approval + policy |
| Execution · reject approval | POST | `/strategy-api/agents/execution/runs/:id/reject-approval` | `{reason?}` | — | `agents.controller.ts` | execution + approval |
| Execution · cancel / retry / mark-failed / reconcile / resolve-reservation | POST | `/strategy-api/agents/execution/runs/:id/{cancel,retry,mark-failed,reconcile,resolve-reservation}` | — | `ExecutionRun`/`ReconcileResult` | `agents.controller.ts` | execution invalidate |
| New strategy · client options | GET | `/api/clients` | — | `ClientLite[]` | `apps/api` clients controller | `['clients']` |
| Step · owner options | GET | `/api/tenant-members` | — | `TenantMember[]` | `apps/api` tenant-members controller | `['tenant-members']` |
| Step · target options (member/committee/agency) | GET | `/api/clients/:clientId/targets` | — | `ClientTargetLite[]` | `apps/api` clients controller | `['client-targets',clientId]` |
| Step · Prepare in Workspace | POST | workspace service drafts endpoint | — | draft ref | `apps/workspace` `cascade`/`drafts` controllers | — |
| Step · Stage outreach | POST | `/api/engagement/outreach` | staged record (send disabled) | outreach record | `apps/api` `engagement/engagement.controller.ts` | — |

## Domain availability matrix

| Domain | Server-side exists? | Controller | Notes |
| --- | --- | --- | --- |
| Strategies CRUD | Yes | `strategy.controller.ts` | list/detail/create/patch |
| Steps / nodes | Yes | `strategy.controller.ts` | add/patch/delete + artifact back-links |
| Revisions / history | Yes | `strategy.controller.ts` `:id/versions` | append-only; restore is non-destructive archive-and-revive |
| Restore impact preview | Yes | `strategy.controller.ts` `restore-impact` | read-only pre-commit |
| Firm phases CRUD | Yes | `firm-phases.controller.ts` | full-replace PUT; propagates to reference layer |
| Reference calendars (legislative/PPBE) | Yes | `reference.controller.ts` | merged read + fork-on-edit PUT |
| Agent watcher change-sets | Yes | `agents.controller.ts` | approve subset via `opIndexes`; apply 409 on moved base; undo |
| Agent missions | Yes | `agents.controller.ts` | standing missions + run-check |
| Watch review (per strategy) | Yes | `agents.controller.ts` watch routes | accept/dismiss/accept-all, pending-counts aggregate |
| Agent execution runs | Yes | `agents.controller.ts` execution routes | plan/execute/resume/policy/approval/cancel/retry/mark-failed/reconcile/resolve-reservation |
| Context documents + versions + SHA-256 | Yes | `context.controller.ts` | upload/archive/sections/locate; supersession via `supersedesId` |
| Extracted facts | Yes | `steward.controller.ts` | ledger read + reject (reversible) |
| Conflicts + steward decisions | Yes | `steward.controller.ts` | resolve (required note) / dismiss; decision durable |
| Context health per client | Yes | `steward.controller.ts` `context/health` | — |
| Plan health (server-computed score) | Partial | none returns a single health scalar | §8.7: derive client-side per formula; GAP entry logged |
| Meri grounding / answer sources | Yes (partial) | `meri.controller.ts` + `GroundingHealth` | groundingHealth on detail; per-answer source list needs verify — GAP candidate |
| Workspace draft from step | Yes | `apps/workspace` drafts controllers | artifact back-link recorded on node |
| Outreach staging from step | Yes | `apps/api engagement.controller.ts` | staged only; external send hard-disabled until Stage H |
| Server clock / "today" marker | Partial | none dedicated | use `lastEditedAt`/server timestamps; GAP candidate |

## Gap candidates confirmed during discovery
- Plan health: no dedicated server scalar — interim client derivation per §8.7 (coverage/grounding/timeliness), clearly adaptered.
- Server-clock "today": timeline marker uses the strategy's server timestamps as the reference rather than `Date.now()` where feasible; a dedicated clock endpoint is a GAP.
- Meri per-answer source list: `GroundingHealth` carries status/conflicts; whether each assistant reply returns its own `sources[]` needs confirmation against the live assistant response — GAP candidate.

See `GAPS.md` for the full, ownered entries.

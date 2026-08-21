# Knowledge Plane Phase 26 — production readiness / zero-bypass closeout

Phases 19–26 are merged. Phase 19 (Meri/Research) landed as PR #1047; Phases
20–26 landed as one rebuilt overlay, PR #1141, squashed to `d8a97dfec`. This
document records the architecture that is now on `main`, the evidence behind it,
what the permanent gates enforce, and what is deliberately still open.

## Architecture on main

Every adopted product operation:

```
product operation
  -> ContextPlaneGatewayService
  -> Context Resolver
  -> Retrieval V2
  -> ContextPacket V2
  -> product reasoning
```

Ten registered operations, all `packet_required`, no migration exceptions:

| Operation | Governed seam |
| --- | --- |
| `meri.chat` | `MeriContextPlaneService` via `MeriContextPlaneRuntimeService.runChatTurn` |
| `meri.research` | `governed-meri-research.factory` |
| `research.generate-report` | `governed-meri-research.factory` |
| `outreach.generate` | `OutreachContextPlaneService` → `GenerationGatewayService` |
| `workspace.generate` | `WorkspaceContextPlaneService` |
| `workspace.editor-assist` | `WorkspaceEditorContextCompilerAdapter` substitution |
| `legiwatch.generate-report` | `LegiWatchContextPlaneService` |
| `crm.fill-with-meri` | `ClientProfileFillContextPlaneService` |
| `meetings.prep-debrief` | `MeetingContextPlaneService` / `meetings-context-plane.runtime` |
| `strategies.generate` | `StrategyContextPlaneService` via the internal bridge |

`defineContextOperation` hard-codes `mode: 'packet_required'`, and the registry
throws `context_operation_migration_debt_remains` at module load if any entry is
not. The five governed layers (firm identity, firm playbook, user voice, client
steering, client people) are unchanged; `ContextLayer` is still a five-member
union. No new RAG system, vector store, embeddings stack, graph, context
compiler or packet type was introduced.

## Strategy (Phase 25) runtime — verified, not assumed

An earlier audit found Phase 25 only partially connected. On current `main`:

- `api-strategy` reaches context **only** through
  `POST /internal/strategy/context/compile`, behind `InternalServiceGuard`.
- `StrategyContextPlaneService.securityEnvelope()` re-resolves, server-side and
  from the database, for the real Clerk actor: active membership, the canonical
  client, the ethical wall (`memoryWall: false` OR an explicit
  `memoryAccessGrants` row), and mailbox ownership
  (`integrationConnection.createdByUserId = actor`). A walled, archived,
  cross-tenant or nonexistent client all return the same non-disclosing
  `NotFoundException`, so access fails **before** retrieval.
- `allowExternalLookup: false` for private context resolution.
- `assertExactStrategyScope` fails closed on packet/client/current-object/surface
  mismatch.
- Destination operations are correct and cannot be relabelled:
  `governedBody(body, [expected])` in `strategy-orchestrator.client.ts` accepts
  only `workspace.generate` for a `workspace_draft` and only
  `outreach.generate` for an `outreach_record`, and additionally requires
  `governed.contextPacket.clientId === body.clientId`.
- The three governed hops are `async`, so a fail-closed throw surfaces as a
  rejected promise rather than escaping synchronously past a `.catch()`.
- The orchestrator no longer compiles a second client pack for Strategy:
  `strategy-context-pack.service.ts` is 104 lines and reads only
  `currentGovernedMeriContext()`; all three Strategy routes call
  `resolver.resolveIdentity(tc)`.

### `strategies_work` Retrieval V2 adapter

Read-only (`$queryRaw` only), reading `sp_strategy`, `sp_node`,
`sp_context_document`, `sp_context_fact`, `sp_context_conflict`. It never touches
`sp_agent_run`, `sp_change_set`, `sp_event_outbox`, `sp_strategy_chat_message`,
`sp_approval` or `sp_send_token`. It re-intersects the caller's envelope with
live CRM status and wall grants, so a stale or forged envelope cannot expose
`sp_*`. Coverage is honest: denial and unsupported paths return
`paginationComplete: false` with a specific `stopReason`
(`client_wall_or_status_denied`, `client_outside_security_envelope`,
`client_subject_required`, `query_class_not_supported`) rather than an empty
"complete" result. Zero records never implies complete coverage.

## Permanent gates

`scripts/check-context-plane-new-bypasses.mjs` now enforces three layers:

1. **Added-line guard** — a PR may not add a reference to a shared-plane
   internal outside the plane. Comment-aware; reviewed adapters are pinned to
   exact source lines in `APPROVED_ADAPTER_LINES`.
2. **HEAD invariants** — the registry, Strategy bridge, Strategy adapter and the
   whole `apps/api/src/engagement` tree, plus new **neutralization** invariants
   that pin every mechanism a dormant annotation depends on: the Phase 22 blocked
   compiler in both LegiWatch modules, the Phase 21 Workspace editor
   substitution, and the Phase 19 Meri runtime wrap
   (`streamMessage` → `runChatTurn`, and `if (!governed) return
   originalOrchestrate(...)`).
3. **Repo-wide census** — every non-plane, non-test line in `apps/**` and
   `packages/**` that names a shared-plane internal must appear in
   `SHARED_PLANE_CONSUMER_CENSUS` by exact trimmed text. This closes the hole
   where a bypass already sitting on the base branch was invisible to a
   diff-only guard. Entries are classified `neutralized` or `unmigrated`, and the
   `unmigrated` list is printed loudly on every run — it is a pinned, reviewed
   inventory, not a silent waiver.

20 negative-control mutations were each proven to fail the guard, including the
new census and neutralization checks.

Run everything with:

```bash
pnpm validate:knowledge-plane:phase26
```

It runs the guard, five zero-error typechecks, the `apps/api` typecheck against
a pinned pre-existing-error baseline, the Context Plane + adoption test surface,
and `git diff --check`. No check is wrapped in `|| true`.

## Known-open items

- **Funding-opportunity assessment is an unmigrated direct consumer.**
  `apps/api/src/meri/meri.module.ts` (`FUNDING_OPPORTUNITY_ASSESSMENT_WIRING`)
  hands the real `ContextCompilerService` to `MeriOpportunityAssessmentService`,
  which compiles a `tool-invoke` packet directly. It predates the Phase 19–26
  sequence (`ae1200599`) and is not one of the ten registered operations, so it
  was never in scope for this migration. It is best-effort and non-authoritative
  (`persistence: 'best-effort'`, errors swallowed, returns `null`), but it is a
  live path around the gateway. It is now pinned in the census and reported on
  every guard run. Migrating it means registering an eleventh operation — a
  scope decision, not a defect fix.
- **`apps/api/scripts/meriv2-phase18-application-rehearsal.ts`** constructs the
  compiler directly. Offline harness, not wired into any Nest module.
- **`ENGAGEMENT_GENERATION_GATEWAY` is no longer a kill switch.** It defaults
  true and no OFF branch exists; `GenerationGatewayService.enabled` is retained
  but never read as a fork. Rollback for Outreach generation is code-revert only.
- **The orchestrator still compiles a packet for `steward-extract`** with a real
  `clientId`. `steward-extract.service.ts` reads only `tenantId`, `userId` and
  the packet id for provenance — no context layer reaches its prompt — so it is
  not a reasoning bypass, but it is a latent surface worth removing.
- Pre-existing, unrelated to this work and verified identical on the base commit:
  16 `apps/api` `tsc` errors (all in `*.spec.ts`), 3 failing `apps/api` suites,
  4 failing `apps/workspace` suites, 2 failing `apps/meriv2-orchestrator` suites,
  and a literal NUL byte in
  `apps/api/src/engagement/generation/author-style-profile.service.ts` that makes
  `grep` treat that file as binary.

## Rollout sequence

Deployment and enforcement activation are separate actions. Do not enable all
operations at once because the code deployed.

1. Deploy the code with rollback available. The Context Plane release switch
   (`CONTEXT_PACKET_V2` / `resolveContextPacketMode`) is the supported rollback
   for registered operations: a non-`enforce` mode is allowed and audited as
   `release_switch_rollback`, not misreported as governed V2 consumption.
   Outreach generation is the exception — code-revert only.
2. Verify health and Context Plane telemetry.
3. Canary the adopted operations gradually.
4. Per operation, verify packet persistence, retrieval coverage, wall isolation,
   error rates, latency and provider behaviour.
5. Widen enforcement only after the canary is healthy.

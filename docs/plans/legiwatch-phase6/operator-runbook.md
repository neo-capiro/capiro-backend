# Phase 6 operator runbook

## Release scope

Candidate affects API, Intel service/report worker, Workspace, Meri and web-vnext. Engagement is unchanged. Apply additive owner migrations API → Intel → Workspace before compatible backend/worker rollout, then web. Pin exact qualified image digests. Refresh current main, ECS service/worker task definitions, migration ledger, active browser/server recordings and pending outbound work immediately before authorized rollout; the earlier read is not a current safety guarantee. Preserve newer intervening releases and all active capture connections.

The new capabilities default off. Deployment alone does not activate client rules. No client pilot scope, labeled corpus or channel authorization was supplied during implementation.

Workspace's legacy `migrate` wrapper auto-resolves failed rows in the shared migration ledger. For this rollout use its qualified image with entrypoint `node`, arguments `node_modules/prisma/build/index.js migrate deploy`, working directory `/app/apps/workspace`, and the existing owner connection supplied through normal secret injection. API and Intel use their existing fail-closed migration entrypoints. Preflight the ledger read-only; stop on unresolved failures and use the existing reviewed recovery process. Do not run Workspace's auto-resolution wrapper or reseed unrelated global templates for this migration. The immutable-image verification uses this direct packaged Workspace Prisma command.

## Gates and adapters

| Capability | Tenant feature | Runtime gate |
|---|---|---|
| Discovery | `legiwatch_keyword_discovery_v1` | `LEGIWATCH_KEYWORD_DISCOVERY_ENABLED=true` for unattended scans |
| Automatic additions | `legiwatch_keyword_auto_add_v1` | `LEGIWATCH_KEYWORD_AUTO_ADD_ENABLED=true` |
| Internal actions | `legiwatch_internal_workflows_v1` | `LEGIWATCH_INTERNAL_WORKFLOWS_ENABLED=true` |
| Keyword outbound | `legiwatch_keyword_delivery_v1` | `LEGIWATCH_KEYWORD_DELIVERY_ENABLED=true` |

Rules and templates also require their own explicit reviewed activation. Existing reports/calendar/Phase 5 gates continue to apply. Report workflow UI requires `legiwatch_reports_updates_v1`; published review requires `LEGIWATCH_RECORD_RECONCILIATION_ENABLED=true` and existing source/owner gates. Existing reports/agenda/capture settings must not be changed to activate Phase 6.

Keyword inbox delivery additionally checks `LEGIWATCH_KEYWORD_DELIVERY_ENABLED` in the API runtime. Keep it off together with Intel's gate until the separate channel qualification is approved.

Intel service AND the scheduled report worker need `WORKSPACE_BASE_URL` (trusted Workspace origin) and the existing `INTERNAL_SERVICE_SECRET`. Workspace needs `INTEL_API_BASE_URL` (trusted Intel origin) and the same narrowly scoped service secret. Requests append `/workspace-api/internal/legiwatch/preparations` and `/intel-api/internal/legiwatch/workflow-actions/:id` respectively; do not include those suffixes in origin values. API's Meri bridge uses `TRACKER_APP_BASE_URL` and the existing service secret. Missing configuration holds preparation; it does not fall back to a public or guessed endpoint. Do not log secret values or action payloads/private notes.

Use existing EventBridge `run-report-updates` targets with explicit tenant UUID; do not create another scheduler. New budgets: 10 owners/configs per tick, 25 scan bills/automatic additions per bounded pass, 10 source events per configuration, 25 delivery recipients per drain; batch review max 200. Actual processing SLA/cost is not established by these limits.

## Preview and narrow pilot

1. Open Bills → folder → Suggested bills / Keyword rules. Confirm exact canonical jurisdiction/session, active owner, client wall and editable folder. GET only reads; explicit preview/scans may save diagnostics but create zero assignments, tasks, drafts or messages.
2. Review the ten imported rules before promotion. Keep exact raw expressions/source IDs. Resolve aggregation, selected definitions, owner and target folders explicitly. Alert-35 stays incomplete; alert-38 holds selected definition 32340 until semantics are resolved. Alert-36 preserves end-of-day. Current staff channels require explicit reviewed mapping; no external contact list or SMS inference.
3. Run a bounded complete preview and inspect positive, negative and incomplete source coverage. Full-text automation cannot be enabled while that corpus remains unqualified. Select one qualified deterministic rule/folder and a from-now baseline only after pilot authorization and labeled evaluation. Meri remains suggestion-only.
4. Review frozen suggestion IDs/versions, apply a batch, inspect each outcome and immutable history. Existing context remains. Manual removal suppresses every rule in that folder; explicit restore/manual re-add clears that scope. Undo removes only a sole, untouched automation-created membership.
5. Configure one paused workflow, preview exact sources/output, then explicitly activate from-now. Observe the actual worker source event → action → Workspace receipt/output chain and verify one output on retry. Follow public packet and report-review links; approval/send/attendance/capture remain separate user actions.
6. Only after current channel qualification, review exact recipients/cadence and enable keyword delivery separately. Record inbox/message receipt evidence and opt-out/pause behavior. Do not treat fixture transport acknowledgements as delivered email.

## Diagnostics and recovery

Keyword history exposes query/control versions, source hashes, scan checkpoints/counts/gaps and decisions. Delivery history exposes held/uncertain/queued outcomes and body hash. Workflow history exposes frozen input, lease/step, failure reason and output IDs. Log IDs/hashes/sanitized reasons only.

- Unsupported/empty query: hold; review raw source without silently changing meaning.
- Partial/missing text: inspect source coverage; never count unknown as a complete negative.
- Stale rule/folder/source or owner withdrawal: refresh/review; do not force old snapshots through.
- Partial preparation or lost acknowledgement: inspect existing source receipt/output, then Resume. The remote receipt is authoritative; human edits survive. Deleted output remains a hold.
- Held delivery: resolve its actual reason, review exact frozen body hash/current audience, then use the existing report recipient retry endpoint. New source/rule meaning requires a new preview.
- Uncertain delivery: use existing transport reconciliation; no automatic resend.

## Pause and rollback

Disable keyword outbound and new automatic/internal effect gates first; pause the affected rule/template. Tenant gates and current rule state are checked before each effect, including a running worker; stopping a future schedule alone is insufficient. Observe no new assignment/output/message after pause and retain queued/held evidence. Do not disable unrelated report/agenda/record/capture workers.

Keep completed drafts, manual/import memberships, source snapshots, decisions, suppression, report history and immutable receipts. Use targeted audited undo only when the sole automation contribution remains untouched; otherwise leave the work and explain the conflict. Never bulk-delete or resend uncertain messages. Retain additive schema and use compatible pinned images or forward repair. Roll back UI/backend behavior without discarding protected history.

Exact application/image/worker qualification and infrastructure failures: [release-qualification.md](release-qualification.md).

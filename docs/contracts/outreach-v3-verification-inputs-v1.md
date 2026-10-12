# Outreach V3 verification inputs v1

This is the operating input for `scripts/verify-outreach-v3-p1-architecture.mjs`, used by the existing Outreach verification gates. It replaces the guard's two historical-plan presence checks with complete preserved requirements. The four other required operating documents remain active: [runtime ownership contract](engagement-runtime-ownership-v1.md), [capability contract](capiro-capabilities-v1.md), [capability security runbook](../runbooks/capiro-capability-security.md), and [runtime ownership runbook](../runbooks/engagement-runtime-ownership.md).

Historical implementation labels below are claims preserved from the original plans; they do not establish current completion or a passing gate.

The frozen Phase 1 catalog has nine entries; the current architecture verifier requires all thirteen current entries and their existing authority checks.

This contract grants no production ownership transfer, future-profile activation, frontend retirement, or waiver of executable acceptance gates.

## Requirements and evidence custody

The complete original requirements are pinned at [`f1e83a3f194a8ebd972e370ff6e5b5f559888b29`](https://github.com/neo-capiro/capirov2/tree/f1e83a3f194a8ebd972e370ff6e5b5f559888b29): [Revised Phase 1 shared foundations](https://github.com/neo-capiro/capirov2/blob/f1e83a3f194a8ebd972e370ff6e5b5f559888b29/docs/plans/outreach-v3/revised-phase-1-shared-foundations.md) and [Revised Phase 2 readiness](https://github.com/neo-capiro/capirov2/blob/f1e83a3f194a8ebd972e370ff6e5b5f559888b29/docs/plans/outreach-v3/revised-phase-2-readiness.md). Both bodies below are byte-identical to those originals and to the pre-edit source checkpoint `8ac4c42cc49876ec19808369c0683956e0f2f474`, protected by `refs/tags/cleanup-recovery/20261012/consumer-retirement-before-8ac4c42`. The verifier checks each embedded body's SHA-256 and refuses omissions, changes, missing markers, or duplicate markers.

An additional read-only copy of both complete plans, the original verifier, its unchanged six-case specification, and `CHECKPOINT.json` is held at `/workspace/backend-cleanup-recovery-20261012/outreach-operating-inputs-before-8ac4c42`. The checkpoint manifest SHA-256 is `495665b0c2e4c37fbf514a0c121f1049c56e36513d3a3e301c565bb555cc6607`. Archive-relative paths match original repository paths. Git checkpoints and original histories remain preserved; this filesystem copy supplements their custody.

| Preserved input | Original Git blob | SHA-256 | Bytes |
| --- | --- | --- | ---: |
| Revised Phase 1 shared foundations | `b8741c9b637d04423593547fcc6efa5accb99548` | `89ca2d953e3d9b5861e9e286d9e3372e838ac851660681a750b4e5e145aaed55` | 2474 |
| Revised Phase 2 readiness | `89c8d191ed5ffd1280b374c6c42d8ae1816e2a9c` | `9c1ceeac9a5733306312b8124b15f10acf5a87b77ef0294a66389b9131e00716` | 1215 |

The original Phase 1 DB-free and authoritative local commands, Phase 3 regression/browser harness obligations, exact-head evidence, current/future ownership rehearsals, security boundaries, completion conditions, and Phase 2 entry criteria are preserved in full below. Their operational prerequisites remain requirements, including executable CI jobs and a qualified local host. This source migration records no native test run, browser result, independent product acceptance, actual build-tree attestation, or production cutover.

The original planning files remain in the active tree. CI path filters, synthetic prototype/scope tests, links, and historical source-bound evidence must be assessed before any later retirement. Historical evidence stays attached to its original source identity; adopting an archive/proof chain on changed source requires fresh, separately retained source-bound evidence. Unfinished or conflicting completion claims must be resolved by retained command output and independent validation, rather than relabeling historical claims. Existing operating/API/recovery/migration/incident records and the unpublished Engagement report remain outside this migration.

## Complete original Phase 1 requirements

<!-- outreach-v3-phase1-foundations:begin -->
# Outreach V3 Revised Phase 1 — Shared Foundations

## Scope

This phase decouples runtime ownership and establishes one shared Capiro capability layer for Meri and future Outreach V3. It does not add the Outreach V3 reasoning loop, Campaign Spec, final UI, sending UI, OpenAI conversation state, LangGraph, a new database, a new service, or a production cutover.

## Implemented boundaries

- neutral `AiCredentialsModule`, retaining tenant-first keys, platform fallback, model override, encryption, validation timeout, internal-service guard, and runtime-policy denial;
- neutral `ClientDocumentsModule` port over the current governed attachment implementation;
- neutral exact immutable-version `OutreachReviewTransactionsService`, with review identity, reviewer authorization, version decision, and review stamp in one transaction;
- independently composable authenticated integration actions, provider callbacks/notifications, Recall webhook, and background workers;
- request/core Engagement composition with no registered timers or callback controllers;
- one runtime ownership contract with current-main and future-test-only profiles;
- provider-neutral capability context, result, provenance, exclusion, error, definition, registry, and adapter contracts;
- one nine-entry shared capability catalog;
- proof implementations for `get_client_context`, `get_recent_activity`, and `get_capiro_record`;
- composition into both `AppModule` and `EngagementApiAppModule`.

## Compatibility

Public paths and methods are unchanged. Outreach v2 remains the default. Meetings, Reports, Integrations, authorization middleware exclusions, raw Recall body handling, signature verification, and current external-action denial behavior remain in place.

The old Microsoft and Google controller files remain only as the frozen Phase 0 route-parser inputs; Nest registers the split controller classes. Their route semantics are required to remain identical.

## Verification

```bash
pnpm verify:outreach-v3-phase-1
pnpm verify:outreach-v3-phase-1:local -- --sha "$(git rev-parse HEAD)"
```

The DB-free gate checks ownership and architecture negative controls, focused tests, a dedicated TypeScript project, Phase 3 regression, API build, and whitespace. The authoritative local gate additionally executes the exact-head Phase 3 dual-runtime/browser harness and current/future ownership rehearsals.

No completion claim is valid without real command output and retained evidence.
<!-- outreach-v3-phase1-foundations:end -->

## Complete original Phase 2 entry requirements

<!-- outreach-v3-phase2-readiness:begin -->
# Outreach V3 Revised Phase 2 Readiness

## Entry condition

Revised Phase 2 may begin only after:

```text
Phase 3 DB-free PASS
Phase 3 authoritative local PASS
Revised Phase 1 DB-free PASS
Revised Phase 1 authoritative local PASS
Open P0 = 0
Open P1 = 0
Blocking P2 = 0
Independent validation = OUTREACH_V3_PHASE1_APPROVED
```

## Available foundations

Phase 2 can consume the shared capability registry and provider-neutral adapter contract; it must not copy client context, recent activity, or record lookup into an Outreach-owned implementation. It can rely on exact immutable draft-version review and the explicit runtime ownership modules.

## Phase 2 scope

Phase 2 owns the canonical Campaign Spec, state versions, event log, strict command schemas, and deterministic command engine. It does not inherit authority to transfer production callbacks/workers/Recall, enable the future ownership profile, or introduce a separate AI platform.

## Known operational prerequisite

GitHub Actions must create executable jobs, and the authoritative local host must provide Docker/pgvector, Chrome/Chromium, and dedicated Clerk acceptance actors. Source review or a workflow `startup_failure` is not a passing gate.
<!-- outreach-v3-phase2-readiness:end -->

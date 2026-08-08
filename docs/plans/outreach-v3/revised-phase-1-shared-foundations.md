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

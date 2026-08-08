# Engagement Runtime Ownership Contract V1

## Purpose

This contract prevents the main API and `engagement-api` from simultaneously owning Engagement background work, provider callbacks, Recall processing, or externally acting operations.

## Current production profile

The current profile is intentionally unchanged:

```text
workers          api
callbacks        api
Recall           api
external actions api
engagement-api   shadow / disabled
```

The machine-readable source is `infra/cdk/fixtures/engagement-runtime-ownership.v1.json`. `scripts/engagement-runtime-ownership.mjs` derives owners from each service posture and fails unless every concern has exactly one owner.

## Future rehearsal profile

A second profile models all four concerns moving to `engagement-api`. It is marked `testOnly=true` and `productionAllowed=false`. It exists only to prove that ownership can move through configuration and routing later, without another source fork.

It is not production cutover authorization and is not accepted by the current production shadow-environment validator.

## Composition rules

- `EngagementModule` is request/core composition and registers no callback controllers or timer providers.
- `EngagementWorkersModule` owns timer registration.
- `EngagementCallbacksModule` owns Microsoft notifications and Microsoft/Google OAuth callback routes.
- `RecallWebhookModule` owns `POST /webhooks/recall`.
- `EngagementIntegrationActionsModule` owns authenticated connect, disconnect, subscription, and manual-sync actions.
- every provider boundary still consults `EngagementRuntimePolicyService` before acting.

## Prohibited states

The ownership verifier rejects dual owners, missing owners, an unknown service, a production-enabled future profile, a non-shadow current `engagement-api`, or any declaration that disagrees with the posture-derived owner.

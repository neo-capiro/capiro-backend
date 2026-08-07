# Engagement Phase 3 — Rollback

Phase 3 changes the web only for an explicitly activated internal preview. Canonical Engagement traffic remains on the main API.

## Fastest containment

For an individual test session:

1. choose **Turn off preview** or navigate with `engagement-api-preview=off`;
2. confirm the parameter is consumed;
3. confirm the preview indicator disappears;
4. confirm subsequent Engagement requests carry no preview header.

The transition cancels/removes only Engagement-owned React Query entries; unrelated owner caches are preserved.

## Dev web rollback

If the Phase 3 web build itself is unhealthy:

1. redeploy the prior known-good web image/artifact;
2. do not change the generic `/api/*` rule;
3. verify ordinary Engagement traffic still reaches main;
4. verify `/webhooks/recall` and OAuth callbacks are unchanged;
5. verify current product health.

No database rollback exists because Phase 3 creates no migration.

## Dark-service containment

If preview routing or the dark service is unhealthy and the preview must be made unreachable:

1. delete/disable the exact **preview** listener rule using the accepted Phase 2 fail-closed rule manager;
2. verify ordinary current product traffic remains healthy;
3. only then, if separately authorized, scale `engagement-api` to zero;
4. do not scale or redeploy main as part of Phase 3 rollback.

Do not alter DNS, certificates, generic API routing, Recall/callback routing, or the historical frozen Compute stack.

## What must remain true after rollback

```text
ordinary /api/engagement/* → main API
Recall/callback ownership   → unchanged main owner
workers                     → unchanged
external actions            → not enabled in shadow
migrations                  → none
Outreach v2                 → present/default
Outreach V3                 → not deployed by Phase 3
```

## Evidence

Record exact prior/new web SHAs, preview-rule state, ECS desired/running counts when changed, and one ordinary Engagement health/read probe. Never report a rollback as complete based only on a deployment command returning success.

# Engagement Runtime Ownership Runbook

## Inspect current contract

```bash
node scripts/engagement-runtime-ownership.mjs
node --test scripts/engagement-runtime-ownership.spec.mjs
```

A valid current profile has one owner for workers, callbacks, Recall, and external actions, and all four owners are `api`.

## Current-owner rehearsal

```bash
node scripts/run-outreach-v3-p1-owner-rehearsal.mjs
```

The current profile must resolve every concern to the main API. `engagement-api` remains shadow and performs no external action.

## Future-owner rehearsal

The same command evaluates the test-only future profile. It must resolve every concern to `engagement-api`, while retaining `productionAllowed=false` and `testOnly=true`.

This is a configuration proof only. Production transfer additionally requires a later approved routing/configuration phase, provider fakes during rehearsal, full Phase 3 parity, deployment review, and explicit cutover authorization.

## Failure response

Do not start either runtime when the verifier reports dual or missing ownership. Do not weaken the fixture, remove an owner check, or enable shadow external actions as a workaround. Restore a single current owner, then rerun DB-free and local verification.

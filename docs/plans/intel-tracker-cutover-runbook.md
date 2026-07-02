# Bill-Tracker Cutover Runbook (legacy apps/api → intel-api)

Per-tenant, reversible cutover of the client-profile Tracker from the legacy
`apps/api` tracker to `intel-api`. Preserves the single-sender invariant at every
step: **exactly one system delivers alerts for a tenant at all times.**

All commands run as one-off ECS tasks on the intel-api verb task-def
(`capiro-dev-intel-api-enableflag`, container `intel-api-enableflag`) via the
`task <verb>` runner, e.g.:

```
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-intel-api-enableflag \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"intel-api-enableflag","command":["task","<verb>","<args>"]}]}'
```

## 0. Preconditions (ALL must hold for the pilot tenant — do NOT flip otherwise)

- [ ] **Parity green ≥ 7 contiguous days** — `task cutover-status <tenant>` shows `parityGreen=true` (per-tenant or rolled-up streak ≥ 7, no missing days). The `capiro-intel-parity-missed-criticals` alarm has NOT fired.
- [ ] **Ninja S10 sign-off** recorded (plan §8 gate).
- [ ] **SES production access granted** — `aws sesv2 get-account` → `ProductionAccessEnabled: true` (so intel-api can deliver to real recipients, not just verified identities).
- [ ] **Data synced** — `cutover-status` shows non-zero `trackedBills` / `alertPrefs` for the tenant (Phase-2 backfill ran). `intel_watchlist` for the tenant is current (scheduled `sync-watchlists-from-legacy` is live).

## 1. Arm the legacy single-sender guard (once, before the first flip)

Set `TRACKER_SINGLE_SENDER_GUARD=on` on the **apps/api** task-defs that run the
legacy detector — the scheduled `detect-tracker-alerts` task-def AND (for safety)
the serve task-def — then register + roll. While the guard is on but no tenant
has the `tracker_owner_intel` flag, legacy behavior is unchanged (the guard skips
zero tenants). This is a no-op until step 2 flips a tenant.

> Verify the guard reads the flag: after step 2, the legacy detector logs
> `single-sender guard ON: suppressing legacy delivery for N intel-owned tenant(s)`
> and its run summary shows `suppressedOwned=N`.

## 2. Flip the tenant (the cutover)

```
task enable-feature tracker_owner_intel <tenant>   # intel becomes delivery owner; legacy guard now skips this tenant
task enable-feature tracker_v2 <tenant>            # unified tracker UI + combined feed visible for this tenant
```

Order matters: enable `tracker_owner_intel` FIRST (transfers delivery), then
`tracker_v2` (reveals the new UI). The moment `tracker_owner_intel` is set:
- legacy `detect-tracker-alerts` skips fan-out for this tenant (single-sender guard), and
- intel delivery for this tenant activates only when `TRACKER_ALERTS_ENABLED` is on for intel-api (the intel kill-switch — enable it in the same change window).

## 3. Verify (no double-send, alerts flowing from intel only)

- [ ] `task cutover-status <tenant>` → `owner=true v2=true`.
- [ ] Legacy detector next run: `suppressedOwned ≥ 1` for this tenant, and `notification_log` gets NO new legacy rows for it.
- [ ] intel-api delivers: `intel_notification_log` rows with `status='sent'` for the tenant (once `TRACKER_ALERTS_ENABLED=on`), and `shadow-selftest` is no longer suppressed.
- [ ] Spot-check the client-profile Tracker tab (tracker_v2 UI) + the combined feed render.

## 4. Rollback (instant, reversible)

```
task disable-feature tracker_owner_intel <tenant>   # legacy resumes delivery for this tenant
task disable-feature tracker_v2 <tenant>            # hide the new UI
```

Legacy immediately resumes (the guard stops skipping the tenant). intel-api stops
being the owner. No data is lost (intel_alert rows remain; they just aren't
delivered). If needed, also set `TRACKER_SINGLE_SENDER_GUARD=off` to fully revert
the legacy detector to pre-cutover behavior across all tenants.

## Notes

- The guard reads the intel-owned set from `intel_feature_flag` (feature=`tracker_owner_intel`, enabled=true); the flip in step 2 is what the guard keys on. It deliberately ignores the internal-tenant always-on hardcode (intel doesn't deliver for internal in shadow).
- Roll tenants ONE pilot at a time; re-run steps 0–3 per tenant. Keep the missed-critical alarm subscribed throughout.
- `cutover-status` is read-only and safe to run anytime.

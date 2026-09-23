# Stage 3D: controlled evidence profiles

## Why

The explicit tool profile table prevents a new or Capiro-derived tool from being treated as official, primary, and authoritative by default. Because these classifications affect claim support, confidence, release holds, and provenance, the safer table is independently rolled out rather than changing live behavior globally.

## Controls and modes

The control family is `MERI_EVIDENCE_PROFILES_MODE`, `MERI_EVIDENCE_PROFILES_TENANTS`, and `MERI_EVIDENCE_PROFILES_SURFACES`.

- `off` (default): uses the legacy regex classification exactly; no comparison runs.
- `shadow`: returns the legacy ledger and emits one `meri.evidence_profiles.shadow` JSON event per evaluated call site.
- `enforce`: uses the explicit tool profile table, including its fail-closed unknown-tool fallback.

The shadow event contains only `surface`, `callSite`, `evidenceItems`, `evidenceChanged`, sorted unique `toolsChanged`, `claims`, `claimSupportChanged`, `claimConfidenceChanged`, and `primarySourcePresentChanged`. It contains no claim text, passages, evidence IDs, tenant IDs, or client data. Comparison and logging failures are ignored so they cannot affect a turn.

## Measuring shadow results

CloudWatch Logs Insights:

```sql
fields surface, toolsChanged, claims, claimSupportChanged
| filter event = "meri.evidence_profiles.shadow"
| stats sum(claimSupportChanged) as changedClaims,
        sum(claims) as totalClaims,
        100.0 * sum(claimSupportChanged) / sum(claims) as changedClaimPct,
        count(*) as evaluations
  by surface, toolsChanged
| sort changedClaimPct desc
```

## Promotion rule

Run shadow for all tenants and all intended surfaces first. A person must review both the changed-claim rate and every tool in `toolsChanged`. Enforce only after that review confirms the changes are expected and acceptable; promote surfaces deliberately rather than globally by default.

## Stage 4 dependency

Stage 4 provenance, match labels, and status provenance must only be enabled where `EVIDENCE_PROFILES` resolves to `enforce`. `sources[].provenance` copies these classifications, so exposing Stage 4 provenance before profile enforcement could publish legacy classifications as if they were the reviewed profile result.

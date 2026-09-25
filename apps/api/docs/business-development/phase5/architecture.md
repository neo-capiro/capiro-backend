# Business Development Phase 5 — Watch Architecture

Status: implemented in the Phase 5 release branch; production identifiers and pilot evidence are recorded in `operations-and-rollback.md` after deployment.

## Scope

Phase 5 adds a tenant-owned watch to an existing Business Development prospect, a DB-only evaluator over existing canonical projections, append-only source-linked alerts, per-recipient in-app delivery state, the existing notification-bell integration, and a read-only Meri follow-up tool.

Email, SMS, push notifications, automatic outreach, and a second watchlist application are not part of this release.

## INV-0: existing ingestion only

The evaluator imports no provider client and performs no provider HTTP request. It does not create a source fetcher, poller, mapper, mirror, ingestion job, or ingestion schedule. It consumes these existing projections:

- `FederalAward`
- `FederalAssistanceAward`
- `SamOpportunity`
- `TangoResourceSnapshot`
- `LdaFiling`

The existing acquisition revision ledger is recognized by the closed source-family vocabulary but is deferred: its current identity key does not prove an exact company-to-prospect link. It is excluded from the default allowlist and cannot produce a baseline or alert. Phase 5 never substitutes fuzzy company matching.

No existing ingestion owner was modified. Federal awards and assistance are linked by exact UEI. Tango entity snapshots are linked by exact UEI. LDA candidates are bounded and retained only after exact normalized canonical-or-alias name comparison. SAM opportunities use a narrow agency-exposure relationship derived from exact-UEI award history; their language is explicitly thematic and never claims that the company will bid or win.

The invariant is covered by a source-import/network-call contract test over the watch runner and CLI.

## Tenant persistence

The additive migration creates four FORCE-RLS tables:

| Table | Purpose |
|---|---|
| `business_development_watches` | One tenant-private watch per prospect; active/paused/ended state, owner, categories, mute, and preference version |
| `business_development_watch_source_states` | One per-watch/per-source quiet baseline, health, complete-check marker, and lease |
| `business_development_alerts` | Append-only material-change facts, deterministic fingerprint/dedupe key, source locator, distinct dates, and explicitly inferred implication |
| `business_development_alert_deliveries` | Authoritative per-recipient in-app read/dismiss state and delivery idempotency |

Every tenant reference uses composite tenant-safe foreign keys. SQL CHECK constraints close the status, health, source-family, category, materiality, change-kind, delivery-channel, and review-state vocabularies. Each table uses the repository-standard `rls_bypass() OR tenant_id = current_tenant_id()` policy with RLS enabled and forced.

The migration quietly seeds a watch and five supported source-state rows for legacy prospects whose `watch_requested` is true. It inserts no alert. Existing `watch_requested` remains the compatibility bit and is synchronized on real activate/end transitions.

## Quiet baseline and deterministic diff

Each source state stores an explicit `BizDevWatchBaseline`. A missing/uninitialized baseline means the first complete, unambiguous scan records the observed set without emitting alerts. An initialized empty set is a real baseline, so a later first record can alert.

The pure diff compares only allowlisted material fields. Fetch timestamps, raw payloads, and JSON key ordering cannot cause an alert. Its change kinds are:

- `new_record`
- `material_update`
- `correction`
- `backfill`

Materiality is `high`, `medium`, or `low`. Identity below the confidence threshold produces `review`, not a confident alert. A missing stable record identity or usable exact source URL is skipped. Review/skip or an over-bound source read makes the source result partial: it inserts and delivers nothing and preserves the last complete baseline/check marker. Backfill updates an otherwise complete baseline but is suppressed from user delivery by default. Every accepted-but-suppressed candidate records a QA-safe `suppressionReason` code in the existing tenant-private source baseline JSON (`backfill`, `category_not_selected`, `watch_paused`, `watch_muted`, `prospect_conflict_excluded`, or `prospect_dismissed`); it does not create a second alert or delivery stream.

The content fingerprint and monotonic semantic sequence distinguish unchanged replay from a legitimate A→B→A→B series. Database uniqueness makes the alert and recipient delivery idempotent.

## Evaluator and lease ownership

`bizdev-watch-scan` is a short-lived, DB-only API image verb. It has no internal timer, sleep, or retry loop. The external scheduler is the only re-invoker.

Candidate discovery is a bounded trusted-server operation under the repository's audited system/RLS-bypass transaction. Before claiming work it fail-closes unless all of these are true:

1. global `BIZDEV_WATCH_ENABLED` is true;
2. tenant `businessDevelopment.enabled` is true;
3. tenant `businessDevelopment.watch.enabled` is true.

Claims and all watch/alert reads and writes immediately return to `withTenant`. Every source-state finalization predicates on the exact lease token. A stale worker cannot release or overwrite a newer claim. Only a complete healthy pass commits alert insertion, a delivery for an active owner, prospect activity, baseline advancement, and lease release together. Conflict-safe insertion lets an idempotent replay finish without aborting its transaction.

Source families fail independently. An error or partial read updates only that source's health and never advances its complete state; other source states continue.

## API, UI, and authorization

All watch/alert routes sit under the existing Business Development controller and require the base Business Development guard plus the Phase 5 guard. The latter enforces the global kill switch and tenant watch flag and returns the same 404-shaped failure when disabled.

Watch activation validates a non-null owner against an active membership. Alert listing, unread counts, read, dismiss, and read-all operate only on an existing current-recipient `in_app` delivery. Another user cannot mutate the owner's delivery. The UI makes zero Phase 5 requests when `/api/me.features.businessDevelopmentWatch` is false or absent.

The prospect page keeps controls beside the prospect header and displays source health, the all-source last-complete boundary, alert facts, separately labeled dates, materiality, inference, exact source link, read, and dismiss. The existing top-bar bell adds Business Development as a third feed; it does not create a parallel notification center.

## Meri follow-up

`get_business_development_recent_changes` is a native read-only tool. Its model input is only the current `conversationId` and an optional bounded limit. Existing prospect-chat scope is the sole authority; tenant, user, prospect, canonical entity, watch, alert, and client IDs supplied by the model are rejected.

The tool returns already-ingested alert facts, structured changed fields, exact locators, separated dates, and an implication object explicitly labeled as inference. It neither marks alerts read nor updates a brief, and it never calls a source provider. Its wording states that a thematic signal does not prove bid or win intent.

## Explicit deferrals

- Acquisition revision alerts: deferred pending a provable existing identity link.
- Email/SMS/push: deferred pending a separate opt-in, retry, authorization, and duplicate-delivery gate.
- Jev relevance classification: not needed for the deterministic MVP and remains dark.
- Any new source family: requires proof of an existing governed ingestion owner, rights review, an exact identity strategy, and a separate reviewed change; the watch cannot become an ingestion side door.

# Phase 7 operator runbook

## Ownership and entry points

Public source evidence belongs to API (`legal_reference`, `legal_text_revision`, `rule_notice_revision`, `rule_notice_reference`, `legal_published_date`, `legislative_legal_occurrence`, `legal_source_receipt`, `legal_dataset_archive`). Private research/import/membership/monitor state belongs to Intel. Workspace owns editable drafts and immutable source-action receipts. Intel owns reviewed report versions and current scope checks.

The UI route is `/legiwatch?tab=research&researchView=bills&jurisdiction=FL&session=2026`. Subviews are `bills`, `statutes`, `rules`, `dates`, `imports`, `coverage`; compare links include both document IDs and revision hashes. Bill session and statute edition are distinct. The folder tracker remains the default Bills view. Folder tracked-statutes, Bill 360 and linked-hearing entries reach the same research route.

Authenticated Intel routes are under `/intel-api/legiwatch/research`: `POST search`, `POST compare`, `GET versions`, `GET references`, `GET rules`, `GET deadlines`, `GET coverage`, `GET/POST memberships`, `GET imports`, `POST imports/preview`, `POST imports/decide`, `POST imports/promote`, `POST drafts`, `POST reports/preview`, `POST reports/approve`, `POST deadlines/drafts`; monitor configuration/preview/activation/scan/history lives under `monitors/:id`. Current tenant, owner, folder and client authorization is checked by the backend. Internal source routes require the existing internal-service secret.

Meri tools are `search_legislative_research`, `get_legal_reference`, `compare_legislative_versions`, `save_legislative_research`. The complete shared registry, API schemas/handlers, orchestrator filtering and write classification are tested. Never pass an actor/tenant supplied by generated source text.

## Controls

`legiwatch_research_v1` enables research and monitor setup/reads. The proposed separate statute-rules tenant flag was not added; the matcher has its own runtime control. `LEGIWATCH_STATUTE_MONITOR_ENABLED=true` enables due scans in the existing `task run-report-updates TENANT` worker. Existing report, workflow and delivery gates remain authoritative. Imported definitions are paused; cadence, current recipients, scope, edition and descendant policy require explicit configuration. Activation from now records existing matches as baseline and emits no historical matches. Membership/configuration changes invalidate the prior preview.

`LEGIWATCH_RESEARCH_MANIFEST` points to an explicit JSON file for API `sync-legal-research`. Default behavior is dry-run. `LEGIWATCH_RESEARCH_APPLY=true` applies the manifest. Maximum 30 citations, 30 bills, three constitution articles and three publisher-selected adopted-rule links. Document hydration also requires `LEGISCAN_DOCUMENT_EVIDENCE_ENABLED=true` and a `documentBudget` of 1–30. It reserves four query units per requested document and missing bill inventory, including transport retries; unused attempts are refunded. Changed canonical bill hashes hold for the regular writer. No quota increase is needed or permitted as an incidental fix.

Example proposed source manifest (shared evidence only):

```json
{"jurisdiction":"FL","edition":"2026","sessionKey":"2026","citations":["395.003","Chapter 395"],"billIds":["fl-2026-h1207","fl-2026-s1156"],"hydrateDocuments":true,"documentBudget":12,"adoptedRules":[{"ruleNumber":"1-1.008","sourceUrl":"https://flrules.org/gateway/readFile.asp?sid=0&tid=31220534&type=1&file=1-1.008.doc"}]}
```

FAR uses the existing state-register owner. Set explicit `STATE_REGISTER_TRACKED_RULES`, `STATE_REGISTER_MAX_PAGES`, and `STATE_REGISTER_REVISIT_DAYS`; inspect per-family gaps and retained receipts. A notice date cannot create a recording session. A correction or withdrawal holds affected private follow-up; never compute an unstated legal deadline.

Historical mode uses `LEGISCAN_STATES=FL`, `LEGISCAN_SESSIONS=selected`, exact `LEGISCAN_SESSION_IDS`, the retained reviewed provider inventory and `LEGISCAN_SELECTED_HISTORY_APPLY=true`; `LEGISCAN_SESSION_INVENTORY_FILE` must name the retained reviewed session/dataset inventory. Never run `all` as a Phase 7 shortcut. See the helper's exact manifest gate names before invocation. Keep public corpus and client-export reconciliation separate.

## Qualification and rollout

Use `scripts/legiwatch-phase7-upgrade.mjs` for clean/populated disposable owner migration rehearsals, and `scripts/legiwatch-phase7-qualification.mjs` for Phase 6 regression plus Phase 7 checks. The latter rejects skipped tests. Run all five affected services' type checks and native ARM64 image/Prisma probes. Verify packaged API/Intel migration commands, Workspace's direct packaged Prisma TLS launcher, registered report-worker command and web HTTP separately at immutable digests.

Refresh main and actual services immediately before release. Preserve API, Intel, Workspace, Meri and Web network/role/secret/count settings. Inspect active recordings, pending work, exact migration checksums and unexpected pending migrations. API public evidence migration precedes Intel private associations. Phase 7 adds no Workspace migration. Do not resolve failed ledger entries or apply unrelated data approval backfills as a shortcut.

Deploy compatible backend readers/writers with matching and delivery inactive, then web. Verify disabled/unauthenticated access, existing Bills/Hearings/Reports and current folder/client guards. Apply the explicit source manifest, review real corpus receipts, enable only the intended tenant's research, and apply reviewed imports via the canonical service. Record all six rule outcomes and all 174 membership outcomes. Verify a source-backed draft and exact edited report selection through an authenticated current user.

Matching activation requires retained independent human qualification for parser `fl-citation-v3`, with at least 60 citation and 20 rule cases. A manually dispatched worker is not scheduled execution. External delivery requires an authorized audience/body/version; source capture checkboxes do not provide it.

## Recovery

Pause the affected monitor and `LEGIWATCH_STATUTE_MONITOR_ENABLED`; hold unsent work. Keep immutable source/decision/Workspace/report history and current private access guards. Preserve completed or uncertain outputs. Check captures before service replacement and use qualified compatible digests. Keep additive schema and human edits. Resume with a fresh baseline instead of clearing checkpoints or replaying old source events.

# Phase 3 → Phase 4 Gap Ledger

**Repository:** `neo-capiro/capirov2`
**Phase 3 branch:** `agent/engagement-api-phase-3-full-ui-parity`
**Purpose:** preserve full existing-UI parity without silently moving reverse dependencies or side-effect ownership into Phase 3.

Phase 3 intentionally keeps `engagement-api` in the accepted Phase 2 shadow posture. The current UI may read and perform approved database-local writes through the preview runtime, while every provider/external action remains denied. This ledger records the boundaries Phase 4 must decouple before canonical ownership can move.

Evidence inputs:

- `apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json`
- `docs/contracts/engagement-current-ui-parity-v1.md`
- `docs/plans/engagement-api/phase-3-input-lock.md`
- `apps/api/src/engagement/runtime/engagement-runtime-policy.service.ts`
- Phase 0 route/dependency/side-effect manifests and Phase 1 runtime registry/verifiers

| Capability | Current owner / caller | Engagement-api dependency | Phase 3 result | Why Phase 3 stops here | Required Phase 4 boundary | Evidence |
|---|---|---|---|---|---|---|
| AI credentials | main API credential resolution; internal resolve route | Engagement generation paths ultimately require tenant/provider credential resolution | Preview leaves generation disabled | Moving decrypted/provider credential ownership is a security boundary, not UI parity | explicit service-authenticated credential resolution contract with least privilege and audit | Phase 0 dependency manifest; `/api/internal/ai-credentials/resolve` is deliberately excluded from the SPA preview route-pattern generator |
| Client-document writing | current main/workspace document services | Engagement artifacts and downstream memo/workspace flows can reverse-depend on document writing | Reads/metadata may be parity-tested; external document mutation is not moved | document persistence and workspace ownership cross service boundaries | service contract for authorized client-document create/update with tenant/client checks and durable provenance | current UI inventory + reverse-dependency manifest |
| Outreach review transactions | Reviews/main API + Engagement draft/review data | exact-version holds/approvals must remain atomic with current review semantics | Existing reads preserved; Phase 3 does not move approval ownership | approval is a governed transaction, not a routing concern | one authoritative review transaction API/repository with exact-version correlation and audit | Phase 0 reverse dependencies; current Outreach v2 trust-boundary tests |
| Recall webhook | main API webhook ownership | notetaker lifecycle ultimately updates Engagement records | `/webhooks/recall` is excluded from preview routing | inbound vendor callback cannot be dual-owned | explicit webhook owner, idempotency, tenant resolution, verification, drain/cutover plan | generated preview-route exclusions + Phase 1 Recall containment |
| Worker ownership | current process loops / accepted Phase 2 disabled shadow owner | outreach jobs, send intents, mail/calendar work | `ENGAGEMENT_BACKGROUND_OWNER=disabled` in preview | two active owners would duplicate work | deterministic worker-owner lease/config + drain/claim handoff | Phase 0 side-effect registry; Phase 1 strict-background proof |
| OAuth callbacks | main API | Microsoft/Google callbacks write integration state and credentials | callbacks disabled in shadow | callback URLs and token mutation are external security boundaries | callback ownership contract, state verification parity, rollout/rollback route plan | runtime policy sibling `ENGAGEMENT_CALLBACKS_DISABLED`; Phase 1 callback registry |
| Mail/calendar sync | main API/current workers and provider adapters | normalized meetings/mail are shared Engagement data | reads of stored integration state can be previewed; sync is denied | provider calls and cursor mutation must have one owner | sync command boundary + lock/ownership transfer + retry/idempotency contract | UI inventory classifies provider sync routes `external_action` |
| Generation | current governed generation gateway / main execution path | Outreach, prep/debrief and attachment extraction call AI/provider infrastructure | generation controls remain present but shadow returns `ENGAGEMENT_EXTERNAL_ACTION_DISABLED` | Phase 3 proves refusal, not external-action parity | explicit generation service boundary that preserves evidence packet, auditor, provider/metering and exact draft-version semantics | UI inventory external-action classifications; Phase 1 runtime action registry |
| Send | current durable send-intent/provider path | Outreach send/test/schedule eventually calls Gmail/Graph | all sends remain disabled in shadow | at-most-once and unknown-delivery semantics cannot be split | one durable send owner with claim/drain/idempotency contract and no auto-retry of unknown | Engagement trust-boundary suites + runtime action registry |
| Attachments | Engagement DB metadata + S3/extraction provider boundary | UI reads metadata; upload/download/extract can touch external storage | metadata parity is in Phase 3; external S3/extraction is denied | S3/provider mutations require IAM and side-effect ownership | attachment storage/read boundary with tenant authorization, integrity/scan state, explicit owner | UI inventory + Phase 3 fixture catalog (`phase3-parity-fixture-bucket-no-object`) |
| Notetaker | Engagement notetaker service + Recall adapter | dispatch/remove and callback lifecycle are external | current controls remain; dispatch/remove denied in preview | bot creation/removal must never occur from two runtimes | notetaker command owner + Recall adapter isolation + webhook ownership transfer | UI inventory + Phase 1 notetaker containment specs |

## Phase 4 acceptance consequence

Phase 4 must not treat a green Phase 3 UI as proof these boundaries have moved. A Phase 3 green result means the current product can use the shadow service for the permitted parity workload while these external/reverse dependencies remain intentionally owned elsewhere.

Canonical cutover remains forbidden until Phase 4 establishes explicit ownership for every row above and its own rollback/evidence contract.

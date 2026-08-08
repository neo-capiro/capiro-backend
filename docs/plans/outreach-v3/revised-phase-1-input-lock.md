# Outreach V3 Revised Phase 1 — Input Lock

## Status

```text
PROVISIONAL_INPUT_LOCK
PHASE3_PREREQUISITE: MERGED_BUT_NOT_INDEPENDENTLY_ACCEPTED
PHASE1_IMPLEMENTATION: PROVISIONAL
PRODUCTION_CUTOVER: PROHIBITED
```

This record resolves the exact source and repository state used for Revised Outreach Phase 1. It does **not** convert missing executable evidence into acceptance.

## Repository state

| Field | Value |
|---|---|
| Repository | `neo-capiro/capirov2` |
| Phase 1 branch | `agent/outreach-v3-p1-shared-foundations-gpt56-complete` |
| Phase 1 base on `main` | `46e029dad5c27bf44c7920cd5a4000716621671f` |
| Last implementation head before this closeout record | `ae938249d35476a1a7a4eada9949ac3b3aedd20e` |
| Draft PR | `#822` |
| Migrations in Phase 1 | none |
| UI changes in Phase 1 | none |
| Canonical cutover | not performed |
| Worker/callback/Recall production transfer | not performed |

The final Phase 1 head is the commit containing this document or a descendant that changes only closeout evidence.

## Phase 3 prerequisite truth

| Field | Value |
|---|---|
| Phase 3 implementation branch | `agent/engagement-api-phase-3-full-ui-parity` |
| Phase 3 implementation head | `c27f278edff81abc1f66fb7741d86906d515dc8c` |
| Phase 3 merge commit on `main` | `102112b2d34082aa301acc36e2cfe1de98b77413` |
| Phase 3 PR | `#781` — merged |
| Final exact-head DB-free evidence | missing |
| Final exact-head local evidence | missing |
| Separate independent validation | pending |
| Recorded Phase 3 outcome | `PHASE3_CODE_COMPLETE_BLOCKED` |

The Revised Phase 1 source plan permits planning and provisional implementation while Phase 3 is environment-blocked, but forbids an acceptance claim. All implementation on this branch is therefore provisional until Phase 3 is independently accepted.

## Locked source inputs

| Input | SHA-256 |
|---|---|
| `Outreach V3 (standalone)(2).html` | `84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453` |
| Revised Phase 1 executable plan | `75b773131012e71fd906bfb4a618a80edc87960b2b4fa15a92e273282d9b704b` |
| Revised Phase 2 executable plan | `24f9b1d9d5506cda14d541ad5f6d0c3d1fe05f514057e1b46a9274116db10670` |
| Phase 3 master context (inherited lock) | `fc681d3e046276a6faf49f5fb3c1e95bc1b8c7ba1373876320075958d072e2a8` |

## Locked repository manifests

Git blob SHAs identify the exact committed manifest bytes on the Phase 1 branch.

| Manifest | Blob SHA |
|---|---|
| Engagement route manifest | `347a8a1865aff4d8f39e88fabe88c781265dacd8` |
| Current Engagement UI inventory | `ac4d76bd902c44cf41d551876de0accab3e9d241` |
| Engagement side-effect registry | `b45ba88c9e5888fb9fe54dcc406fceb96d308c7c` |
| Outreach V3 prototype-state manifest | `a1f4a512b5882f6f2fe315b56e3fe23b739fced3` |

## Dependency and ownership inventory

| Concern | Current owner | Consumers | Exact boundary | Primary risk | Phase 1 session |
|---|---|---|---|---|---|
| Tenant AI credentials | main API | Engagement, Meri, internal services | `AiCredentialsModule` | raw-key leakage, cross-tenant fallback | 1.2 |
| Client document mutation | main API | alert memo, district brief, hearing recap, Reviews | `ClientDocumentsModule` / `ClientDocumentWriterService` | S3 mutation before runtime denial; provenance drift | 1.3–1.4 |
| Exact Outreach draft review | main API | Reviews, future Outreach | `OutreachReviewModule` / `OutreachReviewTransactionsService` | review A releasing version B; split transaction | 1.5–1.6 |
| Notetaker persistence | main API | `NotetakerService` | `MeetingCapturePersistenceService` | broad service coupling; transcript lifecycle drift | 1.7 |
| Recall webhook | main API | Recall provider | `RecallWebhookModule` | duplicate receiver, raw-body/signature drift | 1.8 |
| OAuth callbacks and notifications | main API | Microsoft/Google | `EngagementCallbacksModule` | two callback owners; unauthenticated callback execution | 1.9 |
| Mail/calendar integration actions | main API | authenticated Engagement routes | `EngagementIntegrationActionsModule` | route drift; external action bypass | 1.9 |
| Background timers | main API | sync, generation, send-intent, notetaker | `EngagementWorkersModule` | duplicate timers and double effects | 1.10–1.11 |
| Shared Capiro read capabilities | shared domain layer | Meri and future Outreach | `CapabilitiesModule` | model-supplied tenant/client scope; unbounded results | 1.12–1.15 |

The machine-readable detail lives in:

```text
apps/api/src/engagement/__fixtures__/outreach-v3-p1-reverse-dependencies.v1.json
apps/api/src/engagement/__fixtures__/outreach-v3-p1-runtime-ownership.v1.json
apps/api/src/capabilities/__fixtures__/capiro-capability-catalog.v1.json
infra/cdk/fixtures/engagement-runtime-ownership.v1.json
```

## Binding constraints

- Outreach v2 remains default.
- Meetings, Reports, and Integrations remain behaviorally unchanged.
- No OpenAI Responses API or OpenAI conversation state.
- No LangGraph or general LangChain agent.
- No Campaign Spec, state-version, event-log, or command-engine persistence.
- No Prisma migration.
- No new Fargate service.
- No canonical route cutover.
- No production ownership transfer.
- No Phase 2 implementation until the Phase 1 final handoff is independently approved.

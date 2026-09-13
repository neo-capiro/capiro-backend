# Comprehensive meeting preparation

Implementation date: 2026-09-12. Release posture: **disabled by default; staging qualification required**. This change does not deploy to os.capiro.ai or change production configuration.

## User outcome

Meeting Prep and Meri's `create_meeting_brief` use the same durable job and saved briefing. The briefing targets about 1,000–1,600 words, with up to three takeaways and seven sections:

1. Recent client or issue developments.
2. Important email exchanges.
3. Previous meetings and conversations.
4. Decisions already made.
5. Outstanding questions and unresolved issues.
6. Upcoming deadlines, meetings and legislative developments.
7. Commitments to the client.

Bullets display links when usable source references were returned. Missing or malformed citations and attendee discrepancies do not reject a briefing. Empty sections explain whether no evidence was found in the searched scope or a source was unavailable. Prompts still ask the model to distinguish proposals from promises and respect chronology, but there is no post-generation attendee/factual-support validator. Users should review the generated text before relying on it.

## Search and generation policy

| Setting              | Standard            | Deep                 |
| -------------------- | ------------------- | -------------------- |
| Past meetings        | Up to 25 / 180 days | Up to 100 / 365 days |
| Recent email threads | Up to 100 / 90 days | Up to 300 / 365 days |
| Email messages       | Up to 1,000         | Up to 3,000          |
| Upcoming window      | 30 days             | 90 days              |
| Overall job deadline | 1 hour              | 2 hours              |

Open tasks have no age cutoff. Open tasks also pin older originating email threads outside the recency window; these can increase the selected thread count, but remain subject to the message cap. Email selection preserves original messages and latest replies across threads, then prioritizes important intermediate exchanges. Counts and truncation are disclosed; the caps are not promises that every record exists or can be read.

Shared governed retrieval supplies client context, authorized notes/debriefs, email bodies, tasks, bill developments, hearings and mapped Monday items/updates. Internal searches remain actor-owned, null-client and focus-filtered; they do not search the user's whole client portfolio.

Monday uses the managed connector merged in [PR #1611](https://github.com/neo-capiro/capirov2/pull/1611). There is no second OAuth store or ad-hoc Monday API client. Users explicitly map up to 20 board IDs to the canonical client through Meeting Prep settings. The adapter uses discovered read-only `get_board_items_page` and `get_updates` schemas, paginates items and updates independently, and fails closed for unsupported required fields. It never invokes generic/write-capable tools. Internal or unmapped meetings cannot search the account broadly.

The pipeline extracts facts in batches, synthesizes the briefing, checks the entire extracted ledger for important omissions, and allows two repair passes. Repair is a quality lever, not a gate: after the last pass the most recent renderable briefing is saved and any still-flagged omissions or excess length are disclosed in its limitations; only a briefing that never renders is refused. The attendee/source validator and its review-specific schema, verdict fields, errors and legacy review request have been deleted. Comprehensive coverage review checks only missing topics, not identities, factual support or citation completeness. JSON/renderable-shape, required-section, output-length and provider-truncation handling remain. Unknown source IDs and non-verbatim quotes are omitted from display metadata without rejecting generated prose or inventing source evidence.

Budgets are operation-local in `apps/api/src/engagement/meeting-prep-policy.ts`:

- Extraction: 8,192 output tokens and up to 10 minutes per batch; at most three concurrent calls.
- Synthesis: 32,768 output-token allowance and up to 20 minutes.
- Coverage review: up to 10 minutes per batch. Repairs may use up to 49,152 output tokens when the configured model supports it.
- Provider truncation: one bounded larger-output retry when context/output capacity permits; never save truncated output as completed.
- Monday reads: up to 45 seconds per call, bounded by the retrieval/job deadline.
- Retrieval/extraction reserve downstream time; persistence retains a 15-second reserve.
- Evidence packing uses conservative UTF-8 byte upper bounds, not an exact tokenizer. The 64,000 evidence budget therefore usually contains fewer than 64,000 actual tokens.

Comprehensive searches run outside HTTP/Meri request lifetimes. While that feature remains disabled, the legacy prep route allows up to 25 minutes per provider call and 50 minutes across all attempts; the shared transport keeps the timeout active through response-body reading. The web client gives POST `/engagement/meetings/:id/prep` 55 minutes instead of accidentally applying its ordinary 30-second timeout. Status/cancel/mapping requests and unrelated AI/CRUD requests retain their existing limits; explicit per-request overrides are preserved. Legacy model output allowances are unchanged by this timeout fix.

Read-only AWS verification on 2026-09-12 confirmed that the load balancer attached to `capiro-dev-engagement-api` has a 4,000-second idle timeout; Node's shared server configuration disables its request timeout. The 55-minute browser limit leaves headroom under that load balancer ceiling. No AWS settings were changed. Unlimited HTTP waits cannot bypass infrastructure or provider limits. Cancellation, leases and finite job deadlines remain intentional; there is no guarantee of zero timeouts.

Prep calls also use an isolated HTTP dispatcher that disables the native client's shorter headers/body idle timers; the operation's abort signal and full-response deadline stay active. The dispatcher is destroyed after each call and never replaces the global dispatcher. This follows the [Undici timeout contract](https://github.com/nodejs/undici/blob/v6.28.1/docs/docs/api/Client.md); the direct dependency stays on the Node-20.16-compatible 6.x line. Structured JSON output remains in place per the [OpenAI structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs), without an attendee/source review verdict.

## Durability and data boundaries

- Tenant/user request keys make repeated submission idempotent; reuse with changed settings is rejected.
- A conditional database claim assigns a 90-second lease. A 15-second heartbeat renews it; no more than three attempts are allowed within the original deadline.
- Inputs and extraction checkpoints use the existing meeting-notes encryption service. Bearer tokens and provider credentials are not stored in jobs.
- Membership, role, canonical client assignment, roster, meeting schedule and runtime policy are checked again during execution. Workers reconstruct the current user context rather than using a stored bearer.
- Cancellation, lease loss and deadline exhaustion abort active generation. Completion, the new artifact and superseding old generated/edited artifacts share one transaction. A stale worker cannot publish. Failed or cancelled regeneration preserves the previous usable briefing.
- Displayed source excerpts come only from supplied records. Independent access-only provenance retains every consulted native/private source even if the model omitted citations; removing the quality validator does not bypass source authorization. Completed checkpoints are cleared. Source permissions and client scope are rechecked at persistence and display, including native note/debrief visibility and current Monday connection/mapping. Approval, edit and campaign-consumption paths also recheck V2 source access. Existing saved preps use their previous source metadata for backward compatibility.
- Monday evidence is personal. A colleague without the original actor's source access does not receive that briefing just because the meeting was shared.
- The exact generation requests are hashed without credentials; packet identity, policy version, input hash and coverage accompany the saved artifact. A resumed run can reuse unchanged extraction checkpoints; its prompt hash describes the calls actually executed in that attempt.

## API and UI

With `MEETING_PREP_COMPREHENSIVE_ENABLED=true`:

- `POST /api/engagement/meetings/:id/prep` accepts `additionalContext`, `depth` (`standard` or `deep`) and an optional `requestKey`; returns HTTP 202 with a job.
- `GET /api/engagement/meetings/:id/prep-jobs/latest` restores progress after reload.
- `GET /api/engagement/meetings/:id/prep-jobs/:jobId` reads current status.
- `DELETE /api/engagement/meetings/:id/prep-jobs/:jobId` cancels an active job.
- `POST /api/engagement/meetings/:id/prep-jobs/:jobId/resume` resumes a failed job only when its original deadline/attempt budget remains. An exhausted job requires a fresh run.
- `GET` / `PUT /api/engagement/meetings/:id/prep-monday-mapping` reads/saves the caller's client-to-board mapping.

The UI polls active jobs, keeps an earlier briefing visible during regeneration, supports cancellation and shows coverage limitations. The briefing view and PDF export render all seven sections. Legacy edited preps retain the existing editor/display. Meri returns job status and retrieves the same current saved artifact on completion; it does not block a chat turn for a deep search.

With the flag absent/false, the existing synchronous endpoint remains HTTP 201 and no job-table read is made by the disabled status hook. The new settings are hidden.

## Deployment prerequisites and release sequence

1. Review the branch against main containing PR #1611. Do not independently redeploy or recreate Monday OAuth configuration.
2. Keep `MEETING_PREP_COMPREHENSIVE_ENABLED` absent/false in every process during migration. Apply the normal reviewed migration workflow, including `20260912000100_meeting_prep_jobs`; generate Prisma Client. The migration creates jobs, personal client-board mappings, foreign keys, status/depth checks and forced tenant/user RLS.
3. Verify the existing meeting encryption keys are available to both request and worker processes. Never generate replacement keys for existing encrypted data.
4. The job runs on `MEETING_PREP_OPENAI_MODEL` / `MEETING_PREP_ANTHROPIC_MODEL` (defaults `gpt-5` / `claude-sonnet-4-6`; a tenant BYOK model override still wins; set to '' to use the global model). Qualify the actual resolved AI provider/model, including tenant BYOK/fallback choices. Set `MEETING_PREP_MODEL_CONTEXT_TOKENS` and `MEETING_PREP_MODEL_MAX_OUTPUT_TOKENS` to verified supported capacities. Defaults are 128,000 and 32,768; the configured minimum output allowance is 32,768. Do not inflate these settings beyond provider limits. To allow 49,152-token repairs, both output and total context capacity must support the complete request. Reasoning controls use the existing model-aware provider adapter.
5. The configured Engagement background owner must import `EngagementWorkersModule`, permit `meeting_prep_generate`, and have Monday connector configuration/network access. Preserve the existing runtime ownership/promotion policy: never arm a shadow process or alter global ownership merely to enable this feature. There is one active prep per owning process; test capacity before enabling more traffic.
6. Enable the feature in an approved staging environment only. Restart the background owner when enabling; the worker timer is constructed at boot. Confirm the API capability response, job submission, worker claim and shared connector state agree.
7. Complete the acceptance gates below. Then use the normal reviewed deployment and controlled rollout for os.capiro.ai. This runbook is not authorization to apply production migrations, enable flags or merge a PR.

Rollback: disable the feature and restart/redeploy the owning process; confirm no active job is still publishing. Keep the additive tables and previous artifacts. Do not drop tables or erase encrypted checkpoints as an incident workaround. Status reads are feature-gated, so inspect outstanding jobs through authorized operations tooling before disabling their user-visible status.

## Local verification

Run separately from a normal API typecheck because the focused Jest configuration skips ts-jest diagnostics for speed:

```sh
pnpm --filter @capiro/api exec tsc --noEmit --pretty false
pnpm --filter @capiro/web typecheck
pnpm --filter @capiro/api exec jest --config jest.meeting-prep.config.cjs --runInBand --runTestsByPath src/engagement/meeting-prep-evidence.spec.ts src/engagement/meeting-prep-comprehensive.spec.ts src/engagement/meeting-prep-job.service.spec.ts src/engagement/meeting-prep-source-access.spec.ts src/engagement/meeting-prep-persistence.spec.ts src/retrieval/adapters/meeting-briefing-core.reader.spec.ts src/retrieval/adapters/monday-managed-mcp.adapter.spec.ts
pnpm --filter @capiro/web exec vitest run src/lib/api-client.test.ts src/pages/engagement/meetings/PrepTab.test.tsx --poolOptions.threads.singleThread --testTimeout=20000
pnpm --filter @capiro/api run verify:engagement-phase-0
```

The PostgreSQL suite is opt-in via `MEETING_PREP_TEST_DATABASE_URL`, with **no fallback to DATABASE_URL**. Use only a disposable local PostgreSQL instance and an account allowed to create a temporary schema/role. It applies the real feature migration over minimal parent fixtures and tests competing claims, stale-lease publication rollback, cancellation and tenant/user RLS. It is not a full application migration-stack or boot test.

```sh
pnpm --filter @capiro/api exec jest --config jest.meeting-prep.config.cjs --runInBand --runTestsByPath src/engagement/meeting-prep-jobs-postgres.spec.ts
```

## Staging acceptance gates still required

- Live Monday OAuth + discovered schemas: multiple boards, multiple item/update pages, empty boards, revoked access, reauthorization, unsupported schema, interrupted reads and repeated cursors. Verify the adapter's normalized response against the real server, not only mocks.
- Live model structured output and reasoning: large history, long individual threads, long notes, provider rate limits, output truncation, fallback models, exhausted capacity and malformed responses. Record end-to-end latency, provider token use and cost; do not infer safe production capacity from mocked tests.
- Full migrated database + worker boot: refresh/reconnect UI, two actual app workers, process death/reclaim, cancel during synthesis and at commit, user/membership/client-wall revocation, inferred assignment stability and explicit reassignment, encrypted-checkpoint recovery, denied cross-user/source reads, and previous-prep preservation.
- Quality fixtures: more than five meetings; more than fifteen threads and evidence older than thirty days; original/intermediate/resolution exchange; an old open promise; a later explicit resolution; contradictory owners/dates; a cancelled meeting; internal strategy call; legislative deadline; missing or stale sources; and injected instructions in an email/Monday update. Human review must confirm the seven sections are accurate and concise.
- Load: standard and deep histories under realistic concurrency. The overall deadline currently starts at submission, so queue delay consumes the budget. Observe queue age, source gaps, failed/expired leases, stage duration, failed reviews, cancellation latency and cost before selecting production worker capacity and alerts.
- Retention: completed checkpoints are cleared; failed/cancelled encrypted checkpoints currently have no automatic TTL cleanup. Approve a retention period and an authorized cleanup process before broad production use.

## Explicit coverage limits

Private recording/audio/S3 transcript expansion and generic document/attachment extraction are not implemented by this change. Authorized notes/debriefs and available hearing data are searched; raw private transcripts are explicitly marked not searched. Search depth is selected up front; omission repair revisits the extracted ledger, not an additional autonomous external search. Monday item access is checked during live retrieval; saved-artifact checks use the current stored connection/mapping and do not re-fetch every remote item's ACL. Source projection/message/artifact/pagination caps and stale ingestion remain possible gaps. These limits must remain visible and must not be presented as exhaustive client memory.

# Meri Phase 4 active runtime integration audit

Date: 2026-09-25. This is a read-only source audit of the exact provisional branch, not a test, deployment, or Phase 4 acceptance result.

## Verdict

The exact-request identity in `meri-hermes-dispatch-intent.contract.ts` is dormant. Active dispatch still builds a JavaScript body and sends `JSON.stringify(body)` directly to upstream Hermes. There is no worker claim before upstream session/idempotency/agent/provider mutation. A delivered POST whose acceptance response is lost is currently recorded as failed; Stop without a stored Hermes ID can be finalized as never admitted; a known-ID Stop failure is best-effort and can still be followed by local finalization. Those states are epistemically unknown and must not become terminal until durable claim/absence and worker outcome evidence resolves them.

The current path is:

1. `MeriController` receives the conversation stream request.
2. `MeriV3RuntimeProxy` selects Hermes behind the tenant feature gate.
3. `MeriHermesRuntimeAdapter` persists the user turn, reserves budget, and creates the API run in separate operations.
4. `MeriHermesPrismaRunRepository.create()` uses a conversation advisory lock and atomically upserts scope, creates the run, and appends `run.accepted`, but it does not contain the already-written message or a dispatch intent.
5. `MeriHermesRuntimeClient.createRun()` separately serializes and sends `/v1/runs`.
6. The adapter binds the returned worker ID only after the response arrives.

Current Stop/run/session locks protect useful local races, but they do not provide a cross-host pre-effect claim. The broker is later tool-call ingress, not worker admission. The worker overlay does not invoke a private API gate before Hermes session creation or provider work. Client-wall grants, tenant membership, Clerk lifecycle, provisioning, session epoch, and worker credentials do not share one authorization generation/lock domain. Mutating broker paths also lack one stable operation/effect ledger spanning Stop, authorization, budget, database changes, external effects, audit, and replay.

## Required implementation sequence

1. Add an immutable Postgres dispatch-intent authority containing the complete exact-request identity, `prepared`/`claimed`/`sealed_absent` state, known worker ID, DB-clock cutoffs, and retained tombstones.
2. Build the outbound request once as immutable bytes. Persist and transmit the same buffer; never reserialize a lost request.
3. Put the durable user message, API run, prepared intent, conversation/session epoch, authorization generation, and applicable reservation in one pre-dispatch transaction and shared lock domain.
4. Add an authenticated private claim/status endpoint. Its transaction must compare exact bytes/HMAC, persisted API idempotency key, Stop, current session epoch, membership/grants, worker generation/ingress, credential ID and expiry, catalog, and tool view before `prepared -> claimed`.
5. Patch every reachable worker `/v1/runs` ingress before any upstream session, idempotency, agent, provider, broker, budget, or native mutation. Only a newly committed claim launches. Exact duplicate delivery is status-only; different identity is denied; uncertain claim response cannot launch.
6. Replace ambiguous dispatch and Stop finalization with durable observation. `claimed` exposes the worker ID, `sealed_absent` proves no admission under the reviewed horizon, and unresolved `prepared`/`UNKNOWN` remains nonterminal. Remove the two-minute false-terminal path for unresolved intents.
7. Persist worker task generation, ingress identity, credential ID and expiry; retain request-HMAC verification keys through reconciliation.
8. Route grant, membership, revocation, and session-epoch writers through the same authorization-generation fence used by claim and effects.
9. Add a broker-effect ledger keyed by stable operation ID and semantic digest. Commit local database effects, budget, events, and audit under the run/Stop/auth fence; stage and reconcile external effects such as S3/provider calls. Deny unfenced native worker effects.
10. Record launch acknowledgement separately from claim and terminal acknowledgement separately from launch. A claimed intent is never permission to launch again.

## Acceptance evidence still required

- Cross-language TypeScript/Python golden vectors for exact bytes, Unicode, reordered JSON, session HMAC, and key rotation.
- Postgres race tests for duplicate/different claims, Stop-first/claim-first, revocation, session epoch, and rollback.
- Crash/partition tests around prepared, delivery, claim commit, lost claim response, launch, lost 202, and lost Stop acknowledgement.
- Pinned worker-image tests proving all ingresses claim before any effect.
- Broker effect idempotency, replay, race, and uncertain-outcome reconciliation tests.
- Applied migration, retained tombstones/keys, no-bypass ingress inventory, pinned image/source checksums, lifecycle canary receipts, and a rollback path that closes new admission while preserving claim/status/Stop/reconciliation.
- Final guarded `https://os.capiro.ai` QA after exact-candidate acceptance. B1 ordinary-user behavior remains separately unverified under the approved identity limitation.

No code path was activated and no test, build, migration, provider call, deployment, or browser QA ran for this audit.

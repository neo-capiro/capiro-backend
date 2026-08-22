# LegiWatch Live Hearings — Phase 3/4 Parallel Implementation

**Prepared:** August 20, 2026
**Inspected base:** `neo-capiro/capirov2@7a4b39fccff916334cb5ae0a9c8dbdabfe7013d6`
**Integration point:** apply after the Phase 2 canonical hearing/capture schema commit.

## Purpose

This package advances Phase 3 and Phase 4 without changing Prisma, migrations, existing browser capture, Bill Tracker, or production infrastructure. The code is organized around persistence, scheduler, queue, credential, and runtime ports so the Phase 2 repositories can implement those ports after their schema lands.

## Phase 3 delivered

- Provider-neutral official-source adapter contracts.
- Congress.gov committee-meeting list/detail adapter, including House, Senate, and joint/NoChamber events.
- House Committee Repository calendar → event page → official meeting XML adapter.
- Senate central schedule XML adapter with DST-aware Eastern timestamps.
- Configuration-driven committee-site adapter for representative stable pages.
- Deterministic event identity and complete-linkage reconciliation.
- Source authority/freshness conflict resolution with observations retained.
- Partial-source failure semantics that preserve valid rows while marking coverage incomplete.
- Canonical change detection for schedule, status, witness, document, stream, archive, and transcript changes.
- A 46-body committee source catalog, safe source probing/bootstrap, and coverage audit.
- Master Calendar query contract with bounded filters and a tenant overlay only at the repository seam.

## Phase 4 delivered

- Explicit first-party, browser-only, license-required, blocked, and review-required source policy.
- Automatic resolver bridge over the existing Senate/direct-media resolver.
- Deterministic preflight cadence for 24h, 1h, 15m, 5m, rapid near-start polling, delayed-start grace, and error backoff.
- Global capture state machine, idempotency keys, versioned leases/fencing, worker takeover, and transcript-gap accounting.
- Queue payload trust boundary that rejects tenant IDs, client IDs, credentials, and media URLs.
- Just-in-time worker-side source resolution.
- FFmpeg command/runtime for HTTPS input and mono 16 kHz linear16 PCM.
- Reconnect-safe server Deepgram manager with monotonic timestamps, bounded buffering, and explicit gaps.
- Platform-owned Deepgram credential boundary for a globally shared public capture.

## Integration still required

1. Implement persistence ports with the Phase 2 Prisma repositories and RLS boundaries.
2. Wire the discovery jobs into the existing scheduler/SQS/EventBridge stack.
3. Register Master Calendar and schedule/cancel APIs.
4. Wire platform Deepgram credentials and the long-running worker runtime.
5. Add exact approved committee CDN hosts only after source-policy review.
6. Add custom/headless adapters for JavaScript-only committee outliers.
7. Enforce media egress controls for absolute HLS segment URLs.
8. Run a real first-party live-stream smoke test and full repository CI.

## Validation executed before packaging

- Strict TypeScript source/spec validation with local compatibility stubs.
- 23 focused runtime suites covering discovery, reconciliation, policy, leases, jobs, FFmpeg, Deepgram, and capture orchestration.
- Executable FFmpeg → PCM → canonical transcript simulation.
- Whitespace validation.

Full repository typecheck/Jest/LegiWatch CI was not executed in the packaging environment and must run after application to the active repository branch.

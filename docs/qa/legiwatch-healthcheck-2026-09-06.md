# LegiWatch vNext healthcheck — 2026-09-06

Status: code repaired and regression-tested; production operation is not yet verified. This change does not merge, deploy, migrate, enable capture, or alter rollout controls.

Audited source: `neo-capiro/capirov2` main `e1cfc7471d60b6ecd5ef99fd93bad463f39d4481`. Main subsequently advanced to `627240bdc38b85031b3b6bea26ac239a88c737f5` through funding and Strategies changes. The changed-file comparison found no overlap with this patch. Source files in the local audit snapshot were verified against Git blob hashes; the snapshot was partial, not a complete clone.

## Verified defects repaired

| Surface | Defect and resulting repair |
| --- | --- |
| Server transcription | Missing provider KeepAlive could close the stream during a recess. Send text KeepAlive every three seconds and clean up timers and sockets at completion. |
| Audio replay | Reconnect/HLS bursts could overwhelm Deepgram or the reconnect buffer. Pace FFmpeg input and ordered PCM delivery; bound replay at 1.25× real time and retain timeline offsets and explicit gaps. |
| Final transcript persistence | Failed attempts returned progress before final writes drained. Drain final results and gap persistence before reporting completion/recovery; preserve recent FFmpeg diagnostics. |
| Capture ownership | Scheduler reconciliation could change the version of an active capture, preventing its eventual finalization. Leave actively leased captures untouched and protect the corresponding SQL updates. |
| Lease loss | Hung renewal could leave a stale recorder running. Abort at the lease deadline, reject delayed renewals against the database clock, and preserve retryability. |
| Transcript fencing | Stale workers could append transcript/gap writes. Fence those writes by owner, token and unexpired lease; transactionally checkpoint progress for crash recovery. |
| Worker queue | One task claimed many jobs but recorded them sequentially, stranding later hearings behind a multi-hour capture. Claim one recording per task so other tasks can claim the remaining hearings. |
| Browser transcription | Add four-second Deepgram KeepAlive and thirty-second native WebSocket ping. Serialize input, bound queued frames to 2 MiB / 256 messages, and bound capture database startup operations to fifteen seconds. |
| Browser shutdown | Late provider results and delayed claims could outlive stopped capture. Drain final results, disconnect on the drain deadline, ignore late callbacks, and release late claims by their exact token. |
| Intelligence enrichment | Credential resolution could hang before the existing enrichment timeout. Add a five-second credential request deadline and stable IDs for persisted summary cards. |
| vNext origin | `os.capiro.ai` was missing from default intel HTTP/WebSocket allowlists. Add the exact HTTPS origin while continuing to reject untrusted origins. |
| vNext recording room | The separate room had no working browser capture lifecycle and misleading controls/status. Reuse the actual canonical browser room, with wake lock, restored intelligence, safer start/stop and bounded uploads. |
| Hearing navigation | Repair live-row/detail/session routes, browser attendance startup, and the Workspace brief editor link. Preserve attachment to an existing public capture. |
| Long transcript/intel views | Oldest-page limits hid later hearing material. Drain pagination, maintain a transcript resume cursor, refresh in the background, reconcile mutable intelligence and reload after focus/reconnect. |
| Public access and scheduling | Block private/unknown capture paths and non-public transcript access; prevent unresolved streams from overriding browser-only, licensed or blocked capture policy. |
| Client relevance | Apply relevant-only filtering before pagination and totals, with tenant context and predicates. |
| Bill tracker | Make all pages reachable, deduplicate by client/bill, apply filters consistently, preserve saved URL controls, show correct status/client labels, and invalidate all-scope caches. |
| Feed and actions | Restore saved filters and browser Back, clear selections/packets on scope changes, use the real memo composer, and fetch state-bill events from the correct source family. Unsupported packet brief/outreach actions now have explicit disabled states and guidance. |
| Digest | Fix history selection and cross-client stale results, scope federal/state bill movement, validate inputs/client ownership, and serialize initial schedule saves. The cadence preference does not have a delivery worker; the UI now says so explicitly. |
| Analytics | Count the tenant/client's tracked bills instead of the whole public corpus, fix the momentum calculation, include all supported source families, and respect visible-alert statuses. |
| Settings | Route monitoring setup to the existing watchlist editor. Changing or clearing a phone removes the previous number's SMS verification. |
| Dead code and tests | Remove the unreachable transcription setup modal, obsolete Phase 8 placeholder and duplicated policy logic. Add capture/intelligence/vNext suites to the LegiWatch CI gate and raise its floors. |

## Four-hour lifecycle

The supported design remains one public hearing → one owned server capture → one canonical transcript → tenant subscriptions and relevance. A viewer is not the owner of server recording. Server capture and scheduled intelligence processing operate independently of the page once their production workers, schedules, credentials and capture demand are enabled and healthy.

The code does not rely on extending one HTTP request to four hours. Provider keepalives, WebSocket traffic, renewable capture leases, durable transcript writes and resumable reads each protect their own connection/lifecycle. Capturing a new stream after a transient failure preserves offsets and records gaps; it does not guarantee zero missing audio during a provider/network outage.

Screen Wake Lock is best-effort. A browser cannot guarantee continued capture through OS sleep, laptop closure, tab discard or lost screen-sharing permission. Server recording is the required mode for offline continuity; browser capture needs the device awake and may require the user to resume sharing after an interruption.

The existing scheduled capture-worker launch is one task per minute. With one recording claimed per task, simultaneous-hearing startup latency depends on task fan-out and capacity. This change does not increase production task counts or claim that this capacity has been load-tested.

## Executed verification

| Check | Result |
| --- | --- |
| vNext LegiWatch, canonical hearing room, shared hearing hooks, wake lock | 31 files; 317 tests passed |
| API hearing services/controllers, policy, relevance contracts, digest and analytics | 12 suites; 88 tests passed |
| Intel capture, browser gateway, credentials, intelligence, state-bill events and watchlist preferences | 35 suites; 277 tests passed |
| Intel capture DI, hearing hardening, tenant scope and WebSocket tickets | 4 suites; 55 tests passed |
| Total selected tests | 737 passed; zero failed; zero skipped |
| Full `apps/intel-api` TypeScript check | Passed |
| Changed web surface TypeScript diagnostics | None; whole-web typecheck remains blocked by missing unrelated files in the partial snapshot |
| Diff whitespace checks | Passed |

Meaningful simulated-duration cases include four hours of provider keepalive, four hours of capture lease renewals (720 renewals), provider reconnect/paced replay, hung-renewal abort, queued-audio overflow, delayed final callbacks, and transcript/intelligence paging and recovery. These use accelerated clocks and provider doubles; they are not a real four-hour production soak.

Prisma generation calls reported an environment approval error (`network approval was cancelled before a decision was returned`). A generated client was nevertheless present afterward; its model schema was compared with the canonical schema and matched, and the additional tests/typecheck above ran against it. No further generation attempt was made after the rejection. A disposable PostgreSQL package installed, but its server could not start: this environment runs as root and changing to the existing unprivileged user failed with `Operation not permitted`. No real-PostgreSQL result is claimed.

## Required release verification

1. Run the complete repository's normal web/API/intel typecheck/build and LegiWatch CI, using its lockfile and generated clients.
2. Replay required migrations in disposable PostgreSQL and run the expanded capture, detail/relevance and Wave 3 schedule integration suites. Verify real row locking, lease expiry, concurrent schedule saves and tenant isolation. Mocked SQL binding tests do not replace this gate.
3. Inspect the deployed task definitions and secret bindings, FFmpeg availability, WebSocket routing, worker heartbeat/queue health and registered capture/intelligence schedules. Repository defaults and task templates do not prove production configuration.
4. Run authenticated vNext QA. This session reached the real site's sign-in screen but did not enter an authenticated tenant or start any production recording.
5. Run an actual four-hour approved hearing soak: include a recess, viewer disconnect/rejoin, provider interruption and worker restart; confirm transcript/intelligence progression, one active capture owner, explicit gaps, final drain and no ongoing provider/worker resources after completion. Record real timestamps, image digests and costs.

Preserve the existing SHADOW rollout restriction. Do not change `production_default`, `capture_all_public_events`, the kill switch, CANARY/READY/CUTOVER state, or reserved hearing `cm-119-119533` as an implicit side effect of this healthcheck.

Legacy compatibility: canonical capture and shared hook repairs also benefit existing callers. The separately gated legacy Phase 7/8 UI surfaces retain their own older pagination hooks; they are not certified by this vNext healthcheck. The live room's old decorative layout is replaced by the canonical working recording layout inside the vNext module; the app's top and left navigation are unchanged.

Provider references: [Deepgram KeepAlive](https://developers.deepgram.com/docs/audio-keep-alive), [stream recovery](https://developers.deepgram.com/docs/recovering-from-connection-errors-and-timeouts-when-live-streaming-audio), [CloseStream](https://developers.deepgram.com/docs/close-stream), [Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API).

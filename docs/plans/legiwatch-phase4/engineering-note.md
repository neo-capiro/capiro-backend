# LegiWatch Phase 4 — recording, reviewed updates and unofficial recaps

## Current checkpoint — September 13, 07:04 UTC

API 336 (`63dc1139c`), Intel 35 (`e85dad394`), Web 276 (`ff73d9eb9`) and Meri 47 (`ea927897b`) are healthy with pinned native ARM64 digests. The later main meeting-preparation fix remains preserved. The separate web saved-clock image at `b1c5970ad` passed 812 scoped and 68 Phase 4 tests and is sealed at `sha256:43fca9ccfd3d5f7ba071846466ac51ef54e6af6d4a68ea8df9729a05bc59c8b7`; its rollout remains guarded until the active browser recording completes. Intel must remain untouched during that capture.

The independent native server gate passed within owned fixture scope. Task `50381b822815431e947ad2391b012546` ran from 02:40:31.825 to 06:50:36.942 UTC, 250 minutes 5.117 seconds elapsed. All 2,998 stored PCM parts passed hash, size, sequence, frame-count and coverage verification; decoded audio totals 249 minutes 49.719 seconds. Two epochs preserve a 10.149-second WORKER_RESTART gap and 15 minutes 55 seconds of contiguous digital silence. One capture served two isolated fixture tenants and persisted 3,992 finals. Whole-task Container Insights sampled at most 143 MB; Node heap at most 22,784,232 bytes. The 10-second checkpoint sample p95 is 5.159 seconds, explicitly not per-part acknowledgement latency or an SLA percentile. The complete 322,653,243-byte archive hashes to `e8fd2f6abfd78f6f56165c5ba663139e16b844157f09686e582986fa51d20035`; chart and evidence were visually reviewed. This does not qualify the production resolver, broadcast mapping, source agreement, scheduled start or client acceptance.

The separate deployed 250-minute browser run started 05:59:38.886 UTC, session `cmtzemd8y028iemdgcan0xy8c`. It continued durable saves with its page hidden through the planned 16-minute recess and resumed speech. Its 90-minute close/re-share remains ahead; expected capture end is about 10:09:39 UTC, followed by assembly and independent full decoding. The frozen harness uses normal Chrome background behavior and an owned private HTTPS source. Earlier failed local endurance runs stay failed.

Meri generation now succeeds. Initial structured-output repair `dd930e8e2` fixed missing claims, but three further live attempts still changed quote wording, including after stronger instructions at `b1c5970ad`. An isolated owned diagnostic confirmed that the actual model prefixed and joined quote fragments. Final repair `ea927897b` makes model output select exactly one persisted evidence ID for a quote; application code copies its text. Observations/analysis retain text and evidence references. Strict schema, unknown-reference, duplicate-ID, quote-length and downstream exact-quote checks remain. Native build `a08a1767` passed core/provider 38, Meri 67 and API evidence 4 tests without failures/skips. Meri 47 deployed at 06:48:54 and fully settled at 06:51:48 UTC, digest `sha256:154423c964e8ad65b1ec8983d2871844cbd757130c2ec604b79381d2c4107c43`. No recording service changed.

Actual UI-generated publication `77fcd15e-121f-4fba-b3fc-862f066c5841`, version 1, hash `e88ed885430f938edb8d2e8e8bd0056ddbfb7fb29f862b845d7bc4f9ee2c31e8`, contains a source-copied quote, supported observation and explicitly labeled analysis. All three claims were reviewed against persisted finals and coverage. It was approved, saved and indexed in existing Documents; repeat save reused attachment `748ed4da-67b4-5be6-a300-223b7fda7a84`. The actual saved private blob and UI DOCX export are identical 9,611-byte files, SHA-256 `3cab5e840055cba85a8aa057350a3ecc689849cee9a4603d2702f34eb27d0a6f`; one page passed visual review. The returned model field is null, so this artifact does not establish model identity. Earlier manual quote publication `2b1ca0bc` separately passed this workflow and is explicitly not generation proof.

Both approved recap versions reached only the existing actor's own authenticated inbox. A manual exact-quote live update `36679e6f-6fce-4600-aeb2-87459fc95679` was also reviewed and delivered while the browser recording continued; its immutable snapshot labels streaming/unfinished coverage and unresolved jurisdiction/session. Exactly one inbox row was found for each publication. Approval-to-provider acceptance measured 47.695 and 33.298 seconds for the recaps and 91.471 seconds for the live update. These exceed the proposed 30-second target and establish no p95; the existing two-minute worker cadence/startup remains a measured limitation. No email, SMS, OTP, outside recipient or provider outreach was activated.

The full owned HTTPS pilot remains active for one synthetic client and self inbox only. Final full-pilot rollback must wait for the capture and preserve both evidence and retention cleanup. Public/state capture, Florida source permission, external receipt/account readiness and client acceptance remain unqualified. GitHub billing still prevents repository checks from starting; PR #1616 stays draft. This checkpoint supersedes historical statuses below.


## Historical checkpoint — September 13, 06:22 UTC

API 336 remains healthy at `63dc1139c`, preserving the later main meeting-preparation fix. Web 276 is healthy at `ff73d9eb9`; native qualification passed 811 scoped and 67 Phase 4 tests. The duplicate recording/publication panel defect is repaired. Intel 35 remains at the original qualified `e85dad394` recording runtime.

Actual deployed short session `cmtzealog01cxemdgzeilntli` captured with the page hidden, closed, explicitly re-shared, stopped and reopened. Its draft step first failed on a harness label selector; the capture evidence remains separate. A fresh Chrome/Clerk verifier checked both exact private artifact SHA-256 values, six start/middle/end player seeks tied to their exact epoch URL and duration, 1.5 speed, byte-range 206, expired-signature 403 and authenticated refresh 206, with no page errors. Independent full FFmpeg decoding produced 139,740 ms of PCM versus 139,770 ms in the remux manifest; the 30 ms difference is decoder/container accounting. The coverage gap is 12,881 ms. A preceding verifier raced the second source change; its explicit audit rejects per-epoch seek acceptance while preserving valid byte/hash/decode evidence. Successful proof: `deployed-full-short-media-verification-2`.

The deployed 250-minute browser run `deployed-full-four-hour-1` started at 05:59:38.886 UTC, session `cmtzemd8y028iemdgcan0xy8c`. It uses a frozen standalone Chrome harness, normal background behavior, an owned private HTTPS speech/tone source, 16-minute recess, and one planned 90-minute close/re-share. Expected capture end is about 10:09:39 UTC; acceptance also requires scheduled assembly, at least 240 minutes of decoded media and independent verification. No Intel replacement is allowed during it. The native ECS run remains active from 02:40:32 toward 06:50:32 UTC; its completed recess/restart and checkpoints are recorded independently.

Live Meri generation initially returned no claim array. Repair `dd930e8e2` uses the existing structured completion client and retains server-side reference, exact-quote and duplicate-ID checks. Native build `42a21efa` passed core/provider 37, Meri credential/registry/controller 67, and API evidence 4 tests, zero failures/skips. Meri 45 deployed at 06:10:53 and became healthy with the old task drained at 06:13:26 UTC; image `sha256:f575ab4accb0d891f93432513c47d5482ef2fe811bdfae9058d588cf6c670278`. Two subsequent live drafts were rejected for changed quote text; no invalid draft was approved or delivered. Follow-up `b1c5970ad` clarifies exact quotes and observations through the existing structured tool description; native Meri build `37be4b6e` is separate.

Reopened UI inspection also found the room clock and saved-byte summary falling back to transcript/current-connection values. Repair `1785e45e6` passes durable recording progress from the existing manifest panel through the shared lifecycle. Its regression includes a silent transcript tail and an explicit gap; all 29 capture/player tests pass. Native web build `17b64a73` is preparing this repair from `b1c5970ad`; deployment is deliberately guarded until the frozen four-hour capture and retained media complete. No new recording transport or server code changed.

The full internal owned HTTPS pilot remains enabled for one synthetic client and self inbox only. Actual generated draft approval, Documents indexing/export, inbox delivery and full-pilot rollback remain unqualified. External email/SMS, public/state capture and outside recipients stay off. GitHub billing still prevents repository checks from starting. Earlier failed runs remain failed; this checkpoint supersedes historical status below.

## Historical checkpoint — September 13, 05:46 UTC

API reconciliation is complete. Revision 336 runs immutable ARM64 digest `sha256:f5f9511bf57a3b7be22d12d0558f78be55f3fb0fc68b44a7c35f1f638f47f1b6`, source `63dc1139c`, preserving main's later meeting-preparation fix. Native build `f715f7bf` passed both migration chains, typechecks, full scoped API 1,045 / Intel 768 / web 809 tests and Phase 4 API 58 / Intel 100 / web 65 tests with no failures/skips. Four additional meeting-preparation suites passed 40/40 unit tests locally; the Context Plane guard still passes all ten adopted-product invariants. Both API tasks and targets are healthy; earlier tasks drained. Original release evidence remains sealed separately.

The actual private S3 HTTPS fixture replaced the WAF-rejected loopback URL without changing WAF. Deployed short session `cmtzcu5up0032emdg58xezox3` saved two attempts. Its first verification script queried Clerk too early after reopening; that attempt remains failed. A fresh Chrome process and new Clerk login subsequently verified both playable epochs, 141 seconds decoded media, 1.5 playback speed, no page errors and publication access denied. A fresh held-feature check then verified recording capability unavailable and publications denied. Old loopback and recording-only HTTPS grants are revoked. The full internal HTTPS pilot activated at 05:27 UTC with one-day retention, one synthetic client, and self-inbox-only qualification; media and delivery schedules are enabled. Email, SMS, public/state capture and outside recipients remain off.

Standalone Chrome with its own profile and `connectOverCDP({noDefaults:true})` avoids Playwright focus emulation as well as background-throttling override switches. A probe verified actual visible-to-hidden behavior. The full short capture continued durable writes with the page hidden, but its harness then failed taking a screenshot of a hidden page. A retry exposed a product defect: recording and publication panels used identical React keys, which left duplicate audio panels when both features rendered. Fix `ff73d9eb9381b7b56824cead22cbfc2b86ac8e6e` gives them distinct scoped keys. A regression reproduced the duplicate; canonical and vNext cases pass after the repair. Native web build `18feefc6` passed typechecking, all 811 scoped web tests and all 67 Phase 4 web tests, zero failures/skips. Image completion, deployment and actual-page requalification remain separate gates. The browser harness now foregrounds screenshots, records screenshot failures separately from media, preserves its exact source and records process memory and temporary system-awake-request cleanup.

The independent native server run has passed three hours, including the planned 16-minute recess and one process interruption. Four-hour acceptance still awaits final decoded media and complete evidence. The full deployed browser, generated recap approval, Documents indexing, inbox delivery and final rollback are still being qualified. GitHub Actions remains unable to start because of account billing/spending limits. No provider contact, external message, SMS or OTP was sent. This checkpoint supersedes historical status below.

## Historical checkpoint — September 13, 05:08 UTC

API revision 335 now carries main's meeting-preparation fix `e39f47822`, deployed by a separate AWS CLI release at 04:42:16 UTC. Merge `63dc1139ced50a4f52e492cd2ebebe292d571f01` preserves that fix together with Phase 4. Native CodeBuild `f715f7bf-ec31-4dcd-a3cd-228e9d40a7d0` is qualifying the exact merged tree `1fa93db98adf17cbbadf9b461177e16dd495f09e` and building a new API image. The original four-image release and its evidence stay sealed at `e85dad394`; Intel, Meri, web, shared packages and the lockfile have no changes from that runtime. API 331 will not be restored over the later fix.

A restricted internal recording pilot was enabled at 04:41 UTC: recording only, one owned synthesized source, one-day retention, no distribution permission. Its media schedule was enabled at 04:52 UTC. Reviewed update/recap flags and delivery stayed disabled. Three browser attempts created three empty synthetic clients, then WAF rejected the loopback source URL with `EC2MetaDataSSRF_BODY`; no hearing session or recording was created by those attempts. The client identity from the third attempt will be reused. At 05:04 UTC the recording pilot was held; its media schedule was disabled at 05:05 UTC. The old source grant is being revoked before a separate exact private S3 HTTPS source grant is activated. The WAF policy is unchanged. This source transition and subsequent controls must be read from the timestamped owner/schedule evidence.

The native server run continues beyond two hours with durable progress after its planned 90-minute process interruption. Its planned 16-minute recess completed without restart. Final four-hour acceptance still requires completed metadata, every audio part, decoded duration, coverage/gaps and memory evidence. All five native stop cases passed. The completed short native run's entire 34-part PCM recording was downloaded, hashed and decoded, including 15 seconds of continuous digital silence. Whole-task Container Insights and clearly labeled sampled checkpoint lag are included; neither is a per-part acknowledgement percentile.

All 36,532 versions in the 27 inactive local fixture prefixes were preserved in verified local archives before scoped deletion; every selected prefix is now empty. Active ECS and deployed data were excluded. The failed local long runs remain failed. GitHub Actions still cannot start because of the account billing/spending-limit block. Full deployed recap approval, Documents indexing, delivery, rollback and client acceptance remain unqualified. No outward message, OTP or provider contact was sent. This checkpoint supersedes the historical status below.

## Historical checkpoint — September 13, 03:02 UTC

Native ARM64 CodeBuild `72d43256-c1cd-4ae8-a5a8-0f2f816568b2` succeeded for runtime source `e85dad394ba473e572e1d0d49886d74531c713b8`, exact raw tree `7428ec999fd874f6dae9883d2e71c2a5fc53746d`. Both migration chains and typechecks passed. Full scoped regressions passed API 1,045, Intel 768 and web 809 tests; the separate Phase 4 matrix passed API 58, Intel 100 and web 65, with zero failures/skips. Three private-audio/client-logo policy tests passed. The Context Plane guard found no new bypasses. CI follow-up `76305bf284bbbcab7d8f2d118508715b6878ee14` wires Phase 4 qualification, FFmpeg and disposable database settings into the existing GitHub job; it changes no runtime source. GitHub jobs remain unable to start because of the account billing/spending-limit block.

All four images were published and their manifest/config digests, ARM64 architecture and source labels verified. API: `sha256:c054f22881801feb058f36b123fad581c8c7177663a7d8bbf013df0d4283abbf`; Intel: `sha256:fa1ec54ab26080f360bb6de34a75a6f9fb3fa4ccc6b6132f22716aa56c0e32d0`; Meri: `sha256:deb20124ee16874c54456d0e79763ca69a3b7d6d167954d8b4ae67c8a15ebd67`; web: `sha256:3ac95387f2c6dd13d25c6ac941740cf17990a404bc8a7851b1d5547c6af42ff8`.

The scoped private-audio IAM policy is applied. Live API owner migration task `319e6cce11a4486197ea8dbb6cae2208` used migration revision 114 and exited zero; Intel owner task `679a58087f5e4eba999e47f0a47549ae` used revision 7 and exited zero. A read-only audit confirmed the established `capiro_master` owners and the intended `capiro_app` restrictions. API 331, Intel 34, Meri 44 and web 275 reached healthy deployment states. Seventeen existing worker rules were retargeted without changing schedule state, timing or input; the two new media/delivery rules remain disabled. Intel pilot definition 35 is deployed with tenant activation still separate and off.

At 02:45:55 UTC, a competing AWS CLI deployment changed the API service from qualified revision 331 to revision 333. The new index digest is `sha256:a64cefdc001b0ff0b15f79fd1e7fe637fbda0804dd6e3edd0ded3b670b716320`, tagged earlier main `285d848`; its source label is absent and its startup mapping lacks `/hearing-recaps/approved`. It retained the Phase 4 environment marker, demonstrating why that marker alone is insufficient. This is a healthy but inconsistent release. Internal activation is held pending coordination, and the pilot helper now checks all required service definitions before activation. No competing rollout was overwritten.

The isolated native ECS short recording test passed: 184.967 seconds elapsed, 169.765 seconds retained, a 10.094-second process-restart gap, two tenants/one capture, 45 finals, six decoded samples and hashed exported metadata/media evidence. The native 250-minute server run is active in task `50381b822815431e947ad2391b012546`, starting about 02:40:32 UTC. It uses the pinned release image and isolated PostgreSQL sidecar with an owned WAV adapter. It does not qualify a third-party resolver, Florida permission, or a source scheduler. Separate native source/demand/tenant withdrawal tests measured process stops of 129/98/150 ms; terminal capture disposition and latency percentiles are not inferred from those measurements.

The browser four-hour gate remains unpassed. The prepared replacement uses actual deployed Clerk/HTTP/WebSocket and native tab audio, but is held by the API mismatch. Historical local metadata incorrectly described browser background defaults: those launchers retained Playwright throttling overrides. The replacement removes them. The real deployed hearing list passed a read-only browser smoke at 02:59 UTC: 28 sessions, no errors or horizontal overflow; its temporary login was revoked.

No new tenant capability, live source grant, client capture, outward message or OTP has been activated. Actual deployed recap generation/approval, Documents/Meri indexing, delivery, rollback and client acceptance remain pending. Florida source terms were rechecked through the public notices and still require source-specific qualification; no provider was contacted. See [acceptance.md](acceptance.md) and [operator-runbook.md](operator-runbook.md). The sections below retain earlier engineering history and are superseded by this checkpoint where their status differs.

## Verified execution baseline

Execution started September 12, 2026 from main
`589b16de2081e89030187b603afff61c449f9c5d`, in isolated branch
`agent/legiwatch-phase4-recording-live-updates`. Phase 3 PR #1607 was merged
at 13:34:42 UTC; its reviewed head was `325f010429077e867074bc50fc7f9841060c607c`.
The handoff's unmerged-parent dependency is therefore superseded.
GitHub squash-merged Phase 3 as `e118400cf9c91c7a83809654350c7c14f7bb8c61`;
that merge commit is an ancestor of this branch. The original branch head is
not a direct ancestor, as expected for a squash merge.

All 45 files listed by the evidence package manifest passed SHA-256 and size
verification. The separately supplied handoff matches the packaged copy.
Historical client evidence remains outside the repository. No AGENTS.md was
found in this checkout or its workspace ancestors.

Read-only AWS inspection confirmed account 967807252336, region us-east-1,
cluster capiro-dev: API task revision 327 (2/2 running), Intel 33 (1/1),
web-vNext 271 (1/1); all three service rollouts reported COMPLETED. These
are baseline observations, not Phase 4 deployments. Exact images, workers,
migration ledgers, schedules and active captures require release-time checks.

## Implementation status

Work in progress; this branch has not been deployed or activated. Implemented
contracts now include durable browser epochs/parts, private playback and purge,
server WAV manifests, saved-audio transcription repair, reviewed immutable
publications, purpose/client-bound SMS consent, approved DOCX provenance, and
separate registered media/delivery maintenance runners.

The shared browser lifecycle owns retained capture and the publication panel.
The canonical event detail owns the separate server-audio player. The API state
attendance adapter requires an exact event/source grant, current membership,
tenant flag and the two state/server runtime gates. The legacy unscoped schedule
guard rejects state capture; federal defaults and the federal view remain intact.
Explicit automatic attendance stores the same internal user UUID used by the
API tenant context; worker permission checks also recognize historical Clerk IDs.
Follow/browser-only rows create no state server-capture demand.

Private playback now checks current membership and recording capability, and
requires a current retention grant before issuing another URL. Upload retries
preserve immutable bytes and recheck access before the durable manifest commit.
The public sink pauses FFmpeg output while retrying a bounded part, with at most
eight storage attempts and bounded backoff; capture cancellation aborts the
pending storage operation. The earlier three-attempt sink failed the first long
server run and must not be described as qualified.

Meri evidence mode accepts persisted final segment IDs and returns individually
referenced claims. Selected folder context uses resolved jurisdiction/session
bill IDs, positions, importance and external comments. Internal comments remain
outside this generation input. Folder and assignment versions are checked again
after generation and before approval/delivery; the saved payload includes context
provenance. Private browser evidence is not inserted into global public rows.

Reviewed email, SMS and owner-selected inbox items share ReportDeliveryService's
leased queue. The new hearing-delivery runner requires the registered, enabled
hearing-delivery-worker and selected channel/tenant gates. A queued item is held
if its runtime, actor, source, context or recipient permission changes. Outward
delivery and actual email/SMS receipts have not been exercised with a real
recipient. The API inbox uses its existing event table and the actual API user
UUID, with the approved publication ID/hash in its idempotency key.

Approved recap export/save fetches the immutable version through authenticated
Intel access, renders DOCX using the existing renderer, and rechecks permission
before writing through ClientDocumentWriterService. Existing attachment metadata
now retains source version/hash; the source provenance cannot be rewritten.

Still required before a release claim: connect canonical server evidence to the
reviewed publication workflow; finish public state intelligence adapters; finish
browser/Figma parity and DOCX visual QA; complete both long runs; qualify actual
task images, worker scheduling, storage IAM, migration owners and rollback;
and obtain authorization/readiness for recipient receipt tests.

## Qualification checkpoint — September 12, 22:22 UTC

All API and Intel migration chains have been applied to local disposable
PostgreSQL, including API-owned hearing media/delivery runtime registration,
approved attachment provenance and hearing publication inbox support.
No shared-cloud database migration or feature activation has occurred.

The short retained-browser recovery run passed with actual tab audio, S3,
Deepgram, explicit re-share and decoded seeks. Saved server audio from an
interrupted epoch was retranscribed through the current recovery worker:
365 seconds processed in two bounded chunks, 12 additional final segments,
without replacing the original transcript or erasing its gap.

The first unattended long run ended after about 55 minutes on repeated storage
timeouts, after three attempts. Preserve its failed manifest and event log.
The replacement sink passed a 185,497 ms short run, including controlled process
loss, a 9,646 ms gap, two retained attempts and six decoded start/middle/end
samples. The replacement long run started at 22:09:25.805 UTC for 250 minutes,
capture f60ebfbd-6272-4c12-bfca-0d961e73812c. Its capture sources are frozen;
elapsed gaps do not count toward the required 240 minutes of saved media.

The retained-browser long run started at 21:11:44.563 UTC for 250 minutes,
session cmtyvrk5t0001zescxh8w6jmt. It has recorded one unplanned interruption
and an explicit re-share. The run must still meet four hours of actual retained
media; neither its elapsed clock nor a simulated test constitutes that gate.

These are owned synthetic fixtures using the existing private development S3
bucket and real Deepgram. The database is local. The unattended resolver is an
owned local-file fixture, and no result establishes Florida source permission,
ECS scheduling, production egress or client pilot acceptance.

## Boundaries

The shared browser lifecycle and existing public capture runtime retain their
separate ownership. A browser restart creates a new container epoch and an
explicit gap. Durable media acknowledgements require both private object storage
and a recoverable manifest. Existing transcript-only sessions acquire no audio.
No-storage sessions persist no media, transcript or derived recap content.

Florida media permissions remain unqualified. Public viewing links and imported
contacts neither authorize capture nor activate any delivery audience. Synthetic
owned fixtures can qualify engineering but do not qualify a Florida broadcast,
SMS account, or client pilot. Every transcript-derived update and recap remains
unofficial; canonical published-record state is unchanged.

## Qualification checkpoint 2026-09-12 23:17 UTC

The implementation now connects canonical server captures to the reviewed publication workflow. A tenant and actor own an immutable review context that references the existing capture and original final segment IDs. It never copies the global transcript or starts another recorder. PostgreSQL checks cover two tenants sharing one capture, original evidence IDs, interim rejection, source withdrawal, correction before approval, preserved gaps and approved DOCX source binding. State public intelligence uses qualified source analysis permissions and resolves Florida HB/SB against jurisdiction and legislative session.

The current branch includes main through 285d84884b7f21257f04ec9c70222201f038725f. Its implementation checkpoint is c3496bee3132a82b2ba0419120e9e84d6fd8fbac, merged in 4e940e13243fe7eddf6e12d5c410eed40336741e. The first qualification commit 271c8ec53e5ec66fde4ed3caa8b76fdace737bf9 is pushed. A follow-up fixes retained audio startup after a Deepgram connection error or timeout. The earlier browser qualification stopped at about 115 minutes, then its re-share failed because of this startup bug. It is a failed run, not a four-hour pass. The startup fix has 25 passing gateway tests and an in-progress real browser/S3 check with an intentionally rejected initial Deepgram connection.

The complete scoped local qualification passed 53 API tests, 94 Intel tests and 59 web tests, with no failures or skips. A separate DOCX render used an actual approved synthetic canonical recap source and the existing Capiro memo renderer; repeat bytes matched, the single page was inspected and literal Markdown markers were corrected. This does not prove deployed Documents indexing or client delivery.

Active-stop measurements against real owned FFmpeg processes: source permission withdrawal 4,596 ms; last demand withdrawal 4,601 ms; tenant capability withdrawal 4,594 ms; existing capture runtime disabled 5,017 ms; explicit canonical capture cancellation 7,067 ms. These are local disposable-database measurements, not ECS schedule qualification. The runtime registry is checked by active scheduled capture processes; changing an environment variable only on a new ECS task is insufficient to stop an old process.

The 250-minute server qualification remains active. Its first attempt stopped after a storage timeout at about 58 minutes; attempt two is saving again and the gap is retained. The controlled 90-minute process failure remains pending. A release archive upload coincided with both browser and server storage stalls. Future uploads use a compressed archive and a 256 KiB/s limit; no failed long run is relabeled as passing. The first native CodeBuild run 9963be5f-f59d-4ae0-b727-a755c0b4a07b was deliberately stopped before deployment when the browser startup defect was identified.

The refreshed service baseline is API 330 (2/2), Intel 33 (1/1), Meri orchestrator 43 (1/1), and dedicated web-vNext 273 (1/1). There are 22 relevant EventBridge rules and 14 distinct task definitions in the runtime snapshot. A read-only database audit is running through the existing inspection family. No Phase 4 service rollout, production database migration, IAM update, new worker schedule activation or outward message has occurred.

SNS remains in its sandbox with a $1 monthly spend limit and zero verified destinations. The existing US toll-free registration is COMPLETE and its route is ACTIVE, but provider qualification and an explicitly authorized receipt are still outstanding. SMS remains off. Florida source capture permission also remains unresolved, so Florida sources stay link-only.

Outstanding: finish actual long-run media qualification; qualify the exact native ARM64 release; inspect current component layouts and final Figma parity; prepare and execute the scoped owner-ordered dark rollout with active-capture preservation; qualify worker scheduling, playback, Documents indexing and rollback; and obtain explicit recipient authorization before any delivery test. Earlier outstanding notes about the missing canonical review connection and state intelligence adapter are superseded by this checkpoint.

The startup failure browser qualification subsequently passed in 205,554 ms. Deepgram deliberately rejected its first connection; the recording saved media without live transcription, a fresh epoch later transcribed normally, five final segments persisted, and both assembled epochs reopened and sought successfully (69,671 ms and 101,046 ms decoded). The new frozen browser runtime is `browser-runtime-startup`, running a fresh 250-minute qualification. It does not inherit a passing duration from earlier failed attempts.

## Qualification checkpoint — September 13, 00:02 UTC

The actual shared hearing page exposed two defects beyond the raw transport harness: a soft transcription warning rejected the pending capture-ready handshake, and the start callback retained the recording policy from the initial render. Both are fixed. The page keeps saving audio with an explicit interrupted-transcription label, uses the current retention policy, and resets the warning when its session scope changes. The page lifecycle suite passes 23 tests. Both retained players pass seven tests covering gap rejection, stale URL disposal, same-URL seeks and playback speed after access refresh.

A real Chrome check of the production shared page and native vNext presentation completed in 197,487 ms. It used localhost fixture identity/read routes, actual single-use tickets, the production gateway, private S3 and Deepgram. The first provider connection was deliberately rejected; audio still saved. A development-server reload contributed to the first interruption, which remains in the evidence. The page was explicitly reopened and re-shared; 15 final segments persisted after recovery. Both epochs assembled, the reopened page played saved audio, and 1.5× speed was verified. This is a short product-page check, not deployed login, four-hour UI or recipient acceptance.

Ten local component screenshots cover live, ready, recovery, approved recap and canonical server audio at 1440 and 390 pixels. They use synthetic response fixtures and have no page errors or horizontal overflow. Recording and publication panels now use the full room width instead of occupying spare columns in the older media grid. The narrow original-source control no longer clips. The Phase 4 Figma headers now refer to review and saved audio instead of the inherited calendar export actions.

The native ARM64 attempt `84ec65dd-f0af-4401-899a-dfb597bf6d30` failed before image builds: API 1,039/1,040, Intel 764/768 and web 767/806. Investigation found stale assertions for the two new dark registry jobs, private canonical review contexts and idempotent live activation, plus ten isolated UI fixtures lacking the new tenant/actor cache-scope mock. Assertions now retain those protections, and the ten fixtures explicitly provide their mocked API scope. The complete local web scope then passed 808 tests; the subsequent loaded-policy regression adds one case. Both affected Intel suites passed all 30 tests. No production authorization fallback was added to accommodate tests.

The complete local Phase 4 runner passed API 53, Intel 96 and web 65 tests with no failures or skips. The new hearing-audio IAM grant and existing logo isolation passed three CDK tests. The grant is restricted to `hearing-audio/*`, including version listing/deletion required for real retention cleanup; no IAM mutation has been made yet. Native qualification must be repeated from the corrected committed source. Its disposable Node container now explicitly installs FFmpeg for the real assembly tests.

The successful read-only cloud database audit at 23:27:34 UTC found zero active browser sessions, zero active public captures, and no unresolved migration failures. Existing hearing tables and the shared migration ledger are owned by `capiro_master`; both current migration task families use the established master-owner credential reference. API migrations must run before Intel migrations. Current application reads use `capiro_app`; inspection did not change ownership or migration history.

The server long run recovered from its controlled process termination at 23:39:28 UTC. Attempt three began at 23:39:38 and remains in the same canonical capture; the new epoch starts at 5,410,216 ms after the prior durable endpoint of 5,395,669 ms. The 14,547 ms process gap remains explicit. Both long runs are still pending. No Phase 4 cloud migration, service rollout, schedule activation, client feature activation or outward message has occurred.

## Qualification checkpoint — September 13, 00:30 UTC

The production shared page passed another real Chrome/S3/Deepgram check with development reloads disabled: 203,806 ms elapsed, deliberate initial transcription rejection, 71.76 seconds saved before intentional page closure, explicit re-share, two playable epochs and 16 final segments. The reopened player preserved 1.5× speed and displayed the roughly nine-second browser gap. This supersedes the previous short run for clean page-lifecycle evidence; both runs remain recorded. A separate real Clerk sign-in to the currently deployed internal Capiro organization loaded all 28 existing sessions, with no page errors or horizontal overflow. The newly created qualification login was revoked afterward.

PR #1616 is open as a draft. GitHub Actions reported that jobs could not start because of account billing or spending-limit restrictions; no GitHub checks are claimed as passing. Native ARM64 build d5e836c5-5262-41c8-9030-34b2cf580080 applied the complete disposable migration chains, passed typechecks and reached regression qualification. It was stopped before release after a final API review found that the legacy recap save route could bypass no-storage and the new approved-version boundary. No image from that candidate was deployed.

The correction makes no-storage sessions unavailable for recap saves and excludes other actors' canonical review contexts from API recap access/listing. Retained-audio sessions, canonical review contexts and tenants with reviewed recaps enabled require the approved route. Existing transcript-only saves remain available to tenants whose new recap capability is off. Authorization is rechecked after rendering and before the legacy document write. Real PostgreSQL tests cover each boundary plus an approved save by the canonical context owner; the new API qualification floor is 58 tests.

The prepared release snapshots 13 task definitions, 17 existing hearing/delivery rules and two new schedules staged disabled. API migration revision 113 and Intel migration revision 6 use the established master-owner secret reference; live reads use capiro_app. Every currently deployed service source is an ancestor of the candidate: API a6280baffec7a2e3db378b69ca90e03167aa1333, Intel/Meri 589b16de2081e89030187b603afff61c449f9c5d, web 285d84884b7f21257f04ec9c70222201f038725f. Source digests, task environments and schedule inputs are preserved privately for drift checks and rollback. The plan must be refreshed for the corrected source before sealing.

## Owner privilege rehearsal — September 13, 00:46 UTC

The cloud read-only audit found `capiro_master` default table privileges granting `capiro_app` more than the new tables' explicit GRANT statements intended. Intel migration `20260912225000_hearing_runtime_privileges` now removes application insertion, permission expansion/deletion and truncation of source grants. It keeps SELECT and UPDATE on the immutable identity column, which PostgreSQL needs for current-permission `FOR SHARE` locks; a trigger rejects identity changes. Application deletion/truncation of publication versions and SMS consent history is also revoked. Operator grant withdrawal and normal runtime row locking remain available.

An isolated PostgreSQL instance rehearsed both complete migration chains as `capiro_master`, API first. Before Intel migrations it applied the broader observed owner default ACL. All four actual `capiro_app` role tests passed: usable shared locks, denied forged/expanded source grants, preserved immutable history and tenant isolation with operator withdrawal. The hearing permission, publication and recording tables are owned by `capiro_master` with FORCE RLS enabled. This local instance is separate from both active long captures. The full Phase 4 matrix is being repeated on it.

The source upload for ac4849d8f417d2e210001db540e3fb7b69c72cf0 was stopped before starting CodeBuild to include this privilege correction. Its incomplete source multipart upload was aborted; recording objects were untouched. The previously stopped build remains stopped, and no Phase 4 image, migration or policy has been applied to the live services.

The full local matrix subsequently passed on the isolated owner-rehearsal database: API 58, Intel 100 and web 65 tests, no failures or skips. API and Intel typechecks also passed for these corrections. Native image qualification and both actual four-hour captures remain separate, unfinished gates at this checkpoint.

## Native regression and local environment loss — September 13, 01:55 UTC

Native ARM64 build `a005d769-f78d-4b6b-946b-b59768b383fe` verified source tree `22afc3902eb33eb94b9fb228a4828e15429c4b23` for `1e8a4645ec56819d1a411f795cbd546a2846c3f6`, applied both disposable migration chains and passed typechecks. The existing Intel regression suite passed 768 tests and web passed 809. API passed 1,044 of 1,045; its legacy recap SQL assertion still expected the parameter list before the new tenant recap-feature subquery. The assertion now covers that parameter, no-storage exclusion and the canonical private-context condition. This attempt failed before image publication and is retained as a failed build.

The latest local browser run failed after 7,609.697 seconds; the separate server run failed after 11,826.277 seconds. Both are below four hours and cannot be combined into an accepted run. Docker subsequently reported zero containers and neither local PostgreSQL port was reachable. Its available event buffer records 60 volume destructions and a volume prune followed by image removals; the earlier container-removal timestamp is outside that buffer. Saved objects remain under the exact owned S3 prefixes, but the disposable database metadata is unavailable. Earlier storage/network interruptions are still recorded separately; the final failures cannot be attributed to S3 alone.

The next server qualification is prepared for the pinned release image in ECS with its own ephemeral PostgreSQL sidecar, API-then-Intel migration dependencies and the owned WAV adapter. It does not use live database credentials or qualify an external source resolver. The next browser qualification uses the authenticated deployed shared page and actual browser tab audio. External source, email, SMS and client acceptance gates remain unqualified; no Phase 4 service rollout has occurred at this checkpoint.

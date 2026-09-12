# LegiWatch Phase 4 — recording, reviewed updates and unofficial recaps

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

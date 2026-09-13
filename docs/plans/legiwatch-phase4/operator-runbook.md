# LegiWatch Phase 4 operations

Current release coordination (September 13, 07:04 UTC): API 336/Intel 35/Web 276/Meri 47 are healthy with separately qualified immutable sources. Preserve API63dc’s later main fix. The independent native four-hour server gate and deployed generated recap/Documents/self-inbox proof passed within owned fixture scope. The full owned HTTPS recording/update/recap pilot and both schedules are active; external channels and public/state capture remain off. The 250-minute browser run started 05:59:39 UTC and must complete on its frozen web/Intel runtime; do not redeploy Intel or disable/revoke its controls. The saved-clock web image is sealed; deployment requires completed long retained media. Final rollback must disable new launches/dispatch while preserving media maintenance for actual one-day retention cleanup. Refer to current engineering and sealed release evidence; the 03:02 table below is historical.

This runbook separates code deployment from tenant/source/channel activation. Consult the accompanying release record for the actual source SHA, immutable images, task definitions, worker targets and validation times. Do not substitute a mutable image tag. The initial release keeps new Phase 4 capabilities disabled.

## Historical release and coordination gate — 03:02 UTC

At September 13, 03:02 UTC, native runtime `e85dad394ba473e572e1d0d49886d74531c713b8` passed qualification and all four image builds. API owner migration revision 114 then Intel owner migration revision 7 completed successfully. Live ownership and application privileges were verified. CI follow-up `76305bf28` changes no application runtime source.

| Service | Qualified task definition | Current checkpoint |
| --- | --- | --- |
| API | `capiro-dev-api:331` | Replaced by a competing AWS CLI rollout to `:333` at 02:45:55 UTC. Its image is tagged earlier main `285d848`, and the approved-recap route is absent from startup mapping |
| Intel | `capiro-dev-intel-api:34` with new gates off; `:35` prepared for the owned internal pilot | `:35` healthy; new tenant flags remain off |
| Meri | `capiro-dev-meriv2-orchestrator:44` | Healthy on the qualified image |
| Web vNext | `capiro-dev-web-vnext:275` | Healthy on the qualified image; existing authenticated hearing list passed a read-only smoke test |

The API mismatch holds pilot activation. Coordinate with the competing deployment before restoring a definition; do not overwrite another rollout or accept a retained Phase 4 environment marker as proof of image contents. The original qualified API remains registered at revision 331. Its native image is `capiro/dev/api@sha256:c054f22881801feb058f36b123fad581c8c7177663a7d8bbf013df0d4283abbf` in the existing account registry. A restore must preserve any subsequently reviewed changes and recheck service health and routes.

The two new EventBridge rules are `capiro-dev-legiwatch-hearing-media-worker` and `capiro-dev-legiwatch-hearing-delivery-worker`, both disabled. Their dark targets are `capiro-dev-legiwatch-phase9-intel:13` and `:14`; the separately prepared pilot targets are `:15` and `:16`. All 17 existing hearing/delivery rules retain their prior schedule expressions, inputs and enabled/disabled states. No running worker was stopped to retarget the next invocation.

The temporary owned-source operator uses its own `capiro-dev-legiwatch-phase4-owned-operator:1` family. An unused registration under API migration revision 115 was immediately deregistered; the migration family's latest active revision was verified to be 114 with command `migrate`. No task ran the unused revision. Never register diagnostic/operator commands as the latest migration-family definition.

Read current service and schedule references before acting:

```powershell
aws ecs describe-services --profile capiro-dev --region us-east-1 --cluster capiro-dev --services capiro-dev-api capiro-dev-intel-api capiro-dev-meriv2-orchestrator capiro-dev-web-vnext --query 'services[].{Service:serviceName,Definition:taskDefinition,Running:runningCount,Desired:desiredCount}' --output table
aws ecs describe-task-definition --profile capiro-dev --region us-east-1 --task-definition capiro-dev-api:331 --query 'taskDefinition.containerDefinitions[].image'
aws events describe-rule --profile capiro-dev --region us-east-1 --name capiro-dev-legiwatch-hearing-media-worker --query '{Name:Name,State:State,Schedule:ScheduleExpression}'
aws events list-targets-by-rule --profile capiro-dev --region us-east-1 --rule capiro-dev-legiwatch-hearing-media-worker --query 'Targets[].EcsParameters.TaskDefinitionArn'
```

The live owner can grant or withdraw exact source permission. The application role intentionally cannot create, expand, delete or truncate source grants; its UPDATE permission on the immutable ID column exists only for PostgreSQL row locks. Do not broaden that permission to work around an operator error. Publication versions and SMS consent history also deny application deletion/truncation.

## Runtime controls

| Control | Scope and behavior |
| --- | --- |
| `hearing_watch` | Existing tenant hearing-room access; preserved. |
| `legiwatch_hearing_recording_v1` | Explicit tenant permission for retained browser audio and qualified public audio. Defaults false, including internal tenants. |
| `legiwatch_hearing_updates_v1` | Explicit tenant permission for reviewed live updates. |
| `legiwatch_hearing_recaps_v1` | Explicit tenant permission for reviewed recaps; the legacy save route cannot bypass approval. |
| `legiwatch_hearing_sms_v1` | Separate tenant SMS permission; insufficient without provider/consent/channel gates. |
| `HEARING_AUDIO_STORAGE_ENABLED`, `ASSETS_BUCKET` | Actual private S3 sink. The inspected bucket uses AES256; use the configured KMS option only with its matching policy. |
| `HEARING_PUBLIC_AUDIO_STORAGE_ENABLED`, `LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED` | Separate canonical retained-audio and state bridge controls. Existing federal consumers retain their prior boundary. |
| `HEARING_AUDIO_MAINTENANCE_ENABLED` | Media maintenance entrypoint. Also requires both runtime registration switches. |
| `HEARING_TRANSCRIPTION_RECOVERY_ENABLED` | Bounded saved-audio retranscription through the existing provider. |
| `LEGIWATCH_HEARING_EMAIL_ENABLED`, `LEGIWATCH_HEARING_INBOX_ENABLED`, `LEGIWATCH_HEARING_SMS_ENABLED` | Independent selected-kind dispatch channels. They do not release old report or agenda queues. |
| `HEARING_SMS_READINESS_APPROVED` | Additional SMS account readiness gate. It stays false while provider receipt is unqualified. |
| `hearing-media-worker`, `hearing-delivery-worker` | Existing `legiwatch_runtime_heartbeat` registry: both `enabled` and `schedule_enabled` must be true. New rows start false. |

The media command is `hearing-media --limit=2`; delivery is `hearing-delivery`. The prepared EventBridge rules use those command overrides in the existing ARM64 `capiro-dev-legiwatch-phase9-intel` family and existing `capiro-dev-legiwatch-phase9-events` invocation role. Both new rules start disabled. There is no manual switch for bypassing their registration gates.

Each permission row binds an exact source URL, event where present, tenant, mode, approved operations, reviewer/evidence dates and expiry. Retention is bounded to 1–90 days; owned engineering fixtures use one day. An official-looking URL, calendar follow or folder assignment does not grant recording permission or create automatic capture demand. Florida media remains link-only until source-specific permission and technical qualification exist.

## Release procedure

1. Refresh main and verify Phase 3 ancestry, all four currently deployed source revisions, healthy service baselines, worker rule inputs and source schedules. Snapshot the established task definitions and image digests. Stop on concurrent drift.
2. Require the exact source native ARM64 build to pass migrations, typechecks, relevant regression and Phase 4 qualification before image publication. Verify each API, Intel, Meri and web manifest/config digest, ARM64 architecture and source revision label. Preserve failed/stopped attempts as such.
3. Apply API migrations with the existing API migration-owner task first, then Intel migrations with its established owner. Both inspected families use the master-owner credential reference; application requests use `capiro_app`. Do not rewrite a migration ledger or switch the owner to an application role.
4. Apply the reviewed private audio policy for `hearing-audio/*`, including version deletion/listing for expiry cleanup. Preserve the existing tenant-assets and client-logo policies. Broad CDK deployment is unnecessary for this scoped release.
5. Refresh the read-only active-capture audit immediately before replacing Intel HTTP tasks. Existing browser WebSockets and public captures must finish naturally unless an intentional stop/recovery has been authorized for those exact captures. A quiet audit hours earlier is insufficient.
6. Deploy pinned API, Intel and Meri definitions; wait for completed ECS rollout, desired healthy tasks and healthy load-balancer targets. Pin compatible existing hearing/delivery worker targets while preserving schedule state, timing and command input. Stage the two new schedules disabled. Do not stop running worker tasks merely because their next invocation will use a newer image.
7. Deploy the dedicated web-vNext service after backend contracts and compatible workers are ready. Preserve unrelated services, including API strategy, and unrelated ingestion schedules.
8. Use the existing internal organization and an owned source for recording, reopen/seek, evidence, approved recap and Documents/Meri validation. New channel and tenant gates remain separate. Exercise an internal feature-off rollback after the owned test capture ends.
9. Before any outward activation, review the exact approved message, audience, client/purpose consent, provider readiness and current source distribution permission. Revalidate held work; stale approvals require new review. Do not turn on SMS or email to test an imported list.

## Read-only diagnosis

Use the established database inspection task with a read-only transaction and the appropriate server-side tenant scope. Do not expose raw transcript, recipients, credentials or signed URLs in routine logs. Capture IDs, epoch IDs, version/hash, task IDs and bounded failure codes are sufficient for correlation.

```sql
BEGIN READ ONLY;
SELECT job_key, enabled, schedule_enabled, status, last_heartbeat_at,
       last_success_at, consecutive_failures
FROM legiwatch_runtime_heartbeat
WHERE job_key IN ('capture-worker','intelligence-worker',
                  'hearing-media-worker','hearing-delivery-worker');
SELECT id, tenant_id, status, started_at, updated_at
FROM intel_live_hearing_session WHERE status IN ('live','paused');
SELECT id, hearing_id, domain_status, worker_lease_owner, lease_expires_at
FROM public_hearing_capture
WHERE domain_status IN ('CAPTURING','PREPARING','RECOVERING','FINALIZING');
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;
ROLLBACK;
```

Private recording metadata is available through authenticated `GET /intel-api/hearings/:sessionId/recording`. A new short-lived playback URL is issued by `POST /intel-api/hearings/:sessionId/recording/epochs/:epochId/playback`. Every request rechecks current session/actor/tenant/source access. Reissue access through this endpoint rather than extending or publishing a stored S3 URL. The browser marks gaps and rejects a seek into an uncovered interval.

| Symptom | Action and expected evidence |
| --- | --- |
| No tab audio | Open and play the permitted source, select the actual tab with tab audio enabled, and check the meter. A microphone is not silently substituted. |
| Source permission blocked | Keep the original-source link. Verify exact event, URL, operations, expiry and tenant; acquire the missing permission before recording. |
| No retained recording | Check policy and capability. Historical transcript-only and no-storage sessions have no fabricated audio. Enable retention before capture only when permitted. |
| Storage stalls | Compare sent bytes with the durable checkpoint and bounded backlog. Stop/re-share after the surfaced failure; preserve the partial tail and recording identifiers. Do not relabel sent bytes as saved. |
| Transcription interrupted while audio saves | Leave recording running if storage is healthy. The room shows transcript delayed; bounded recovery can transcribe saved audio after the provider recovers. A new WebM recorder starts a new epoch. |
| Browser closed or device suspended | Reopen saved portions. A fresh user gesture and source share are required for future capture; the missing interval remains a gap. |
| Finalization or assembly stuck | Check the media registration, schedule heartbeat, epoch lease/error and current permission. The normal media worker recovers abandoned attempts and assembles ordered verified fragments. Do not concatenate arbitrary WebM fragments manually. |
| Expired source URL in server capture | Allow the existing qualified resolver to re-resolve in the worker. Do not copy a transient URL into permanent permission evidence or bypass nested media/egress policy. |
| State/session identity mismatch | Hold automatic state enrollment and bill-linked observations. Preserve the unresolved identity and public source links. |
| Saved link expired | Request fresh authenticated playback. Permission withdrawal or media expiry is an access denial, not a reason to lengthen the URL lifetime. |
| Recipient changed or opted out | Correct the current client/purpose membership and obtain new consent where required. Editing audience or destination invalidates the previous approval/verification. |
| SMS dormant | Check existing SNS account mode, verified destinations, registration, suppression and purpose-bound OTP readiness. Adapter code alone is not provider qualification. |
| Provider outcome uncertain | Hold and reconcile the original attempt. Do not auto-retry a possibly accepted message. A reviewed correction is a new version referencing the original. |
| Recap save rejected | Use the immutable approved version/hash. No-storage cannot export; canonical review contexts remain actor-private. Legacy caller Markdown is accepted only for the preserved transcript-only path before reviewed recaps are enabled. |

## Rollback and retention

Hold new Phase 4 dispatch first using the new delivery registration and channel/tenant controls. Preserve the queue, approved versions, consent and delivery history. Changing an existing capture scheduler is not proof that its active process stopped; it can also affect unrelated federal captures. Scope source/demand withdrawal or explicit capture cancellation to an intentional stop. Qualified local owned-source measurements were 4.6–7.1 seconds. Five separate native ARM64 runs measured source/demand/tenant/runtime/cancel process stops of 129/98/150/5,012/5,021 ms. All used isolated PostgreSQL and an owned WAV adapter. These are individual process measurements, not percentiles, production-source qualification or proof of the terminal canonical disposition.

Before restoring the recorded prior service definitions, inspect active captures and additive-schema compatibility. Let active recordings drain where possible. Disabling the recording tenant permission is an active revocation and can stop ongoing recording; do not use it as a harmless scheduling-only switch. Restore only the exact prior pinned definitions from the release snapshot, preserve compatible media processing for saved data, and confirm health afterward.

Expiry cleanup must delete immutable object versions as well as current parts and assembled artifacts. Keep the required scoped S3 cleanup permission while retained media exists. Do not remove the bucket policy, reset queues, delete media or roll back schema columns to make a release appear clean. Re-enable only the capability whose failed gate has fresh evidence; uncertain or stale messages stay held.

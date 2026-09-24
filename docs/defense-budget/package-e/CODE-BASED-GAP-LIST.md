# Package E code-based gap list

Initial snapshot: `codex/package-e-batch-ingestion`, 2026-09-20. Updated by
Package 0 on 2026-09-24. Source implementation, migration rehearsal, final-image
release qualification and dormant AWS deployment have passed. No production
batch is claimed or authorized.

## Blocking release and authorization gates

| Priority | Gap | Required closure |
| --- | --- | --- |
| Gate | No authorized runnable production manifest exists. The current proposal is qualification-only, has `executionAuthorized: false`, and has no runnable members. | Qualify eligible sources on the exact final image, create their lifecycle/observation/outbox rows through the governed path, freeze one exact manifest and independent S3 object hash, review it, and obtain one explicit batch authorization. |
| P1 | The three proposed non-Air-Force documents are archive-proven but are not current-image-qualified and do not have eligible existing lifecycle/outbox rows. | Qualify Army FY27 RDT&E Vol 1 BA1, Central DoD FY27 R-1, and Army FY27 Missile Procurement independently. Reconcile Central DoD's stale family classification and exercise OCR for the image-only missile document. Admit only rows that then pass exact preview. |
| Closed | Package E merge and final API/drain image provenance were absent. | Resolved through PR #1759 plus release fixes #1762/#1763. Final Linux/ARM64 digests are recorded in `../package-0/release-evidence-2026-09-24.json`; the drain's API-layer prefix is exact. |
| P1 | No audited Package E CodeBuild override or sanitized ECS task-definition payload generator is committed. The old Package A artifact is identity-specific and the project default builds/deploys a different service. | Before release, review a fail-closed buildspec and task-definition cloning/sanitizing procedure against current AWS state. It must not expose secrets, use mutable tags, or activate the drain. |
| Closed for release smoke | The exact final drain digest lacked repeat runtime qualification. | Two independent isolated runs of the representative immutable FY2024 Army R-2 source and a missing-credential negative control completed on qualification revision 33. Both positive reports passed the formal release verifier. The three proposed future first-batch members remain unqualified and unadmitted. |
| Closed | Dormant deployment had not occurred. | AWS CLI applied the additive migration, stabilized API revision 439, registered parked drain revision 27, and confirmed no automatic drain/manifest consumer. The manifest command was not launched. |

## Remaining engineering limitations

| Priority | Limitation | Current mitigation / next proof |
| --- | --- | --- |
| P1 | Qualification references and hashes are manifest assertions; the runtime does not independently fetch each qualification-evidence object. | Release review must verify each immutable evidence object/hash/profile before authorizing the manifest. Consider a signed/immutable qualification registry in a later schema version rather than widening v1 during release. |
| P1 | Uncertain-task reconciliation does not call AWS automatically. | Every start/resume now derives and stores the exact ECS TaskARN from metadata and verifies task-definition revision, container image digest, and CPU/memory. The runbook requires a read-only `describe-tasks` check before exact-ID reconciliation. Exercise this during final-image qualification. |
| P2 | Some human-readable member fields (agency, exhibit, volume, format-profile label) are not authoritative database columns. | Exact source document, observation, outbox, source/archive hashes/bytes/version, candidate/approval/correction counts, runtime, and ordered membership are enforced. Review descriptive fields against qualification evidence before authorization. |
| P2 | The real parser proof was source-tree/local-infrastructure proof, not a container image run, and did not span the production two-minute lease. | Final-image qualification must retain heartbeat/task telemetry during a representative parse. The controller timer already passed a slow-bridge test beyond its test lease. |
| P2 | Immutable artifact writes made immediately before a crash can remain orphaned even though stale workers cannot make them authoritative. | Correlation IDs and persistence fences prevent adoption without the exact operation/item/generation. Retain orphan identifiers and clean them only through a separately reviewed maintenance operation. |
| P2 | Old registered drain revisions remain manually runnable and do not contain the reservation exclusion. | Re-audit services, schedules, rules, and running tasks before deployment and before an authorized batch; prohibit old drain launches while any active manifest reservation exists. |

## Closed gaps in this change

- Resume fails closed unless the exact operation and manifest hash already exist.
- Active candidate, scoped approval, and correction counts are checked at
  preflight and claim time.
- Start/resume require a version-pinned S3 manifest plus an independent object
  SHA-256; mutable/local write input is refused.
- Start/resume attest the live ECS task definition, container image digest,
  TaskARN, exact `capiro-dev` cluster/account/`us-east-1` region, and resource
  shape instead of trusting only injected variables. Conflicting region aliases
  fail closed before an S3-backed manifest read.
- Document/operation deadlines abort the parser and version-pinned archive
  request, race rather than await a non-cooperative bridge, stop new claims,
  fence late verification persistence/checkpointing, and leave durable
  uncertainty for exact reconciliation unless exact evidence was already
  checkpointed before the boundary.
- Absolute, protocol-relative, and relative durable references are all scanned
  for URL userinfo and presigned credential fields.
- Candidate-before-ack recovery adopts the exact persisted correlation without a
  second parse; stale generations are fenced.
- The controller heartbeats both item and outbox leases and refuses uncertain
  ownership loss.
- Item-row inserts are now SQL-checked against exactly one complete member in
  the immutable parent manifest, serialized on the parent row, and capped at
  five even when a writer bypasses the TypeScript repository.
- Start/resume fail before parser setup unless the runtime has a configured
  version-pinned S3 extraction-artifact bucket; filesystem-only extraction
  storage remains available to local preview/development paths.
- The real archive/bridge/parser/persistence path demonstrated ingestion-only
  behavior with protected state unchanged.
- Transient and deterministic failure isolation, later-member continuation,
  stop-new-work, overlap exclusion, legacy-drain reservation exclusion, and
  unknown-operation resume refusal have executable tests.

## No-go rule

Do not claim `ENGINEERING_COMPLETE_PILOT_AWAITING_AUTHORIZATION` or run a
production task until the proposed batch members have exact-source
qualification and lifecycle/outbox bindings, an exact runnable preview exists,
the protected-state baseline is reconfirmed, and explicit manifest
authorization is recorded. Package 0 closed the merge, image, representative
release-smoke and dormant-deployment gates only. Air Force FY27 RDT&E Volume I
remains outside this package.

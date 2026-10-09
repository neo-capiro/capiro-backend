# Meeting prep mail-window follow-up

Candidate source: 5e597983c114b778b79f0e27b92cc497ad437066
Worker image: 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/engagement-api@sha256:6ed4a5731e1c355f8161d1d2e82bb3698544f07a62ac553199b8664f06fd4e79
CodeBuild: capiro-build-web-dev:ae5f4804-fa72-45df-9e69-9cc249292cc3

The production candidate overlays only the prep mail query, safe job failure diagnostics, regression tests and runbook on deployed worker source ce698b63f22f57b124340241d52a07ba2ffd9185. No migration, credentials, runtime policy or other service changes.

Validation completed:
- 73 focused tests passed across hearing retrieval, meeting context and comprehensive generation.
- Full API TypeScript check passed.
- Native ARM64 Node 22.23.3 image build passed. Packaged offline probe checked prep transcript exclusions, date bounds, quoted evidence, unchanged general retrieval, denied client scope and bounded mail association discovery.
- Packaged migrations match candidate source; candidate migrations are byte-identical to the deployed baseline.
- Read-only C2 email replay: both original and bounded searches returned the same 25 eligible recent threads; isolated lookup elapsed time decreased from 505 ms to 270 ms. Historical mail matching no longer precedes the declared prep window filter.

The previously deployed hearing scope fix remains unchanged. Safe failure logs contain only job ID, public error code and bounded cause code; exception messages and source bodies are excluded.

The affected C2 run also had an intermittent failure before model calls, which did not reproduce in isolated full-context diagnostics. This follow-up bounds unnecessary historical discovery and supplies safe cause codes for future diagnosis. It does not assert that the transient failure cause was captured.

Production rollout completed on 2026-10-09: engagement-api task definition 153 is healthy on both service tasks, using the immutable image above. Guarded promotion manifest SHA-256: `91ec283c1e69f9c49c9327c948a734132ebb453bde304648a5d2461829dd4c7a`. The rollback task definition is 152. No credentials or runtime policy changed.

Affected-meeting acceptance passed at 14:39 UTC on 2026-10-09. The affected client prep completed, persisted an approved version-2 briefing with all seven sections and a nonempty summary, and an independent read-only observer retrieved that same artifact through `EngagementService.getMeeting` under the original requesting user's tenant, membership and meeting access scope. The completed job has no public error and its encrypted checkpoints were cleared by the normal persistence commit.

Recovery used a scoped one-off worker running the first qualified hearing-fix image and the existing `MeetingPrepJobService.process` handler, with background lifecycle hooks disabled. Only the affected failed job was claimed after authorization; its deadline, retry ceiling, lease heartbeats, model settings, source access checks and final persistence checks remained in force. The one-off recovery and independent observer both exited successfully. This verifies the saved artifact and handler recovery, rather than asserting that the earlier intermittent failure was reproduced or that a fresh run on the shared worker was tested.

The recovered generation took 1,532,911 ms (25.5 minutes): all 33 extraction batches completed, 785 facts were reviewed, and 173 facts fit the final synthesis budget. The briefing explicitly reports partial coverage. The internal comparison used 30 sources and one extraction batch, finishing in approximately 3.5 minutes. The affected client used 834 governed sources after the hearing fix. C2's configured legacy OpenAI model resolves through the shared policy to `gpt-6-astra`; the internal tenant explicitly selects `gpt-6.1-sol`. No model preference was changed. The hearing expansion defect is repaired, but the comprehensive model and revision workflow still has substantial latency on larger client records.

import { CUTOVER_EVIDENCE_TYPES } from './legiwatch-phase9-gates.js';

export interface LegiWatchPhase9VerificationScenario {
  evidenceType: (typeof CUTOVER_EVIDENCE_TYPES)[number];
  category:
    | 'LIVE_CHAIN'
    | 'CAPTURE_RECOVERY'
    | 'EVENT_LIFECYCLE'
    | 'SOURCE_RESILIENCE'
    | 'FALLBACK_POLICY'
    | 'TRANSCRIPT_QUALITY'
    | 'TENANT_INTELLIGENCE'
    | 'OPERATIONS';
  requirement: string;
  acceptableSources: ReadonlyArray<'LIVE' | 'OFFICIAL_ARCHIVE' | 'LOCAL_FIXTURE' | 'MIXED'>;
  maxAgeDays: number;
  artifactRequired: boolean;
  automatedProof: readonly string[];
  operatorProof: string;
}

/**
 * Single source of truth for the Phase 9 cutover verification matrix.
 *
 * Automated tests prove the mechanism. They never fabricate LIVE evidence:
 * the operator proof must still be recorded against a current run/hearing where
 * the scenario requires it.
 */
export const LEGIWATCH_PHASE9_VERIFICATION_MATRIX: readonly LegiWatchPhase9VerificationScenario[] = [
  {
    evidenceType: 'LIVE_DISCOVERY',
    category: 'LIVE_CHAIN',
    requirement: 'A currently announced official congressional proceeding is observed and reconciled automatically.',
    acceptableSources: ['LIVE', 'MIXED'],
    maxAgeDays: 30,
    artifactRequired: true,
    automatedProof: [
      'apps/api/src/hearing-discovery/hearing-reconciler.service.spec.ts',
      'apps/api/src/live-hearings/phase9/legiwatch-phase9-readiness.service.spec.ts',
    ],
    operatorProof: 'Persist the official observation id, canonical hearing id, source adapter, observed time, and safe artifact reference.',
  },
  {
    evidenceType: 'LIVE_RESOLUTION',
    category: 'LIVE_CHAIN',
    requirement: 'The worker resolves a current first-party live stream in its own egress environment immediately before capture.',
    acceptableSources: ['LIVE', 'MIXED'],
    maxAgeDays: 30,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/capture/automatic-stream-resolver.spec.ts',
      'apps/intel-api/src/hearing/capture/stream-resolution-policy.spec.ts',
    ],
    operatorProof: 'Record hearing/capture ids, provider, policy, reason code, resolution time, and credential-free proof artifact.',
  },
  {
    evidenceType: 'LIVE_CAPTURE',
    category: 'LIVE_CHAIN',
    requirement: 'One global server capture consumes a current live official proceeding while the requesting user is offline.',
    acceptableSources: ['LIVE', 'MIXED'],
    maxAgeDays: 30,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/capture/public-capture-postgres.integration.spec.ts',
      'apps/api/src/live-hearings/live-hearings-phase7.integration.spec.ts',
    ],
    operatorProof: 'Record hearing/capture ids, capture attempt, start/end times, outcome reason, and task/log artifact.',
  },
  {
    evidenceType: 'LIVE_DEEPGRAM',
    category: 'LIVE_CHAIN',
    requirement: 'The live server PCM path reaches Deepgram and persists final canonical transcript segments.',
    acceptableSources: ['LIVE', 'MIXED'],
    maxAgeDays: 30,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/capture/ffmpeg-deepgram-capture.runtime.spec.ts',
      'apps/intel-api/src/hearing/capture/e2e-senate-smoke.spec.ts',
    ],
    operatorProof: 'Record hearing/capture ids, final-segment count, first/last segment times, and redacted provider/session evidence.',
  },
  {
    evidenceType: 'RECOVERY_GAP',
    category: 'CAPTURE_RECOVERY',
    requirement: 'A recoverable interruption produces one durable gap and resumes the same canonical transcript timeline.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/capture/recovery.integration.spec.ts',
      'apps/api/src/live-hearings/phase9/legiwatch-phase9-readiness.service.spec.ts',
    ],
    operatorProof: 'Record capture/attempt ids, injected failure, gap interval, resumed segment, and resulting terminal state.',
  },
  {
    evidenceType: 'WORKER_CRASH_RECOVERY',
    category: 'CAPTURE_RECOVERY',
    requirement: 'An expired worker lease is reclaimed and the stale worker cannot finalize the capture.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/capture/public-hearing-capture.store.spec.ts',
      'apps/intel-api/src/hearing/capture/public-capture-persistent-queue.adapter.spec.ts',
    ],
    operatorProof: 'Record old/new worker ids, lease/fencing values, takeover time, stale rejection, and final outcome.',
  },
  {
    evidenceType: 'NETWORK_RECOVERY',
    category: 'CAPTURE_RECOVERY',
    requirement: 'A media/network interruption triggers bounded recovery and worker-side source re-resolution.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/capture/public-capture.orchestrator.spec.ts',
      'apps/intel-api/src/hearing/capture/recovery.integration.spec.ts',
    ],
    operatorProof: 'Record the fault interval, retry number, re-resolution result, gap, and terminal reason.',
  },
  {
    evidenceType: 'DEEPGRAM_RECOVERY',
    category: 'CAPTURE_RECOVERY',
    requirement: 'A Deepgram disconnect does not duplicate final segments and either recovers or terminalizes explicitly.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/deepgram-stream.manager.spec.ts',
      'apps/intel-api/src/hearing/capture/ffmpeg-deepgram-capture.runtime.spec.ts',
    ],
    operatorProof: 'Record disconnect/reconnect times, retry result, final-segment idempotency check, and outcome reason.',
  },
  {
    evidenceType: 'DUPLICATE_SUPPRESSION',
    category: 'CAPTURE_RECOVERY',
    requirement: 'Duplicate discovery, scheduling, and queue delivery converge on one canonical event/capture/job.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/api/src/live-hearings/live-hearings-phase7.integration.spec.ts',
      'apps/intel-api/src/hearing/capture/public-capture-persistent-queue.adapter.spec.ts',
      'apps/api/src/live-hearings/phase9/legiwatch-phase9.integration.spec.ts',
    ],
    operatorProof: 'Record duplicate inputs and the resulting canonical ids/counts.',
  },
  {
    evidenceType: 'CONCURRENT_CAPTURES',
    category: 'CAPTURE_RECOVERY',
    requirement: 'Multiple simultaneous hearings are leased and captured independently without global serialization.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/capture/public-capture-persistent-queue.adapter.spec.ts',
      'apps/intel-api/src/hearing/capture/public-capture-postgres.integration.spec.ts',
    ],
    operatorProof: 'Record concurrent hearing/capture/task ids, lease overlap, and independent terminal outcomes.',
  },
  {
    evidenceType: 'DELAYED_START',
    category: 'EVENT_LIFECYCLE',
    requirement: 'A proceeding that starts late remains in delayed preflight and is captured after the official stream becomes live.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/api/src/live-hearings/phase9/legiwatch-phase9-preflight.service.spec.ts',
      'apps/intel-api/src/hearing/capture/automatic-stream-resolver.spec.ts',
    ],
    operatorProof: 'Record scheduled start, delayed checkpoints, actual live resolution, and capture start.',
  },
  {
    evidenceType: 'CANCELLATION',
    category: 'EVENT_LIFECYCLE',
    requirement: 'An official cancellation updates the canonical event and prevents a new unattended capture.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/api/src/hearing-discovery/hearing-reconciler.service.spec.ts',
      'apps/api/src/live-hearings/live-hearings-phase7.service.spec.ts',
    ],
    operatorProof: 'Record observation change, canonical status, canceled preflight/capture disposition, and user-visible state.',
  },
  {
    evidenceType: 'RESCHEDULE',
    category: 'EVENT_LIFECYCLE',
    requirement: 'An official time change updates the same canonical hearing and re-plans checkpoint timing.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/api/src/hearing-discovery/hearing-reconciler.service.spec.ts',
      'apps/api/src/live-hearings/phase9/legiwatch-phase9-preflight.service.spec.ts',
    ],
    operatorProof: 'Record old/new start, observation revision, canonical id stability, and new checkpoint due times.',
  },
  {
    evidenceType: 'SOURCE_ROTATION',
    category: 'SOURCE_RESILIENCE',
    requirement: 'A changed official media reference is re-resolved at the worker and does not reuse a stale ingest URL.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/capture/automatic-stream-resolver.spec.ts',
      'apps/intel-api/src/hearing/capture/public-capture.orchestrator.spec.ts',
    ],
    operatorProof: 'Record old/new source references, resolution timestamps, worker attempt, and explicit provenance.',
  },
  {
    evidenceType: 'COMMITTEE_SITE_CHANGE',
    category: 'SOURCE_RESILIENCE',
    requirement: 'A committee-site adapter/probe failure is isolated, visible in coverage, and does not erase the canonical corpus.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/api/src/hearing-discovery/discovery-jobs.service.spec.ts',
      'apps/api/src/live-hearings/phase9/legiwatch-phase9-readiness.service.spec.ts',
    ],
    operatorProof: 'Record source id, parser/version, failure, inherited/central fallback, and coverage status.',
  },
  {
    evidenceType: 'BROWSER_FALLBACK',
    category: 'FALLBACK_POLICY',
    requirement: 'A browser-only public source hands off only the official page and never creates a second canonical server transcript.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/api/src/live-hearings/live-hearings-phase7.integration.spec.ts',
      'apps/web/src/pages/radar/live-hearings/LiveHearingsV2BroadcastPanel.test.ts',
    ],
    operatorProof: 'Record policy, browser handoff, existing canonical attachment decision, and absence of raw media URL.',
  },
  {
    evidenceType: 'POLICY_BLOCK',
    category: 'FALLBACK_POLICY',
    requirement: 'YouTube, C-SPAN, private, closed, licensed, or otherwise blocked sources remain explicitly non-recordable server-side.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/capture/stream-resolution-policy.spec.ts',
      'apps/api/src/live-hearings/live-hearings-phase7-schedule.guard.spec.ts',
    ],
    operatorProof: 'Record provider, capture policy, reason code, and truthful UI action set.',
  },
  {
    evidenceType: 'SILENCE_HANDLING',
    category: 'TRANSCRIPT_QUALITY',
    requirement: 'Silence or no-speech periods do not fabricate transcript text and remain observable in capture health.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/deepgram-stream.manager.spec.ts',
      'apps/intel-api/src/hearing/capture/ffmpeg-deepgram-capture.runtime.spec.ts',
    ],
    operatorProof: 'Record the silence interval, emitted segment count, capture liveness, and terminal result.',
  },
  {
    evidenceType: 'SPEAKER_ATTRIBUTION',
    category: 'TRANSCRIPT_QUALITY',
    requirement: 'Low-confidence or incorrect speaker labels remain machine-attributed and do not become unsupported identity facts.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/deepgram-stream.manager.spec.ts',
      'apps/api/src/live-hearings/live-hearings-phase7.service.spec.ts',
    ],
    operatorProof: 'Record speaker/confidence output, disclaimer, and comparison against an official source where available.',
  },
  {
    evidenceType: 'TENANT_RLS',
    category: 'TENANT_INTELLIGENCE',
    requirement: 'Two tenants can share one public capture/insight corpus while relevance and alerts remain isolated.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/capture/hearing-subscription-rls.integration.spec.ts',
      'apps/intel-api/src/hearing/intelligence/hearing-intelligence.integration.spec.ts',
    ],
    operatorProof: 'Record only aggregate tenant-isolation results; never place tenant/client bodies in the global evidence row.',
  },
  {
    evidenceType: 'INTELLIGENCE_LATENCY',
    category: 'TENANT_INTELLIGENCE',
    requirement: 'Public insights and tenant relevance complete within the configured latency budget after final transcript persistence.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/intel-api/src/hearing/intelligence/hearing-intelligence-job.store.spec.ts',
      'apps/api/src/live-hearings/phase9/legiwatch-phase9-readiness.service.spec.ts',
    ],
    operatorProof: 'Record final-segment time, public-insight completion, relevance completion, and measured latency.',
  },
  {
    evidenceType: 'ROLLBACK',
    category: 'OPERATIONS',
    requirement: 'Rollback disables the default and schedules, engages the kill switch, disables capture-all, and preserves the legacy surface.',
    acceptableSources: ['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED'],
    maxAgeDays: 90,
    artifactRequired: true,
    automatedProof: [
      'apps/api/src/live-hearings/phase9/legiwatch-phase9-cutover.service.spec.ts',
      'apps/web/src/pages/radar/live-hearings/legiwatch-live-hearings-flags.test.ts',
    ],
    operatorProof: 'Run a controlled rollback rehearsal and record pre/post state, disabled rules, and preserved UI proof.',
  },
] as const;

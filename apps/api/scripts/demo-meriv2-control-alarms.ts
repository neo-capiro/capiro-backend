#!/usr/bin/env tsx
/**
 * Emit one deliberate alarm-breaching MeriV2 control sample in a real NON-PROD
 * AWS environment. This is an alarm-wiring demonstration, not a product test.
 *
 * Refuses Capiro `dev` because that environment currently serves production
 * traffic. The operator must use an isolated `staging` or `test` account/stack
 * and provide the exact confirmation phrase below.
 */
import {
  emitMeriV2ControlMetrics,
  normalizeMeriV2ControlEnvironment,
} from '@capiro/meriv2-core';

const CONFIRMATION = 'NONPRODUCTION_ONLY';
const environment = normalizeMeriV2ControlEnvironment(
  process.env.CAPIRO_ENV ?? process.env.NODE_ENV,
);

if (process.env.MERIV2_ALARM_DEMO_CONFIRM !== CONFIRMATION) {
  throw new Error(`MERIV2_ALARM_DEMO_CONFIRM must equal ${CONFIRMATION}`);
}
if (environment !== 'staging' && environment !== 'test') {
  throw new Error(
    `Alarm demonstration is refused for environment ${environment}; use an isolated staging/test stack.`,
  );
}

const emitted = emitMeriV2ControlMetrics(
  {
    PendingCandidateOldestAgeSeconds: 172_800,
    SelfReviewDenials: 2,
    EthicalWallDenials: 25,
    ConflictedMemoryCount: 2,
    ContextPacketPersistenceFailures: 2,
    AssuranceHeldOutcomes: 10,
    AssuranceDegradedOutcomes: 20,
    UnsupportedHighRiskClaimRate: 100,
    OutboxOldestAgeSeconds: 3_600,
    OutboxRetryingCount: 5,
    OutboxDeadLetterCount: 2,
    PolicyDriftInvalidations: 2,
    BackfillQuarantineCount: 2,
    BackfillDriftCount: 2,
    ControlMonitorFailures: 2,
  },
  { force: true, environment },
);

if (!emitted) throw new Error('Alarm demonstration metric emission failed.');
console.log(
  JSON.stringify({
    event: 'meriv2.control.alarm_demo_emitted',
    environment,
    metricCount: emitted._aws.CloudWatchMetrics[0]?.Metrics.length ?? 0,
    customerDataTouched: false,
  }),
);

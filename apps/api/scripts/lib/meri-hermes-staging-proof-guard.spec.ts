import {
  MERI_HERMES_STAGING_PROOF_TENANT_ID,
  assertMeriHermesStagingProofEvidence,
  assertMeriHermesStagingProofGuards,
  parseMeriHermesProofReattachArgs,
  type MeriHermesStagingProofEvidence,
} from './meri-hermes-staging-proof-guard.js';

function validEvidence(): MeriHermesStagingProofEvidence {
  const result = {
    schemaVersion: '1.0.0',
    environment: 'staging',
    tenantId: MERI_HERMES_STAGING_PROOF_TENANT_ID,
    startedAt: '2026-09-23T12:00:00.000Z',
    finishedAt: '2026-09-23T12:01:00.000Z',
    queued: {
      runId: '10000000-0000-4000-8000-000000000001', terminalStatus: 'completed', detached: true,
      freshProcessReconnect: true, duplicateRetryReattached: true, oneRun: true,
      oneUserMessage: true, terminalOutputPersisted: true, monotonicUniqueEvents: true,
    },
    active: {
      runId: '10000000-0000-4000-8000-000000000002', terminalStatus: 'completed', detached: true,
      freshProcessReconnect: true, outputSnapshotReplay: true, monotonicUniqueEvents: true,
      terminalOutputPersisted: true,
    },
    authorization: { crossOwnerDenied: true, crossTenantDenied: true },
    stop: {
      runId: '10000000-0000-4000-8000-000000000003', terminalStatus: 'cancelled',
      stopRequested: true, noSuccessAfterStop: true, stopAfterRollbackGateClosed: true,
    },
    disabledPath: {
      wrongTenantGateDenied: true, tenantFlagOffDenied: true,
      rollbackGateClosedWhileActive: true, inFlightCompletedAfterRollback: true,
    },
    cleanup: { syntheticTenantDeleted: true },
  } as const;
  return result;
}

describe('Meri Hermes staging continuity proof safety', () => {
  test('requires every hard guard with exact values', () => {
    const valid = {
      NODE_ENV: 'staging', MERI_HERMES_STAGING_PROOF: 'YES',
      MERI_HERMES_STAGING_PROOF_TENANT_ID,
    };
    expect(() => assertMeriHermesStagingProofGuards(valid)).not.toThrow();
    for (const invalid of [
      { ...valid, NODE_ENV: 'production' },
      { ...valid, MERI_HERMES_STAGING_PROOF: 'true' },
      { ...valid, MERI_HERMES_STAGING_PROOF_TENANT_ID: '10000000-0000-4000-8000-000000000099' },
    ]) {
      expect(() => assertMeriHermesStagingProofGuards(invalid)).toThrow();
    }
  });

  test('accepts only complete, terminal, opaque evidence', () => {
    expect(() => assertMeriHermesStagingProofEvidence(validEvidence())).not.toThrow();
    const failed = validEvidence();
    failed.queued.oneRun = false;
    expect(() => assertMeriHermesStagingProofEvidence(failed)).toThrow(/assertions failed/);
    const contentBearing = { ...validEvidence(), prompt: 'must never be emitted' };
    expect(() =>
      assertMeriHermesStagingProofEvidence(contentBearing as MeriHermesStagingProofEvidence),
    ).toThrow(/Forbidden content-bearing/);
  });

  test('parses the fresh-process mode without shifting opaque ids', () => {
    expect(parseMeriHermesProofReattachArgs([
      '/usr/bin/node', '/app/proof.ts', '--reattach',
      '10000000-0000-4000-8000-000000000001',
      MERI_HERMES_STAGING_PROOF_TENANT_ID,
      '10000000-0000-4000-8000-000000000002',
      '7',
    ])).toEqual({
      runId: '10000000-0000-4000-8000-000000000001',
      tenantId: MERI_HERMES_STAGING_PROOF_TENANT_ID,
      userId: '10000000-0000-4000-8000-000000000002',
      afterSeq: 7,
    });
  });
});

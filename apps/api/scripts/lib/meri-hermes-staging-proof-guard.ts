export const MERI_HERMES_STAGING_PROOF_TENANT_ID =
  'f17a0000-0000-4000-8000-000000000001' as const;
export const MERI_HERMES_STAGING_PROOF_TENANT_SLUG =
  'meri-hermes-phase1-staging-proof' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'expired']);

export interface MeriHermesStagingProofEvidence {
  schemaVersion: '1.0.0';
  environment: 'staging';
  tenantId: typeof MERI_HERMES_STAGING_PROOF_TENANT_ID;
  startedAt: string;
  finishedAt: string;
  queued: {
    runId: string;
    terminalStatus: string;
    detached: boolean;
    freshProcessReconnect: boolean;
    duplicateRetryReattached: boolean;
    oneRun: boolean;
    oneUserMessage: boolean;
    terminalOutputPersisted: boolean;
    monotonicUniqueEvents: boolean;
  };
  active: {
    runId: string;
    terminalStatus: string;
    detached: boolean;
    freshProcessReconnect: boolean;
    outputSnapshotReplay: boolean;
    terminalOutputPersisted: boolean;
    monotonicUniqueEvents: boolean;
  };
  authorization: {
    crossOwnerDenied: boolean;
    crossTenantDenied: boolean;
  };
  stop: {
    runId: string;
    terminalStatus: string;
    stopRequested: boolean;
    noSuccessAfterStop: boolean;
    stopAfterRollbackGateClosed: boolean;
  };
  disabledPath: {
    wrongTenantGateDenied: boolean;
    tenantFlagOffDenied: boolean;
    rollbackGateClosedWhileActive: boolean;
    inFlightCompletedAfterRollback: boolean;
  };
  cleanup: { syntheticTenantDeleted: boolean };
}
/**
 * This destructive proof is intentionally impossible to run from ordinary
 * application tasks. All three conditions are exact comparisons (no truthy
 * aliases) and every subprocess runs this guard again.
 */
export function assertMeriHermesStagingProofGuards(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'staging') {
    throw new Error('Meri Hermes continuity proof requires NODE_ENV=staging');
  }
  if (env.MERI_HERMES_STAGING_PROOF !== 'YES') {
    throw new Error('Meri Hermes continuity proof requires MERI_HERMES_STAGING_PROOF=YES');
  }
  if (env.MERI_HERMES_STAGING_PROOF_TENANT_ID !== MERI_HERMES_STAGING_PROOF_TENANT_ID) {
    throw new Error(
      `Meri Hermes continuity proof requires the exact synthetic tenant id ${MERI_HERMES_STAGING_PROOF_TENANT_ID}`,
    );
  }
}

export function parseMeriHermesProofReattachArgs(argv: string[]): {
  runId: string;
  tenantId: string;
  userId: string;
  afterSeq: number;
} {
  const [, , mode, runId, tenantId, userId, rawAfterSeq] = argv;
  if (mode !== '--reattach' || !runId || !tenantId || !userId) {
    throw new Error('Missing fresh-process reconnect arguments');
  }
  assertUuid(runId, 'reattach.runId');
  assertUuid(tenantId, 'reattach.tenantId');
  assertUuid(userId, 'reattach.userId');
  const afterSeq = Number(rawAfterSeq ?? 0);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('Invalid reattach.afterSeq');
  return { runId, tenantId, userId, afterSeq };
}

function assertIso(value: unknown, field: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ${field}`);
  }
}

function assertUuid(value: unknown, field: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`Invalid ${field}`);
}

/**
 * Evidence is deliberately a fixed allow-list of opaque identifiers, counts
 * expressed as booleans, states, and timestamps. Prompt, response, note,
 * attachment, secret, token, and message content have no schema slot.
 */
export function assertMeriHermesStagingProofEvidence(
  evidence: MeriHermesStagingProofEvidence,
): void {
  if (evidence.schemaVersion !== '1.0.0' || evidence.environment !== 'staging') {
    throw new Error('Invalid proof evidence envelope');
  }
  if (evidence.tenantId !== MERI_HERMES_STAGING_PROOF_TENANT_ID) {
    throw new Error('Proof evidence tenant mismatch');
  }
  assertIso(evidence.startedAt, 'startedAt');
  assertIso(evidence.finishedAt, 'finishedAt');
  assertUuid(evidence.queued.runId, 'queued.runId');
  assertUuid(evidence.active.runId, 'active.runId');
  assertUuid(evidence.stop.runId, 'stop.runId');
  for (const [name, status] of [
    ['queued.terminalStatus', evidence.queued.terminalStatus],
    ['active.terminalStatus', evidence.active.terminalStatus],
    ['stop.terminalStatus', evidence.stop.terminalStatus],
  ] as const) {
    if (!TERMINAL.has(status)) throw new Error(`${name} is not terminal`);
  }
  const required = [
    evidence.queued.detached,
    evidence.queued.freshProcessReconnect,
    evidence.queued.duplicateRetryReattached,
    evidence.queued.oneRun,
    evidence.queued.oneUserMessage,
    evidence.queued.terminalOutputPersisted,
    evidence.queued.monotonicUniqueEvents,
    evidence.active.detached,
    evidence.active.freshProcessReconnect,
    evidence.active.outputSnapshotReplay,
    evidence.active.terminalOutputPersisted,
    evidence.active.monotonicUniqueEvents,
    evidence.authorization.crossOwnerDenied,
    evidence.authorization.crossTenantDenied,
    evidence.stop.stopRequested,
    evidence.stop.noSuccessAfterStop,
    evidence.stop.stopAfterRollbackGateClosed,
    evidence.disabledPath.wrongTenantGateDenied,
    evidence.disabledPath.tenantFlagOffDenied,
    evidence.disabledPath.rollbackGateClosedWhileActive,
    evidence.disabledPath.inFlightCompletedAfterRollback,
    evidence.cleanup.syntheticTenantDeleted,
  ];
  if (required.some((value) => value !== true)) {
    throw new Error('One or more required continuity proof assertions failed');
  }

  const keys = JSON.stringify(evidence).toLowerCase();
  for (const forbidden of ['prompt', 'content', 'body', 'password', 'secret', 'token', 'attachment']) {
    if (keys.includes(`\"${forbidden}`)) {
      throw new Error(`Forbidden content-bearing evidence field: ${forbidden}`);
    }
  }
}

import type { ParserRouterTerminalOutputV1 } from '../parser-router/parser-router-v1.service.js';
import type {
  ObservationIngestionBridgeExecutionV1,
  ObservationIngestionBridgeResult,
} from '../observation-ingestion-bridge.service.js';
import type { VerificationPersistenceFenceV1 } from '../verification/persistence/verification-persistence-fence-v1.js';
import type {
  IngestionManifestMemberV1,
  IngestionManifestV1,
} from './ingestion-manifest-contract-v1.js';
import type {
  IngestionManifestItemRecordV1,
  IngestionManifestOperationRecordV1,
  IngestionManifestRepositoryV1,
} from './ingestion-manifest-repository-v1.js';
import { RunIngestionManifestV1 } from './run-ingestion-manifest-v1.js';

const uuid = (suffix: number): string =>
  `10000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;

function makeMember(ordinal: number, maxAttempts = 2): IngestionManifestMemberV1 {
  return {
    memberId: uuid(ordinal),
    ordinal,
    documentKey: `document-${ordinal}`,
    timeoutSeconds: 60,
    retry: {
      classification: 'transient_only',
      maxAttempts,
      initialBackoffSeconds: 1,
    },
    lifecycle: {
      cycleId: uuid(100),
      sourceDocumentId: uuid(200 + ordinal),
      observationId: uuid(300 + ordinal),
      outboxRowId: uuid(400 + ordinal),
    },
    source: { sha256: `${ordinal}`.repeat(64).slice(0, 64), byteSize: 1_000 + ordinal },
    archive: {
      bucket: 'package-e-test-archive',
      objectKey: `fixtures/document-${ordinal}.pdf`,
      versionId: `version-${ordinal}`,
      sha256: `${ordinal}`.repeat(64).slice(0, 64),
      byteSize: 1_000 + ordinal,
    },
  } as unknown as IngestionManifestMemberV1;
}

function makeManifest(memberCount: number, maxAttempts = 2): IngestionManifestV1 {
  return {
    operationId: uuid(900),
    contentSha256: 'a'.repeat(64),
    members: Array.from({ length: memberCount }, (_, index) => makeMember(index + 1, maxAttempts)),
    limits: {
      resourceShape: { cpuUnits: 4_096, memoryMiB: 8_192, ephemeralStorageGiB: 20, cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
      costCeiling: { currency: 'USD', maximumAmount: '25.00', enforcement: 'operator_and_elapsed_limits' },
    },
  } as unknown as IngestionManifestV1;
}

function makeItem(
  operationId: string,
  member: IngestionManifestMemberV1,
): IngestionManifestItemRecordV1 {
  return {
    id: member.memberId,
    operationId,
    ordinal: member.ordinal,
    outboxRowId: member.lifecycle.outboxRowId,
    observationId: member.lifecycle.observationId,
    cycleId: member.lifecycle.cycleId,
    sourceDocumentId: member.lifecycle.sourceDocumentId,
    sourceSha256: member.source.sha256,
    sourceByteSize: member.source.byteSize,
    expectedOutboxState: 'pending',
    member,
    status: 'pending',
    leaseToken: null,
    leaseGeneration: 0,
    leasedUntil: null,
    lastHeartbeatAt: null,
    taskJobId: null,
    attempts: 0,
    nextAttemptAt: '2026-09-20T12:00:00.000Z',
    executionHistory: [],
    verificationCorrelations: [],
    reconciliations: [],
    terminal: null,
    candidateId: null,
    verificationRunId: null,
    parserDisposition: null,
    lastErrorClass: null,
    lastErrorMessage: null,
    startedAt: null,
    finishedAt: null,
  };
}

function makeRepository(manifest: IngestionManifestV1): {
  repository: IngestionManifestRepositoryV1;
  operation: IngestionManifestOperationRecordV1;
} {
  const now = Date.now();
  const operation: IngestionManifestOperationRecordV1 = {
    id: manifest.operationId,
    manifestSha256: manifest.contentSha256,
    manifest,
    status: 'running',
    stopRequestedAt: null,
    startedAt: new Date(now - 1_000).toISOString(),
    deadlineAt: new Date(now + 60 * 60 * 1_000).toISOString(),
    completedAt: null,
    items: manifest.members.map((member) => makeItem(manifest.operationId, member)),
  };

  const itemFor = (itemId: string) => operation.items.find((item) => item.id === itemId);
  const clearLease = (item: IngestionManifestItemRecordV1): void => {
    item.leaseToken = null;
    item.leasedUntil = null;
  };
  const markOperationCompletedWhenSettled = (): void => {
    if (operation.items.every((item) => ['completed', 'quarantined'].includes(item.status))) {
      operation.status = 'completed';
      operation.completedAt = '2026-09-20T12:05:00.000Z';
    }
  };

  const persistenceFence: VerificationPersistenceFenceV1 = async () => undefined;
  const repository: IngestionManifestRepositoryV1 = {
    preflight: jest.fn(async () => ({ eligible: true, issues: [] })),
    register: jest.fn(async () => ({
      outcome: 'existing' as const,
      operation,
      issues: [],
    })),
    read: jest.fn(async () => operation),
    requestStop: jest.fn(async () => {
      operation.status = 'stop_requested';
      operation.stopRequestedAt = '2026-09-20T12:01:00.000Z';
      return operation;
    }),
    resume: jest.fn(async () => {
      operation.status = 'running';
      return 'resumed' as const;
    }),
    claimNext: jest.fn(async ({ leaseToken, taskJobId }) => {
      const evidenceReady = operation.items.find((item) => item.status === 'evidence_ready');
      if (evidenceReady) {
        evidenceReady.leaseToken = leaseToken;
        evidenceReady.taskJobId = taskJobId;
        return { outcome: 'evidence_ready' as const, item: evidenceReady };
      }
      const next = operation.items.find((item) => item.status === 'pending') ??
        operation.items.find((item) => item.status === 'retry_wait');
      if (next) {
        next.status = 'running';
        next.leaseToken = leaseToken;
        next.leaseGeneration += 1;
        next.taskJobId = taskJobId;
        next.attempts += 1;
        next.startedAt ??= new Date().toISOString();
        return { outcome: 'claimed' as const, item: next };
      }
      markOperationCompletedWhenSettled();
      return {
        outcome: operation.status === 'completed' ? ('complete' as const) : ('none' as const),
        item: null,
      };
    }),
    heartbeat: jest.fn(async () => true),
    markUncertain: jest.fn(async (input) => {
      const item = itemFor(input.itemId);
      if (!item || item.status !== 'running' || item.leaseToken !== input.leaseToken) return false;
      item.status = 'uncertain';
      item.lastErrorClass = input.errorClass;
      item.lastErrorMessage = input.detail;
      clearLease(item);
      return true;
    }),
    checkpointTerminal: jest.fn(async (context, terminal) => {
      const item = itemFor(context.itemId);
      if (!item || item.status !== 'running' || item.leaseToken !== context.leaseToken)
        return false;
      const decision = terminal.verifierDecision;
      if (decision !== 'PASS' && decision !== 'REVIEW' && decision !== 'REJECT') return false;
      item.terminal = terminal;
      item.candidateId = String(terminal.candidateId);
      item.verificationRunId = String(terminal.verificationRunId);
      item.parserDisposition = decision;
      item.verificationCorrelations.push({
        candidateId: item.candidateId,
        verificationRunId: item.verificationRunId,
      });
      item.status = 'evidence_ready';
      return true;
    }),
    finalizeEvidence: jest.fn(async (context) => {
      const item = itemFor(context.itemId);
      if (!item || item.status !== 'evidence_ready' || item.leaseToken !== context.leaseToken) {
        return false;
      }
      item.status = 'completed';
      item.finishedAt = '2026-09-20T12:02:00.000Z';
      clearLease(item);
      markOperationCompletedWhenSettled();
      return true;
    }),
    recordTransientFailure: jest.fn(async (input) => {
      const item = itemFor(input.itemId);
      if (!item || item.leaseToken !== input.leaseToken) return 'lease_lost' as const;
      item.lastErrorClass = input.errorClass;
      item.lastErrorMessage = input.detail;
      clearLease(item);
      if (item.attempts >= item.member.retry.maxAttempts) {
        item.status = 'quarantined';
        item.finishedAt = '2026-09-20T12:03:00.000Z';
        markOperationCompletedWhenSettled();
        return 'quarantined' as const;
      }
      item.status = 'retry_wait';
      return 'retry_wait' as const;
    }),
    quarantineFailure: jest.fn(async (input) => {
      const item = itemFor(input.itemId);
      if (!item || item.leaseToken !== input.leaseToken) return false;
      item.status = 'quarantined';
      item.lastErrorClass = input.errorClass;
      item.lastErrorMessage = input.detail;
      item.finishedAt = '2026-09-20T12:03:00.000Z';
      clearLease(item);
      markOperationCompletedWhenSettled();
      return true;
    }),
    reconcileUncertain: jest.fn(async () => 'ineligible' as const),
    persistenceFence: jest.fn(() => persistenceFence),
  };
  return { repository, operation };
}

function terminalFor(
  executionId: string,
  ordinal: number,
  verifierDecision: 'PASS' | 'REVIEW' | 'REJECT',
): ParserRouterTerminalOutputV1 {
  return {
    executionId,
    finalState:
      verifierDecision === 'PASS'
        ? 'TERMINAL_PASSED'
        : verifierDecision === 'REVIEW'
          ? 'TERMINAL_REVIEW'
          : 'TERMINAL_REJECTED',
    candidateId: uuid(600 + ordinal),
    verificationRunId: uuid(700 + ordinal),
    artifactId: `artifact-${ordinal}`,
    artifactLocator: `s3://evidence/artifact-${ordinal}.json`,
    artifactContentSha256: 'b'.repeat(64),
    artifactByteSha256: 'c'.repeat(64),
    verifierDecision,
    unresolvedFindings: [],
    reviewRequiredFindings: [],
    paidPagesUsed: [],
    localPagesUsed: {},
    reusedArtifacts: [],
    rounds: [],
    costReport: {} as ParserRouterTerminalOutputV1['costReport'],
    nextOperatorAction: 'none',
  };
}

function bridgeResult(
  observationId: string,
  status: ObservationIngestionBridgeResult['status'],
): ObservationIngestionBridgeResult {
  const resolved = [
    'ingested',
    'already_ingested',
    'review_required',
    'verification_rejected',
  ].includes(status);
  return {
    status,
    observationId,
    sourceDocumentId: resolved ? uuid(800) : null,
    reason: resolved ? null : `deterministic ${status}`,
    sourceDocumentBound: resolved,
    parserVerificationSucceeded: status === 'ingested' || status === 'already_ingested',
    durableEvidencePersisted: resolved,
    ingestionSucceeded: status === 'ingested' || status === 'already_ingested',
    parserHandoffInvoked: resolved,
    parserHandoffError: null,
    verifierDecision:
      status === 'review_required'
        ? 'REVIEW'
        : status === 'verification_rejected'
          ? 'REJECT'
          : resolved
            ? 'PASS'
            : null,
  };
}

describe('RunIngestionManifestV1', () => {
  it('continues PASS -> deterministic quarantine -> REVIEW -> PASS and invokes no readiness, approval, or canonical hooks', async () => {
    const manifest = makeManifest(4);
    const { repository } = makeRepository(manifest);
    const readiness = jest.fn();
    const approval = jest.fn();
    const canonical = jest.fn();
    const bridge = {
      readiness,
      approval,
      canonical,
      bridge: jest.fn(
        async (
          observationId: string,
          execution?: ObservationIngestionBridgeExecutionV1,
        ): Promise<ObservationIngestionBridgeResult> => {
          const ordinal =
            manifest.members.findIndex(
              (member) => member.lifecycle.observationId === observationId,
            ) + 1;
          if (ordinal === 2) return bridgeResult(observationId, 'blocked');
          const decision = ordinal === 3 ? 'REVIEW' : 'PASS';
          await execution!.governedExecution.onTerminal(
            terminalFor(execution!.governedExecution.executionId, ordinal, decision),
          );
          return bridgeResult(
            observationId,
            decision === 'REVIEW' ? 'review_required' : 'ingested',
          );
        },
      ),
    };
    const controller = new RunIngestionManifestV1({
      repository,
      bridge,
      heartbeatMs: 60_000,
      leaseToken: (() => {
        let next = 1_000;
        return () => uuid(next++);
      })(),
    });

    const result = await controller.run(manifest, { taskJobId: 'ecs-task-1' });

    expect(result.outcome).toBe('completed');
    expect(bridge.bridge.mock.calls.map(([observationId]) => observationId)).toEqual(
      manifest.members.map((member) => member.lifecycle.observationId),
    );
    expect(result.summary).toMatchObject({
      selected: 4,
      review: 1,
      passed: 2,
      rejected: 0,
      quarantined: 1,
      pending: 0,
      running: 0,
      retryWait: 0,
      approvals: 'not_performed',
      readiness: 'not_performed',
      canonicalPublication: 'not_performed',
    });
    expect(result.summary!.items[0]).toMatchObject({
      status: 'completed',
      disposition: 'PASS',
    });
    expect(result.summary!.items[1]).toMatchObject({
      status: 'quarantined',
      disposition: null,
      lastErrorClass: 'blocked',
    });
    expect(result.summary!.items[2]).toMatchObject({
      status: 'completed',
      disposition: 'REVIEW',
    });
    expect(result.summary!.items[3]).toMatchObject({
      status: 'completed',
      disposition: 'PASS',
    });
    expect(readiness).not.toHaveBeenCalled();
    expect(approval).not.toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
  });

  it('lets another member finish after a transient failure and stops reparsing at the retry limit', async () => {
    const manifest = makeManifest(2, 2);
    const { repository } = makeRepository(manifest);
    const executionIds: string[] = [];
    const observations: string[] = [];
    const bridge = {
      bridge: jest.fn(
        async (observationId: string, execution?: ObservationIngestionBridgeExecutionV1) => {
          observations.push(observationId);
          executionIds.push(execution!.governedExecution.executionId);
          if (observationId === manifest.members[1]!.lifecycle.observationId) {
            await execution!.governedExecution.onTerminal(
              terminalFor(execution!.governedExecution.executionId, 2, 'PASS'),
            );
            return bridgeResult(observationId, 'ingested');
          }
          return bridgeResult(observationId, 'downstream_failed');
        },
      ),
    };
    const controller = new RunIngestionManifestV1({
      repository,
      bridge,
      heartbeatMs: 60_000,
      leaseToken: (() => {
        let next = 2_000;
        return () => uuid(next++);
      })(),
    });

    const result = await controller.run(manifest, { taskJobId: 'ecs-task-retry' });

    expect(result.outcome).toBe('completed');
    expect(bridge.bridge).toHaveBeenCalledTimes(3);
    expect(observations).toEqual([
      manifest.members[0]!.lifecycle.observationId,
      manifest.members[1]!.lifecycle.observationId,
      manifest.members[0]!.lifecycle.observationId,
    ]);
    expect(executionIds.filter(id => id.endsWith(manifest.members[0]!.memberId))).toHaveLength(2);
    expect(result.summary!.items[0]).toMatchObject({
      status: 'quarantined',
      attempts: 2,
      lastErrorClass: 'downstream_failed',
    });
    expect(result.summary!.items[1]).toMatchObject({ status: 'completed', disposition: 'PASS' });
  });

  it('returns at the operation deadline even when the bridge ignores abort, then durably marks the item uncertain', async () => {
    const manifest = makeManifest(1);
    const { repository, operation } = makeRepository(manifest);
    operation.deadlineAt = new Date(Date.now() + 25).toISOString();
    let observedSignal: AbortSignal | undefined;
    const bridge = {
      bridge: jest.fn(async (
        _observationId: string,
        execution?: ObservationIngestionBridgeExecutionV1,
      ): Promise<ObservationIngestionBridgeResult> => {
        observedSignal = execution!.governedExecution.abortSignal;
        return await new Promise<ObservationIngestionBridgeResult>(() => undefined);
      }),
    };
    const controller = new RunIngestionManifestV1({
      repository,
      bridge,
      heartbeatMs: 5,
      leaseToken: () => uuid(2_500),
    });

    let guard: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      controller.run(manifest, { taskJobId: 'ecs-task-timeout' }),
      new Promise<never>((_resolve, reject) => {
        guard = setTimeout(() => reject(new Error('controller remained blocked on non-cooperative bridge')), 500);
      }),
    ]).finally(() => { if (guard) clearTimeout(guard); });

    expect(observedSignal?.aborted).toBe(true);
    expect(repository.requestStop).toHaveBeenCalledTimes(1);
    expect(repository.markUncertain).toHaveBeenCalledWith(expect.objectContaining({
      errorClass: 'EXECUTION_DEADLINE_EXCEEDED',
    }));
    expect(result).toMatchObject({
      outcome: 'uncertain',
      summary: { uncertain: 1, items: [{ status: 'uncertain' }] },
    });
  });

  it('resumes a durably checkpointed terminal item by finalizing evidence without reparsing', async () => {
    const manifest = makeManifest(1);
    const { repository, operation } = makeRepository(manifest);
    const item = operation.items[0]!;
    const terminal = terminalFor(`manifest-${manifest.operationId}-${item.id}`, 1, 'REVIEW');
    item.status = 'evidence_ready';
    item.attempts = 1;
    item.terminal = terminal as unknown as Record<string, unknown>;
    item.candidateId = terminal.candidateId!;
    item.verificationRunId = terminal.verificationRunId!;
    item.parserDisposition = 'REVIEW';
    item.verificationCorrelations = [
      { candidateId: terminal.candidateId, verificationRunId: terminal.verificationRunId },
    ];
    const bridge = { bridge: jest.fn() };
    const controller = new RunIngestionManifestV1({
      repository,
      bridge,
      heartbeatMs: 60_000,
      leaseToken: () => uuid(3_000),
    });

    const result = await controller.run(manifest, {
      taskJobId: 'ecs-task-resume',
      resume: true,
    });

    expect(repository.resume).toHaveBeenCalledWith(manifest.operationId);
    expect(repository.finalizeEvidence).toHaveBeenCalledTimes(1);
    expect(bridge.bridge).not.toHaveBeenCalled();
    expect(result.outcome).toBe('completed');
    expect(result.summary).toMatchObject({ review: 1, quarantined: 0 });
    expect(result.summary!.items[0]).toMatchObject({
      status: 'completed',
      disposition: 'REVIEW',
      attempts: 1,
    });
  });

  it('refuses resume for an operation that was never registered', async () => {
    const manifest = makeManifest(1);
    const { repository } = makeRepository(manifest);
    (repository.read as jest.Mock).mockResolvedValueOnce(null);
    const bridge = { bridge: jest.fn() };
    const result = await new RunIngestionManifestV1({ repository, bridge }).run(manifest, {
      taskJobId: 'ecs-task-missing-resume',
      resume: true,
    });
    expect(result.outcome).toBe('ineligible');
    expect(result.preflightIssues).toEqual([expect.objectContaining({ code: 'RESUME_OPERATION_NOT_FOUND' })]);
    expect(repository.register).not.toHaveBeenCalled();
    expect(repository.resume).not.toHaveBeenCalled();
    expect(bridge.bridge).not.toHaveBeenCalled();
  });
});

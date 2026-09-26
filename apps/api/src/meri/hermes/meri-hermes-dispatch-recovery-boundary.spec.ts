import { Buffer } from 'node:buffer';
import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestMaterialV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  matchesMeriHermesRecoveryNativeRequestV1,
  mintMeriHermesRecoveryReceiptV1,
  verifyMeriHermesRecoveryCommandV1,
  type MeriHermesRecoveryCommandKeyV1,
  type MeriHermesRecoveryReceiptKeyV1,
} from './meri-hermes-dispatch-recovery.contract.js';
import {
  MeriHermesDispatchRecoveryBoundaryV1,
  type MeriHermesDispatchRecoveryBoundaryDependenciesV1,
  type MeriHermesVerifiedRecoveryPersistenceV1,
} from './meri-hermes-dispatch-recovery-boundary.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const SCOPE = 'tenant:' + TENANT + ':user:' + ACTOR;
const WORKER_RUN = 'worker-run-recovery-boundary-1';
const STARTED_AT = '1790366300000000';
const OBSERVED_AT = '1790366301000000';
const VERIFIED_AT = '1790366302000000';
const OPERATION = '55555555-5555-4555-8555-555555555555';
const NONCE = Buffer.alloc(16, 51).toString('base64url');

const MATERIAL: MeriDispatchRequestMaterialV2 = {
  metadata: {
    version: 2,
    tenantId: TENANT,
    actorType: 'user',
    actorId: ACTOR,
    meriAudience: 'private',
    clientId: null,
    workspaceId: null,
    scopeId: SCOPE,
    conversationId: CONVERSATION,
    userMessageId: '66666666-6666-4666-8666-666666666666',
    runId: RUN,
    idempotencyKey: 'phase4-recovery-boundary',
    conversationEpoch: 2,
    workerAudience: 'meri-hermes-scope-worker',
    workerIngressId: 'private-ingress-a',
    workerGeneration: 'worker-generation-a',
    workerCredentialId: 'worker-credential-a',
    authorizationVersion: 'authorization-v8',
    authorizationPolicyVersion: 'policy-v8',
    grantVersion: 'grant-v4',
    catalogDigest: 'a'.repeat(64),
    toolViewDigest: 'b'.repeat(64),
    sessionHeaderKeyId: 'session-key-a',
    claimNotAfterEpochMicros: '1790366400000000',
    deliveryNotAfterEpochMicros: '1790366460000000',
    workerCredentialNotAfterEpochMicros: '1790366460000000',
    reconciliationNotAfterEpochMicros: '1790456460000000',
    retainUntilEpochMicros: '1790546460000000',
  },
  sourceMessage: { body: 'recover exact run', metadata: {} },
  bodyBytes: Buffer.from('{"input":"recover"}'),
  sessionKeyHeaderValue: SCOPE + ':conversation:' + CONVERSATION + ':e2',
  sessionHeaderHmacKey: Buffer.alloc(32, 9),
};
const IDENTITY = createMeriDispatchRequestIdentityV2(MATERIAL);
const BINDING = {
  tenantId: TENANT,
  workerAudience: IDENTITY.workerAudience,
  workerIngressId: IDENTITY.workerIngressId,
  workerGeneration: IDENTITY.workerGeneration,
  workerCredentialId: IDENTITY.workerCredentialId,
};
const COMMAND_KEY: MeriHermesRecoveryCommandKeyV1 = {
  purpose: MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  keyId: 'command-key-a',
  ...BINDING,
  secret: Buffer.alloc(32, 61),
  notBeforeEpochMicros: '1790366200000000',
  notAfterEpochMicros: '1790456400000000',
};
const RECEIPT_KEY: MeriHermesRecoveryReceiptKeyV1 = {
  purpose: MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  keyId: 'receipt-key-a',
  ...BINDING,
  secret: Buffer.alloc(32, 62),
  notBeforeEpochMicros: '1790366200000000',
  notAfterEpochMicros: '1790456400000000',
};

function dependencies(options: {
  observation?: 'run_nonterminal' | 'run_terminal' | 'not_found' | 'stop_accepted';
  action?: 'status' | 'stop';
  transportFailure?: boolean;
  mutateReceipt?: boolean;
  persistence?: 'inserted' | 'exact_replay' | 'conflict' | 'UNKNOWN';
  commandKey?: MeriHermesRecoveryCommandKeyV1;
  receiptKey?: MeriHermesRecoveryReceiptKeyV1;
} = {}) {
  const persisted: MeriHermesVerifiedRecoveryPersistenceV1[] = [];
  const times = [STARTED_AT, VERIFIED_AT];
  const commandKey = options.commandKey ?? COMMAND_KEY;
  const receiptKey = options.receiptKey ?? RECEIPT_KEY;
  const observation = options.observation ?? 'run_nonterminal';
  const workerStatus =
    observation === 'run_terminal' ? 'completed'
      : observation === 'run_nonterminal' ? 'running' : null;
  const nativeResponseBodyBytes =
    observation === 'not_found'
      ? Buffer.from('{"error":"not found"}')
      : observation === 'stop_accepted'
        ? Buffer.from('{"accepted":true}')
        : Buffer.from(JSON.stringify({ run_id: WORKER_RUN, status: workerStatus }));
  const nativeHttpStatus =
    observation === 'not_found' ? 404 : observation === 'stop_accepted' ? 202 : 200;
  const deps: MeriHermesDispatchRecoveryBoundaryDependenciesV1 = {
    resolveContext: jest.fn(async () => ({ identity: IDENTITY, workerRunId: WORKER_RUN })),
    readDbNowEpochMicros: jest.fn(async () => times.shift() ?? VERIFIED_AT),
    resolveCommandKey: jest.fn(async () => commandKey),
    resolveReceiptKey: jest.fn(async () => receiptKey),
    transport: {
      execute: jest.fn(async (request) => {
        if (options.transportFailure) throw new Error('lost response');
        const command = verifyMeriHermesRecoveryCommandV1(
          request.commandToken,
          IDENTITY,
          WORKER_RUN,
          commandKey,
          STARTED_AT,
        );
        if (!command) throw new Error('command did not verify');
        const expectedBody = options.action === 'stop' ? Buffer.from('{}') : Buffer.alloc(0);
        expect(Buffer.from(request.nativeBodyBytes)).toEqual(expectedBody);
        expect(matchesMeriHermesRecoveryNativeRequestV1(
          command,
          options.action === 'stop' ? 'POST' : 'GET',
          options.action === 'stop'
            ? '/v1/runs/' + WORKER_RUN + '/stop'
            : '/v1/runs/' + WORKER_RUN,
          request.nativeBodyBytes,
        )).toBe(true);
        let receiptToken = mintMeriHermesRecoveryReceiptV1({
          commandToken: request.commandToken,
          command,
          observation,
          workerStatus,
          nativeHttpStatus,
          nativeResponseBodyBytes,
          observedAtEpochMicros: OBSERVED_AT,
        }, receiptKey);
        if (options.mutateReceipt) {
          receiptToken = receiptToken.slice(0, -1) + (receiptToken.endsWith('A') ? 'B' : 'A');
        }
        return { receiptToken, nativeHttpStatus, nativeResponseBodyBytes };
      }),
    },
    persistence: {
      persistVerified: jest.fn(async (value) => {
        persisted.push(value);
        if (options.persistence === 'conflict' || options.persistence === 'UNKNOWN') {
          throw new Error('persistence unavailable');
        }
        return { kind: options.persistence === 'exact_replay' ? 'replayed' : 'inserted' } as const;
      }),
    },
  };
  return { deps, persisted, nativeResponseBodyBytes };
}

function input(action: 'status' | 'stop' = 'status') {
  return {
    tenantId: TENANT,
    runId: RUN,
    action,
    operationId: OPERATION,
    attemptNonce: NONCE,
    nativeBodyBytes: action === 'status' ? Buffer.alloc(0) : Buffer.from('{}'),
  } as const;
}

describe('dormant Phase 4 dispatch recovery boundary', () => {
  test('persists a verified exact observation and returns its nonterminal disposition', async () => {
    const { deps, persisted, nativeResponseBodyBytes } = dependencies();
    const boundary = new MeriHermesDispatchRecoveryBoundaryV1(deps);

    await expect(boundary.recover(input())).resolves.toMatchObject({
      version: 1,
      kind: 'nonterminal',
      receipt: { observation: 'run_nonterminal', workerStatus: 'running' },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      identity: IDENTITY,
      workerRunId: WORKER_RUN,
      commandKey: { keyId: COMMAND_KEY.keyId },
      receiptKey: { keyId: RECEIPT_KEY.keyId },
      verifiedCommand: { operationId: OPERATION, attemptNonce: NONCE, keyId: COMMAND_KEY.keyId },
      verifiedReceipt: { keyId: RECEIPT_KEY.keyId, observation: 'run_nonterminal' },
    });
    expect(Buffer.from(persisted[0]!.nativeResponseBodyBytes))
      .toEqual(nativeResponseBodyBytes);
    expect(persisted[0]!.nativeResponseBodyBytes).not.toBe(nativeResponseBodyBytes);
  });

  test('accepts only a signed terminal observation as terminal', async () => {
    const { deps } = dependencies({ observation: 'run_terminal' });
    const boundary = new MeriHermesDispatchRecoveryBoundaryV1(deps);
    await expect(boundary.recover(input())).resolves.toMatchObject({
      kind: 'terminal',
      receipt: { observation: 'run_terminal', workerStatus: 'completed' },
    });
  });

  test('keeps not_found UNKNOWN and stop_accepted nonterminal', async () => {
    const missing = dependencies({ observation: 'not_found' });
    await expect(new MeriHermesDispatchRecoveryBoundaryV1(missing.deps).recover(input()))
      .resolves.toEqual({ version: 1, kind: 'UNKNOWN', reason: 'absence_unproven' });
    expect(missing.persisted).toHaveLength(1);

    const stopped = dependencies({ action: 'stop', observation: 'stop_accepted' });
    await expect(new MeriHermesDispatchRecoveryBoundaryV1(stopped.deps).recover(input('stop')))
      .resolves.toMatchObject({
        kind: 'nonterminal',
        receipt: { observation: 'stop_accepted', workerStatus: null },
      });
  });

  test('keeps lost transport and invalid receipts UNKNOWN and does not persist them', async () => {
    const lost = dependencies({ transportFailure: true });
    await expect(new MeriHermesDispatchRecoveryBoundaryV1(lost.deps).recover(input()))
      .resolves.toEqual({ version: 1, kind: 'UNKNOWN', reason: 'transport_unconfirmed' });
    expect(lost.persisted).toHaveLength(0);

    const tampered = dependencies({ mutateReceipt: true });
    await expect(new MeriHermesDispatchRecoveryBoundaryV1(tampered.deps).recover(input()))
      .resolves.toEqual({ version: 1, kind: 'UNKNOWN', reason: 'receipt_unverified' });
    expect(tampered.persisted).toHaveLength(0);
  });

  test('fails closed on persistence conflict and exact replay is idempotent', async () => {
    const conflict = dependencies({ persistence: 'conflict' });
    await expect(new MeriHermesDispatchRecoveryBoundaryV1(conflict.deps).recover(input()))
      .resolves.toEqual({ version: 1, kind: 'UNKNOWN', reason: 'persistence_unconfirmed' });
    const replay = dependencies({ persistence: 'exact_replay' });
    await expect(new MeriHermesDispatchRecoveryBoundaryV1(replay.deps).recover(input()))
      .resolves.toMatchObject({ kind: 'nonterminal' });
  });

  test('rejects wrong authoritative context, expired key windows, and same-secret keys', async () => {
    const wrong = dependencies();
    (wrong.deps.resolveContext as jest.Mock).mockResolvedValue({
      identity: { ...IDENTITY, tenantId: '99999999-9999-4999-8999-999999999999' },
      workerRunId: WORKER_RUN,
    });
    await expect(new MeriHermesDispatchRecoveryBoundaryV1(wrong.deps).recover(input()))
      .resolves.toEqual({ version: 1, kind: 'UNKNOWN', reason: 'context_unavailable' });

    const expired = dependencies({
      commandKey: { ...COMMAND_KEY, notAfterEpochMicros: STARTED_AT },
    });
    await expect(new MeriHermesDispatchRecoveryBoundaryV1(expired.deps).recover(input()))
      .resolves.toEqual({ version: 1, kind: 'UNKNOWN', reason: 'window_unavailable' });

    const reused = dependencies({
      receiptKey: { ...RECEIPT_KEY, secret: COMMAND_KEY.secret },
    });
    await expect(new MeriHermesDispatchRecoveryBoundaryV1(reused.deps).recover(input()))
      .resolves.toEqual({ version: 1, kind: 'UNKNOWN', reason: 'key_unavailable' });
    expect(reused.deps.transport.execute).not.toHaveBeenCalled();
    expect(reused.persisted).toHaveLength(0);
  });

  test('copies caller bytes before await and never reads the process clock', async () => {
    const { deps } = dependencies({ action: 'stop', observation: 'stop_accepted' });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    (deps.resolveContext as jest.Mock).mockImplementation(async () => {
      await hold;
      return { identity: IDENTITY, workerRunId: WORKER_RUN };
    });
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('process clock must not be read');
    });
    try {
      const body = Buffer.from('{}');
      const pending = new MeriHermesDispatchRecoveryBoundaryV1(deps).recover({
        ...input('stop'),
        nativeBodyBytes: body,
      });
      body[0] = 0x5b;
      release();
      await expect(pending).resolves.toMatchObject({ kind: 'nonterminal' });
    } finally {
      clock.mockRestore();
    }
  });
});

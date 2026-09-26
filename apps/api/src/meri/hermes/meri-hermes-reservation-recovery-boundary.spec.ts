import { createHash, createHmac } from 'node:crypto';
import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestMaterialV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  type MeriHermesRecoveryCommandKeyV1,
  type MeriHermesRecoveryReceiptKeyV1,
} from './meri-hermes-dispatch-recovery.contract.js';
import {
  MeriHermesReservationRecoveryBoundaryV1,
  type MeriHermesReservationRecoveryBoundaryDependenciesV1,
  type MeriHermesVerifiedReservationRecoveryCommitV1,
} from './meri-hermes-reservation-recovery-boundary.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const RUN = '55555555-5555-4555-8555-555555555555';
const SCOPE = `tenant:${TENANT}:user:${ACTOR}`;
const DELIVERY = '1790366290000000';
const STARTED = '1790366300000000';
const OBSERVED = '1790366310000000';
const VERIFIED = '1790366320000000';
const OPERATION = '77777777-7777-4777-8777-777777777777';
const NONCE = Buffer.alloc(16, 33).toString('base64url');

const MATERIAL: MeriDispatchRequestMaterialV2 = {
  metadata: {
    version: 2, tenantId: TENANT, actorType: 'user', actorId: ACTOR,
    meriAudience: 'private', clientId: null, workspaceId: null, scopeId: SCOPE,
    conversationId: CONVERSATION,
    userMessageId: '44444444-4444-4444-8444-444444444444', runId: RUN,
    idempotencyKey: 'phase4-reservation-boundary', conversationEpoch: 3,
    workerAudience: 'meri-hermes-scope-worker', workerIngressId: 'private-ingress-a',
    workerGeneration: 'worker-image-sha256:2026',
    workerCredentialId: 'worker-credential-2026-09',
    authorizationVersion: 'authorization-v8', authorizationPolicyVersion: 'policy-v8',
    grantVersion: 'grant-v4', catalogDigest: 'a'.repeat(64), toolViewDigest: 'b'.repeat(64),
    sessionHeaderKeyId: 'dispatch-hmac-2026-09',
    claimNotAfterEpochMicros: '1790366250000000',
    deliveryNotAfterEpochMicros: DELIVERY,
    workerCredentialNotAfterEpochMicros: DELIVERY,
    reconciliationNotAfterEpochMicros: '1790456460000000',
    retainUntilEpochMicros: '1790546460000000',
  },
  sourceMessage: { body: 'recover this exact turn', metadata: { runtime: 'hermes' } },
  bodyBytes: Buffer.from('{"input":"recover"}', 'utf8'),
  sessionKeyHeaderValue: `${SCOPE}:conversation:${CONVERSATION}:e3`,
  sessionHeaderHmacKey: Buffer.alloc(32, 7),
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
  keyId: 'reservation-command-key-a', ...BINDING,
  secret: Buffer.alloc(32, 41),
  notBeforeEpochMicros: '1790366200000000',
  notAfterEpochMicros: '1790366500000000',
};
const RECEIPT_KEY: MeriHermesRecoveryReceiptKeyV1 = {
  purpose: MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  keyId: 'reservation-receipt-key-a', ...BINDING,
  secret: Buffer.alloc(32, 42),
  notBeforeEpochMicros: '1790366200000000',
  notAfterEpochMicros: '1790366500000000',
};

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function receiptFor(
  request: Parameters<
    MeriHermesReservationRecoveryBoundaryDependenciesV1['transport']['execute']
  >[0],
  outcome: 'reserved' | 'sealed_absent',
) {
  const body = outcome === 'reserved'
    ? Buffer.from('{"outcome":"reserved","workerRunId":"worker-run-late-1","workerStatus":"running"}')
    : Buffer.from(
      `{"outcome":"sealed_absent","sealedAtEpochMicros":"1790366305000000",` +
      `"retainUntilEpochMicros":"${IDENTITY.retainUntilEpochMicros}"}`,
    );
  const command = request.command;
  const claims = {
    version: 1,
    purpose: 'meri-hermes-reservation-receipt',
    keyId: RECEIPT_KEY.keyId,
    tenantId: command.tenantId,
    runId: command.runId,
    requestSha256: command.requestSha256,
    workerAudience: command.workerAudience,
    workerIngressId: command.workerIngressId,
    workerGeneration: command.workerGeneration,
    workerCredentialId: command.workerCredentialId,
    idempotencyKey: command.idempotencyKey,
    deliveryNotBeforeEpochMicros: command.deliveryNotBeforeEpochMicros,
    retainUntilEpochMicros: command.retainUntilEpochMicros,
    operationId: command.operationId,
    attemptNonce: command.attemptNonce,
    commandSha256: sha256(request.commandToken),
    nativeMethod: command.nativeMethod,
    nativePath: command.nativePath,
    nativeBodySha256: command.nativeBodySha256,
    nativeHttpStatus: 200,
    nativeResponseBodySha256: sha256(body),
    outcome,
    workerRunId: outcome === 'reserved' ? 'worker-run-late-1' : null,
    workerStatus: outcome === 'reserved' ? 'running' : null,
    sealedAtEpochMicros: outcome === 'sealed_absent' ? '1790366305000000' : null,
    observedAtEpochMicros: OBSERVED,
    notBeforeEpochMicros: command.notBeforeEpochMicros,
    notAfterEpochMicros: command.notAfterEpochMicros,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', RECEIPT_KEY.secret)
    .update('capiro.meri.phase4.reservation-receipt/v1\0', 'utf8')
    .update(`mhrqr1.${payload}`, 'ascii').digest('base64url');
  return { body, token: `mhrqr1.${payload}.${signature}` };
}

function dependencies(options: {
  outcome?: 'reserved' | 'sealed_absent';
  startedAt?: string;
  transportFailure?: boolean;
  mutateReceipt?: boolean;
  mutateBody?: boolean;
  commitMismatch?: boolean;
  commandKey?: MeriHermesRecoveryCommandKeyV1;
  receiptKey?: MeriHermesRecoveryReceiptKeyV1;
} = {}) {
  const outcome = options.outcome ?? 'reserved';
  const commandKey = options.commandKey ?? COMMAND_KEY;
  const receiptKey = options.receiptKey ?? RECEIPT_KEY;
  const persisted: MeriHermesVerifiedReservationRecoveryCommitV1[] = [];
  const times = [options.startedAt ?? STARTED, VERIFIED];
  const deps: MeriHermesReservationRecoveryBoundaryDependenciesV1 = {
    resolveContext: jest.fn(async () => ({
      identity: IDENTITY,
      state: 'prepared' as const,
      workerRunId: null,
      idempotencyKey: IDENTITY.idempotencyKey,
      deliveryNotBeforeEpochMicros: DELIVERY,
    })),
    readDbNowEpochMicros: jest.fn(async () => times.shift() ?? VERIFIED),
    resolveCommandKey: jest.fn(async () => commandKey),
    resolveReceiptKey: jest.fn(async () => receiptKey),
    transport: {
      execute: jest.fn(async (request) => {
        if (options.transportFailure) throw new Error('lost response');
        const signed = receiptFor(request, outcome);
        let token = signed.token;
        if (options.mutateReceipt) {
          token = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
        }
        const body = options.mutateBody
          ? Buffer.concat([signed.body, Buffer.from(' ')]) : signed.body;
        return {
          receiptToken: token,
          nativeHttpStatus: 200,
          nativeResponseBodyBytes: body,
        };
      }),
    },
    persistence: {
      commitVerified: jest.fn(async (value) => {
        persisted.push(value);
        if (options.commitMismatch) {
          return outcome === 'reserved'
            ? { kind: 'sealed_absent' as const }
            : { kind: 'bound_worker' as const, workerRunId: 'wrong-worker' };
        }
        return outcome === 'reserved'
          ? { kind: 'bound_worker' as const, workerRunId: 'worker-run-late-1' }
          : { kind: 'sealed_absent' as const };
      }),
    },
  };
  return { deps, persisted };
}

function input() {
  return { tenantId: TENANT, runId: RUN, operationId: OPERATION, attemptNonce: NONCE };
}

describe('dormant Phase 4 unknown-worker reservation recovery boundary', () => {
  test('commits a signed exact reservation as a late worker binding', async () => {
    const { deps, persisted } = dependencies();
    await expect(new MeriHermesReservationRecoveryBoundaryV1(deps).recover(input()))
      .resolves.toMatchObject({
        version: 1, kind: 'bound_worker', workerRunId: 'worker-run-late-1',
        receipt: { outcome: 'reserved', workerStatus: 'running' },
      });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      identity: IDENTITY,
      idempotencyKey: IDENTITY.idempotencyKey,
      deliveryNotBeforeEpochMicros: DELIVERY,
      commandKey: { keyId: COMMAND_KEY.keyId },
      receiptKey: { keyId: RECEIPT_KEY.keyId },
      verifiedCommand: { operationId: OPERATION, attemptNonce: NONCE },
      verifiedReceipt: { outcome: 'reserved', workerRunId: 'worker-run-late-1' },
    });
  });

  test('commits only a signed tombstone as sealed_absent', async () => {
    const { deps, persisted } = dependencies({ outcome: 'sealed_absent' });
    await expect(new MeriHermesReservationRecoveryBoundaryV1(deps).recover(input()))
      .resolves.toMatchObject({
        version: 1, kind: 'sealed_absent', receipt: { outcome: 'sealed_absent' },
      });
    expect(persisted).toHaveLength(1);
  });

  test('does not query before the authoritative delivery cutoff', async () => {
    const { deps, persisted } = dependencies({ startedAt: '1790366289999999' });
    await expect(new MeriHermesReservationRecoveryBoundaryV1(deps).recover(input()))
      .resolves.toEqual({ version: 1, kind: 'UNKNOWN', reason: 'window_unavailable' });
    expect(deps.transport.execute).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(0);
  });

  test('rejects mutable-context substitutions before transport', async () => {
    for (const changed of [
      { state: 'claimed', workerRunId: 'already-bound' },
      { idempotencyKey: 'different-key' },
      { deliveryNotBeforeEpochMicros: '1790366290000001' },
    ]) {
      const { deps, persisted } = dependencies();
      (deps.resolveContext as jest.Mock).mockResolvedValue({
        identity: IDENTITY,
        state: 'prepared',
        workerRunId: null,
        idempotencyKey: IDENTITY.idempotencyKey,
        deliveryNotBeforeEpochMicros: DELIVERY,
        ...changed,
      });
      await expect(new MeriHermesReservationRecoveryBoundaryV1(deps).recover(input()))
        .resolves.toEqual({ version: 1, kind: 'UNKNOWN', reason: 'context_unavailable' });
      expect(deps.transport.execute).not.toHaveBeenCalled();
      expect(persisted).toHaveLength(0);
    }
  });

  test('keeps lost, tampered, byte-substituted, and mismatched commits UNKNOWN', async () => {
    const cases = [
      { option: { transportFailure: true }, reason: 'transport_unconfirmed' },
      { option: { mutateReceipt: true }, reason: 'receipt_unverified' },
      { option: { mutateBody: true }, reason: 'receipt_unverified' },
      { option: { commitMismatch: true }, reason: 'persistence_unconfirmed' },
    ] as const;
    for (const row of cases) {
      const { deps } = dependencies(row.option);
      await expect(new MeriHermesReservationRecoveryBoundaryV1(deps).recover(input()))
        .resolves.toEqual({ version: 1, kind: 'UNKNOWN', reason: row.reason });
    }
  });

  test('rejects shared secrets and copies input without reading the process clock', async () => {
    const shared = dependencies({
      receiptKey: { ...RECEIPT_KEY, secret: COMMAND_KEY.secret },
    });
    await expect(new MeriHermesReservationRecoveryBoundaryV1(shared.deps).recover(input()))
      .resolves.toEqual({ version: 1, kind: 'UNKNOWN', reason: 'key_unavailable' });
    expect(shared.deps.transport.execute).not.toHaveBeenCalled();

    const { deps } = dependencies();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    (deps.resolveContext as jest.Mock).mockImplementation(async () => {
      await hold;
      return {
        identity: IDENTITY, state: 'prepared', workerRunId: null,
        idempotencyKey: IDENTITY.idempotencyKey,
        deliveryNotBeforeEpochMicros: DELIVERY,
      };
    });
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('process clock must not be read');
    });
    try {
      const mutable = input();
      const pending = new MeriHermesReservationRecoveryBoundaryV1(deps).recover(mutable);
      mutable.tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      release();
      await expect(pending).resolves.toMatchObject({ kind: 'bound_worker' });
    } finally {
      clock.mockRestore();
    }
  });
});

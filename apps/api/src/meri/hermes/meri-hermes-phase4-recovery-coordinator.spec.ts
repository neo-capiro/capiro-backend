import { randomUUID } from 'node:crypto';
import {
  MeriHermesPhase4RecoveryCoordinatorV1,
  type MeriHermesPhase4RecoveryCandidateV1,
} from './meri-hermes-phase4-recovery-coordinator.js';

const nonce = (byte: number) => Buffer.alloc(16, byte).toString('base64url');

function reservation(byte = 1): MeriHermesPhase4RecoveryCandidateV1 {
  return Object.freeze({
    kind: 'reservation',
    tenantId: randomUUID(),
    runId: randomUUID(),
    claimToken: randomUUID(),
    operationId: randomUUID(),
    attemptNonce: nonce(byte),
  });
}

function dispatch(
  action: 'status' | 'stop',
  byte = 2,
): MeriHermesPhase4RecoveryCandidateV1 {
  return Object.freeze({
    kind: 'dispatch',
    tenantId: randomUUID(),
    runId: randomUUID(),
    action,
    claimToken: randomUUID(),
    operationId: randomUUID(),
    attemptNonce: nonce(byte),
    nativeBodyBytes: action === 'status' ? new Uint8Array() : Uint8Array.from(Buffer.from('{}')),
  });
}

interface TestDependencies {
  enabled: jest.Mock<boolean, []>;
  claimBatch: jest.Mock<Promise<readonly MeriHermesPhase4RecoveryCandidateV1[]>, [number]>;
  reservationBoundary: { recover: jest.Mock<Promise<any>, [any]> };
  dispatchBoundary: { recover: jest.Mock<Promise<any>, [any]> };
  recordOutcome: jest.Mock<Promise<'recorded' | 'replayed'>, [any, any]>;
}

function dependencies(
  candidates: readonly MeriHermesPhase4RecoveryCandidateV1[] = [],
): TestDependencies {
  return {
    enabled: jest.fn(() => true),
    claimBatch: jest.fn(async (_limit: number) => candidates),
    reservationBoundary: {
      recover: jest.fn(async (_input: any) => Object.freeze({
        version: 1,
        kind: 'sealed_absent',
        receipt: Object.freeze({ outcome: 'sealed_absent' }),
      })),
    },
    dispatchBoundary: {
      recover: jest.fn(async (_input: any) => Object.freeze({
        version: 1,
        kind: 'terminal',
        receipt: Object.freeze({ observation: 'run_terminal' }),
      })),
    },
    recordOutcome: jest.fn(async (_candidate: any, _observation: any) => 'recorded' as const),
  };
}

describe('dormant Phase 4 recovery coordinator', () => {
  test('is default-off and performs no discovery or recovery while disabled', async () => {
    const deps = dependencies([reservation()]);
    deps.enabled.mockReturnValue(false);
    const result = await new MeriHermesPhase4RecoveryCoordinatorV1(deps).runOnce();
    expect(result).toEqual({ version: 1, kind: 'disabled' });
    expect(deps.claimBatch).not.toHaveBeenCalled();
    expect(deps.reservationBoundary.recover).not.toHaveBeenCalled();
    expect(deps.dispatchBoundary.recover).not.toHaveBeenCalled();
  });

  test('claims a bounded batch and processes reservation, Stop, then status deterministically', async () => {
    const status = dispatch('status', 3);
    const stop = dispatch('stop', 4);
    const lookup = reservation(5);
    const deps = dependencies([status, stop, lookup]);
    const order: string[] = [];
    deps.reservationBoundary.recover.mockImplementation(async () => {
      order.push('reservation');
      return { version: 1, kind: 'sealed_absent', receipt: { outcome: 'sealed_absent' } };
    });
    deps.dispatchBoundary.recover.mockImplementation(async (input: { action: string }) => {
      order.push(input.action);
      return { version: 1, kind: 'terminal', receipt: { observation: 'run_terminal' } };
    });

    const result = await new MeriHermesPhase4RecoveryCoordinatorV1(deps, 3).runOnce();
    expect(deps.claimBatch).toHaveBeenCalledWith(3);
    expect(order).toEqual(['reservation', 'stop', 'status']);
    expect(result).toEqual({
      version: 1,
      kind: 'completed',
      claimed: 3,
      processed: 3,
      verified: 3,
      unknown: 0,
      boundaryFailures: 0,
      invalid: 0,
      outcomeUnconfirmed: 0,
    });
    expect(deps.recordOutcome).toHaveBeenCalledTimes(3);
  });

  test('does not overlap one coordinator instance', async () => {
    let release!: (value: readonly MeriHermesPhase4RecoveryCandidateV1[]) => void;
    const pending = new Promise<readonly MeriHermesPhase4RecoveryCandidateV1[]>((resolve) => {
      release = resolve;
    });
    const deps = dependencies();
    deps.claimBatch.mockImplementation(() => pending);
    const coordinator = new MeriHermesPhase4RecoveryCoordinatorV1(deps);
    const first = coordinator.runOnce();
    await Promise.resolve();
    await expect(coordinator.runOnce()).resolves.toEqual({ version: 1, kind: 'already_running' });
    release([]);
    await expect(first).resolves.toMatchObject({ kind: 'completed', claimed: 0 });
    expect(deps.claimBatch).toHaveBeenCalledTimes(1);
  });

  test('retains UNKNOWN and boundary failures as recorded nonterminal outcomes', async () => {
    const lookup = reservation(6);
    const stop = dispatch('stop', 7);
    const deps = dependencies([lookup, stop]);
    deps.reservationBoundary.recover.mockResolvedValue({
      version: 1,
      kind: 'UNKNOWN',
      reason: 'transport_unconfirmed',
    });
    deps.dispatchBoundary.recover.mockRejectedValue(new Error('transport unavailable'));

    await expect(new MeriHermesPhase4RecoveryCoordinatorV1(deps).runOnce()).resolves.toEqual({
      version: 1,
      kind: 'completed',
      claimed: 2,
      processed: 2,
      verified: 0,
      unknown: 1,
      boundaryFailures: 1,
      invalid: 0,
      outcomeUnconfirmed: 0,
    });
    expect(deps.recordOutcome.mock.calls[0]![1]).toMatchObject({
      kind: 'reservation',
      result: { kind: 'UNKNOWN', reason: 'transport_unconfirmed' },
    });
    expect(deps.recordOutcome.mock.calls[1]![1]).toEqual({
      kind: 'boundary_failure',
      category: 'dispatch_unavailable',
    });
  });

  test('copies caller-owned Stop bytes before recovery and outcome recording', async () => {
    const mutable = dispatch('stop', 8) as Extract<
      MeriHermesPhase4RecoveryCandidateV1,
      { kind: 'dispatch' }
    >;
    const deps = dependencies([mutable]);
    deps.dispatchBoundary.recover.mockImplementation(async (input: { nativeBodyBytes: Uint8Array }) => {
      expect(Buffer.from(input.nativeBodyBytes).toString()).toBe('{}');
      mutable.nativeBodyBytes.fill(0x78);
      return { version: 1, kind: 'terminal', receipt: { observation: 'run_terminal' } };
    });
    await new MeriHermesPhase4RecoveryCoordinatorV1(deps).runOnce();
    const recorded = deps.recordOutcome.mock.calls[0]![0] as Extract<
      MeriHermesPhase4RecoveryCandidateV1,
      { kind: 'dispatch' }
    >;
    expect(Buffer.from(recorded.nativeBodyBytes).toString()).toBe('{}');
  });

  test('rejects an over-limit source and skips malformed claimed rows', async () => {
    const over = dependencies(Array.from({ length: 3 }, (_, index) => reservation(index + 10)));
    await expect(new MeriHermesPhase4RecoveryCoordinatorV1(over, 2).runOnce()).resolves.toEqual({
      version: 1,
      kind: 'source_invalid',
      claimed: 3,
    });
    expect(over.reservationBoundary.recover).not.toHaveBeenCalled();

    const valid = dispatch('status', 20);
    const malformed = { ...reservation(21), extra: true } as never;
    const mixed = dependencies([malformed, valid]);
    await expect(new MeriHermesPhase4RecoveryCoordinatorV1(mixed).runOnce()).resolves.toMatchObject({
      kind: 'completed',
      claimed: 2,
      processed: 1,
      invalid: 1,
    });
    expect(mixed.dispatchBoundary.recover).toHaveBeenCalledTimes(1);

    const malformedStop = {
      ...dispatch('stop', 23),
      nativeBodyBytes: Uint8Array.from(Buffer.from('{"force":true}')),
    } as never;
    const stopBatch = dependencies([malformedStop]);
    await expect(new MeriHermesPhase4RecoveryCoordinatorV1(stopBatch).runOnce())
      .resolves.toMatchObject({ kind: 'completed', processed: 0, invalid: 1 });
    expect(stopBatch.dispatchBoundary.recover).not.toHaveBeenCalled();
    expect(stopBatch.recordOutcome).not.toHaveBeenCalled();
  });

  test('rejects a duplicate durable operation before either copy reaches a boundary', async () => {
    const candidate = reservation(22);
    const duplicate = dependencies([candidate, { ...candidate }]);
    await expect(new MeriHermesPhase4RecoveryCoordinatorV1(duplicate).runOnce()).resolves.toEqual({
      version: 1,
      kind: 'source_invalid',
      claimed: 2,
    });
    expect(duplicate.reservationBoundary.recover).not.toHaveBeenCalled();
    expect(duplicate.recordOutcome).not.toHaveBeenCalled();
  });

  test('continues the bounded batch when durable outcome recording is uncertain', async () => {
    const deps = dependencies([reservation(30), dispatch('status', 31)]);
    deps.recordOutcome.mockRejectedValueOnce(new Error('commit uncertain'));
    await expect(new MeriHermesPhase4RecoveryCoordinatorV1(deps).runOnce()).resolves.toMatchObject({
      kind: 'completed',
      processed: 2,
      verified: 2,
      outcomeUnconfirmed: 1,
    });
    expect(deps.recordOutcome).toHaveBeenCalledTimes(2);
  });

  test('requires explicit ports and a bounded safe integer batch size', () => {
    const deps = dependencies();
    expect(() => new MeriHermesPhase4RecoveryCoordinatorV1({} as never)).toThrow(
      'requires explicit authority ports',
    );
    expect(() => new MeriHermesPhase4RecoveryCoordinatorV1(deps, 0)).toThrow('batch limit is invalid');
    expect(() => new MeriHermesPhase4RecoveryCoordinatorV1(deps, 101)).toThrow('batch limit is invalid');
  });
});

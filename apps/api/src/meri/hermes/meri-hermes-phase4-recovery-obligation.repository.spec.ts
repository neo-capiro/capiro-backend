import { randomUUID } from 'node:crypto';
import {
  MeriHermesPhase4RecoveryObligationRepositoryV1,
  MeriHermesPhase4RecoveryObligationSourceError,
  MeriHermesPhase4RecoveryOutcomeConflictError,
  type MeriHermesPhase4RecoveryCallerTransactionV1,
} from './meri-hermes-phase4-recovery-obligation.repository.js';
import type {
  MeriHermesPhase4DispatchCandidateV1,
  MeriHermesPhase4ReservationCandidateV1,
} from './meri-hermes-phase4-recovery-coordinator.js';

const ownerId = randomUUID();
const nonce = Buffer.alloc(16, 7).toString('base64url');

function reservationRow() {
  const operationId = randomUUID();
  return {
    obligation_id: operationId,
    tenant_id: randomUUID(),
    run_id: randomUUID(),
    obligation_kind: 'reservation',
    action: null,
    claim_token: randomUUID(),
    operation_id: operationId,
    attempt_nonce: nonce,
    native_body_bytes: new Uint8Array(),
  };
}

function database(rows: readonly object[]) {
  const query = jest.fn(async (_sql: string, _parameters: readonly unknown[]) => rows);
  return {
    query,
    db: {
      withRecoveryCallerTransaction: async <T>(
        run: (tx: MeriHermesPhase4RecoveryCallerTransactionV1) => Promise<T>,
      ) => run({ query } as unknown as MeriHermesPhase4RecoveryCallerTransactionV1),
    },
  };
}

describe('Phase 4 recovery obligation repository', () => {
  test('claims a bounded fixed-SQL batch and copies returned body bytes', async () => {
    const row = {
      ...reservationRow(),
      obligation_kind: 'dispatch',
      action: 'stop',
      native_body_bytes: Uint8Array.from(Buffer.from('{}')),
    };
    const fixture = database([row]);
    const repo = new MeriHermesPhase4RecoveryObligationRepositoryV1(fixture.db, ownerId, 30_000_000n);
    const candidates = await repo.claimBatch(20);
    expect(fixture.query).toHaveBeenCalledWith(expect.stringContaining(
      'public.meri_phase4_claim_recovery_obligations'), [ownerId, 20, '30000000']);
    expect(candidates).toEqual([{
      kind: 'dispatch',
      tenantId: row.tenant_id,
      runId: row.run_id,
      action: 'stop',
      claimToken: row.claim_token,
      operationId: row.operation_id,
      attemptNonce: nonce,
      nativeBodyBytes: Uint8Array.from(Buffer.from('{}')),
    }]);
    row.native_body_bytes.fill(0x78);
    const candidate = candidates[0] as MeriHermesPhase4DispatchCandidateV1;
    expect(Buffer.from(candidate.nativeBodyBytes).toString()).toBe('{}');
  });

  test('fails closed on malformed, duplicate, or over-limit authority output', async () => {
    const malformed = database([{ ...reservationRow(), attempt_nonce: 'not-canonical' }]);
    await expect(new MeriHermesPhase4RecoveryObligationRepositoryV1(
      malformed.db, ownerId, 1_000_000,
    ).claimBatch(1)).rejects.toBeInstanceOf(MeriHermesPhase4RecoveryObligationSourceError);

    const row = reservationRow();
    const duplicate = database([row, { ...row }]);
    await expect(new MeriHermesPhase4RecoveryObligationRepositoryV1(
      duplicate.db, ownerId, 1_000_000,
    ).claimBatch(2)).rejects.toBeInstanceOf(MeriHermesPhase4RecoveryObligationSourceError);

    const over = database([reservationRow(), reservationRow()]);
    await expect(new MeriHermesPhase4RecoveryObligationRepositoryV1(
      over.db, ownerId, 1_000_000,
    ).claimBatch(1)).rejects.toBeInstanceOf(MeriHermesPhase4RecoveryObligationSourceError);

    const invalidStop = database([{
      ...reservationRow(), obligation_kind: 'dispatch', action: 'stop',
      native_body_bytes: Uint8Array.from(Buffer.from('{"force":true}')),
    }]);
    await expect(new MeriHermesPhase4RecoveryObligationRepositoryV1(
      invalidStop.db, ownerId, 1_000_000,
    ).claimBatch(1)).rejects.toBeInstanceOf(MeriHermesPhase4RecoveryObligationSourceError);
  });

  test('records UNKNOWN without accepting a receipt identity', async () => {
    const candidate: MeriHermesPhase4ReservationCandidateV1 = {
      kind: 'reservation',
      tenantId: randomUUID(),
      runId: randomUUID(),
      claimToken: randomUUID(),
      operationId: randomUUID(),
      attemptNonce: nonce,
    };
    const fixture = database([{ record_result: 'recorded' }]);
    const repo = new MeriHermesPhase4RecoveryObligationRepositoryV1(fixture.db, ownerId, '30000000');
    await expect(repo.recordOutcome(candidate, {
      kind: 'reservation',
      result: { version: 1, kind: 'UNKNOWN', reason: 'transport_unconfirmed' },
    })).resolves.toBe('recorded');
    const parameters = fixture.query.mock.calls[0]![1] as unknown[];
    expect(parameters.slice(0, 6)).toEqual([
      candidate.tenantId, candidate.operationId, ownerId, candidate.claimToken,
      candidate.operationId, candidate.attemptNonce,
    ]);
    expect(parameters.slice(6)).toEqual(['unknown', null, null, 'transport_unconfirmed']);
  });

  test('requires a verified receipt to bind the exact candidate operation and action', async () => {
    const candidate: MeriHermesPhase4DispatchCandidateV1 = {
      kind: 'dispatch',
      tenantId: randomUUID(),
      runId: randomUUID(),
      action: 'stop',
      claimToken: randomUUID(),
      operationId: randomUUID(),
      attemptNonce: nonce,
      nativeBodyBytes: Uint8Array.from(Buffer.from('{}')),
    };
    const fixture = database([{ record_result: 'replayed' }]);
    const repo = new MeriHermesPhase4RecoveryObligationRepositoryV1(fixture.db, ownerId, 30_000_000);
    const receipt = {
      tenantId: candidate.tenantId,
      runId: candidate.runId,
      operationId: candidate.operationId,
      attemptNonce: candidate.attemptNonce,
      action: 'stop',
      observation: 'stop_accepted',
    };
    await expect(repo.recordOutcome(candidate, {
      kind: 'dispatch', action: 'stop',
      result: { version: 1, kind: 'nonterminal', receipt } as never,
    })).resolves.toBe('replayed');
    const parameters = fixture.query.mock.calls[0]![1] as unknown[];
    expect(parameters.slice(6)).toEqual([
      'dispatch_nonterminal', candidate.operationId, candidate.attemptNonce, 'stop_accepted',
    ]);

    await expect(repo.recordOutcome(candidate, {
      kind: 'dispatch', action: 'stop',
      result: {
        version: 1,
        kind: 'nonterminal',
        receipt: { ...receipt, operationId: randomUUID() },
      } as never,
    })).rejects.toBeInstanceOf(MeriHermesPhase4RecoveryOutcomeConflictError);
    expect(fixture.query).toHaveBeenCalledTimes(1);
  });

  test('maps a bound worker to the signed reserved receipt outcome', async () => {
    const candidate: MeriHermesPhase4ReservationCandidateV1 = {
      kind: 'reservation', tenantId: randomUUID(), runId: randomUUID(),
      claimToken: randomUUID(),
      operationId: randomUUID(), attemptNonce: nonce,
    };
    const workerRunId = 'worker-run-1';
    const fixture = database([{ record_result: 'recorded' }]);
    const repo = new MeriHermesPhase4RecoveryObligationRepositoryV1(fixture.db, ownerId, 30_000_000);
    const receipt = {
      tenantId: candidate.tenantId,
      runId: candidate.runId,
      operationId: candidate.operationId,
      attemptNonce: candidate.attemptNonce,
      outcome: 'reserved',
      workerRunId,
    };
    await expect(repo.recordOutcome(candidate, {
      kind: 'reservation',
      result: { version: 1, kind: 'bound_worker', workerRunId, receipt } as never,
    })).resolves.toBe('recorded');
    expect(fixture.query.mock.calls[0]![1].slice(6)).toEqual([
      'reservation_bound_worker', candidate.operationId, candidate.attemptNonce, 'reserved',
    ]);
  });

  test('rejects cross-purpose failures and invalid repository configuration', async () => {
    const candidate: MeriHermesPhase4ReservationCandidateV1 = {
      kind: 'reservation', tenantId: randomUUID(), runId: randomUUID(),
      claimToken: randomUUID(),
      operationId: randomUUID(), attemptNonce: nonce,
    };
    const fixture = database([{ record_result: 'recorded' }]);
    const repo = new MeriHermesPhase4RecoveryObligationRepositoryV1(fixture.db, ownerId, 30_000_000);
    await expect(repo.recordOutcome(candidate, {
      kind: 'boundary_failure', category: 'dispatch_unavailable',
    })).rejects.toBeInstanceOf(MeriHermesPhase4RecoveryOutcomeConflictError);
    await expect(repo.recordOutcome(candidate, {
      kind: 'reservation',
      result: { version: 1, kind: 'UNKNOWN', reason: 'caller_selected_text' },
    } as never)).rejects.toBeInstanceOf(MeriHermesPhase4RecoveryOutcomeConflictError);
    await expect(repo.recordOutcome(candidate, {
      kind: 'reservation',
      result: {
        version: 1, kind: 'not_a_result',
        receipt: {
          tenantId: candidate.tenantId, runId: candidate.runId,
          operationId: candidate.operationId, attemptNonce: candidate.attemptNonce,
          outcome: 'sealed_absent',
        },
      },
    } as never)).rejects.toBeInstanceOf(MeriHermesPhase4RecoveryOutcomeConflictError);
    expect(fixture.query).not.toHaveBeenCalled();
    expect(() => new MeriHermesPhase4RecoveryObligationRepositoryV1(
      fixture.db, 'not-a-uuid', 30_000_000,
    )).toThrow('configuration is invalid');
    expect(() => new MeriHermesPhase4RecoveryObligationRepositoryV1(
      fixture.db, ownerId, 999,
    )).toThrow('configuration is invalid');
  });
});

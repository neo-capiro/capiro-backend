import type { ClientObjectiveRevision, Prisma } from '@prisma/client';
import {
  appendObjectiveReadyIntent,
  objectiveRevisionSnapshotHash,
  OBJECTIVE_WORK_BLOCKER,
  OBJECTIVE_WORK_PURPOSE,
} from './objective-work-intent.js';

const revision: ClientObjectiveRevision = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  clientId: '33333333-3333-4333-8333-333333333333',
  objectiveId: '44444444-4444-4444-8444-444444444444',
  actorUserId: '55555555-5555-4555-8555-555555555555',
  version: 2,
  operation: 'confirm_ready',
  createdAt: new Date('2026-10-15T00:00:00Z'),
  snapshot: {
    id: '44444444-4444-4444-8444-444444444444',
    clientId: '33333333-3333-4333-8333-333333333333',
    version: 2,
    status: 'ready',
    outcome: 'Preserve authority',
    governmentProblem: 'Authority expires',
    askType: 'policy_authority',
    minimumWin: 'One year',
    limits: '',
  },
};

function fixture() {
  const row = {
    id: '66666666-6666-4666-8666-666666666666',
    tenantId: revision.tenantId,
    clientId: revision.clientId,
    objectiveId: revision.objectiveId,
    objectiveRevisionId: revision.id,
    objectiveVersion: revision.version,
    actorUserId: revision.actorUserId,
    purpose: OBJECTIVE_WORK_PURPOSE,
    state: 'pending',
    blockedReason: OBJECTIVE_WORK_BLOCKER,
    snapshotHash: objectiveRevisionSnapshotHash(revision.snapshot),
  };
  const query = jest
    .fn()
    .mockResolvedValueOnce([{ id: row.id }])
    .mockResolvedValue([row]);
  const tx = { $queryRaw: query } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>;
  return { row, query, tx };
}

describe('pending Objective ready intent (synthetic transaction adapter only)', () => {
  test('binds the actual saved revision and returns the checked durable identity', async () => {
    const { tx, query, row } = fixture();
    await expect(appendObjectiveReadyIntent(tx, revision)).resolves.toEqual({
      id: row.id,
      objectiveRevisionId: revision.id,
    });
    const [sql, ...values] = query.mock.calls[0]!;
    expect((sql as TemplateStringsArray).join('?')).toContain('ON CONFLICT');
    expect(values).toEqual(
      expect.arrayContaining([
        revision.tenantId,
        revision.clientId,
        revision.objectiveId,
        revision.id,
        revision.version,
        revision.actorUserId,
        OBJECTIVE_WORK_PURPOSE,
        row.snapshotHash,
        OBJECTIVE_WORK_BLOCKER,
      ]),
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  test('reconciles the existing append-once winner in a subsequent statement', async () => {
    const { tx, query, row } = fixture();
    query.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    await expect(appendObjectiveReadyIntent(tx, revision)).resolves.toEqual({
      id: row.id,
      objectiveRevisionId: revision.id,
    });
  });

  test.each([
    'tenantId',
    'clientId',
    'objectiveId',
    'objectiveRevisionId',
    'actorUserId',
    'snapshotHash',
    'purpose',
    'state',
    'blockedReason',
  ] as const)('rejects a mismatched stored %s rather than claim pending success', async (field) => {
    const { tx, row } = fixture();
    row[field] = 'wrong';
    await expect(appendObjectiveReadyIntent(tx, revision)).rejects.toThrow('receipt mismatch');
  });

  test('rejects wrong version and missing or duplicate receipt rows', async () => {
    for (const result of [
      [],
      [fixture().row, fixture().row],
      [{ ...fixture().row, objectiveVersion: 3 }],
    ]) {
      const { tx, query } = fixture();
      query.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce(result);
      await expect(appendObjectiveReadyIntent(tx, revision)).rejects.toThrow('receipt mismatch');
    }
  });

  test.each([
    { ...revision, operation: 'edit' },
    { ...revision, snapshot: { status: 'draft' } },
    { ...revision, snapshot: { ...(revision.snapshot as object), version: 1 } },
    { ...revision, snapshot: [] },
    { ...revision, snapshot: null },
  ])('refuses a non-ready or non-matching revision before SQL', async (input) => {
    const { tx, query } = fixture();
    await expect(appendObjectiveReadyIntent(tx, input)).rejects.toThrow('saved ready revision');
    expect(query).not.toHaveBeenCalled();
  });

  test('hashes JSONB object keys independently of insertion order without losing array order', () => {
    expect(objectiveRevisionSnapshotHash({ b: { y: 2, x: 1 }, a: [1, 2] })).toBe(
      objectiveRevisionSnapshotHash({ a: [1, 2], b: { x: 1, y: 2 } }),
    );
    expect(objectiveRevisionSnapshotHash({ a: [1, 2] })).not.toBe(
      objectiveRevisionSnapshotHash({ a: [2, 1] }),
    );
    expect(objectiveRevisionSnapshotHash(revision.snapshot)).toMatch(/^[a-f0-9]{64}$/);
  });

  test('propagates persistence failure; no dispatch or external fallback exists', async () => {
    const { tx, query } = fixture();
    query.mockReset().mockRejectedValue(new Error('synthetic database failure'));
    await expect(appendObjectiveReadyIntent(tx, revision)).rejects.toThrow(
      'synthetic database failure',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});

import { canonicalApplicationRequestId } from './objective-canonical-application.js';
import type { CanonicalProducerWork } from '../meri/objective-canonical-producer.js';
import {
  PLANNER_CONTINUATION_OPERATION,
  claimPlannerContinuationOperationWithinTx,
  finalizePlannerContinuationOperationWithinTx,
  insertPlannerContinuationOperationWithinTx,
  newPlannerContinuationOperation,
  parsePlannerContinuationOperation,
  plannerContinuationOperationId,
  readPlannerContinuationOperationWithinTx,
  type PlannerContinuationOperation,
  type StoredPlannerContinuationOperation,
} from './objective-planner-continuation.store.js';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const deadline = Date.parse('2026-10-17T01:00:00.000Z'), now = deadline - 120_000;
function fixture() {
  const canonical: CanonicalProducerWork['canonical'] = {
    canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
    canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 1, epoch: 1,
    requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 2,
    snapshotHash: 'a'.repeat(64),
  };
  const work: CanonicalProducerWork = { canonical, actorUserId: id(9), consentId: id(10), controlVersion: 3,
    applicationRequestId: canonicalApplicationRequestId(canonical, id(9)), generationJobId: id(11),
    generationRequestId: id(12), strategyId: id(5), strategyVersionId: id(13),
    objectiveReceiptSha256: 'b'.repeat(64), snapshotDigest: 'c'.repeat(64) };
  const input = { work, clerkUserId: 'user_original', membershipId: id(14), originalDeadlineAt: new Date(deadline).toISOString() };
  return { input, data: newPlannerContinuationOperation(input) };
}
function memory() {
  let row: Record<string, any> | null = null;
  const calls: Array<{ operation: string; input: any }> = [];
  const tx = { spPlannerResource: {
    findFirst: jest.fn(async (input: any) => {
      calls.push({ operation: 'read', input: copy(input) });
      return row?.tenantId === input.where.tenantId && row?.id === input.where.id ? copy(row) : null;
    }),
    create: jest.fn(async (input: any) => {
      calls.push({ operation: 'create', input: copy(input) });
      if (row) throw new Error('unique violation');
      row = copy(input.data); return copy(row);
    }),
    updateMany: jest.fn(async (input: any) => {
      calls.push({ operation: 'update', input: copy(input) });
      if (!row || Object.entries(input.where).some(([key, value]) => key === 'data'
        ? JSON.stringify(row!.data) !== JSON.stringify((value as { equals: unknown }).equals)
        : row![key] !== value)) return { count: 0 };
      row = { ...row, data: copy(input.data.data), version: row.version + input.data.version.increment };
      return { count: 1 };
    }),
  } };
  return { tx: tx as unknown as Parameters<typeof readPlannerContinuationOperationWithinTx>[0], mocks: tx.spPlannerResource,
    calls, row: () => copy(row), set: (next: Record<string, any>) => { row = copy(next); } };
}
function scope(row: StoredPlannerContinuationOperation) {
  return { tenantId: row.tenantId, clerkUserId: row.ownerId, operationId: row.id };
}
async function queued() {
  const f = fixture(), db = memory();
  const record = await insertPlannerContinuationOperationWithinTx(db.tx, f.data);
  return { ...f, db, record };
}
const lease = (token = id(20)) => ({ leaseToken: token, nowMs: now, leaseExpiresAtMs: now + 30_000 });

describe('Planner continuation durable original-operation store', () => {
  it('derives one original operation, attempt and run from pinned work, without a new clock deadline', () => {
    const f = fixture(), again = newPlannerContinuationOperation(f.input);
    expect(again).toEqual(f.data);
    expect(new Set([f.data.original.operationId, f.data.original.attemptId, f.data.original.runId]).size).toBe(3);
    expect(plannerContinuationOperationId(f.input.work)).toBe(f.data.original.operationId);
    expect(f.data.original.originalDeadlineAt).toBe(f.input.originalDeadlineAt);
    const changedConsent = copy(f.input); changedConsent.work.consentId = id(30);
    expect(newPlannerContinuationOperation(changedConsent).original.operationId).not.toBe(f.data.original.operationId);
    const changedDeadline = newPlannerContinuationOperation({ ...f.input, originalDeadlineAt: new Date(deadline + 1).toISOString() });
    expect(changedDeadline.original.operationId).toBe(f.data.original.operationId);
    expect(changedDeadline.original.requestFingerprint).not.toBe(f.data.original.requestFingerprint);
  });

  it('rejects accessor, proxy, malformed scope and noncanonical deadline input', () => {
    const f = fixture();
    let read = false;
    const accessor = { ...f.input, get membershipId() { read = true; return id(14); } };
    expect(() => newPlannerContinuationOperation(accessor)).toThrow(); expect(read).toBe(false);
    expect(() => newPlannerContinuationOperation(new Proxy(f.input, {}))).toThrow();
    expect(() => newPlannerContinuationOperation({ ...f.input, originalDeadlineAt: '2026-10-17T01:00:00Z' })).toThrow();
    expect(() => newPlannerContinuationOperation({ ...f.input, clerkUserId: '' })).toThrow();
    expect(() => newPlannerContinuationOperation({ ...f.input, membershipId: 'caller-name' })).toThrow();
    expect(() => parsePlannerContinuationOperation({ ...f.data, tenantId: id(31) })).toThrow();
  });

  it('inserts an entirely private row once and returns its existing state on replay', async () => {
    const { db, data, record } = await queued();
    expect(db.row()).toMatchObject({ tenantId: data.tenantId, ownerId: data.clerkUserId,
      kind: PLANNER_CONTINUATION_OPERATION, projectId: null, shareTokenHash: null, archived: false, version: 1 });
    const claimed = await claimPlannerContinuationOperationWithinTx(db.tx, record, lease());
    expect(await insertPlannerContinuationOperationWithinTx(db.tx, data)).toEqual(claimed);
    expect(db.mocks.create).toHaveBeenCalledTimes(1);
    expect(claimed!.data.original).toEqual(data.original);
    expect(db.calls.every(c => c.operation === 'create' ? c.input.data.tenantId === data.tenantId :
      c.input.where.tenantId === data.tenantId)).toBe(true);
  });

  it('rejects a changed membership or deadline under the same operation identity', async () => {
    const { db, input } = await queued();
    await expect(insertPlannerContinuationOperationWithinTx(db.tx,
      newPlannerContinuationOperation({ ...input, membershipId: id(31) }))).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(insertPlannerContinuationOperationWithinTx(db.tx,
      newPlannerContinuationOperation({ ...input, originalDeadlineAt: new Date(deadline + 1).toISOString() })))
      .rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect(db.mocks.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['tenantId', id(31)], ['ownerId', 'user_other'], ['kind', 'template'], ['name', 'renamed'],
    ['projectId', id(32)], ['shareTokenHash', 'shared'], ['archived', true], ['version', 0], ['version', 2],
  ])('refuses malformed or public row metadata %s', async (key, value) => {
    const { db, record } = await queued();
    // Return wrong-scope rows even when the normal fake query would filter them.
    db.mocks.findFirst.mockResolvedValueOnce({ ...db.row(), [key]: value } as any);
    await expect(readPlannerContinuationOperationWithinTx(db.tx, scope(record))).rejects.toThrow();
  });

  it('rejects tampered immutable work/original and invalid state envelopes', () => {
    const { data } = fixture();
    for (const mutate of [
      (d: PlannerContinuationOperation) => { d.work.snapshotDigest = 'd'.repeat(64); },
      (d: PlannerContinuationOperation) => { d.original.runId = id(31); },
      (d: PlannerContinuationOperation) => { d.original.workSha256 = 'd'.repeat(64); },
      (d: PlannerContinuationOperation) => { d.original.requestFingerprint = 'd'.repeat(64); },
      (d: PlannerContinuationOperation) => { d.state = 'leased'; },
      (d: PlannerContinuationOperation) => { d.terminal = { receiptId: id(31), recordedAtMs: now }; },
    ]) {
      const changed = copy(data); mutate(changed);
      expect(() => parsePlannerContinuationOperation(changed)).toThrow();
    }
  });

  it('claims using CAS, refuses the stale version, and never changes original work identity', async () => {
    const { db, record } = await queued();
    const claimed = await claimPlannerContinuationOperationWithinTx(db.tx, record, lease());
    expect(claimed).toMatchObject({ version: 2, data: { state: 'leased', lease: { token: id(20), expiresAtMs: now + 30_000 } } });
    expect(claimed!.data.work).toEqual(record.data.work); expect(claimed!.data.original).toEqual(record.data.original);
    await expect(claimPlannerContinuationOperationWithinTx(db.tx, record, lease(id(21)))).rejects.toThrow();
    expect(db.row()!.version).toBe(2);
  });

  it('does not reclaim live or expired leases from age/receipt absence alone', async () => {
    const { db, record } = await queued();
    const claimed = (await claimPlannerContinuationOperationWithinTx(db.tx, record, lease()))!;
    expect(await claimPlannerContinuationOperationWithinTx(db.tx, claimed,
      { ...lease(id(21)), nowMs: now + 1, reclaimExpiredLease: 'application-and-operation-atomic' })).toBeNull();
    expect(await claimPlannerContinuationOperationWithinTx(db.tx, claimed,
      { ...lease(id(21)), nowMs: now + 30_001, leaseExpiresAtMs: now + 60_000 })).toBeNull();
    expect(db.mocks.updateMany).toHaveBeenCalledTimes(1);
  });

  it('compares the complete prior JSON on CAS, including exact lease token', async () => {
    const { db, record } = await queued();
    const claimed = (await claimPlannerContinuationOperationWithinTx(db.tx, record, lease()))!;
    const forged = copy(claimed); forged.data.lease!.token = id(31);
    await expect(finalizePlannerContinuationOperationWithinTx(db.tx, forged, {
      state: 'applied', terminalReceiptId: id(40), leaseToken: id(31), nowMs: now + 1,
    })).rejects.toThrow();
    expect(db.row()!.data.lease.token).toBe(id(20)); expect(db.row()!.version).toBe(2);
  });

  it('allows explicit invariant-based reclaim under the owner gate, with a fresh lease and same original run', async () => {
    const { db, record } = await queued();
    const claimed = (await claimPlannerContinuationOperationWithinTx(db.tx, record, lease()))!;
    const reclaimed = await claimPlannerContinuationOperationWithinTx(db.tx, claimed,
      { leaseToken: id(21), nowMs: now + 30_000, leaseExpiresAtMs: now + 60_000,
        reclaimExpiredLease: 'application-and-operation-atomic' });
    expect(reclaimed!.version).toBe(3); expect(reclaimed!.data.original).toEqual(record.data.original);
    expect(reclaimed!.data.work).toEqual(record.data.work); expect(reclaimed!.data.lease!.token).toBe(id(21));
    await expect(finalizePlannerContinuationOperationWithinTx(db.tx, reclaimed!, {
      state: 'applied', terminalReceiptId: id(40), leaseToken: id(20), nowMs: now + 30_001,
    })).rejects.toThrow();
  });

  it('refuses invalid lease deadlines, deadline renewal and expired queued claims', async () => {
    const { db, record } = await queued();
    for (const claim of [
      { ...lease(), leaseExpiresAtMs: now }, { ...lease(), leaseExpiresAtMs: deadline + 1 },
      { ...lease(), nowMs: -1 }, { ...lease(), nowMs: Number.NaN }, { ...lease(), leaseToken: 'untrusted' },
    ]) await expect(claimPlannerContinuationOperationWithinTx(db.tx, record, claim)).rejects.toThrow();
    await expect(claimPlannerContinuationOperationWithinTx(db.tx, record,
      { leaseToken: id(20), nowMs: deadline, leaseExpiresAtMs: deadline + 1 })).rejects.toThrow();
    expect(db.mocks.updateMany).not.toHaveBeenCalled();
  });

  it('accounts applied in the caller transaction, returns immutable terminal replay and refuses competing outcomes', async () => {
    const { db, record } = await queued();
    const claimed = (await claimPlannerContinuationOperationWithinTx(db.tx, record, lease()))!;
    const finish = { state: 'applied' as const, terminalReceiptId: id(40), leaseToken: id(20), nowMs: now + 1 };
    const applied = await finalizePlannerContinuationOperationWithinTx(db.tx, claimed, finish);
    expect(applied).toMatchObject({ version: 3, data: { state: 'applied', lease: null,
      terminal: { receiptId: id(40), recordedAtMs: now + 1 } } });
    expect(applied.data.original).toEqual(record.data.original);
    expect(await finalizePlannerContinuationOperationWithinTx(db.tx, applied, { ...finish, nowMs: deadline + 1 })).toEqual(applied);
    await expect(finalizePlannerContinuationOperationWithinTx(db.tx, applied,
      { ...finish, state: 'failed' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect(await claimPlannerContinuationOperationWithinTx(db.tx, applied, lease(id(21)))).toBeNull();
    expect(await readPlannerContinuationOperationWithinTx(db.tx, scope(applied))).toEqual(applied);
  });

  it('refuses applied accounting without a live exact claim', async () => {
    const { db, record } = await queued();
    const finish = { state: 'applied' as const, terminalReceiptId: id(40), leaseToken: null, nowMs: now + 1 };
    await expect(finalizePlannerContinuationOperationWithinTx(db.tx, record, finish)).rejects.toThrow();
    const claimed = (await claimPlannerContinuationOperationWithinTx(db.tx, record, lease()))!;
    await expect(finalizePlannerContinuationOperationWithinTx(db.tx, claimed,
      { ...finish, leaseToken: id(21) })).rejects.toThrow();
    await expect(finalizePlannerContinuationOperationWithinTx(db.tx, claimed,
      { ...finish, leaseToken: id(20), nowMs: now + 30_000 })).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    await expect(finalizePlannerContinuationOperationWithinTx(db.tx, claimed,
      { ...finish, leaseToken: id(20), nowMs: deadline })).rejects.toThrow();
    expect(db.row()!.data.state).toBe('leased');
  });

  it.each(['cancelled', 'failed'] as const)('can account %s after original expiry without renewing a run', async state => {
    const { db, record } = await queued();
    const done = await finalizePlannerContinuationOperationWithinTx(db.tx, record,
      { state, terminalReceiptId: id(40), leaseToken: null, nowMs: deadline + 1 });
    expect(done.data.state).toBe(state); expect(done.data.original).toEqual(record.data.original);
    expect(parsePlannerContinuationOperation(done.data)).toEqual(done.data);
  });

  it('pins asynchronous insertion inputs and does not allow another tenant read', async () => {
    const f = fixture(), db = memory();
    const waiting = insertPlannerContinuationOperationWithinTx(db.tx, f.data);
    f.data.work.consentId = id(31); f.data.original.originalDeadlineAt = new Date(deadline + 1).toISOString();
    const saved = await waiting;
    expect(saved.data.work.consentId).toBe(id(10));
    expect(saved.data.original.originalDeadlineAt).toBe(new Date(deadline).toISOString());
    expect(await readPlannerContinuationOperationWithinTx(db.tx, { ...scope(saved), tenantId: id(31) })).toBeNull();
  });
});

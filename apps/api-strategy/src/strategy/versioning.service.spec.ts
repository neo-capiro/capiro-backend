import { describe, expect, it } from '@jest/globals';
import { VersioningService } from './versioning.service.js';

/*
 * Stage C transactional-outbox choke point: logActivity is the ONE place every
 * mutation path flows through, so emitting the sp_event_outbox row there means
 * every bump site emits by construction. This spec pins that contract: ONE call
 * writes BOTH the sp_activity_log row AND an sp_event_outbox row on the SAME
 * tx, with outbox.type === action and the payload carrying entityType/entityId.
 */

interface Rec {
  [k: string]: unknown;
}

type Tx = Parameters<VersioningService['logActivity']>[0];

const T = 'tenant-1';
const U = 'user-1';

function makeCaptureTx() {
  const activity: Rec[] = [];
  const outbox: Rec[] = [];
  const tx = {
    spActivityLog: {
      create: async ({ data }: { data: Rec }) => {
        activity.push(data);
      },
    },
    spEventOutbox: {
      create: async ({ data }: { data: Rec }) => {
        outbox.push(data);
      },
    },
  } as unknown as Tx;
  return { tx, activity, outbox };
}

describe('VersioningService.logActivity', () => {
  it('writes the activity row AND an outbox row: type === action, payload carries entityType/entityId', async () => {
    const { tx, activity, outbox } = makeCaptureTx();

    await new VersioningService().logActivity(tx, {
      tenantId: T,
      actorUserId: U,
      authorKind: 'person',
      action: 'node.updated',
      entityType: 'node',
      entityId: 'N1',
      before: { title: 'old' },
      after: { title: 'new' },
    });

    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      tenantId: T,
      actorUserId: U,
      authorKind: 'person',
      action: 'node.updated',
      entityType: 'node',
      entityId: 'N1',
      before: { title: 'old' },
      after: { title: 'new' },
      requestId: null,
    });

    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.tenantId).toBe(T);
    expect(outbox[0]!.type).toBe('node.updated'); // type IS the activity action
    expect(outbox[0]!.payload).toEqual({
      entityType: 'node',
      entityId: 'N1',
      actorUserId: U,
      authorKind: 'person',
      requestId: null,
    });
  });

  it('system-authored writes: null actor + meri authorKind propagate to both rows, requestId passes through', async () => {
    const { tx, activity, outbox } = makeCaptureTx();

    await new VersioningService().logActivity(tx, {
      tenantId: T,
      actorUserId: null,
      authorKind: 'meri',
      action: 'run.created',
      entityType: 'run',
      entityId: 'R1',
      requestId: 'req-42',
    });

    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      actorUserId: null,
      authorKind: 'meri',
      action: 'run.created',
      entityType: 'run',
      entityId: 'R1',
      requestId: 'req-42',
    });
    // before/after omitted => undefined passthrough (Prisma "leave unset").
    expect(activity[0]!.before).toBeUndefined();
    expect(activity[0]!.after).toBeUndefined();

    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.type).toBe('run.created');
    expect(outbox[0]!.payload).toEqual({
      entityType: 'run',
      entityId: 'R1',
      actorUserId: null,
      authorKind: 'meri',
      requestId: 'req-42',
    });
  });
});

/*
 * cutVersion's fold must re-check coalescible AT WRITE TIME (updateMany with
 * coalescible:true in the where), not just in the read: ChangeSetsService.create
 * SEALS the pinned head by flipping coalescible off so the plan can't be
 * rewritten in place under a pinned change-set. A fold that raced the seal
 * (read pre-seal, write post-seal) must match 0 rows and fall through to a
 * fresh version — otherwise the head id never moves and apply's staleness
 * check silently overwrites the user's edits.
 */
describe('VersioningService.cutVersion fold guard', () => {
  const strategyRow = {
    id: 'S1',
    clientId: 'C1',
    title: 'Plan',
    type: 'appropriations',
    goal: null,
    meriContext: null,
    meriSummary: null,
    targetDate: null,
    ownerUserId: U,
    createdByUserId: U,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    nodes: [] as Rec[],
  };

  function makeCutTx(opts: { foldMatches: boolean }) {
    const updateManyArgs: Rec[] = [];
    const created: Rec[] = [];
    const latest = {
      id: 'v-latest',
      authorKind: 'person',
      authorUserId: U,
      restoredFromVersionId: null,
      coalescible: true, // the READ still sees a coalescible head...
      createdAt: new Date(), // ...inside the window
    };
    const tx = {
      spStrategy: { findFirstOrThrow: async () => strategyRow },
      spVersion: {
        findFirst: async () => latest,
        updateMany: async (args: Rec) => {
          updateManyArgs.push(args);
          // ...but the WRITE re-checks coalescible: 0 rows if sealed meanwhile.
          return { count: opts.foldMatches ? 1 : 0 };
        },
        create: async ({ data }: { data: Rec }) => {
          const rec = { ...data, id: 'v-fresh' };
          created.push(rec);
          return rec;
        },
      },
    } as unknown as Tx;
    return { tx, updateManyArgs, created };
  }

  const cutOpts = {
    tenantId: T,
    strategyId: 'S1',
    authorKind: 'person' as const,
    authorUserId: U,
    note: 'Updated step',
    coalesce: true,
  };

  it('folds in place when the guarded updateMany matches (where includes coalescible:true)', async () => {
    const { tx, updateManyArgs, created } = makeCutTx({ foldMatches: true });

    const id = await new VersioningService().cutVersion(tx, cutOpts);

    expect(id).toBe('v-latest');
    expect(created).toHaveLength(0);
    expect(updateManyArgs).toHaveLength(1);
    expect(updateManyArgs[0]!.where).toEqual({ id: 'v-latest', coalescible: true });
  });

  it('falls through to a FRESH version when the head was sealed between read and write (updateMany count 0)', async () => {
    const { tx, created } = makeCutTx({ foldMatches: false });

    const id = await new VersioningService().cutVersion(tx, cutOpts);

    expect(id).toBe('v-fresh'); // head id MOVES — apply's staleness check fires
    expect(created).toHaveLength(1);
    expect(created[0]!.coalescible).toBe(true); // still a normal field-edit batch
  });
});

import {
  activityCommandHash,
  activityCommandInput,
} from './activity-commands/activity-command.input.js';
import { projectActivityDetails } from './client-activity-details.js';
import {
  bearer,
  ctx,
  fixture,
  followInput,
  IDs,
} from '../../test/support/activity-command.fixture.js';

const objectiveId = '90000000-0000-4000-8000-000000000001';
const revisionId = '90000000-0000-4000-8000-000000000002';
const richInput = {
  ...followInput,
  activity: {
    kind: 'commitment',
    title: 'Send the briefing',
    body: 'Private client detail',
    occurredAt: '2025-10-11T14:00:00-04:00',
    dueAt: '2026-11-01T15:00:00Z',
    direction: 'we_owe',
    counterparty: '  Client legal team  ',
    objectiveId,
    objectiveVersion: 3,
  },
};

function setup() {
  const f = fixture();
  const objective = { version: 3, available: true, scopeAllowed: true, revisionAvailable: true };
  const query = f.tx.$queryRaw as jest.Mock;
  query.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('FROM tenants t'))
      return objective.scopeAllowed &&
        values.includes(ctx.tenantId) &&
        values.includes(ctx.userId) &&
        values.includes(ctx.clerkUserId) &&
        values.includes(IDs.client)
        ? [{ userId: IDs.actor, memoryWall: false }]
        : [];
    if (sql.includes('FROM client_objectives'))
      return objective.available &&
        values.includes(ctx.tenantId) &&
        values.includes(IDs.client) &&
        values.includes(objectiveId)
        ? [{ version: objective.version }]
        : [];
    if (sql.includes('FROM client_objective_revisions'))
      return objective.revisionAvailable ? [{ id: revisionId }] : [];
    return [];
  });
  const tx = Object.assign(f.tx, {
    clientObjective: {
      findMany: jest.fn(async () =>
        objective.available ? [{ id: objectiveId, version: objective.version }] : [],
      ),
    },
  });
  return { ...f, tx, objective };
}

describe('Quick Log details on canonical activity commands', () => {
  it('preserves the pre-extension hash for an old omitted-field request', () => {
    const parsed = activityCommandInput({
      requestId: '20000000-0000-4000-8000-000000000001',
      activity: { kind: 'note', title: 'A note' },
    });
    expect(activityCommandHash(parsed)).toBe(
      'b229ac759adf004f8ba90984f4e69aa7e00b0a449c477e34e151ea328c6d48e3',
    );
  });

  it('records a commitment and scoped revision with one durable generic follow-up', async () => {
    const f = setup();
    const receipt = await f.service.create(ctx, IDs.client, richInput, bearer);
    expect(receipt).toMatchObject({
      receiptVersion: 1,
      status: 'completed',
      followUp: { taskId: IDs.task },
    });
    expect(f.activities[0]).toMatchObject({
      kind: 'commitment',
      occurredAt: new Date('2025-10-11T18:00:00Z'),
      dueAt: new Date('2026-11-01T15:00:00Z'),
      metadata: {
        quickLog: {
          version: 1,
          direction: 'we_owe',
          counterparty: 'Client legal team',
          objective: { objectiveId, objectiveVersion: 3, objectiveRevisionId: revisionId },
        },
      },
    });
    expect(f.planner.create).toHaveBeenCalledTimes(1);
    expect(f.rows[0].plannerPayload).toMatchObject({
      name: 'Follow up on logged activity',
      description: '',
      clientId: null,
    });
    expect(JSON.stringify(f.rows[0].plannerPayload)).not.toMatch(/Client legal|Private|90000000/);
    const authorityReads = f.tx.$queryRaw.mock.calls.length;
    f.objective.version = 4;
    const replay = await f.service.create(ctx, IDs.client, richInput, bearer);
    expect(replay).toEqual(receipt);
    expect(f.activities).toHaveLength(1);
    expect(f.planner.create).toHaveBeenCalledTimes(1);
    // Replay only takes the command lock; an old selected revision is not re-admitted.
    expect(f.tx.$queryRaw.mock.calls.length).toBe(authorityReads + 1);
  });

  it.each(['scopeAllowed', 'available', 'revisionAvailable'] as const)(
    'refuses unavailable Objective authority (%s) before any writes',
    async (field) => {
      const f = setup();
      f.objective[field] = false;
      await expect(f.service.create(ctx, IDs.client, richInput, bearer)).rejects.toThrow(
        'Objective not found',
      );
      expect(f.activities).toHaveLength(0);
      expect(f.rows).toHaveLength(0);
      expect(f.planner.create).not.toHaveBeenCalled();
    },
  );
  it('rejects another client/objective and a stale Objective version', async () => {
    const f = setup();
    await expect(
      f.service.create(
        ctx,
        IDs.client,
        {
          ...richInput,
          activity: { ...richInput.activity, objectiveId: IDs.person },
        },
        bearer,
      ),
    ).rejects.toThrow('Objective not found');
    f.objective.version = 4;
    await expect(f.service.create(ctx, IDs.client, richInput, bearer)).rejects.toThrow(
      'Objective changed',
    );
    expect(f.activities).toHaveLength(0);
  });
  it('rolls back details and activity if the command insert fails', async () => {
    const f = setup();
    f.state.failCommandInsert = true;
    await expect(f.service.create(ctx, IDs.client, richInput, bearer)).rejects.toThrow(
      'Synthetic insert',
    );
    expect(f.activities).toHaveLength(0);
    expect(f.rows).toHaveLength(0);
    expect(f.planner.create).not.toHaveBeenCalled();
  });
  it.each([{ direction: 'they_owe' }, { counterparty: 'Another team' }, { objectiveVersion: 4 }])(
    'refuses changing rich fields under an existing request key %j',
    async (change) => {
      const f = setup();
      await f.service.create(ctx, IDs.client, richInput, bearer);
      await expect(
        f.service.create(
          ctx,
          IDs.client,
          {
            ...richInput,
            activity: { ...richInput.activity, ...change },
          },
          bearer,
        ),
      ).rejects.toThrow('different activity data');
      expect(f.activities).toHaveLength(1);
    },
  );
  it.each([
    { direction: 'client' },
    { kind: 'note', direction: 'we_owe' },
    { counterparty: ' ' },
    { counterparty: 'x'.repeat(301) },
    { objectiveId: null },
    { objectiveVersion: null },
    { objectiveVersion: 0 },
    { objectiveVersion: '3' },
    { objectiveRevisionId: revisionId },
    { strategyStepId: IDs.task },
    { metadata: {} },
  ])('rejects malformed or unsupported detail %j', (change) => {
    expect(() =>
      activityCommandInput({ ...richInput, activity: { ...richInput.activity, ...change } }),
    ).toThrow();
  });
  it('keeps custom task title unsupported', () => {
    expect(() =>
      activityCommandInput({
        ...richInput,
        followUp: { ...followInput.followUp, title: 'Client detail' },
      }),
    ).toThrow();
  });

  it('projects current, changed and unavailable historical links without raw metadata', async () => {
    const f = setup();
    await f.service.create(ctx, IDs.client, richInput, bearer);
    const project = () => projectActivityDetails(f.tx as never, ctx, IDs.client, f.activities);
    expect((await project())[0]).toMatchObject({
      objective: { objectiveId, objectiveRevisionId: revisionId, availability: 'current' },
    });
    f.objective.version = 4;
    expect((await project())[0]?.objective?.availability).toBe('changed');
    f.objective.available = false;
    expect((await project())[0]?.objective?.availability).toBe('unavailable');
    expect(f.tx.clientObjective.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: IDs.tenant,
        clientId: IDs.client,
        deletedAt: null,
        id: { in: [objectiveId] },
      },
      select: { id: true, version: true },
    });
  });
  it('treats unrelated or invalid legacy metadata as absent details', async () => {
    const f = setup();
    const result = await projectActivityDetails(f.tx as never, ctx, IDs.client, [
      { metadata: { arbitrary: 'private' } },
      { metadata: { quickLog: { version: 99 } } },
      {},
    ]);
    expect(result).toEqual(Array(3).fill({ direction: null, counterparty: null, objective: null }));
    expect(f.tx.clientObjective.findMany).not.toHaveBeenCalled();
  });
  it('rechecks the canonical client wall after reading Objective availability', async () => {
    const f = setup();
    await f.service.create(ctx, IDs.client, richInput, bearer);
    f.tx.clientObjective.findMany.mockImplementationOnce(async () => {
      f.state.actorWall = false;
      return [{ id: objectiveId, version: 3 }];
    });
    await expect(
      projectActivityDetails(f.tx as never, ctx, IDs.client, f.activities),
    ).rejects.toThrow('Client not found');
  });
});

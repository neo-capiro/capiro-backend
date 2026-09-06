import { describe, expect, jest, test } from '@jest/globals';
import {
  FUNDING_OPPORTUNITY_TASK_SOURCE,
  fundingOpportunityTaskSourceId,
  syncExistingFundingActionTask,
} from './funding-opportunity-task-link.js';

const input = {
  tenantId: 'tenant-a',
  clientId: 'client-a',
  source: 'sam_gov' as const,
  sourceRecordId: 'notice-a',
  intent: 'pursuit' as const,
};

function fixture(over: { legacy?: boolean; clientId?: string; absent?: boolean } = {}) {
  const row = {
    id: 'task-a',
    tenantId: input.tenantId,
    clientId: over.clientId ?? input.clientId,
    sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
    sourceId: over.legacy
      ? 'sam_gov:notice-a:pursuit'
      : fundingOpportunityTaskSourceId(
          input.clientId,
          input.source,
          input.sourceRecordId,
          input.intent,
        ),
    title: 'Existing next action',
    ownerUserId: 'owner-a',
    dueDate: new Date('2026-10-01T12:00:00.000Z'),
  };
  const tx = {
    engagementTask: {
      findFirst: jest.fn(async (args: any) =>
        !over.absent &&
        Object.entries(args.where).every(([key, value]) => row[key as keyof typeof row] === value)
          ? row
          : null,
      ),
      updateMany: jest.fn(async (args: any) => {
        if (
          Object.entries(args.where).every(([key, value]) => row[key as keyof typeof row] === value)
        ) {
          Object.assign(row, args.data);
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
  };
  return { row, tx };
}

describe('workflow edits keep existing action tasks aligned', () => {
  test.each([false, true])(
    'explicit edits update the same-client task (legacy=%s)',
    async (legacy) => {
      const { tx, row } = fixture({ legacy });
      await syncExistingFundingActionTask(tx as never, {
        ...input,
        ownerUserId: 'owner-b',
        nextAction: '  Confirm requirements  ',
        nextActionDueAt: new Date('2026-10-02T12:00:00.000Z'),
      });
      expect(row).toMatchObject({
        ownerUserId: 'owner-b',
        title: 'Confirm requirements',
        dueDate: new Date('2026-10-02T12:00:00.000Z'),
      });
      expect(tx.engagementTask.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'task-a',
            tenantId: input.tenantId,
            clientId: input.clientId,
            sourceType: FUNDING_OPPORTUNITY_TASK_SOURCE,
          },
        }),
      );
    },
  );

  test('a partial edit preserves omitted owner/date fields', async () => {
    const { tx, row } = fixture();
    await syncExistingFundingActionTask(tx as never, { ...input, nextAction: 'New next action' });
    expect(row.ownerUserId).toBe('owner-a');
    expect(row.dueDate).toEqual(new Date('2026-10-01T12:00:00.000Z'));
  });

  test('explicit null clears owner/date while a blank action never empties a task title', async () => {
    const { tx, row } = fixture();
    await syncExistingFundingActionTask(tx as never, {
      ...input,
      ownerUserId: null,
      nextAction: '   ',
      nextActionDueAt: null,
    });
    expect(row.ownerUserId).toBeNull();
    expect(row.dueDate).toBeNull();
    expect(row.title).toBe('Existing next action');
  });

  test.each([false, true])(
    'a task belonging to another client is never edited (legacy=%s)',
    async (legacy) => {
      const { tx, row } = fixture({ legacy, clientId: 'client-b' });
      await syncExistingFundingActionTask(tx as never, {
        ...input,
        ownerUserId: 'owner-b',
        nextActionDueAt: null,
      });
      expect(tx.engagementTask.updateMany).not.toHaveBeenCalled();
      expect(row.ownerUserId).toBe('owner-a');
    },
  );

  test('an opportunity with no task does not create one just because its workflow is edited', async () => {
    const { tx } = fixture({ absent: true });
    await syncExistingFundingActionTask(tx as never, { ...input, ownerUserId: 'owner-b' });
    expect(tx.engagementTask.updateMany).not.toHaveBeenCalled();
  });

  test('an unrelated workflow edit does not touch task storage', async () => {
    const { tx } = fixture();
    await syncExistingFundingActionTask(tx as never, input);
    expect(tx.engagementTask.findFirst).not.toHaveBeenCalled();
    expect(tx.engagementTask.updateMany).not.toHaveBeenCalled();
  });
});

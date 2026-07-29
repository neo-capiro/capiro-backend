import { describe, expect, test } from '@jest/globals';
import type { PrismaClient } from '@prisma/client';
import {
  deriveLifecycleEvents,
  processLifecycle,
} from './process-funding-opportunity-lifecycle.js';

/**
 * `lifecycleFake` implements only the handful of Prisma calls processLifecycle
 * actually makes, which is the point of the fake — so it is asserted into the
 * PrismaClient parameter rather than the whole client being stubbed out.
 */
const asPrisma = (fake: unknown): PrismaClient => fake as PrismaClient;

const now = new Date('2026-07-29T12:00:00Z');
const base = {
  title: 'Autonomy solicitation',
  workflowStatus: 'saved',
  previous: {
    status: 'active',
    deadline: new Date('2026-08-20T00:00:00Z'),
    updatedAt: new Date('2026-07-20T00:00:00Z'),
    active: true,
  },
  current: {
    status: 'active',
    deadline: new Date('2026-08-20T00:00:00Z'),
    updatedAt: new Date('2026-07-20T00:00:00Z'),
    active: true,
  },
  now,
};

describe('deriveLifecycleEvents', () => {
  test('detects a deadline change', () => {
    const events = deriveLifecycleEvents({
      ...base,
      current: { ...base.current, deadline: new Date('2026-08-25T00:00:00Z') },
    });
    expect(events.map((event) => event.type)).toContain('deadline_changed');
  });

  test('detects a source update without inventing the amendment contents', () => {
    const events = deriveLifecycleEvents({
      ...base,
      current: { ...base.current, updatedAt: new Date('2026-07-28T00:00:00Z') },
    });
    expect(events.find((event) => event.type === 'amended')?.body).toContain('Review the source');
  });

  test('detects closure', () => {
    const events = deriveLifecycleEvents({
      ...base,
      current: { ...base.current, status: 'archived', active: false },
    });
    expect(events.map((event) => event.type)).toContain('cancelled_or_closed');
  });

  test('closing-soon applies only to saved or pursuing work', () => {
    const current = { ...base.current, deadline: new Date('2026-08-05T00:00:00Z') };
    expect(
      deriveLifecycleEvents({ ...base, workflowStatus: 'saved', current }).map((event) => event.type),
    ).toContain('closing_soon');
    expect(
      deriveLifecycleEvents({ ...base, workflowStatus: 'suggested', current }).map((event) => event.type),
    ).not.toContain('closing_soon');
  });
});

function lifecycleFake(options: {
  workflowStatus: string;
  userCreated: boolean;
  active?: boolean;
  existingAlert?: boolean;
}) {
  const updates: unknown[] = [];
  const alerts: unknown[] = [];
  const fake: Record<string, any> = {};
  fake.$transaction = async (fn: (tx: any) => Promise<unknown>) => fn(fake);
  fake.$executeRawUnsafe = async () => 0;
  fake.clientFundingOpportunity = {
    findMany: async () => [
      {
        id: 'wf-1',
        tenantId: '00000000-0000-0000-0000-000000000001',
        clientId: '00000000-0000-0000-0000-000000000010',
        source: 'sam_gov',
        grantOpportunityId: null,
        samOpportunityId: '00000000-0000-0000-0000-0000000003aa',
        workflowStatus: options.workflowStatus,
        userCreated: options.userCreated,
        sourceStatusSnapshot: 'active',
        responseDeadlineSnapshot: new Date('2026-08-20T00:00:00Z'),
        sourceUpdatedAtSnapshot: new Date('2026-07-20T00:00:00Z'),
      },
    ],
    update: async (args: unknown) => {
      updates.push(args);
      return args;
    },
  };
  fake.federalGrant = { findMany: async () => [] };
  fake.samOpportunity = {
    findMany: async () => [
      {
        id: '00000000-0000-0000-0000-0000000003aa',
        title: 'Autonomy solicitation',
        active: options.active ?? false,
        responseDeadline: new Date('2026-08-20T00:00:00Z'),
        archiveDate: options.active === true ? new Date('2026-09-01T00:00:00Z') : now,
        updatedAt: new Date('2026-07-28T00:00:00Z'),
        lastSyncedAt: new Date('2026-07-28T00:00:00Z'),
      },
    ],
  };
  fake.clioProactiveAlert = {
    findFirst: async () => (options.existingAlert ? { id: 'alert-1' } : null),
    create: async (args: unknown) => {
      alerts.push(args);
      return args;
    },
  };
  return { fake, updates, alerts };
}

describe('processLifecycle', () => {
  test('machine suggestions become expired when the source closes', async () => {
    const { fake, updates } = lifecycleFake({ workflowStatus: 'suggested', userCreated: false });
    const result = await processLifecycle(asPrisma(fake), {
      tenantIds: ['00000000-0000-0000-0000-000000000001'],
      commit: true,
      now,
    });
    expect(result.expired).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ workflowStatus: 'expired' }),
      }),
    );
  });

  test.each(['saved', 'pursuing'])('%s decisions are preserved when the source closes', async (status) => {
    const { fake, updates } = lifecycleFake({ workflowStatus: status, userCreated: true });
    const result = await processLifecycle(asPrisma(fake), {
      tenantIds: ['00000000-0000-0000-0000-000000000001'],
      commit: true,
      now,
    });
    expect(result.expired).toBe(0);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        data: expect.not.objectContaining({ workflowStatus: 'expired' }),
      }),
    );
  });

  test('alert fingerprints make lifecycle notifications idempotent', async () => {
    const { fake, alerts } = lifecycleFake({
      workflowStatus: 'saved',
      userCreated: true,
      existingAlert: true,
    });
    const result = await processLifecycle(asPrisma(fake), {
      tenantIds: ['00000000-0000-0000-0000-000000000001'],
      commit: true,
      now,
    });
    expect(result.alerts).toBe(0);
    expect(alerts).toHaveLength(0);
  });
});

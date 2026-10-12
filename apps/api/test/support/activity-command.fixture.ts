import { ActivityCommandService } from '../../src/clients/activity-commands/activity-command.service.js';
import { ClientActivityService } from '../../src/clients/client-activity.service.js';
import type { TenantContext } from '@capiro/shared';

export const IDs = {
  tenant: '10000000-0000-4000-8000-000000000001',
  actor: '20000000-0000-4000-8000-000000000001',
  client: '30000000-0000-4000-8000-000000000001',
  person: '40000000-0000-4000-8000-000000000001',
  assignee: '50000000-0000-4000-8000-000000000001',
  request: '60000000-0000-4000-8000-000000000001',
  task: '70000000-0000-4000-8000-000000000001',
  activity: '80000000-0000-4000-8000-000000000001',
};
export const ctx: TenantContext = {
  tenantId: IDs.tenant,
  userId: IDs.actor,
  clerkUserId: 'user_actor',
  tenantSlug: 'qa',
  role: 'standard_user',
};
export const bearer = 'Bearer synthetic';
export const basicInput = {
  requestId: IDs.request,
  activity: { kind: 'note', title: 'Private title', body: 'Private content', personId: IDs.person },
};
export const followInput = {
  ...basicInput,
  followUp: {
    assigneeUserId: IDs.assignee,
    dueOn: '2026-11-01',
    dueTime: '01:30',
    timeZone: 'America/New_York',
  },
};

/** Transaction/storage simulator, not native RLS/concurrency qualification. */
export function fixture() {
  const rows: any[] = [],
    activities: any[] = [];
  const state = {
    actorActive: true,
    actorClerk: ctx.clerkUserId,
    role: 'standard_user',
    clientActive: true,
    assigneeActive: true,
    assigneeClerk: 'user_assignee',
    personActive: true,
    actorWall: true,
    assigneeWall: true,
    failCommandInsert: false,
    failCommitAfterRemote: false,
  };
  const matches = (row: any, where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
  const tx = {
    $queryRaw: jest.fn(async () => []),
    $queryRawUnsafe: jest.fn(
      async (_sql: string, _tenant: string, _client: string, user: string) => [
        { allowed: user === IDs.assignee ? state.assigneeWall : state.actorWall },
      ],
    ),
    tenantMembership: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.tenantId !== IDs.tenant) return null;
        if (where.user)
          return where.userId === IDs.actor &&
            state.actorActive &&
            where.user.clerkUserId === state.actorClerk
            ? { role: state.role }
            : null;
        return where.userId === IDs.assignee && state.assigneeActive
          ? { user: { clerkUserId: state.assigneeClerk } }
          : null;
      }),
    },
    client: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.tenantId === IDs.tenant && where.id === IDs.client && state.clientActive
          ? { id: IDs.client }
          : null,
      ),
    },
    clientPerson: {
      findFirst: jest.fn(async ({ where }: any) =>
        state.personActive &&
        where.id === IDs.person &&
        where.tenantId === IDs.tenant &&
        where.clientId === IDs.client
          ? { id: IDs.person }
          : null,
      ),
    },
    clientActivity: {
      findFirst: jest.fn(
        async ({ where }: any) => activities.find((a) => matches(a, where)) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, id: IDs.activity };
        activities.push(row);
        return row;
      }),
    },
    clientActivityCommand: {
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
      create: jest.fn(async ({ data }: any) => {
        if (state.failCommandInsert) throw Error('Synthetic insert failure');
        const row = {
          version: 0,
          errorCode: null,
          attemptToken: null,
          leaseUntil: null,
          taskId: null,
          plannerPayload: null,
          ...data,
        };
        rows.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => matches(r, where));
        const next = {
          ...data,
          version: data.version ? row.version + data.version.increment : row.version,
        };
        Object.assign(row, next);
        return { ...row };
      }),
    },
  };
  let queue = Promise.resolve();
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, fn: (db: any) => Promise<any>) => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((r) => {
        release = r;
      });
      await previous;
      const beforeRows = structuredClone(rows),
        beforeActivities = structuredClone(activities);
      try {
        const result = await fn(tx);
        if (state.failCommitAfterRemote && rows.some((r) => r.taskId)) {
          state.failCommitAfterRemote = false;
          throw Error('Synthetic commit failure');
        }
        return result;
      } catch (e) {
        rows.splice(0, rows.length, ...beforeRows);
        activities.splice(0, activities.length, ...beforeActivities);
        throw e;
      } finally {
        release();
      }
    }),
  };
  const remote = new Map<string, string>();
  const planner = {
    origin: jest.fn(() => 'https://strategy.invalid'),
    lookup: jest.fn(async (_ctx: unknown, _bearer: string, key: string): Promise<any> =>
      remote.has(key) ? { kind: 'found', taskId: remote.get(key) } : { kind: 'missing' },
    ),
    create: jest.fn(
      async (_ctx: unknown, _bearer: string, key: string, _data: unknown): Promise<any> => {
        remote.set(key, IDs.task);
        return { kind: 'found', taskId: IDs.task };
      },
    ),
  };
  const service = new ActivityCommandService(
    prisma as any,
    new ClientActivityService(prisma as any, {} as any),
    planner as any,
  );
  return { service, prisma, tx, rows, activities, state, planner, remote };
}

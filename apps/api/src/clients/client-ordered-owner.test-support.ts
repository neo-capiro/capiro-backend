import { ClientOrderedOwnerService } from './client-ordered-owner.service.js';
import type { TenantContext } from '@capiro/shared';

export const tenant = '11111111-1111-4111-8111-111111111111';
export const client = '22222222-2222-4222-8222-222222222222';
export const actor = '99999999-9999-4999-8999-999999999999';
export const ids = [1, 2, 3, 4, 5].map((n) => `33333333-3333-4333-8333-33333333333${n}`);
export const ctx = {
  tenantId: tenant,
  userId: actor,
  clerkUserId: 'user_synthetic',
  role: 'user_admin',
} as TenantContext;

/** Transaction adapter, not native SQL/RLS qualification. It retains rollback
 * and serialization so service-level receipts and failed writes are observable. */
export function setup(initial: string[] = []) {
  const state = {
    owners: [...initial],
    primary: initial[0] ?? null,
    version: 0,
    members: new Set(ids),
    role: 'user_admin',
    active: true,
    wall: true,
    archived: false,
    auditFailure: false,
    audits: [] as unknown[],
  };
  const queries: string[] = [];
  const tx = {
    tenantMembership: {
      findFirst: jest.fn(async ({ where }: any) =>
        state.active &&
        where.tenantId === tenant &&
        where.userId === actor &&
        where.user.clerkUserId === ctx.clerkUserId
          ? { role: state.role }
          : null,
      ),
    },
    $queryRawUnsafe: jest.fn(async () => [{ allowed: state.wall }]),
    $queryRaw: jest.fn(async (q: any, ...args: any[]) => {
      const text = Array.isArray(q) ? q.join('?') : q.sql;
      const values = Array.isArray(q) ? args : q.values;
      queries.push(text);
      if (text.includes('account_owner_version AS version'))
        return !state.archived && values[0] === tenant && values[1] === client
          ? [{ version: state.version, primary: state.primary }]
          : [];
      if (text.includes('FOR SHARE OF tm, u'))
        return state.active &&
          values[0] === tenant &&
          values[1] === actor &&
          values[2] === ctx.clerkUserId
          ? [{ role: state.role }]
          : [];
      if (text.includes('FROM client_memory_access')) return state.wall ? [{ user_id: actor }] : [];
      if (text.includes('FROM tenant_memberships'))
        return ids
          .filter((id) => state.members.has(id) && values.includes(id))
          .map((userId) => ({ userId }));
      if (text.includes('SELECT o.user_id'))
        return state.owners.map((userId, i) => ({
          userId,
          rank: i + 1,
          active: state.members.has(userId),
          email: `${i}@synthetic.invalid`,
          firstName: `Person ${i}`,
          lastName: null,
        }));
      if (text.includes('FROM client_ordered_owners'))
        return state.owners.map((userId) => ({ userId }));
      throw Error(`Unexpected query: ${text}`);
    }),
    $executeRaw: jest.fn(async (q: any, ...values: any[]) => {
      const text = q.join('?');
      if (text.includes('DELETE FROM client_ordered_owners')) state.owners = [];
      else if (text.includes('INSERT INTO client_ordered_owners'))
        state.owners[values[2] - 1] = values[3];
      else if (text.includes('UPDATE clients')) {
        state.primary = values[0];
        state.version++;
      } else throw Error(`Unexpected mutation: ${text}`);
      return 1;
    }),
    auditLog: {
      create: jest.fn(async (data) => {
        if (state.auditFailure) throw Error('synthetic audit failure');
        state.audits.push(data);
        return data;
      }),
    },
  };
  let tail = Promise.resolve();
  const prisma = {
    withTenant: async (_tenant: string, run: (tx: any) => Promise<any>) => {
      const prior = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      const before = {
        owners: [...state.owners],
        primary: state.primary,
        version: state.version,
        audits: [...state.audits],
      };
      try {
        return await run(tx);
      } catch (error) {
        Object.assign(state, before);
        throw error;
      } finally {
        release();
      }
    },
  };
  return { service: new ClientOrderedOwnerService(prisma as never), state, tx, queries, prisma };
}

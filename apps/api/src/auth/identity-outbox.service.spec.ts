import type { ClerkService } from './clerk.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CLERK_MEMBERSHIP_DELETE, IdentityOutboxService } from './identity-outbox.service.js';

/**
 * De-provisioning durability.
 *
 * The bug this replaces: removeMember called Clerk's
 * deleteOrganizationMembership INSIDE a Prisma interactive transaction and
 * swallowed the failure, so (a) a Clerk error returned 200 {ok:true} while the
 * user kept their org membership and its tokens, and (b) a Clerk call slower
 * than the 5s transaction budget aborted the transaction with P2028, rolling
 * back the local removal entirely.
 */

type RawHandler = (sql: { strings?: TemplateStringsArray } | unknown, ...args: unknown[]) => unknown;

interface FakeDb {
  queryResults: unknown[][];
  queries: string[];
  executed: string[];
}

function makePrisma(db: FakeDb): { prisma: PrismaService; tx: Record<string, RawHandler> } {
  const tx = {
    $queryRaw: ((strings: TemplateStringsArray, ...args: unknown[]) => {
      db.queries.push(Array.isArray(strings) ? strings.join('?') : String(strings));
      return Promise.resolve(db.queryResults.shift() ?? []);
    }) as RawHandler,
    $executeRaw: ((strings: TemplateStringsArray) => {
      db.executed.push(Array.isArray(strings) ? strings.join('?') : String(strings));
      return Promise.resolve(1);
    }) as RawHandler,
  };
  const prisma = {
    withSystem: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  return { prisma, tx };
}

function makeClerk(deleteImpl: () => Promise<unknown>): {
  clerk: ClerkService;
  calls: number;
} {
  const state = { calls: 0 };
  const clerk = {
    backend: {
      organizations: {
        deleteOrganizationMembership: () => {
          state.calls += 1;
          return deleteImpl();
        },
      },
    },
  } as unknown as ClerkService;
  return {
    clerk,
    get calls() {
      return state.calls;
    },
  } as { clerk: ClerkService; calls: number };
}

describe('IdentityOutboxService', () => {
  describe('enqueueClerkMembershipDelete', () => {
    it('inserts a job and returns its id', async () => {
      const db: FakeDb = { queryResults: [[{ id: 'job-1' }]], queries: [], executed: [] };
      const { prisma, tx } = makePrisma(db);
      const { clerk } = makeClerk(async () => undefined);
      const svc = new IdentityOutboxService(prisma, clerk);

      const id = await svc.enqueueClerkMembershipDelete(tx as never, {
        tenantId: '11111111-1111-1111-1111-111111111111',
        clerkOrgId: 'org_1',
        clerkUserId: 'user_1',
        membershipId: 'mem-1',
      });

      expect(id).toBe('job-1');
      // The insert must be ON CONFLICT DO NOTHING so a retried removal cannot
      // create a second pending job for the same membership.
      expect(db.queries.join(' ')).toContain('ON CONFLICT DO NOTHING');
      expect(db.queries.join(' ')).toContain('identity_outbox');
    });

    it('returns null when a pending job already exists (idempotent)', async () => {
      const db: FakeDb = { queryResults: [[]], queries: [], executed: [] };
      const { prisma, tx } = makePrisma(db);
      const { clerk } = makeClerk(async () => undefined);
      const svc = new IdentityOutboxService(prisma, clerk);

      const id = await svc.enqueueClerkMembershipDelete(tx as never, {
        tenantId: '11111111-1111-1111-1111-111111111111',
        clerkOrgId: 'org_1',
        clerkUserId: 'user_1',
        membershipId: 'mem-1',
      });

      expect(id).toBeNull();
    });
  });

  describe('attemptNow', () => {
    const claim = [
      {
        id: 'job-1',
        type: CLERK_MEMBERSHIP_DELETE,
        payload: { clerkOrgId: 'org_1', clerkUserId: 'user_1', membershipId: 'mem-1' },
      },
    ];

    it('calls Clerk and marks the job consumed on success', async () => {
      const db: FakeDb = { queryResults: [claim], queries: [], executed: [] };
      const { prisma } = makePrisma(db);
      const clerkHarness = makeClerk(async () => undefined);
      const svc = new IdentityOutboxService(prisma, clerkHarness.clerk);

      await expect(svc.attemptNow('job-1')).resolves.toBe(true);
      expect(db.executed.join(' ')).toContain('consumed_at = now()');
    });

    it('NEVER throws when Clerk fails — the job stays pending for the drain', async () => {
      const db: FakeDb = {
        queryResults: [claim, [{ attempts: 1, tenant_id: 't-1' }]],
        queries: [],
        executed: [],
      };
      const { prisma } = makePrisma(db);
      const clerkHarness = makeClerk(async () => {
        throw new Error('Clerk 503');
      });
      const svc = new IdentityOutboxService(prisma, clerkHarness.clerk);

      await expect(svc.attemptNow('job-1')).resolves.toBe(false);
      // Must NOT have been marked consumed.
      expect(db.executed.join(' ')).not.toContain('consumed_at = now()');
    });

    it('treats a Clerk 404 as success — the membership is already gone', async () => {
      const db: FakeDb = { queryResults: [claim], queries: [], executed: [] };
      const { prisma } = makePrisma(db);
      const clerkHarness = makeClerk(async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      });
      const svc = new IdentityOutboxService(prisma, clerkHarness.clerk);

      await expect(svc.attemptNow('job-1')).resolves.toBe(true);
      expect(db.executed.join(' ')).toContain('consumed_at = now()');
    });

    it('treats a resource_not_found error code as success', async () => {
      const db: FakeDb = { queryResults: [claim], queries: [], executed: [] };
      const { prisma } = makePrisma(db);
      const clerkHarness = makeClerk(async () => {
        throw Object.assign(new Error('gone'), { errors: [{ code: 'resource_not_found' }] });
      });
      const svc = new IdentityOutboxService(prisma, clerkHarness.clerk);

      await expect(svc.attemptNow('job-1')).resolves.toBe(true);
    });

    it('does nothing when the job was already claimed by another drain', async () => {
      // The conditional UPDATE returns no rows -> someone else consumed it.
      const db: FakeDb = { queryResults: [[]], queries: [], executed: [] };
      const { prisma } = makePrisma(db);
      const clerkHarness = makeClerk(async () => undefined);
      const svc = new IdentityOutboxService(prisma, clerkHarness.clerk);

      await expect(svc.attemptNow('job-1')).resolves.toBe(false);
      expect(clerkHarness.calls).toBe(0);
    });

    it('claims with a conditional UPDATE, not a read-then-write', async () => {
      const db: FakeDb = { queryResults: [claim], queries: [], executed: [] };
      const { prisma } = makePrisma(db);
      const clerkHarness = makeClerk(async () => undefined);
      const svc = new IdentityOutboxService(prisma, clerkHarness.clerk);

      await svc.attemptNow('job-1');

      const claimSql = db.queries[0] ?? '';
      expect(claimSql).toContain('UPDATE identity_outbox');
      expect(claimSql).toContain('consumed_at IS NULL');
      expect(claimSql).toContain('RETURNING');
    });
  });

  describe('drainPending', () => {
    it('reports zero when nothing is due', async () => {
      const db: FakeDb = { queryResults: [[]], queries: [], executed: [] };
      const { prisma } = makePrisma(db);
      const { clerk } = makeClerk(async () => undefined);
      const svc = new IdentityOutboxService(prisma, clerk);

      await expect(svc.drainPending()).resolves.toEqual({ processed: 0, succeeded: 0 });
    });

    it('processes each due job and counts successes', async () => {
      const due = [{ id: 'job-1' }, { id: 'job-2' }];
      const claimFor = (id: string) => [
        {
          id,
          type: CLERK_MEMBERSHIP_DELETE,
          payload: { clerkOrgId: 'org_1', clerkUserId: 'user_1', membershipId: `mem-${id}` },
        },
      ];
      const db: FakeDb = {
        queryResults: [due, claimFor('job-1'), claimFor('job-2')],
        queries: [],
        executed: [],
      };
      const { prisma } = makePrisma(db);
      const { clerk } = makeClerk(async () => undefined);
      const svc = new IdentityOutboxService(prisma, clerk);

      await expect(svc.drainPending()).resolves.toEqual({ processed: 2, succeeded: 2 });
    });

    it('only selects unconsumed, due, non-exhausted rows', async () => {
      const db: FakeDb = { queryResults: [[]], queries: [], executed: [] };
      const { prisma } = makePrisma(db);
      const { clerk } = makeClerk(async () => undefined);
      const svc = new IdentityOutboxService(prisma, clerk);

      await svc.drainPending();

      const sql = db.queries[0] ?? '';
      expect(sql).toContain('consumed_at IS NULL');
      expect(sql).toContain('next_attempt_at <= now()');
      expect(sql).toContain('attempts <');
    });
  });
});

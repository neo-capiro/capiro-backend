import { describe, expect, it } from '@jest/globals';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaOrgTenantResolver } from './org-tenant-resolver.provider.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/** A connection-pool-timeout style failure: NOT a Postgres error at all, so it
 *  must never be mistaken for the "not a valid UUID" case. */
function poolTimeoutError(): Error {
  return new Error('Timed out fetching a new connection from the connection pool.');
}

/** What Prisma actually throws for `id = $1::uuid` on a non-UUID string —
 *  wrapped as P2010 with the Postgres SQLSTATE at `.meta.code`. */
function invalidUuidError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Raw query failed', {
    code: 'P2010',
    clientVersion: 'test',
    meta: { code: '22P02', message: 'invalid input syntax for type uuid: "not-a-uuid"' },
  });
}

function makePrisma(withSystemImpl: (tx: unknown) => Promise<unknown>): PrismaService {
  return { withSystem: (fn: (tx: unknown) => unknown) => withSystemImpl(fn) } as unknown as PrismaService;
}

describe('PrismaOrgTenantResolver', () => {
  describe('resolveByTenantId', () => {
    it('resolves a tenant row', async () => {
      const prisma = makePrisma(async () => [
        { id: 't1', slug: 'acme', clerkOrgId: 'org_1' },
      ]);
      const resolver = new PrismaOrgTenantResolver(prisma);

      await expect(resolver.resolveByTenantId('t1')).resolves.toEqual({
        tenantId: 't1',
        slug: 'acme',
        clerkOrgId: 'org_1',
      });
    });

    it('returns null for the expected invalid-UUID-literal case (22P02)', async () => {
      const prisma = makePrisma(async () => {
        throw invalidUuidError();
      });
      const resolver = new PrismaOrgTenantResolver(prisma);

      await expect(resolver.resolveByTenantId('not-a-uuid')).resolves.toBeNull();
    });

    it('does NOT swallow a connection-pool/infrastructure error as "no tenant"', async () => {
      const prisma = makePrisma(async () => {
        throw poolTimeoutError();
      });
      const resolver = new PrismaOrgTenantResolver(prisma);

      // Regression test: this must reject (surfacing as a 500 upstream), not
      // resolve to null (which TenantGuard would report as a false 403
      // "no_matching_tenant" — the actual incident this fix addresses).
      await expect(resolver.resolveByTenantId('17b63099-bc0f-4ac5-b596-496161e9481e')).rejects.toThrow(
        'Timed out fetching a new connection',
      );
    });
  });

  describe('resolveByClerkOrgId', () => {
    it('resolves a tenant row', async () => {
      const prisma = makePrisma(async () => [
        { id: 't1', slug: 'acme', clerkOrgId: 'org_1' },
      ]);
      const resolver = new PrismaOrgTenantResolver(prisma);

      await expect(resolver.resolveByClerkOrgId('org_1')).resolves.toEqual({
        tenantId: 't1',
        slug: 'acme',
        clerkOrgId: 'org_1',
      });
    });

    it('rethrows any DB error rather than reporting "no tenant" (no expected-error case exists here)', async () => {
      const prisma = makePrisma(async () => {
        throw poolTimeoutError();
      });
      const resolver = new PrismaOrgTenantResolver(prisma);

      await expect(resolver.resolveByClerkOrgId('org_1')).rejects.toThrow(
        'Timed out fetching a new connection',
      );
    });
  });
});

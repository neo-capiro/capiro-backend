import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { ClientObjectivesService } from './objectives.service.js';

const ctx: TenantContext = { tenantId: '11111111-1111-4111-8111-111111111111', tenantSlug: 'synthetic',
  userId: '22222222-2222-4222-8222-222222222222', clerkUserId: 'user_synthetic', role: 'standard_user' };
const input = { clientId: '33333333-3333-4333-8333-333333333333', objectiveId: '44444444-4444-4444-8444-444444444444', objectiveVersion: 7 };
const revisionId = '55555555-5555-4555-8555-555555555555';

describe('Objective immutable revision read privileges (source/synthetic only)', () => {
  it('resolves under original SELECT/INSERT-only revision permissions without an update grant', async () => {
    const migration = readFileSync(resolve(process.cwd(), 'prisma/migrations/20281011010000_client_objectives/migration.sql'), 'utf8');
    expect(migration).toContain('REVOKE UPDATE, DELETE ON client_objective_revisions FROM capiro_app');
    expect(migration).toContain('GRANT SELECT, INSERT ON client_objective_revisions TO capiro_app');
    const calls: string[] = [];
    const tx = { $queryRaw: async <T>(strings: TemplateStringsArray, ..._values: unknown[]): Promise<T> => {
      const sql = strings.join('?'); calls.push(sql);
      if (sql.includes('FROM client_objective_revisions')) {
        // PostgreSQL SELECT documentation requires UPDATE for every locking
        // SELECT. This is a permission-boundary model, not a database execution.
        if (/\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i.test(sql))
          throw new Error('UPDATE privilege required by locking SELECT on immutable revisions');
        return [{ id: revisionId }] as T;
      }
      if (sql.includes('FROM client_objectives')) return [{ version: 7 }] as T;
      if (sql.includes('FROM client_memory_access')) return [{ id: 'grant' }] as T;
      if (sql.includes('FROM tenants')) return [{ memoryWall: true, userId: ctx.userId }] as T;
      throw new Error('Unexpected query');
    } };
    const service = new ClientObjectivesService({} as PrismaService);
    await expect(service.requireDestinationRevisionWithinTx(tx as unknown as Prisma.TransactionClient, ctx, input))
      .resolves.toEqual({ ...input, objectiveRevisionId: revisionId });
    expect(calls.find(sql => sql.includes('FROM client_objectives'))).toContain('deleted_at IS NULL FOR SHARE');
    expect(calls.find(sql => sql.includes('FROM client_objective_revisions'))).not.toMatch(/\bFOR\s+(?:UPDATE|SHARE|KEY|NO)\b/i);
  });
});

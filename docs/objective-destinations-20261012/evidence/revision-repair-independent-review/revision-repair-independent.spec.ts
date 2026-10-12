import { NotFoundException, ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClientObjectivesService } from '../../../../apps/api/src/clients/objectives/objectives.service.js';
import type { PrismaService } from '../../../../apps/api/src/prisma/prisma.service.js';

const root = resolve(__dirname, '../../../..');
const published = '30fa58467238542ff2b98137844ea02a3225e545';
const objectiveOriginal = '72bfea4c5f574c2d9dba63c6bbc63dac1c7e377e';
const sourcePath = 'apps/api/src/clients/objectives/objectives.service.ts';
const migrationPath = 'apps/api/prisma/migrations/20281011010000_client_objectives/migration.sql';
const ctx: TenantContext = { tenantId: '11111111-1111-4111-8111-111111111111', tenantSlug: 'synthetic',
  userId: '22222222-2222-4222-8222-222222222222', clerkUserId: 'user_repair_review', role: 'standard_user' };
const input = { clientId: '33333333-3333-4333-8333-333333333333',
  objectiveId: '44444444-4444-4444-8444-444444444444', objectiveVersion: 7 };
const revisionId = '55555555-5555-4555-8555-555555555555';
const gitText = (ref: string, path: string) => execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' });
const locked = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i;

/** No database: deny a locking revision SELECT at the tagged SQL boundary. */
function fixture(overrides: { scope?: boolean; wall?: boolean; grant?: boolean; objective?: boolean; revision?: boolean; version?: number } = {}) {
  const calls: Array<{ kind: string; sql: string; values: unknown[] }> = [];
  let parentGate: Promise<void> | undefined;
  const tx = { $executeRaw: jest.fn(() => { throw Error('Unexpected resource mutation'); }),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      const kind = sql.includes('FROM tenants') ? 'scope' : sql.includes('FROM client_memory_access') ? 'grant'
        : sql.includes('FROM client_objective_revisions') ? 'revision' : sql.includes('FROM client_objectives') ? 'objective' : 'unexpected';
      calls.push({ kind, sql, values });
      if (kind === 'scope') return overrides.scope === false ? [] : [{ memoryWall: overrides.wall ?? true }];
      if (kind === 'grant') return overrides.grant === false ? [] : [{ id: 'grant' }];
      if (kind === 'objective') { await parentGate; return overrides.objective === false ? [] : [{ version: overrides.version ?? 7 }]; }
      if (kind === 'revision') {
        if (locked.test(sql)) throw Error('Immutable revision query requested UPDATE privilege');
        return overrides.revision === false ? [] : [{ id: revisionId }];
      }
      throw Error('Unexpected SQL');
    }) };
  const service = new ClientObjectivesService({} as PrismaService);
  return { calls, tx, run: () => service.requireDestinationRevisionWithinTx(tx as unknown as Prisma.TransactionClient, ctx, input),
    gateParent: (gate: Promise<void>) => { parentGate = gate; } };
}

describe('Independent SELECT-only revision repair', () => {
  it('has exactly one production delta: remove the immutable revision FOR SHARE', () => {
    const oldSource = gitText(published, sourcePath);
    const newSource = readFileSync(resolve(root, sourcePath), 'utf8');
    const revisionStart = oldSource.indexOf('SELECT id FROM client_objective_revisions');
    const lockOffset = oldSource.indexOf('      FOR SHARE\n', revisionStart);
    expect(revisionStart).toBeGreaterThan(0); expect(lockOffset).toBeGreaterThan(revisionStart);
    expect(newSource).toBe(oldSource.slice(0, lockOffset) + oldSource.slice(lockOffset + '      FOR SHARE\n'.length));
    const productionPaths = execFileSync('git', ['diff', '--name-only', published, 'HEAD', '--', 'apps/api/src'], { cwd: root, encoding: 'utf8' })
      .trim().split('\n').filter(path => !path.endsWith('.spec.ts'));
    expect(productionPaths).toEqual([sourcePath]);
  });

  it('leaves the original immutable migration/FKs/privileges byte-identical', () => {
    const sql = readFileSync(resolve(root, migrationPath), 'utf8');
    expect(sql).toBe(gitText(published, migrationPath));
    expect(sql).toBe(gitText(objectiveOriginal, migrationPath));
    expect(sql).toContain('REVOKE UPDATE, DELETE ON client_objective_revisions FROM capiro_app');
    expect(sql).toContain('GRANT SELECT, INSERT ON client_objective_revisions TO capiro_app');
    expect(sql).toMatch(/FOREIGN KEY \(tenant_id, client_id, objective_id\)\s+REFERENCES client_objectives\(tenant_id, client_id, id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/FOREIGN KEY \(tenant_id, client_id\)\s+REFERENCES clients\(tenant_id, id\) ON DELETE CASCADE/);
    expect(sql).toContain('tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE');
    expect(sql).toContain('UNIQUE (tenant_id, objective_id, version)');
  });

  it('returns the exact revision with retained current authority locks and no revision UPDATE privilege', async () => {
    const h = fixture(); await expect(h.run()).resolves.toEqual({ ...input, objectiveRevisionId: revisionId });
    expect(h.calls.map(c => c.kind)).toEqual(['scope', 'grant', 'objective', 'revision']);
    expect(h.calls[0]!.sql).toContain('FOR SHARE OF t,m,u,c');
    expect(h.calls[0]!.values).toEqual([ctx.tenantId, ctx.userId, ctx.clerkUserId, input.clientId]);
    expect(h.calls[1]!.sql).toContain('FOR SHARE');
    expect(h.calls[1]!.values).toEqual([ctx.tenantId, input.clientId, ctx.userId]);
    expect(h.calls[2]!.sql).toContain('deleted_at IS NULL FOR SHARE');
    expect(h.calls[2]!.values).toEqual([ctx.tenantId, input.clientId, input.objectiveId]);
    expect(h.calls[3]!.sql).not.toMatch(locked);
    expect(h.calls[3]!.values).toEqual([ctx.tenantId, input.clientId, input.objectiveId, 7]);
    expect(h.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('does not read a revision before the current mutable Objective lock resolves', async () => {
    const h = fixture(); let release!: () => void;
    h.gateParent(new Promise<void>(r => { release = r; }));
    const result = h.run(); for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    expect(h.calls.map(c => c.kind)).toEqual(['scope', 'grant', 'objective']);
    release(); await result;
  });

  it.each(['scope', 'grant', 'objective', 'revision'] as const)('fails closed for missing %s despite SELECT-only revision read', async (field) => {
    const h = fixture({ [field]: false }); await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
    if (field !== 'revision') expect(h.calls.some(c => c.kind === 'revision')).toBe(false);
  });

  it('rejects stale Objective before any immutable historical revision read', async () => {
    const h = fixture({ version: 8 }); await expect(h.run()).rejects.toBeInstanceOf(ConflictException);
    expect(h.calls.some(c => c.kind === 'revision')).toBe(false);
  });

  it('keeps the non-wall parent checks while omitting only the unnecessary grant lookup', async () => {
    const h = fixture({ wall: false, grant: false }); await h.run();
    expect(h.calls.map(c => c.kind)).toEqual(['scope', 'objective', 'revision']);
    expect(h.calls[0]!.sql).toContain('FOR SHARE OF t,m,u,c');
    expect(h.calls[1]!.sql).toContain('FOR SHARE');
  });
});

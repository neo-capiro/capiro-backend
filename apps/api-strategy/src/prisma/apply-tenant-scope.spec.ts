import { describe, expect, it } from '@jest/globals';
import { applyTenantScope, isRetryableTransactionError } from './prisma.service.js';

/**
 * DB-free unit coverage for the SOLE runtime tenant-isolation mechanism.
 *
 * applyTenantScope injects `where.tenantId` for tenant-scoped models on
 * where-bearing ops. Because the runtime `capiro_app` role bypasses RLS, this
 * injection — NOT the DB policies — is the real cross-tenant guard. The
 * DB-backed tenant-isolation.int-spec self-skips without DATABASE_URL (so it
 * does not run in the PR gate); this spec runs in ci-pr and fails fast on any
 * regression to the predicate. Ported from apps/api's prisma-tenant-scope.spec.
 */

const T = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const SCOPED = new Set<string>(['SpStrategy', 'SpNode']); // model names, PascalCase (DMMF)

const WHERE_BEARING = [
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
];

describe('applyTenantScope (the runtime tenant guard)', () => {
  it('injects where.tenantId for a scoped model when no where exists', () => {
    const out = applyTenantScope({ tenantId: T }, 'SpStrategy', 'findMany', {}, SCOPED) as any;
    expect(out.where).toEqual({ tenantId: T });
  });

  it('merges tenantId into an existing where without dropping other filters', () => {
    const out = applyTenantScope(
      { tenantId: T },
      'SpStrategy',
      'findFirst',
      { where: { status: 'active' } },
      SCOPED,
    ) as any;
    expect(out.where).toEqual({ status: 'active', tenantId: T });
  });

  it('OVERRIDES an attacker-supplied cross-tenant where.tenantId', () => {
    const out = applyTenantScope(
      { tenantId: T },
      'SpStrategy',
      'findMany',
      { where: { tenantId: OTHER } },
      SCOPED,
    ) as any;
    expect(out.where.tenantId).toBe(T);
  });

  it('injects on every where-bearing op for a scoped model', () => {
    for (const op of WHERE_BEARING) {
      const out = applyTenantScope({ tenantId: T }, 'SpNode', op, {}, SCOPED) as any;
      expect(out.where).toEqual({ tenantId: T });
    }
  });

  it('does NOT inject for create / createMany (no where to constrain)', () => {
    for (const op of ['create', 'createMany']) {
      const args = { data: { foo: 'bar' } };
      const out = applyTenantScope({ tenantId: T }, 'SpStrategy', op, args, SCOPED) as any;
      expect(out).toEqual(args);
      expect(out.where).toBeUndefined();
    }
  });

  it('does NOT inject under a bypass scope, even for a scoped model + where-bearing op', () => {
    const args = { where: { id: 'x' } };
    const out = applyTenantScope({ bypass: true }, 'SpStrategy', 'findMany', args, SCOPED) as any;
    expect(out).toEqual(args);
  });

  it('does NOT scope a model absent from the scoped set (e.g. global SpReferenceEntry)', () => {
    const args = { where: { kind: 'congress_milestone' } };
    const out = applyTenantScope(
      { tenantId: T },
      'SpReferenceEntry',
      'findMany',
      args,
      SCOPED,
    ) as any;
    expect(out).toEqual(args);
    expect(out.where.tenantId).toBeUndefined();
  });

  it('does not mutate the caller-supplied args object', () => {
    const args = { where: { status: 'active' } };
    const snapshot = JSON.parse(JSON.stringify(args));
    applyTenantScope({ tenantId: T }, 'SpStrategy', 'findMany', args, SCOPED);
    expect(args).toEqual(snapshot); // original untouched
  });
});

describe('isRetryableTransactionError', () => {
  it('is true for deadlock / serialization signatures', () => {
    expect(isRetryableTransactionError(new Error('deadlock detected'))).toBe(true);
    expect(isRetryableTransactionError(new Error('could not serialize access due to ...'))).toBe(
      true,
    );
    expect(isRetryableTransactionError(new Error('SQLSTATE 40P01'))).toBe(true);
    expect(isRetryableTransactionError(new Error('40001'))).toBe(true);
  });

  it('is false for unrelated errors', () => {
    expect(isRetryableTransactionError(new Error('unique constraint violation'))).toBe(false);
    expect(isRetryableTransactionError('nope')).toBe(false);
  });
});

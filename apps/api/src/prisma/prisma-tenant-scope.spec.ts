import { applyTenantScope } from './prisma.service.js';

const scopedModels = new Set(['Client', 'Meeting', 'ClientPerson']);
const T = '11111111-1111-1111-1111-111111111111';

describe('applyTenantScope (tenant-scope query hook decision)', () => {
  it('injects tenantId into a where-bearing read on a tenant-scoped model', () => {
    const out = applyTenantScope(
      { tenantId: T },
      'Client',
      'findMany',
      { where: { status: 'active' } },
      scopedModels,
    ) as { where: Record<string, unknown> };
    expect(out.where).toEqual({ status: 'active', tenantId: T });
  });

  it('injects tenantId when no where was provided', () => {
    const out = applyTenantScope({ tenantId: T }, 'Client', 'findMany', undefined, scopedModels) as {
      where: Record<string, unknown>;
    };
    expect(out.where).toEqual({ tenantId: T });
  });

  it('forces the scope tenant even if the caller passed a different tenantId', () => {
    const out = applyTenantScope(
      { tenantId: T },
      'Client',
      'findMany',
      { where: { tenantId: '99999999-9999-9999-9999-999999999999' } },
      scopedModels,
    ) as { where: Record<string, unknown> };
    expect(out.where.tenantId).toBe(T);
  });

  it('scopes unique-where ops (findUnique) so a cross-tenant id cannot leak', () => {
    const out = applyTenantScope(
      { tenantId: T },
      'Client',
      'findUnique',
      { where: { id: 'abc' } },
      scopedModels,
    ) as { where: Record<string, unknown> };
    expect(out.where).toEqual({ id: 'abc', tenantId: T });
  });

  it('scopes mutation ops (update / deleteMany)', () => {
    const upd = applyTenantScope(
      { tenantId: T },
      'Client',
      'update',
      { where: { id: 'abc' }, data: { name: 'x' } },
      scopedModels,
    ) as { where: Record<string, unknown>; data: unknown };
    expect(upd.where).toEqual({ id: 'abc', tenantId: T });
    expect(upd.data).toEqual({ name: 'x' });

    const del = applyTenantScope(
      { tenantId: T },
      'Client',
      'deleteMany',
      { where: { status: 'archived' } },
      scopedModels,
    ) as { where: Record<string, unknown> };
    expect(del.where).toEqual({ status: 'archived', tenantId: T });
  });

  it('does NOT touch models without a tenantId field (global reference tables)', () => {
    const args = { where: { billId: '119-hr-1' } };
    const out = applyTenantScope({ tenantId: T }, 'CongressBill', 'findMany', args, scopedModels);
    expect(out).toBe(args);
  });

  it('does NOT touch non-where operations (create / createMany)', () => {
    const args = { data: { tenantId: T, name: 'x' } };
    expect(applyTenantScope({ tenantId: T }, 'Client', 'create', args, scopedModels)).toBe(args);
    expect(applyTenantScope({ tenantId: T }, 'Client', 'createMany', args, scopedModels)).toBe(args);
  });

  it('bypass scope (withSystem) injects nothing — cross-tenant reach preserved', () => {
    const args = { where: { status: 'active' } };
    const out = applyTenantScope({ bypass: true }, 'Client', 'findMany', args, scopedModels);
    expect(out).toBe(args);
  });

  it('does not mutate the caller-provided args object', () => {
    const args = { where: { status: 'active' } };
    applyTenantScope({ tenantId: T }, 'Client', 'findMany', args, scopedModels);
    expect(args).toEqual({ where: { status: 'active' } }); // untouched
  });
});

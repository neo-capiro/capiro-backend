import { createHash } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ProspectContactsService } from './prospect-contacts.service.js';
import type { TenantContext } from '@capiro/shared';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2), clerkUserId: 'user_integration', role: 'standard_user' } as TenantContext;
const prospectId = id(3), clientId = id(4), requestId = id(5);
const body = { name: 'Person', requestId };
const hash = createHash('sha256').update(JSON.stringify({ name: 'Person', title: null, email: null, phone: null, notes: null })).digest('hex');

function harness() {
  const state = { tenant: true, feature: true, member: true, role: 'standard_user', prospect: true,
    status: 'active', linkedClientId: null as string | null, convertedAt: null as Date | null,
    client: true, wall: true, grant: true, canonicalWall: true, existing: true,
    errorAt: null as string | null, error: new Error('SOURCE_INFRASTRUCTURE') };
  const contact = { id: id(6), tenant_id: ctx.tenantId, prospect_id: prospectId, request_id: requestId,
    create_hash: hash, name: 'Person', title: null, email: null, phone: null, notes: null, version: 1,
    removed_at: null, created_at: new Date('2026-10-12T00:00:00Z'), updated_at: new Date('2026-10-12T00:00:00Z') };
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  async function query(sql: string, args: unknown[]) {
    calls.push({ sql, args });
    if (state.errorAt && sql.includes(state.errorAt)) throw state.error;
    if (sql.includes('SELECT status, linked_client_id')) return state.prospect ? [{ status: state.status, linked_client_id: state.linkedClientId, converted_at: state.convertedAt }] : [];
    if (sql.includes('FROM business_development_prospects')) return state.prospect ? [{ linkedClientId: state.linkedClientId, status: state.status, dismissedAt: null }] : [];
    if (sql.includes('FROM tenants')) return state.tenant ? [{ settings: { clioFeatureFlags: { 'businessDevelopment.enabled': state.feature } } }] : [];
    if (sql.includes('FROM tenant_memberships')) return state.member && ['standard_user', 'user_admin', 'capiro_admin'].includes(state.role) && args[1] === ctx.userId ? [{ userId: ctx.userId, clerkUserId: ctx.clerkUserId }] : [];
    if (sql.includes('set_config')) return [];
    if (sql.includes('SELECT (NOT c.memory_wall')) return [{ allowed: state.canonicalWall }];
    if (sql.includes('FROM clients')) return state.client ? [{ status: 'active', memoryWall: state.wall }] : [];
    if (sql.includes('FROM client_memory_access')) return state.grant ? [{ id: id(7) }] : [];
    if (sql.includes('business_development_prospect_contacts')) {
      if (sql.startsWith('UPDATE')) return [{ ...contact, version: 2 }];
      if (sql.startsWith('INSERT')) return [contact];
      return state.existing ? [contact] : [];
    }
    throw Error('Unexpected synthetic query');
  }
  const tx = { $queryRaw: jest.fn((parts: TemplateStringsArray, ...args: unknown[]) => query(parts.join('?'), args)),
    $queryRawUnsafe: jest.fn((sql: string, ...args: unknown[]) => query(sql, args)) };
  const prisma = { withTenant: jest.fn((tenant: string, fn: (scopeTx: typeof tx) => unknown) => { expect(tenant).toBe(ctx.tenantId); return fn(tx); }) };
  const service = new ProspectContactsService(prisma as any);
  return { state, contact, calls, service };
}

describe('registered prospect Contacts authority integration', () => {
  it('locks the existing prospect before canonical authority and contact data in one transaction', async () => {
    const h = harness(); await h.service.list(ctx, prospectId);
    expect(h.calls[0]!.sql).toContain('FOR UPDATE');
    const authority = h.calls.findIndex(q => q.sql.includes('FROM tenant_memberships'));
    const data = h.calls.findIndex(q => q.sql.includes('business_development_prospect_contacts'));
    expect(authority).toBeGreaterThan(0); expect(data).toBeGreaterThan(authority);
    expect(h.calls[authority]!.args).toContain(ctx.userId);
  });
  it.each(['tenant', 'feature', 'member', 'prospect'])('denies current %s before any contact data', async field => {
    const h = harness(); (h.state as any)[field] = false;
    await expect(h.service.list(ctx, prospectId)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.calls.some(q => q.sql.includes('business_development_prospect_contacts'))).toBe(false);
  });
  it('rechecks actual role after a stale admin context', async () => {
    const h = harness(); h.state.role = 'view_only';
    await expect(h.service.create({ ...ctx, role: 'capiro_admin' }, prospectId, body)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.calls.some(q => q.sql.includes('business_development_prospect_contacts'))).toBe(false);
  });
  it.each(['client', 'grant', 'canonicalWall'])('requires converted-client current %s on reads and create replay', async field => {
    const h = harness(); h.state.linkedClientId = clientId; h.state.convertedAt = new Date(); (h.state as any)[field] = false;
    await expect(h.service.list(ctx, prospectId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.create(ctx, prospectId, body)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.calls.some(q => q.sql.includes('business_development_prospect_contacts'))).toBe(false);
  });
  it('preserves authorized converted history and exact create recovery, while refusing new writes', async () => {
    const h = harness(); h.state.linkedClientId = clientId; h.state.convertedAt = new Date();
    expect((await h.service.list(ctx, prospectId)).readOnly).toBe(true);
    expect((await h.service.create(ctx, prospectId, body)).id).toBe(h.contact.id);
    h.state.existing = false;
    await expect(h.service.create(ctx, prospectId, body)).rejects.toBeInstanceOf(ConflictException);
    await expect(h.service.update(ctx, prospectId, h.contact.id, { name: 'Changed', expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictException);
    await expect(h.service.remove(ctx, prospectId, h.contact.id, 1)).rejects.toBeInstanceOf(ConflictException);
    expect(h.calls.some(q => /^(INSERT|UPDATE)/.test(q.sql))).toBe(false);
  });
  it('requires fresh current authority on every repeated read', async () => {
    const h = harness(); await h.service.list(ctx, prospectId); h.state.member = false;
    await expect(h.service.list(ctx, prospectId)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('retains changed replay payload conflict after current authority succeeds', async () => {
    const h = harness(); await expect(h.service.create(ctx, prospectId, { ...body, name: 'Changed' })).rejects.toBeInstanceOf(ConflictException);
  });
  it.each(['FROM business_development_prospects', 'FROM tenants', 'FROM tenant_memberships', 'FROM clients', 'FROM client_memory_access', 'business_development_prospect_contacts'])('propagates infrastructure error at %s', async errorAt => {
    const h = harness(); h.state.linkedClientId = clientId; h.state.errorAt = errorAt;
    await expect(h.service.list(ctx, prospectId)).rejects.toBe(h.state.error);
  });
});

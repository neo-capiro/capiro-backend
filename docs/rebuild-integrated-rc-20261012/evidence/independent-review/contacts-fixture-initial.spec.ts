import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { ProspectContactsService } from '../../../../apps/api/src/business-development/prospect-contacts/prospect-contacts.service.js';
import { ProspectContactsController } from '../../../../apps/api/src/business-development/prospect-contacts/prospect-contacts.controller.js';
import { RolesGuard } from '../../../../apps/api/src/auth/roles.guard.js';
import { BusinessDevelopmentFlagGuard } from '../../../../apps/api/src/business-development/business-development-flag.guard.js';
import { CreateProspectContactDto, UpdateProspectContactDto, RemoveProspectContactDto } from '../../../../apps/api/src/business-development/prospect-contacts/prospect-contacts.dto.js';
import type { TenantContext } from '@capiro/shared';

const uuid = (n: number) => `90000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const ctx = { tenantId: uuid(1), userId: uuid(2), clerkUserId: 'user_independent', role: 'standard_user' } as TenantContext;
const prospect = uuid(3), client = uuid(4), request = uuid(5), contactId = uuid(6);
const body = { name: 'Contact', requestId: request };
type Operation = 'list' | 'create' | 'update' | 'remove';
type Phase = 'exclusive' | 'prospect' | 'tenant' | 'member' | 'identity' | 'client' | 'grant' | 'predicate' | 'data';
const operations: Operation[] = ['list', 'create', 'update', 'remove'];

function fixture() {
  const state = { tenant: true, enabled: true, member: true, client: true, grant: true, predicate: true,
    readOnly: false, existing: true, removed: false, hash: true, version: 1,
    failPhase: null as Phase | null, before: null as ((phase: Phase) => void) | null };
  const calls: Array<{ phase: Phase; sql: string; args: unknown[] }> = [];
  const error = new Error('INDEPENDENT_INFRASTRUCTURE');
  const row = () => ({ id: contactId, tenant_id: ctx.tenantId, prospect_id: prospect,
    request_id: request, create_hash: state.hash ? createHash('sha256').update(JSON.stringify({ name: 'Contact', title: null, email: null, phone: null, notes: null })).digest('hex') : 'f'.repeat(64),
    name: 'Contact', title: null, email: null, phone: null, notes: null, version: state.version,
    removed_at: state.removed ? new Date() : null, created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId, created_at: new Date('2026-10-12T00:00:00Z'), updated_at: new Date('2026-10-12T00:00:00Z') });
  async function query(sql: string, args: unknown[]) {
    const phase: Phase = sql.includes('SELECT status, linked_client_id') ? 'exclusive'
      : sql.includes('FROM business_development_prospects') ? 'prospect'
      : sql.includes('FROM tenants') ? 'tenant'
      : sql.includes('FROM tenant_memberships') ? 'member'
      : sql.includes('set_config') ? 'identity'
      : sql.includes('SELECT (NOT c.memory_wall') ? 'predicate'
      : sql.includes('FROM clients') ? 'client'
      : sql.includes('FROM client_memory_access') ? 'grant' : 'data';
    calls.push({ phase, sql, args }); state.before?.(phase);
    if (phase === state.failPhase) throw error;
    if (phase === 'exclusive') return [{ status: state.readOnly ? 'dismissed' : 'active', linked_client_id: client, converted_at: state.readOnly ? new Date() : null }];
    if (phase === 'prospect') return [{ linkedClientId: client, status: state.readOnly ? 'dismissed' : 'active', dismissedAt: state.readOnly ? new Date() : null }];
    if (phase === 'tenant') return state.tenant ? [{ settings: { clioFeatureFlags: { 'businessDevelopment.enabled': state.enabled } } }] : [];
    if (phase === 'member') return state.member && args[1] === ctx.userId ? [{ userId: ctx.userId, clerkUserId: ctx.clerkUserId }] : [];
    if (phase === 'identity') return [];
    if (phase === 'client') return state.client ? [{ status: 'active', memoryWall: true }] : [];
    if (phase === 'grant') return state.grant ? [{ id: uuid(7) }] : [];
    if (phase === 'predicate') return [{ allowed: state.predicate }];
    if (!sql.includes('business_development_prospect_contacts')) throw Error('Unexpected query');
    if (sql.startsWith('INSERT')) { state.existing = true; return [row()]; }
    if (sql.startsWith('UPDATE')) {
      const requested = args.at(-1);
      if (requested !== state.version || state.removed) return [];
      state.version++; return [row()];
    }
    return state.existing && (!sql.includes('removed_at IS NULL') || !state.removed) ? [row()] : [];
  }
  const tx = {
    $queryRaw: jest.fn((parts: TemplateStringsArray, ...args: unknown[]) => query(parts.join('?'), args)),
    $queryRawUnsafe: jest.fn((sql: string, ...args: unknown[]) => query(sql, args)),
  };
  const withTenant = jest.fn(async (tenant: string, fn: (scopeTx: typeof tx) => unknown) => {
    expect(tenant).toBe(ctx.tenantId); return fn(tx);
  });
  const service = new ProspectContactsService({ withTenant } as any);
  const run = (operation: Operation) => operation === 'list' ? service.list(ctx, prospect)
    : operation === 'create' ? service.create(ctx, prospect, body)
    : operation === 'update' ? service.update(ctx, prospect, contactId, { name: 'Contact', expectedVersion: 1 })
    : service.remove(ctx, prospect, contactId, 1);
  return { state, calls, error, run, service, withTenant };
}

describe('independent Contacts composition boundaries', () => {
  it.each(operations.flatMap(operation => ['tenant', 'enabled', 'member', 'client', 'grant', 'predicate'].map(gate => [operation, gate] as const)))('%s denies current %s before all contact data', async (operation, gate) => {
    const h = fixture(); (h.state as any)[gate] = false;
    await expect(h.run(operation)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.calls.some(call => call.phase === 'data')).toBe(false);
    expect(h.withTenant).toHaveBeenCalledTimes(1);
  });
  it.each(operations)('%s preserves exclusive-first and tenant-bound scope order', async operation => {
    const h = fixture(); await h.run(operation);
    expect(h.calls[0]!.phase).toBe('exclusive'); expect(h.calls[0]!.sql).toContain('FOR UPDATE');
    const firstData = h.calls.findIndex(call => call.phase === 'data');
    expect(firstData).toBeGreaterThan(h.calls.findIndex(call => call.phase === 'predicate'));
    for (const call of h.calls.filter(call => call.phase === 'data')) {
      expect(call.args).toContain(ctx.tenantId); expect(call.args).toContain(prospect);
    }
  });
  it.each(operations.flatMap(operation => ['exclusive', 'prospect', 'tenant', 'member', 'identity', 'client', 'grant', 'predicate', 'data'].map(phase => [operation, phase] as const)))('%s preserves infrastructure failure from %s', async (operation, phase) => {
    const h = fixture(); h.state.failPhase = phase;
    await expect(h.run(operation)).rejects.toBe(h.error);
    if (phase !== 'data') expect(h.calls.some(call => call.phase === 'data')).toBe(false);
  });
  it.each(operations)('%s observes member revocation after prospect lock await', async operation => {
    const h = fixture(); h.state.before = phase => { if (phase === 'member') h.state.member = false; };
    await expect(h.run(operation)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.calls.some(call => call.phase === 'data')).toBe(false);
  });
  it.each(operations)('%s cannot rely on a prior grant result when canonical predicate denies', async operation => {
    const h = fixture(); h.state.before = phase => { if (phase === 'predicate') h.state.predicate = false; };
    await expect(h.run(operation)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.calls.some(call => call.phase === 'data')).toBe(false);
  });
  it('converted/dismissed exact replay strips internal receipt metadata', async () => {
    const h = fixture(); h.state.readOnly = true;
    const result = await h.run('create');
    expect(Object.keys(result).sort()).toEqual(['createdAt', 'email', 'id', 'name', 'notes', 'phone', 'prospectId', 'requestId', 'title', 'updatedAt', 'version'].sort());
    expect(h.calls.filter(call => call.phase === 'data').every(call => call.sql.startsWith('SELECT'))).toBe(true);
  });
  it.each(['hash', 'removed'])('refuses changed/removed exact replay (%s) without writing', async field => {
    const h = fixture(); h.state.readOnly = true;
    if (field === 'hash') h.state.hash = false; else h.state.removed = true;
    await expect(h.run('create')).rejects.toBeInstanceOf(ConflictException);
    expect(h.calls.some(call => /^(INSERT|UPDATE)/.test(call.sql))).toBe(false);
  });
  it('new converted create refuses without materializing a client contact or other store', async () => {
    const h = fixture(); h.state.readOnly = true; h.state.existing = false;
    await expect(h.run('create')).rejects.toBeInstanceOf(ConflictException);
    expect(h.calls.some(call => /^(INSERT|UPDATE)/.test(call.sql))).toBe(false);
  });
  it.each(['update', 'remove'] as const)('%s preserves stale CAS conflict', async operation => {
    const h = fixture(); h.state.version = 2;
    await expect(h.run(operation)).rejects.toBeInstanceOf(ConflictException);
    expect(h.state.version).toBe(2);
  });
  it('controller retains firm-private prefix, current role floor and feature guard', () => {
    expect(Reflect.getMetadata('path', ProspectContactsController)).toBe('business-development/prospects/:prospectId/contacts');
    expect(Reflect.getMetadata('__guards__', ProspectContactsController)).toEqual([RolesGuard, BusinessDevelopmentFlagGuard]);
    expect(Reflect.getMetadata('roles', ProspectContactsController)).toEqual(['standard_user', 'user_admin', 'capiro_admin']);
  });
});

describe('actual Contacts validation boundary', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  it.each([
    [CreateProspectContactDto, { ...body, clientId: client }],
    [CreateProspectContactDto, { ...body, tenantId: ctx.tenantId }],
    [CreateProspectContactDto, { ...body, requestId: 'not-a-uuid' }],
    [CreateProspectContactDto, { ...body, name: '   ' }],
    [UpdateProspectContactDto, { name: 'Contact', expectedVersion: '1' }],
    [UpdateProspectContactDto, { name: 'Contact', expectedVersion: 0 }],
    [RemoveProspectContactDto, { expectedVersion: 1, prospectId: prospect }],
  ])('refuses incompatible or caller-authority DTO %j', async (metatype, value) => {
    await expect(pipe.transform(value, { type: 'body', metatype: metatype as any })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('accepts the existing narrow create DTO and trims its name', async () => {
    const result = await pipe.transform({ ...body, name: '  Contact  ' }, { type: 'body', metatype: CreateProspectContactDto });
    expect(result.name).toBe('Contact'); expect(result.requestId).toBe(request);
  });
});

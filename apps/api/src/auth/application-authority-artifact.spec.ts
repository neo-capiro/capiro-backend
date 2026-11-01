import { ApplicationCurrentService } from './application-current.service.js';
import { describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BadRequestException, ForbiddenException, ServiceUnavailableException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import {
  ARTIFACT_AUTHORITY_CONTRACT,
  ARTIFACT_AUTHORITY_V2_CONTRACT,
  ARTIFACT_INTENT_OPERATIONS,
  ARTIFACT_OPERATIONS,
  parseApplicationAuthorityArtifactBody,
  readApplicationAuthorityArtifact,
  type ApplicationAuthorityIdentityProof,
} from './application-authority.js';
import { ApplicationAuthorityController } from './application-authority.controller.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';

// Byte-exact copy of meri-greenfield f6e46de4 docs/integration/artifact-current-authority.vector.json
// (sha256 99a283d6a9e2bda4c2a747a305b5f457b4c9899c6f3478e12c881aed958c5caa).
const vectorPath = resolve(__dirname, '../../../../docs/integration/meri-artifact-current-authority.vector.json');
const vectorBytes = readFileSync(vectorPath);
const vector = JSON.parse(vectorBytes.toString('utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const RECEIPT_KEYS = ['contract', 'observationId', 'principal', 'identityRevision', 'conversationId', 'selectedClientId', 'contextRevision',
  'intent', 'requestSha256', 'operations', 'limits', 'authorityRevision', 'checkedAtMs', 'expiresAtMs'];

/** Port of Meri `core-authority-wire.mjs` `assertArtifactAuthorityReceipt` (f6e46de4), checked below against the vector's refusals. */
function meriAccepts(r: any, q: any): boolean {
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length !== RECEIPT_KEYS.length ||
      Object.keys(r).some((k) => !RECEIPT_KEYS.includes(k))) return false;
  const p = r.principal;
  if (!p || typeof p !== 'object' || Object.keys(p).sort().join() !== 'actorId,tenantId') return false;
  if (r.contract !== ARTIFACT_AUTHORITY_CONTRACT || r.observationId !== q.observationId || r.conversationId !== q.conversationId ||
      r.selectedClientId !== q.clientId || r.intent !== q.intent || r.requestSha256 !== q.requestSha256 ||
      [p.tenantId, p.actorId].some((id) => typeof id !== 'string' || !UUID.test(id)) ||
      [r.identityRevision, r.contextRevision, r.authorityRevision].some((x) => typeof x !== 'string' || !SHA.test(x))) return false;
  if (!Array.isArray(r.operations) || r.operations.length < 1 || r.operations.length > ARTIFACT_OPERATIONS.length ||
      r.operations.some((op: string, i: number) => !(ARTIFACT_OPERATIONS as readonly string[]).includes(op) || (i > 0 && !(r.operations[i - 1] < op))) ||
      vector.intentOperations[q.intent].some((op: string) => !r.operations.includes(op))) return false;
  if (r.limits !== null && (typeof r.limits !== 'object' || Object.keys(r.limits).join() !== 'maxArtifactBytes' ||
      !Number.isSafeInteger(r.limits.maxArtifactBytes) || r.limits.maxArtifactBytes < 1 || r.limits.maxArtifactBytes > 16777216)) return false;
  return Number.isSafeInteger(r.checkedAtMs) && Number.isSafeInteger(r.expiresAtMs) && r.checkedAtMs >= 0 &&
    r.expiresAtMs > r.checkedAtMs && r.expiresAtMs - r.checkedAtMs <= 60000;
}

const createCase = vector.cases[0];
const tenantId = createCase.receipt.principal.tenantId;
const actorId = createCase.receipt.principal.actorId;

function ports(options: { identityExpiresInMs?: number; clientId?: string } = {}) {
  const events: string[] = [];
  const identity = (): ApplicationAuthorityIdentityProof => ({
    principal: { tenantId, actorId }, identityRevision: 'b'.repeat(64), expiresAtMs: Date.now() + (options.identityExpiresInMs ?? 300_000),
    recheckCurrent: async () => identity(),
  });
  const conversation = (id: string) => ({ id, tenantId, userId: actorId, clientId: options.clientId ?? createCase.request.clientId, status: 'active', archivedAt: null });
  return {
    events,
    ports: {
      identity: async () => { events.push('identity'); return identity(); },
      conversation: async (id: string) => { events.push('conversation'); return conversation(id); },
      conversationScope: async () => { events.push('scope'); return null; },
      clientVisible: async () => { events.push('visible'); },
      clientAuthority: async () => { events.push('wall'); return ['wall', false]; },
    },
  };
}

describe('artifact current authority (capiro.meri-artifact-authority.v1)', () => {
  it('admits exact official-source import through existing generation permission and current client authority', async () => {
    const request = parseApplicationAuthorityArtifactBody({ ...createCase.request, intent: 'federal-import' });
    const f = ports();
    const receipt = await readApplicationAuthorityArtifact(request, 'standard_user', f.ports);
    expect(receipt.intent).toBe('federal-import');
    expect(receipt.operations).toContain('artifact.generate');
    await expect(readApplicationAuthorityArtifact(request, 'client_portal_user', ports().ports)).rejects.toThrow();
    await expect(readApplicationAuthorityArtifact(request, 'standard_user', { ...ports().ports,
      clientVisible: async () => { throw new ForbiddenException(); } })).rejects.toThrow(ForbiddenException);
  });
  it('pins the vendored Meri vector bytes', () => {
    expect(createHash('sha256').update(vectorBytes).digest('hex')).toBe('99a283d6a9e2bda4c2a747a305b5f457b4c9899c6f3478e12c881aed958c5caa');
    expect(vector.route).toEqual({ method: 'POST', path: '/api/clio/application-authority/artifact', successStatus: 200 });
    expect(vector.intentOperations).toEqual(Object.fromEntries(
      Object.keys(vector.intentOperations).map(intent => [intent, clone(ARTIFACT_INTENT_OPERATIONS[intent])]),
    ));
    expect(ARTIFACT_INTENT_OPERATIONS.history).toEqual(['artifact.inspect']);
    expect(ARTIFACT_INTENT_OPERATIONS.list).toEqual(['artifact.inspect']);
    expect(ARTIFACT_INTENT_OPERATIONS['federal-prepare']).toEqual(['artifact.download', 'artifact.inspect']);
    expect(ARTIFACT_INTENT_OPERATIONS['federal-load']).toEqual(['artifact.download', 'artifact.inspect']);
    expect(ARTIFACT_INTENT_OPERATIONS['federal-publish']).toEqual(['artifact.download', 'artifact.generate', 'artifact.inspect', 'artifact.revise']);
    expect(ARTIFACT_INTENT_OPERATIONS['federal-import']).toEqual(['artifact.generate']);
    // SCRUM-222: browser-imported bytes reuse the existing generation operation only.
    expect(ARTIFACT_INTENT_OPERATIONS['browser-import']).toEqual(['artifact.generate']);
  });

  it('admits browser import through the same generation permission and current client authority', async () => {
    const request = parseApplicationAuthorityArtifactBody({ ...createCase.request, intent: 'browser-import' });
    const f = ports();
    const receipt = await readApplicationAuthorityArtifact(request, 'standard_user', f.ports);
    expect(receipt.intent).toBe('browser-import');
    expect(receipt.operations).toContain('artifact.generate');
    await expect(readApplicationAuthorityArtifact(request, 'client_portal_user', ports().ports)).rejects.toThrow();
    await expect(readApplicationAuthorityArtifact(request, 'standard_user', { ...ports().ports,
      clientVisible: async () => { throw new ForbiddenException(); } })).rejects.toThrow(ForbiddenException);
  });

  it.each([
    ['office-import', 'artifact.generate'],
    ['office-edit', 'artifact.revise'],
  ] as const)('admits %s only through existing current artifact permissions and client walls', async (intent, operation) => {
    const request = parseApplicationAuthorityArtifactBody({ ...createCase.request, intent });
    expect(ARTIFACT_INTENT_OPERATIONS[intent]).toEqual([operation]);
    const receipt = await readApplicationAuthorityArtifact(request, 'standard_user', ports().ports);
    expect(receipt.intent).toBe(intent);
    expect(receipt.operations).toContain(operation);
    await expect(readApplicationAuthorityArtifact(request, 'client_portal_user', ports().ports)).rejects.toThrow();
    await expect(readApplicationAuthorityArtifact(request, 'standard_user', { ...ports().ports,
      clientVisible: async () => { throw new ForbiddenException(); } })).rejects.toThrow(ForbiddenException);
  });

  it("ports Meri's receipt check faithfully: it accepts each vector receipt and refuses all 18 vector refusals", () => {
    for (const c of vector.cases) expect(meriAccepts(c.receipt, c.request)).toBe(true);
    expect(vector.receiptRefusals).toHaveLength(18);
    for (const refusal of vector.receiptRefusals) {
      const receipt = clone(createCase.receipt);
      const patched = refusal.patch === undefined ? receipt : Object.assign(receipt, refusal.patch);
      if (typeof refusal.remove === 'string') delete patched[refusal.remove];
      expect({ name: refusal.name, accepted: meriAccepts(patched, createCase.request) }).toEqual({ name: refusal.name, accepted: false });
    }
  });

  it('parses exactly the vector request bytes and refuses any other body with 400', () => {
    for (const c of vector.cases) {
      expect(parseApplicationAuthorityArtifactBody(JSON.parse(c.requestJson))).toEqual(c.request);
    }
    const base = createCase.request;
    for (const bad of [
      { ...base, extra: 1 }, { ...base, contract: 'capiro.meri-artifact-authority.v2' },
      { ...base, observationId: '00000000-0000-1000-8000-00000000e001' }, { ...base, conversationId: base.conversationId.toUpperCase() },
      { ...base, intent: 'publish' }, { ...base, requestSha256: 'A'.repeat(64) }, (() => { const { intent: _i, ...rest } = base; return rest; })(),
      null, [], 'x',
    ]) expect(() => parseApplicationAuthorityArtifactBody(bad)).toThrow(BadRequestException);
  });

  it('emits receipts Meri accepts for every vector intent, re-reading identity and context exactly as /context', async () => {
    for (const intent of Object.keys(vector.intentOperations)) {
      const f = ports();
      const request = { ...createCase.request, intent };
      const receipt = await readApplicationAuthorityArtifact(parseApplicationAuthorityArtifactBody(request), 'standard_user', f.ports);
      expect(Object.keys(receipt)).toEqual(RECEIPT_KEYS);
      expect(meriAccepts(receipt, request)).toBe(true);
      expect(receipt).toMatchObject({ operations: [...ARTIFACT_OPERATIONS], limits: null, principal: { tenantId, actorId } });
      expect(receipt.expiresAtMs - receipt.checkedAtMs).toBe(60_000);
      expect(f.events).toEqual(['identity', 'conversation', 'scope', 'visible', 'wall', 'identity', 'conversation', 'scope', 'visible', 'wall']);
    }
  });

  it.each(['history', 'list', 'results'] as const)('admits %s only through current private-conversation read authority', async intent => {
    const request = parseApplicationAuthorityArtifactBody({ ...createCase.request, intent });
    const f = ports();
    const receipt = await readApplicationAuthorityArtifact(request, 'standard_user', f.ports);
    expect(receipt).toMatchObject({ intent, requestSha256: request.requestSha256,
      principal: { tenantId, actorId }, conversationId: request.conversationId,
      selectedClientId: request.clientId, operations: [...ARTIFACT_OPERATIONS] });
    expect(ARTIFACT_INTENT_OPERATIONS[intent]).toEqual(['artifact.inspect']);
    expect(f.events).toEqual(['identity', 'conversation', 'scope', 'visible', 'wall',
      'identity', 'conversation', 'scope', 'visible', 'wall']);
    await expect(readApplicationAuthorityArtifact(request, 'client_portal_user', ports().ports))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(readApplicationAuthorityArtifact(request, 'standard_user',
      ports({ clientId: '00000000-0000-4000-8000-00000000d002' }).ports)).rejects.toThrow();
    const revoked = ports();
    revoked.ports.clientVisible = async () => { throw new ForbiddenException(); };
    await expect(readApplicationAuthorityArtifact(request, 'standard_user', revoked.ports))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps authorityRevision equal across observations of one request, and moves it with role', async () => {
    const one = await readApplicationAuthorityArtifact(createCase.request, 'standard_user', ports().ports);
    const two = await readApplicationAuthorityArtifact({ ...createCase.request, observationId: '00000000-0000-4000-8000-00000000e002' }, 'standard_user', ports().ports);
    expect(two.authorityRevision).toBe(one.authorityRevision);
    expect(two.observationId).toBe('00000000-0000-4000-8000-00000000e002');
    const admin = await readApplicationAuthorityArtifact(createCase.request, 'user_admin', ports().ports);
    expect(admin.authorityRevision).not.toBe(one.authorityRevision);
  });

  it('never outlives the identity, refuses an elapsed one, and refuses a role outside the admitted set or a conversation/client mismatch', async () => {
    const short = await readApplicationAuthorityArtifact(createCase.request, 'standard_user', ports({ identityExpiresInMs: 5_000 }).ports);
    expect(short.expiresAtMs - short.checkedAtMs).toBeLessThanOrEqual(5_000);
    await expect(readApplicationAuthorityArtifact(createCase.request, 'standard_user', ports({ identityExpiresInMs: -1 }).ports)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(readApplicationAuthorityArtifact(createCase.request, 'client_portal_user', ports().ports)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(readApplicationAuthorityArtifact(createCase.request, 'standard_user', ports({ clientId: '00000000-0000-4000-8000-00000000d002' }).ports)).rejects.toThrow();
  });

  it('requires a VERIFIED service identity, not only a passing guard', async () => {
    const SECRET = 'synthetic-service-secret';
    const req = (secret: string) => {
      const r = { headers: { 'x-internal-service-secret': secret }, method: 'POST', path: '/api/clio/application-authority/artifact' } as unknown as Request;
      // Observe mode (development): the guard lets a wrong secret through but does not verify it.
      new ToolServiceSecretGuard({ get: (key: string) => (key === 'NODE_ENV' ? 'development' : key === 'INTERNAL_SERVICE_SECRET' ? SECRET : false) } as never)
        .canActivate({ switchToHttp: () => ({ getRequest: () => r }) } as unknown as ExecutionContext);
      return r;
    };
    const f = ports();
    const tenant = { readApplicationAuthority: jest.fn(f.ports.identity) };
    const controller = new ApplicationAuthorityController({} as never, tenant as never, { resolveApplicationAuthorityClient: f.ports.clientAuthority } as never, {} as never, {} as never);
    // Swap the DB-backed owners for the fake ports; the guard/identity check under test runs first.
    (controller as unknown as { contextPorts: () => unknown }).contextPorts = () => f.ports;
    const ctx = { tenantId, userId: actorId, role: 'standard_user' } as TenantContext;
    await expect(controller.applicationAuthorityArtifact(ctx, req('wrong'), clone(createCase.request))).rejects.toBeInstanceOf(ForbiddenException);
    expect(tenant.readApplicationAuthority).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    const receipt = await controller.applicationAuthorityArtifact(ctx, req(SECRET), clone(createCase.request));
    expect(meriAccepts(receipt, createCase.request)).toBe(true);
    await expect(controller.applicationAuthorityArtifact(ctx, req(SECRET), { ...createCase.request, extra: 1 })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('explicit General artifact authority v2 through the existing current owner', () => {
  const body = () => ({ ...createCase.request, contract: ARTIFACT_AUTHORITY_V2_CONTRACT,
    scopeKind: 'general' as const, clientId: null });
  function general() {
    const f = ports(), ctx = { tenantId, userId: actorId, role: 'standard_user' } as TenantContext;
    const row: any = { id: createCase.request.conversationId, tenantId, userId: actorId,
      clientId: null, status: 'active', archivedAt: null, metadata: {} };
    let receipt: any = { requestId: createCase.request.observationId };
    let membershipAllowed = true, role = 'standard_user';
    const requests: any[] = [];
    const tx = {
      clioConversation: { findFirst: jest.fn(async () => row) },
      clioConversationBootstrapReceipt: { findFirst: jest.fn(async (request: any) => { requests.push(request); return receipt; }) },
    };
    const prisma = { withSystem: jest.fn(async (run: (value: unknown) => Promise<unknown>, options: unknown) => {
      expect(options).toEqual({ isolationLevel: 'RepeatableRead', readOnly: true });return run(tx);
    }) };
    const tenant = { readApplicationAuthoritySession: jest.fn(async () => ({ readCurrent: f.ports.identity })) };
    const membership = { readInTransaction: jest.fn(async () => {
      if (!membershipAllowed) throw new ForbiddenException();
      return { role, permissions: [], clientIds: [], membershipRevision: 'd'.repeat(64) };
    }) };
    const security = { resolveApplicationAuthorityClient: jest.fn(async () => { throw Error('General has no client wall'); }) };
    const controller = new ApplicationAuthorityController(prisma as never, tenant as never, security as never, {} as never, new ApplicationCurrentService(prisma as never, tenant as never, security as never, {} as never, membership as never));
    const req = { headers: { 'x-internal-service-secret': 'synthetic-service-secret' } } as unknown as Request;
    new ToolServiceSecretGuard({ get: (key: string) => key === 'NODE_ENV' ? 'test'
      : key === 'INTERNAL_SERVICE_SECRET' ? 'synthetic-service-secret' : false } as never)
      .canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext);
    return { controller, req, ctx, row, prisma, tenant, membership, security, requests,
      loseReceipt: () => { receipt = null; }, revoke: () => { membershipAllowed = false; },
      setRole: (value: string) => { role = value; } };
  }

  it.each(Object.keys(ARTIFACT_INTENT_OPERATIONS))('uses persisted General and current membership for %s', async intent => {
    const f = general(), receipt = await f.controller.applicationAuthorityArtifact(f.ctx, f.req, { ...body(), intent });
    expect(receipt).toMatchObject({ contract: ARTIFACT_AUTHORITY_V2_CONTRACT, scopeKind: 'general',
      selectedClientId: null, principal: { tenantId, actorId }, operations: [...ARTIFACT_OPERATIONS], limits: null });
    expect(receipt.expiresAtMs - receipt.checkedAtMs).toBeLessThanOrEqual(60_000);
    expect(f.requests).toEqual([{ where: { tenantId, actorUserId: actorId, conversationId: body().conversationId,
      scopeKind: 'general', clientId: null }, select: { requestId: true } }]);
    expect(f.membership.readInTransaction).toHaveBeenCalledTimes(1);
    expect(f.security.resolveApplicationAuthorityClient).not.toHaveBeenCalled();
  });

  it('requires explicit scope/null correspondence while preserving all v1 request bytes', () => {
    expect(parseApplicationAuthorityArtifactBody(body())).toEqual(body());
    expect(parseApplicationAuthorityArtifactBody({ ...body(), scopeKind: 'client', clientId: createCase.request.clientId }))
      .toMatchObject({ scopeKind: 'client', clientId: createCase.request.clientId });
    for (const bad of [{ ...body(), scopeKind: 'client' }, { ...body(), clientId: createCase.request.clientId },
      { ...body(), scopeKind: undefined }, { ...body(), clientId: undefined },
      { ...createCase.request, scopeKind: 'client' }, { ...body(), extra: true }])
      expect(() => parseApplicationAuthorityArtifactBody(bad)).toThrow(BadRequestException);
    for (const c of vector.cases) expect(parseApplicationAuthorityArtifactBody(c.request)).toEqual(c.request);
  });

  it.each(['identity', 'transaction'])('preserves %s unavailability as retryable without a receipt', async kind => {
    const f = general();
    if (kind === 'identity') f.tenant.readApplicationAuthoritySession.mockRejectedValueOnce(new ServiceUnavailableException());
    else f.prisma.withSystem.mockRejectedValueOnce(new Error('synthetic database unavailable'));
    await expect(f.controller.applicationAuthorityArtifact(f.ctx, f.req, body())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.security.resolveApplicationAuthorityClient).not.toHaveBeenCalled();
  });

  it.each(['receipt', 'member', 'role', 'actor', 'tenant', 'client', 'inactive', 'research'])(
    'refuses %s mismatch without a client fallback', async kind => {
      const f = general();
      if (kind === 'receipt') f.loseReceipt();
      if (kind === 'member') f.revoke();
      if (kind === 'role') f.setRole('client_portal_user');
      if (kind === 'actor') f.row.userId = '00000000-0000-4000-8000-000000000099';
      if (kind === 'tenant') f.row.tenantId = '00000000-0000-4000-8000-000000000099';
      if (kind === 'client') f.row.clientId = createCase.request.clientId;
      if (kind === 'inactive') f.row.status = 'archived';
      if (kind === 'research') f.row.metadata.researchPortfolioScope = {};
      await expect(f.controller.applicationAuthorityArtifact(f.ctx, f.req, body())).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.security.resolveApplicationAuthorityClient).not.toHaveBeenCalled();
    });
});

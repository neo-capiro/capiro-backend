import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { canonicalWorkspaceSnapshot } from '@capiro/shared';
import { BadRequestException, ConflictException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { VersionsService } from './versions.service.js';
import { VersionsController } from './versions.controller.js';
import { TenantGuard } from '../auth/tenant.guard.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const tenantId = id(1), userId = id(2), draftId = id(11), versionId = id(12), clientId = id(13), objectiveId = id(14), objectiveRevisionId = id(15);
const clerkUserId = 'user_fixture';
const snapshot = { docTitle: 'Saved work', config: { clientId, sections: ['Update'], sectionContent: { Update: '<p>Exact saved prose.</p>' } }, documents: [{ id: id(16), body: { blocks: [] } }], ask: null };
const hash = (value: unknown) => createHash('sha256').update(canonicalWorkspaceSnapshot(value)).digest('hex');

function harness() {
  const state = {
    tenant: true, member: true, draft: true, version: true, ownerId: clerkUserId,
    role: 'viewer' as string | null, prospectId: null as string | null, sourceType: null as string | null,
    currentConfig: { clientId } as Record<string, unknown>, clientDisplay: null as string | null,
    snapshot: structuredClone(snapshot) as any, client: true, memoryWall: true, grant: true,
    wallAllowed: true, objectiveScope: true, objective: true, objectiveVersion: 3,
    revision: true, failOn: null as string | null, error: new Error('INFRASTRUCTURE_FAILURE'),
  };
  const sql: Array<{ text: string; params: unknown[] }> = [];
  const query = async (text: string, params: unknown[]) => {
    sql.push({ text, params });
    if (state.failOn && text.includes(state.failOn)) throw state.error;
    if (text.includes('set_config')) return [];
    if (text.includes('FROM tenant_memberships')) return state.member && params[1] === clerkUserId ? [{ userId }] : [];
    if (text.includes('FROM tenants t')) return state.objectiveScope && state.tenant && state.member && state.client ? [{ userId, memoryWall: state.memoryWall }] : [];
    if (text.includes('FROM tenants ')) return state.tenant && params[0] === tenantId ? [{ id: tenantId }] : [];
    if (text.includes('FROM ws_draft')) return state.draft && String(params[1]).toLowerCase() === draftId ? [{ ownerId: state.ownerId, prospectId: state.prospectId, config: state.currentConfig, client: state.clientDisplay }] : [];
    if (text.includes('FROM ws_source_action')) return state.sourceType ? [{ sourceType: state.sourceType }] : [];
    if (text.includes('FROM ws_collaborator')) return state.role ? [{ role: state.role }] : [];
    if (text.includes('FROM ws_doc_version')) return state.version && String(params[1]).toLowerCase() === draftId && String(params[2]).toLowerCase() === versionId ? [{ id: versionId, snapshot: state.snapshot, authorId: 'user_original', authorKind: 'person', createdAt: new Date('2026-10-12T00:00:00Z') }] : [];
    if (text.includes('SELECT (NOT c.memory_wall')) return [{ allowed: state.wallAllowed }];
    if (text.includes('FROM clients ')) return state.client ? [{ memoryWall: state.memoryWall }] : [];
    if (text.includes('FROM client_memory_access')) return state.grant ? [{ id: id(17) }] : [];
    if (text.includes('FROM client_objective_revisions')) return state.revision ? [{ id: objectiveRevisionId }] : [];
    if (text.includes('FROM client_objectives')) return state.objective ? [{ version: state.objectiveVersion }] : [];
    throw new Error(`Unexpected source query ${text}`);
  };
  const tx = {
    $executeRaw: jest.fn(async (parts: TemplateStringsArray, ...params: unknown[]) => query(parts.join('?'), params)),
    $queryRawUnsafe: jest.fn(async (text: string, ...params: unknown[]) => query(text, params)),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...params: unknown[]) => query(parts.join('?'), params)),
  };
  const prisma = { $transaction: jest.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) };
  const service = new VersionsService(prisma as any, {} as any);
  const input = { clientId, objectiveId, objectiveVersion: 3 };
  const resolve = (override = {}, actor = clerkUserId, parent = draftId, version = versionId) => service.objectiveDestination(tenantId, parent, version, actor, { ...input, ...override });
  return { state, sql, tx, prisma, service, resolve };
}

describe('canonical saved Workspace revision Objective destination', () => {
  it('binds exact saved version and parent to current Objective revision in one read-only transaction', async () => {
    const h = harness(); const result = await h.resolve();
    expect(result.destination).toEqual({ kind: 'workspace_saved_revision', resourceId: versionId, draftId, clientId, objectiveId, objectiveVersion: 3, objectiveRevisionId });
    expect(result.snapshot).toEqual(snapshot); expect(result.snapshotHash).toBe(hash(snapshot));
    expect(result).toMatchObject({ authorId: 'user_original', authorKind: 'person', savedAt: '2026-10-12T00:00:00.000Z', hashFormat: 'workspace-snapshot-canonical-json-v1' });
    expect(result.contentSkeleton.body).toBe('Update\nExact saved prose.');
    expect(result.destination).not.toHaveProperty('destinationStateVersion');
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.sql.every((q) => !/\b(INSERT|UPDATE|DELETE)\b/.test(q.text))).toBe(true);
    expect(h.sql[0]?.text).toContain('app.current_tenant');
    expect(h.sql.some((q) => q.text.includes('app.current_user') && q.params[0] === userId)).toBe(true);
  });
  it('reads selected saved bytes after working text changes and normalizes UUID case', async () => {
    const h = harness(); h.state.currentConfig.sectionContent = { Update: 'Unsaved work' };
    const result = await h.resolve({ clientId: clientId.toUpperCase(), objectiveId: objectiveId.toUpperCase() }, clerkUserId, draftId.toUpperCase(), versionId.toUpperCase());
    expect(result.snapshotHash).toBe(hash(snapshot)); expect(result.destination.clientId).toBe(clientId);
  });
  it.each(['tenant', 'member', 'draft', 'version', 'client', 'grant', 'wallAllowed', 'objectiveScope', 'objective', 'revision'])('fails closed on current %s unavailability', async (field) => {
    const h = harness(); (h.state as any)[field] = false;
    await expect(h.resolve()).rejects.toBeInstanceOf(NotFoundException);
  });
  it('never fabricates a Core UUID from Workspace Clerk context', async () => {
    const h = harness(); await expect(h.resolve({}, 'user_other')).rejects.toBeInstanceOf(NotFoundException);
    expect(h.sql.every((q) => !q.text.includes(clerkUserId))).toBe(true);
  });
  it.each([null, 'pending', 'unsupported'])('refuses absent/unsupported active draft role %s', async (role) => {
    const h = harness(); h.state.ownerId = 'user_other'; h.state.role = role;
    await expect(h.resolve()).rejects.toBeInstanceOf(NotFoundException);
  });
  it('uses current viewer read/export rights and rechecks every replay after ACL revocation', async () => {
    const h = harness(); h.state.ownerId = 'user_other'; await h.resolve(); h.state.role = null;
    await expect(h.resolve()).rejects.toBeInstanceOf(NotFoundException); expect(h.prisma.$transaction).toHaveBeenCalledTimes(2);
  });
  it.each(['legiwatch_research', 'legiwatch_editorial', 'legiwatch_preparation', 'future_source'])('retains %s source-origin exclusion', async (sourceType) => {
    const h = harness(); h.state.sourceType = sourceType; await expect(h.resolve()).rejects.toBeInstanceOf(NotFoundException);
  });
  it('retains immutable prospect exclusion', async () => {
    const h = harness(); h.state.prospectId = id(18); await expect(h.resolve()).rejects.toBeInstanceOf(NotFoundException);
  });
  it('refuses null/free-text source clients before exposing a stale Objective conflict', async () => {
    const h = harness(); delete h.state.snapshot.config.clientId; h.state.currentConfig = {}; h.state.clientDisplay = 'Client display'; h.state.objectiveVersion = 4;
    await expect(h.resolve()).rejects.toBeInstanceOf(NotFoundException);
    expect(h.sql.some((q) => q.text.includes('FROM client_objectives'))).toBe(false);
  });
  it('refuses cross-client query and current/saved reassignment before querying Objective version', async () => {
    const h = harness(); h.state.objectiveVersion = 4;
    await expect(h.resolve({ clientId: id(19) })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.sql.some((q) => q.text.includes('FROM client_objectives'))).toBe(false);
    h.state.currentConfig.clientId = id(19); await expect(h.resolve()).rejects.toBeInstanceOf(NotFoundException);
  });
  it('returns typed conflict only for an authorized same-client stale current Objective', async () => {
    const h = harness(); h.state.objectiveVersion = 4;
    try { await h.resolve(); throw new Error('Expected conflict'); } catch (error) {
      expect(error).toBeInstanceOf(ConflictException); expect((error as ConflictException).getResponse()).toMatchObject({ code: 'OBJECTIVE_VERSION_CONFLICT' });
    }
  });
  it.each([0, -1, 1.5, 2147483648, NaN])('rejects invalid bounded Objective version %s before a transaction', async (objectiveVersion) => {
    const h = harness(); await expect(h.resolve({ objectiveVersion })).rejects.toBeInstanceOf(BadRequestException); expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(['clientId', 'objectiveId'])('rejects malformed scalar %s service inputs', async (field) => {
    const h = harness(); await expect(h.resolve({ [field]: [id(19)] })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects mismatched parent/version identity', async () => {
    const h = harness(); await expect(h.resolve({}, clerkUserId, id(19))).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.resolve({}, clerkUserId, draftId, id(19))).rejects.toBeInstanceOf(NotFoundException);
  });
  it('rechecks current Objective authority for repeated opens', async () => {
    const h = harness(); await h.resolve(); h.state.objectiveVersion = 4; await expect(h.resolve()).rejects.toBeInstanceOf(ConflictException);
  });
  it.each(['FROM ws_draft', 'FROM client_objectives'])('propagates infrastructure failure at %s without 404 or retry', async (failOn) => {
    const h = harness(); h.state.failOn = failOn; await expect(h.resolve()).rejects.toBe(h.state.error); expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it('keeps mutable locks and plain immutable receipt/revision reads', async () => {
    const h = harness(); await h.resolve();
    for (const table of ['ws_draft', 'ws_doc_version', 'client_objectives']) expect(h.sql.find((q) => q.text.includes(`FROM ${table}`))?.text).toContain('FOR SHARE');
    expect(h.sql.find((q) => q.text.includes('FROM ws_source_action'))?.text).not.toContain('FOR SHARE');
    expect(h.sql.find((q) => q.text.includes('FROM client_objective_revisions'))?.text).not.toContain('FOR SHARE');
  });
});

describe('saved revision Objective destination transport', () => {
  let app: any, h: ReturnType<typeof harness>;
  const path = `/workspace-api/drafts/${draftId}/versions/${versionId}/objective-destination`;
  const query = { clientId, objectiveId, objectiveVersion: '3' };
  beforeAll(async () => {
    h = harness();
    const module = await Test.createTestingModule({ controllers: [VersionsController], providers: [{ provide: VersionsService, useValue: h.service }] })
      .overrideGuard(TenantGuard).useValue({ canActivate(ctx: any) { ctx.switchToHttp().getRequest().tenantContext = { tenantId, clerkUserId, role: null }; return true; } }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('workspace-api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
    await app.init();
  });
  afterAll(async () => { await app?.close(); });
  it('returns literal owner binding with private no-store caching', async () => {
    const response = await request(app.getHttpServer()).get(path).query(query);
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.destination.resourceId).toBe(versionId);
  });
  it.each(['clientId', 'objectiveId', 'objectiveVersion'])('requires query field %s', async (field) => {
    const data = { ...query }; delete (data as any)[field]; expect((await request(app.getHttpServer()).get(path).query(data)).status).toBe(400);
  });
  it.each(['actor', 'tenantId', 'kind', 'resourceId', 'objectiveRevisionId', 'snapshotHash'])('refuses arbitrary query claim %s', async (field) => {
    expect((await request(app.getHttpServer()).get(path).query({ ...query, [field]: 'injected' })).status).toBe(400);
  });
  it.each(['clientId', 'objectiveId', 'objectiveVersion'])('rejects repeated/nested query field %s', async (field) => {
    expect((await request(app.getHttpServer()).get(path).query({ ...query, [field]: [query[field as keyof typeof query], query[field as keyof typeof query]] })).status).toBe(400);
    expect((await request(app.getHttpServer()).get(path).query({ ...query, [field]: { nested: query[field as keyof typeof query] } })).status).toBe(400);
  });
  it('rejects malformed path identities before owner access', async () => {
    expect((await request(app.getHttpServer()).get('/workspace-api/drafts/no/versions/no/objective-destination').query(query)).status).toBe(400);
  });
});

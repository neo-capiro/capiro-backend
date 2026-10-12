import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BadRequestException, ConflictException, NotFoundException, ParseUUIDPipe, ValidationPipe } from '@nestjs/common';
import { canonicalWorkspaceSnapshot } from '../../../../packages/shared/src/workspace-saved-revision';
import { VersionsService } from '../../../../apps/workspace/src/versions/versions.service';
import { VersionsController } from '../../../../apps/workspace/src/versions/versions.controller';
import { WorkspaceObjectiveDestinationQueryDto } from '../../../../apps/workspace/src/versions/dto/objective-destination.dto';

const id = (n: number) => `face0000-1234-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = id(1), userId = id(2), draftId = id(3), versionId = id(4), clientId = id(5), objectiveId = id(6), revisionId = id(7);
const clerkUserId = 'user_independent';
const input = { clientId, objectiveId, objectiveVersion: 3 };
const saved = {
  docTitle: 'Exact saved title', config: { clientId, sections: ['News'], sectionContent: { News: '<p>Saved prose.</p>' } },
  documents: [{ id: id(8), name: 'Primary', ordinal: 0, body: { blocks: [] } }], ask: { amount: '10' },
};
const hash = (snapshot: unknown) => createHash('sha256').update(canonicalWorkspaceSnapshot(snapshot)).digest('hex');
const equalId = (left: unknown, right: string) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase();

function fixture() {
  const state = {
    tenant: tenantId, tenantStatus: 'active', userId, clerk: clerkUserId, memberStatus: 'active', memberRole: 'standard_user',
    draftExists: true, draftTenant: tenantId, draftOwner: clerkUserId, prospectId: null as string | null,
    currentConfig: { clientId } as any, currentDisplay: null as string | null,
    sourceTypes: [] as string[], collaboratorStatus: 'active', collaboratorRole: 'viewer' as string | null,
    versionExists: true, versionTenant: tenantId, versionDraft: draftId, snapshot: structuredClone(saved) as any,
    clientExists: true, clientTenant: tenantId, clientStatus: 'active', wall: true, grant: true, canonicalWallAllowed: true,
    objectiveExists: true, objectiveTenant: tenantId, objectiveClient: clientId, objectiveId, objectiveDeleted: false,
    objectiveVersion: 3, revisionExists: true, revisionTenant: tenantId, revisionClient: clientId, revisionObjective: objectiveId,
    revisionId, failAt: '', marker: Object.assign(new Error('INDEPENDENT_INFRASTRUCTURE_FAILURE'), { code: '40P01' }),
  };
  const sql: Array<{ text: string; values: unknown[]; phase: string }> = [];
  let waitAt = '', release: (() => void) | undefined;
  let waited: Promise<void> | undefined;
  let entered: (() => void) | undefined;
  const query = async (text: string, values: unknown[], method: 'unsafe' | 'tagged' | 'execute') => {
    const phase = text.includes('app.current_tenant') ? 'tenant_context' : text.includes('app.current_user') ? 'user_context' :
      text.includes('FROM tenants t') ? 'objective_scope' : text.includes('FROM tenants ') ? 'source_tenant' :
      text.includes('FROM tenant_memberships') ? 'source_member' : text.includes('FROM ws_draft') ? 'draft' :
      text.includes('FROM ws_source_action') ? 'origin' : text.includes('FROM ws_collaborator') ? 'collaborator' :
      text.includes('FROM ws_doc_version') ? 'saved_version' : text.includes('SELECT (NOT c.memory_wall') ? 'wall_predicate' :
      text.includes('FROM clients') ? 'source_client' : text.includes('FROM client_memory_access') ? (method === 'unsafe' ? 'source_grant' : 'objective_grant') :
      text.includes('FROM client_objective_revisions') ? 'objective_revision' : text.includes('FROM client_objectives') ? 'objective' : 'unknown';
    sql.push({ text, values, phase });
    if (phase === waitAt) { waitAt = ''; entered!(); await waited; }
    if (phase === state.failAt) throw state.marker;
    if (phase === 'tenant_context' || phase === 'user_context') return [];
    if (phase === 'source_tenant') return equalId(values[0], state.tenant) && state.tenantStatus === 'active' ? [{ id: state.tenant }] : [];
    if (phase === 'source_member') return equalId(values[0], state.tenant) && values[1] === state.clerk && (values[2] === null || values[2] === state.userId) && state.memberStatus === 'active' && ['standard_user', 'user_admin', 'capiro_admin'].includes(state.memberRole) ? [{ userId: state.userId }] : [];
    if (phase === 'draft') return state.draftExists && equalId(values[0], state.draftTenant) && equalId(values[1], draftId) ? [{ ownerId: state.draftOwner, prospectId: state.prospectId, config: structuredClone(state.currentConfig), client: state.currentDisplay }] : [];
    if (phase === 'origin') {
      if (/FOR\s+(?:SHARE|UPDATE|KEY\s+SHARE|NO\s+KEY\s+UPDATE)/i.test(text)) throw Object.assign(new Error('source receipt row locking requires forbidden UPDATE grant'), { code: '42501' });
      return state.sourceTypes.map((sourceType) => ({ sourceType }));
    }
    if (phase === 'collaborator') return values[2] === state.clerk && state.collaboratorStatus === 'active' && state.collaboratorRole ? [{ role: state.collaboratorRole }] : [];
    if (phase === 'saved_version') return state.versionExists && equalId(values[0], state.versionTenant) && equalId(values[1], state.versionDraft) && equalId(values[2], versionId) ? [{ id: versionId, snapshot: structuredClone(state.snapshot), authorId: 'user_original', authorKind: 'person', createdAt: new Date('2026-10-12T09:00:00Z') }] : [];
    if (phase === 'source_client') return state.clientExists && equalId(values[0], state.clientTenant) && equalId(values[1], clientId) && state.clientStatus !== 'archived' ? [{ memoryWall: state.wall }] : [];
    if (phase === 'wall_predicate') return [{ allowed: state.canonicalWallAllowed }];
    if (phase === 'source_grant' || phase === 'objective_grant') return state.grant && equalId(values[0], state.clientTenant) && equalId(values[1], clientId) && values[2] === state.userId ? [{ id: id(9) }] : [];
    if (phase === 'objective_scope') return equalId(values[0], state.tenant) && state.tenantStatus === 'active' && (values[1] === null || values[1] === state.userId) && values[2] === state.clerk && equalId(values[3], clientId) && state.memberStatus === 'active' && ['standard_user', 'user_admin', 'capiro_admin'].includes(state.memberRole) && state.clientExists && state.clientStatus !== 'archived' ? [{ userId: state.userId, memoryWall: state.wall }] : [];
    if (phase === 'objective') return state.objectiveExists && !state.objectiveDeleted && equalId(values[0], state.objectiveTenant) && equalId(values[1], state.objectiveClient) && equalId(values[2], state.objectiveId) ? [{ version: state.objectiveVersion }] : [];
    if (phase === 'objective_revision') {
      if (/FOR\s+(?:SHARE|UPDATE|KEY\s+SHARE|NO\s+KEY\s+UPDATE)/i.test(text)) throw Object.assign(new Error('Objective revision row locking requires forbidden UPDATE grant'), { code: '42501' });
      return state.revisionExists && equalId(values[0], state.revisionTenant) && equalId(values[1], state.revisionClient) && equalId(values[2], state.revisionObjective) && values[3] === state.objectiveVersion ? [{ id: state.revisionId }] : [];
    }
    throw new Error(`Unrecognized reviewer SQL: ${text}`);
  };
  const tx = {
    $executeRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => query(parts.join('?'), values, 'execute')),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => query(parts.join('?'), values, 'tagged')),
    $queryRawUnsafe: jest.fn(async (text: string, ...values: unknown[]) => query(text, values, 'unsafe')),
  };
  const prisma = { $transaction: jest.fn(async (work) => work(tx)) };
  const collaborators = { assertCan: jest.fn(() => { throw new Error('unexpected legacy/network authorization path'); }) };
  const owner = new VersionsService(prisma as any, collaborators as any);
  const read = (override = {}, actor = clerkUserId, parent = draftId, selectedVersion = versionId, tenant = tenantId) => owner.objectiveDestination(tenant, parent, selectedVersion, actor, { ...input, ...override });
  const pause = (phase: string) => {
    waitAt = phase; waited = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    return { reached, release: () => release!() };
  };
  return { state, sql, tx, prisma, owner, read, pause, collaborators };
}

describe('independent actual Workspace and Objective source seams', () => {
  it('returns one exact saved snapshot/projection/hash and current Objective binding in one read-only tx', async () => {
    const f = fixture(); const result = await f.read();
    expect(result.destination).toEqual({ kind: 'workspace_saved_revision', resourceId: versionId, draftId, ...input, objectiveRevisionId: revisionId });
    expect(result.snapshot).toEqual(saved); expect(result.snapshotHash).toBe(hash(saved));
    expect(result.contentSkeleton).toEqual({ subject: 'Exact saved title', body: 'News\nSaved prose.', slots: [] });
    expect(result).toMatchObject({ versionId, draftId, clientId, authorId: 'user_original', authorKind: 'person', savedAt: '2026-10-12T09:00:00.000Z', hashFormat: 'workspace-snapshot-canonical-json-v1' });
    expect(result).not.toHaveProperty('snapshotJson'); expect(result.destination).not.toHaveProperty('destinationStateVersion');
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1); expect(f.collaborators.assertCan).not.toHaveBeenCalled();
    expect(f.sql[0]).toMatchObject({ phase: 'tenant_context', values: [tenantId] });
    expect(f.sql.find((q) => q.phase === 'user_context')?.values).toEqual([userId]);
    expect(f.sql.every((q) => !/\b(?:INSERT|UPDATE\s+\w|DELETE|TRUNCATE)\b/.test(q.text))).toBe(true);
  });
  it('hashes the entire saved snapshot including ask/config while ignoring live working prose', async () => {
    const f = fixture(); f.state.currentConfig.sectionContent = { News: 'Unsaved text' };
    const first = await f.read(); expect(first.snapshotHash).toBe(hash(saved)); expect(first.contentSkeleton.body).not.toContain('Unsaved text');
    f.state.snapshot.ask.amount = '11'; const changed = await f.read(); expect(changed.snapshotHash).not.toBe(first.snapshotHash); expect(changed.contentSkeleton).toEqual(first.contentSkeleton);
  });
  it('normalizes canonical UUID case without trusting browser resource or revision claims', async () => {
    const f = fixture(); const result = await f.read({ clientId: clientId.toUpperCase(), objectiveId: objectiveId.toUpperCase() }, clerkUserId, draftId.toUpperCase(), versionId.toUpperCase());
    expect(result.destination).toEqual({ kind: 'workspace_saved_revision', resourceId: versionId, draftId, ...input, objectiveRevisionId: revisionId });
  });
  it.each(['tenantStatus', 'memberStatus', 'memberRole', 'clerk', 'clientExists', 'clientStatus', 'grant', 'canonicalWallAllowed'] as const)('rechecks current %s on every open', async (field) => {
    const f = fixture(); await f.read();
    const values = { tenantStatus: 'suspended', memberStatus: 'removed', memberRole: 'client_user', clerk: 'user_other', clientExists: false, clientStatus: 'archived', grant: false, canonicalWallAllowed: false };
    (f.state as any)[field] = values[field];
    await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
  });
  it('both scopes use current actual Clerk-to-Core mapping, and resource/admin ownership does not bypass wall', async () => {
    const f = fixture(); f.state.memberRole = 'capiro_admin'; await f.read();
    expect(f.sql.find((q) => q.phase === 'source_member')?.values).toEqual([tenantId, clerkUserId, null]);
    expect(f.sql.find((q) => q.phase === 'objective_scope')?.values).toEqual([tenantId, null, clerkUserId, clientId]);
    expect(f.sql.filter((q) => ['source_grant', 'objective_grant'].includes(q.phase)).every((q) => q.values[2] === userId)).toBe(true);
    f.state.grant = false; await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.read({}, 'user_other')).rejects.toBeInstanceOf(NotFoundException);
  });
  it.each(['viewer', 'commenter', 'reviewer', 'editor'])('retains current active Workspace %s read rights, then denies revocation', async (role) => {
    const f = fixture(); f.state.draftOwner = 'user_other'; f.state.collaboratorRole = role;
    await expect(f.read()).resolves.toHaveProperty('destination.resourceId', versionId);
    f.state.collaboratorStatus = 'pending'; await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
  });
  it.each([null, 'pending', 'unknown'])('fails closed for unsupported Workspace role %s even with authorized Objective', async (role) => {
    const f = fixture(); f.state.draftOwner = 'user_other'; f.state.collaboratorRole = role;
    await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.sql.some((q) => q.phase === 'objective_scope')).toBe(false);
  });
  it('requires exact draft/version/tenant binding, never a sibling or current document substitute', async () => {
    for (const kind of ['parent', 'version', 'version_tenant', 'version_draft', 'draft_tenant']) {
      const f = fixture();
      if (kind === 'version_tenant') f.state.versionTenant = id(90);
      if (kind === 'version_draft') f.state.versionDraft = id(91);
      if (kind === 'draft_tenant') f.state.draftTenant = id(92);
      await expect(f.read({}, clerkUserId, kind === 'parent' ? id(93) : draftId, kind === 'version' ? id(94) : versionId)).rejects.toBeInstanceOf(NotFoundException);
      expect(f.sql.some((q) => q.phase === 'objective_scope')).toBe(false);
    }
  });
  it('denies deleted source lifetime on replay without recovering a stale binding', async () => {
    for (const field of ['draftExists', 'versionExists'] as const) {
      const f = fixture(); await f.read(); f.state[field] = false;
      await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
    }
  });
  it.each(['legiwatch_research', 'legiwatch_editorial', 'legiwatch_preparation', 'unknown_future'])('preserves immutable %s origin exclusion without row locks/provider authorization', async (origin) => {
    const f = fixture(); f.state.sourceTypes = [origin]; await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.sql.find((q) => q.phase === 'origin')?.text).not.toMatch(/FOR SHARE|FOR UPDATE/);
    expect(f.sql.some((q) => q.phase === 'objective_scope')).toBe(false);
  });
  it('preserves prospect-origin exclusion after conversion rather than inferring a client', async () => {
    const f = fixture(); f.state.prospectId = id(95); await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.sql.some((q) => q.phase === 'objective_scope')).toBe(false);
  });
  it('rejects null canonical source client and every legacy source hint before stale Objective probes', async () => {
    for (const kind of ['none', 'client', 'clientAssociated', 'clientPersons', 'display']) {
      const f = fixture(); delete f.state.snapshot.config.clientId; f.state.currentConfig = {}; f.state.objectiveVersion = 4;
      if (kind === 'client') f.state.snapshot.config.client = 'Client display';
      if (kind === 'clientAssociated') f.state.currentConfig.clientAssociated = true;
      if (kind === 'clientPersons') f.state.snapshot.config.clientPersons = [{ id: id(96) }];
      if (kind === 'display') f.state.currentDisplay = 'Client display';
      await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
      expect(f.sql.some((q) => q.phase === 'objective_scope')).toBe(false);
    }
  });
  it('denies current/saved client reassignment and requested cross-client before disclosing stale 409', async () => {
    const f = fixture(); f.state.objectiveVersion = 4;
    await expect(f.read({ clientId: id(97) })).rejects.toBeInstanceOf(NotFoundException);
    expect(f.sql.some((q) => q.phase === 'objective_scope')).toBe(false);
    f.state.currentConfig.clientId = id(98); await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
  });
  it.each(['objectiveExists', 'objectiveDeleted', 'objectiveClient', 'objectiveTenant', 'revisionExists', 'revisionClient', 'revisionTenant', 'revisionObjective'] as const)('refuses changed current Objective/revision %s scope', async (field) => {
    const f = fixture(); await f.read();
    (f.state as any)[field] = field === 'objectiveDeleted' ? true : field.endsWith('Exists') ? false : id(99);
    await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
  });
  it('returns typed conflict only for current authorized same-client Objective; refreshed opens read new canonical revision', async () => {
    const f = fixture(); const first = await f.read(); f.state.objectiveVersion = 4; f.state.revisionId = id(100);
    await expect(f.read()).rejects.toBeInstanceOf(ConflictException);
    expect(f.sql.filter((q) => q.phase === 'objective_revision')).toHaveLength(1);
    const refreshed = await f.read({ objectiveVersion: 4 }); expect(refreshed.destination.objectiveRevisionId).toBe(id(100)); expect(first.destination.objectiveRevisionId).toBe(revisionId);
    f.state.grant = false; await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
  });
  it('supports current unwalled canonical client without creating an unnecessary grant', async () => {
    const f = fixture(); f.state.wall = false; f.state.grant = false; await f.read();
    expect(f.sql.some((q) => ['source_grant', 'objective_grant'].includes(q.phase))).toBe(false);
  });
  it('retains mutable authority/lifetime locks while immutable receipts and Objective revisions stay plain SELECT', async () => {
    const f = fixture(); f.state.draftOwner = 'user_other'; await f.read();
    for (const phase of ['source_tenant', 'source_member', 'draft', 'collaborator', 'saved_version', 'source_client', 'source_grant', 'objective_scope', 'objective_grant', 'objective']) expect(f.sql.find((q) => q.phase === phase)?.text).toContain('FOR SHARE');
    for (const phase of ['origin', 'objective_revision']) expect(f.sql.find((q) => q.phase === phase)?.text).not.toMatch(/FOR SHARE|FOR UPDATE/);
    const migration = readFileSync(resolve(__dirname, '../../../../apps/workspace/prisma/migrations/20261012040000_saved_version_immutability/migration.sql'), 'utf8');
    expect(migration).toContain('BEFORE UPDATE ON ws_doc_version'); expect(migration).toContain('NEW IS DISTINCT FROM OLD');
  });
  it.each(['tenant_context', 'source_tenant', 'source_member', 'user_context', 'draft', 'origin', 'saved_version', 'source_client', 'source_grant', 'wall_predicate', 'objective_scope', 'objective_grant', 'objective', 'objective_revision'])('propagates %s permission/deadlock/infrastructure failure without 404, fallback or retry', async (phase) => {
    const f = fixture(); f.state.failAt = phase; await expect(f.read()).rejects.toBe(f.state.marker);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it('denies membership changed during an awaited source authority query', async () => {
    const f = fixture(); const gate = f.pause('source_member'); const read = f.read(); await gate.reached; f.state.memberStatus = 'removed'; gate.release();
    await expect(read).rejects.toBeInstanceOf(NotFoundException); expect(f.sql.some((q) => q.phase === 'objective_scope')).toBe(false);
  });
  it('denies source collaborator changed before the awaited active-role query completes', async () => {
    const f = fixture(); f.state.draftOwner = 'user_other'; const gate = f.pause('collaborator'); const read = f.read(); await gate.reached; f.state.collaboratorStatus = 'pending'; gate.release();
    await expect(read).rejects.toBeInstanceOf(NotFoundException);
  });
  it('denies a deleted saved version before the awaited exact-row read completes', async () => {
    const f = fixture(); const gate = f.pause('saved_version'); const read = f.read(); await gate.reached; f.state.versionExists = false; gate.release();
    await expect(read).rejects.toBeInstanceOf(NotFoundException); expect(f.sql.some((q) => q.phase === 'objective_scope')).toBe(false);
  });
  it('rechecks actual current Objective authority across the seam await instead of returning earlier source success', async () => {
    const f = fixture(); const gate = f.pause('objective_scope'); const read = f.read(); await gate.reached; f.state.memberRole = 'client_user'; gate.release();
    await expect(read).rejects.toBeInstanceOf(NotFoundException);
  });
  it('rechecks the current Objective version during its awaited current-row read', async () => {
    const f = fixture(); const gate = f.pause('objective'); const read = f.read(); await gate.reached; f.state.objectiveVersion = 4; gate.release();
    await expect(read).rejects.toBeInstanceOf(ConflictException); expect(f.sql.some((q) => q.phase === 'objective_revision')).toBe(false);
  });
  it('refuses an immutable source-origin receipt observed at its awaited source query', async () => {
    const f = fixture(); const gate = f.pause('origin'); const read = f.read(); await gate.reached; f.state.sourceTypes = ['legiwatch_preparation']; gate.release();
    await expect(read).rejects.toBeInstanceOf(NotFoundException); expect(f.sql.some((q) => q.phase === 'objective_scope')).toBe(false);
  });
  it('refuses a removed wall grant before the awaited source-grant read completes', async () => {
    const f = fixture(); const gate = f.pause('source_grant'); const read = f.read(); await gate.reached; f.state.grant = false; gate.release();
    await expect(read).rejects.toBeInstanceOf(NotFoundException); expect(f.sql.some((q) => q.phase === 'objective_scope')).toBe(false);
  });
  it('rechecks wall grant again at the Objective seam and never returns earlier source success after denial', async () => {
    const f = fixture(); const gate = f.pause('objective_grant'); const read = f.read(); await gate.reached; f.state.grant = false; gate.release();
    await expect(read).rejects.toBeInstanceOf(NotFoundException); expect(f.sql.some((q) => q.phase === 'objective')).toBe(false);
  });
  it('does not let a working-copy edit substitute for the selected saved snapshot across an await', async () => {
    const f = fixture(); const gate = f.pause('saved_version'); const read = f.read(); await gate.reached; f.state.currentConfig.sectionContent = { News: 'Live replacement' }; gate.release();
    const result = await read; expect(result.snapshotHash).toBe(hash(saved)); expect(result.contentSkeleton.body).toBe('News\nSaved prose.');
  });
  it.each(['empty', 'oversized', 'slots', 'malformed_saved_client'])('keeps published saved-revision %s bounds and never truncates or generates', async (kind) => {
    const f = fixture();
    if (kind === 'empty') f.state.snapshot.config.sectionContent.News = '';
    if (kind === 'oversized') f.state.snapshot.config.sectionContent.News = 'a'.repeat(8001);
    if (kind === 'slots') f.state.snapshot.config.sectionContent.News = '{{slot}}';
    if (kind === 'malformed_saved_client') f.state.snapshot.config.clientId = [clientId];
    await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('independent Workspace bounded transport and source-derived response', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } });
  const validate = (value: unknown) => pipe.transform(value, { type: 'query', metatype: WorkspaceObjectiveDestinationQueryDto });
  it('requires exact scalar fields and marks the nested owner response private/no-store', async () => {
    await expect(validate({ ...input, objectiveVersion: '3' })).resolves.toMatchObject(input);
    expect(Reflect.getMetadata('__headers__', VersionsController.prototype.objectiveDestination)).toContainEqual({ name: 'Cache-Control', value: 'private, no-store' });
  });
  it.each(['clientId', 'objectiveId', 'objectiveVersion'])('refuses missing/repeated/nested %s claim', async (field) => {
    const value = { ...input } as any; delete value[field]; await expect(validate(value)).rejects.toBeInstanceOf(BadRequestException);
    for (const supplied of [[(input as any)[field]], [(input as any)[field], (input as any)[field]], { nested: (input as any)[field] }]) await expect(validate({ ...input, [field]: supplied })).rejects.toBeInstanceOf(BadRequestException);
  });
  it.each(['actor', 'userId', 'clerkUserId', 'tenantId', 'kind', 'resourceId', 'draftId', 'versionId', 'objectiveRevisionId', 'snapshotHash', 'contentSkeleton'])('refuses caller-controlled %s claim', async (field) => {
    await expect(validate({ ...input, [field]: versionId })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects malformed resource UUIDs and scalar/int32 service input before any transaction', async () => {
    const uuid = new ParseUUIDPipe(); await expect(uuid.transform('not-uuid', { type: 'param' })).rejects.toBeInstanceOf(BadRequestException);
    for (const field of ['clientId', 'objectiveId']) for (const value of [null, [clientId], { toString: () => clientId }]) {
      const f = fixture(); await expect(f.read({ [field]: value })).rejects.toBeInstanceOf(BadRequestException); expect(f.prisma.$transaction).not.toHaveBeenCalled();
    }
    for (const value of [0, -1, 1.5, 2147483648, Infinity, '3']) {
      const f = fixture(); await expect(f.read({ objectiveVersion: value })).rejects.toBeInstanceOf(BadRequestException); expect(f.prisma.$transaction).not.toHaveBeenCalled();
    }
  });
});

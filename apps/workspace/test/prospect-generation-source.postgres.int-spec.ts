import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalWorkspaceSnapshot } from '@capiro/shared';
import {
  workspaceProspectGenerationSourceWithinTx, workspaceGenerationConversationId,
  type WorkspaceProspectGenerationSource,
} from '@capiro/shared/workspace-prospect-generation-source';
import { bootstrapWorkspaceGenerationConversation } from '../../api/src/meri/meri-conversation-bootstrap.js';
import { authorizeWorkspaceGenerationSource } from '../../api/src/context/workspace-generation-source.authorization.js';
import { loadOwnedActiveClioConversation } from '../../api/src/context/application-authority-resource.helpers.js';
import type { DraftsService } from '../src/drafts/drafts.service.js';

const repoRoot = resolve(__dirname, '../../..');
const helper = require(join(repoRoot, 'scripts/testing/a1-disposable-postgres.cjs'));
const readiness = helper.nativePostgresReadiness({ repoRoot });
const native = readiness.available ? describe : describe.skip;
type Runtime = typeof import('./support/ws03-postgres-harness.js');
type Harness = Awaited<ReturnType<Runtime['createNativeWorkspaceHarness']>>;
const hash = (value: unknown) => createHash('sha256').update(canonicalWorkspaceSnapshot(value)).digest('hex');

/** Exact production scalar columns plus the bootstrap conversation FK. The
 * normal disposable helper owns isolation; no production database is touched. */
function conversationModels(core: string) {
  return ['ClioConversation', 'ClioConversationBootstrapReceipt'].map(name => {
    const model = core.match(new RegExp(`^model ${name} \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
    if (!model) throw Error('Missing canonical conversation model');
    const lines = model.split('\n').filter(line => {
      if (/^model|^\}|^\s*@@/.test(line)) return true;
      return /^\s*\w+\s+(String|Int|BigInt|Boolean|DateTime|Json|Float|Decimal|Bytes)\??\s/.test(line);
    });
    lines.splice(lines.length - 1, 0, name === 'ClioConversation'
      ? '  bootstrapReceipt ClioConversationBootstrapReceipt?'
      : '  conversation ClioConversation? @relation(fields: [conversationId], references: [id], onDelete: SetNull, map: "clio_bootstrap_receipts_conversation_fkey")');
    return lines.join('\n');
  }).join('\n');
}

native(`prospect generation source authority PostgreSQL [${readiness.reason}]`, () => {
  let database: { url: string; cleanup(): Promise<void> }, h: Harness, runtime: Runtime,
    service: DraftsService, core: any, owner: any;
  const prospectId = '00000000-0000-4000-8000-000000000080';
  const userId = '00000000-0000-4000-8000-000000000020';
  const clientId = '00000000-0000-4000-8000-000000000081';
  const ctx = () => ({ tenantId: runtime.WS03_IDS.tenantId, userId, clerkUserId: 'user_owner',
    tenantSlug: 'a1-native-workspace', role: 'standard_user' as const });
  beforeAll(async () => {
    database = await helper.createDisposableSchema({ repoRoot,
      coreSchemaPath: join(__dirname, 'support/workspace-identity.fixture.prisma'),
      workspaceSchemaPath: join(repoRoot, 'apps/workspace/prisma/schema.prisma'),
      extraModels: (await readFile(join(__dirname, 'support/ws-source-action.fixture.prisma'), 'utf8')) + '\n' +
        conversationModels(await readFile(join(repoRoot, 'apps/api/prisma/schema.prisma'), 'utf8')),
    });
    runtime = require('./support/ws03-postgres-harness.js');
    h = await runtime.createNativeWorkspaceHarness(database.url);
    const { DraftsService } = require('../src/drafts/drafts.service.js');
    service = h.app.get(DraftsService);
    const { PrismaClient } = require(join(repoRoot, 'apps/api/node_modules/@prisma/client'));
    core = new PrismaClient({ datasources: { db: { url: database.url } } });
    owner = { withTenant: (_tenant: string, fn: (tx: any) => unknown) => core.$transaction(fn) };
    const migration = (await readFile(join(repoRoot,
      'apps/api/prisma/migrations/20281029180000_workspace_generation_source_binding/migration.sql'), 'utf8'))
      .replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
    const triggerAt = migration.indexOf('CREATE TRIGGER');
    await h.db.$transaction(async tx => {
      await tx.$executeRawUnsafe(migration.slice(0, triggerAt));
      await tx.$executeRawUnsafe(migration.slice(triggerAt));
    });
    await h.db.$executeRawUnsafe(
      'INSERT INTO business_development_prospects (id,tenant_id,display_name,updated_at) VALUES ($1::uuid,$2::uuid,$3,now())',
      prospectId, runtime.WS03_IDS.tenantId, 'Synthetic prospect');
    await h.db.$executeRawUnsafe(
      'INSERT INTO clients (id,tenant_id,name,memory_wall) VALUES ($1::uuid,$2::uuid,$3,true)',
      clientId, runtime.WS03_IDS.tenantId, 'Synthetic converted client');
  }, 240000);
  afterAll(async () => {
    try { await core?.$disconnect(); await h?.close(); } finally { await database?.cleanup(); }
  }, 60000);
  beforeEach(async () => {
    await core.clioConversationBootstrapReceipt.deleteMany({});
    await core.clioConversation.deleteMany({});
    await h.reset();
    await h.db.wsDraft.update({ where: { id: runtime.WS03_IDS.draftId }, data: { prospectId } });
    await h.db.$executeRawUnsafe("UPDATE business_development_prospects SET status='active',dismissed_at=NULL,linked_client_id=NULL WHERE id=$1::uuid", prospectId);
    await h.db.$executeRawUnsafe("UPDATE tenant_memberships SET status='active' WHERE tenant_id=$1::uuid", runtime.WS03_IDS.tenantId);
    await h.db.$executeRawUnsafe('DELETE FROM client_memory_access WHERE client_id=$1::uuid', clientId);
    await h.db.$executeRawUnsafe('UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
      JSON.stringify({ clioFeatureFlags: { 'businessDevelopment.enabled': true } }), runtime.WS03_IDS.tenantId);
  });
  async function source(): Promise<WorkspaceProspectGenerationSource> {
    const state = await service.prospectState(runtime.WS03_IDS.tenantId, runtime.WS03_IDS.draftId, 'user_owner', prospectId);
    const saved = await service.saveProspect(runtime.WS03_IDS.tenantId, runtime.WS03_IDS.draftId, 'user_owner', {
      requestId: '00000000-0000-4000-8000-000000000090', expectedProspectId: prospectId,
      expectedStateHash: state.stateHash, title: 'Saved source', names: ['Scope'], sections: { Scope: 'Exact saved evidence.' },
    });
    return { schemaVersion: 1, requestId: `wsgen:${'a'.repeat(64)}`, draftId: runtime.WS03_IDS.draftId,
      prospectId, sourceVersionId: saved.receipt.versionId, sourceSnapshotHash: saved.receipt.snapshotHash };
  }
  const read = (input: unknown, edit = true, actor = 'user_owner') => h.db.$transaction<Awaited<ReturnType<typeof workspaceProspectGenerationSourceWithinTx>>>(tx =>
    workspaceProspectGenerationSourceWithinTx(tx, runtime.WS03_IDS.tenantId, { clerkUserId: actor }, input, { edit }));
  const register = (input: unknown) => bootstrapWorkspaceGenerationConversation(owner, ctx(), input, { brand: 'Meri', runtime: 'native' });
  async function current(input: WorkspaceProspectGenerationSource) {
    return core.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const row = await loadOwnedActiveClioConversation(owner, ctx(), workspaceGenerationConversationId(input.requestId), tx);
      return authorizeWorkspaceGenerationSource(tx, ctx(), row, { lock: false });
    }, { isolationLevel: 'RepeatableRead' });
  }

  it('reads exact atomic save bytes, refuses changed/generic sources and uses the existing readonly authority snapshot', async () => {
    const input = await source(), result = await read(input);
    expect(hash(result.snapshot)).toBe(input.sourceSnapshotHash);
    expect(result.scope.userId).toBe(userId);
    await expect(read({ ...input, sourceSnapshotHash: 'f'.repeat(64) })).rejects.toThrow();
    const generic = await h.db.wsDocVersion.findUniqueOrThrow({ where: { id: runtime.WS03_IDS.versionId } });
    await expect(read({ ...input, sourceVersionId: generic.id, sourceSnapshotHash: hash(generic.snapshot) })).rejects.toThrow();
    await register(input);
    expect(await current(input)).toEqual(['workspaceProspectGeneration', input, null, 'owner']);
  });

  it('registers one derived conversation through racing retries and keeps source metadata immutable', async () => {
    const input = await source();
    const [first, second] = await Promise.all([register(input), register(input)]);
    expect(first).toEqual(second);
    expect(first.conversationId).toBe(workspaceGenerationConversationId(input.requestId));
    expect(await core.clioConversation.count()).toBe(1);
    expect(await core.clioConversationBootstrapReceipt.count()).toBe(1);
    await expect(core.clioConversation.update({ where: { id: first.conversationId }, data: { metadata: {} } })).rejects.toThrow();
    await expect(core.clioConversation.update({ where: { id: first.conversationId }, data: { userId: '00000000-0000-4000-8000-000000000021' } })).rejects.toThrow();
    await core.clioConversation.update({ where: { id: first.conversationId }, data: { title: 'Renamed safely' } });
    expect(await register(input)).toEqual(first);
    await core.clioConversation.delete({ where: { id: first.conversationId } });
    await expect(register(input)).rejects.toMatchObject({ status: 409 });
    expect(await core.clioConversation.count()).toBe(0);
  });

  it('rechecks membership, later client conversion/walls and active prospect state on transcript reads and bootstrap replay', async () => {
    const input = await source(); await register(input);
    await h.db.$executeRawUnsafe('UPDATE business_development_prospects SET linked_client_id=$1::uuid WHERE id=$2::uuid', clientId, prospectId);
    await expect(current(input)).rejects.toMatchObject({ status: 404 });
    await expect(register(input)).rejects.toMatchObject({ status: 404 });
    await h.db.$executeRawUnsafe('INSERT INTO client_memory_access (id,tenant_id,client_id,user_id) VALUES ($1::uuid,$2::uuid,$1::uuid,$3::uuid)', clientId, runtime.WS03_IDS.tenantId, userId);
    expect(await current(input)).toEqual(['workspaceProspectGeneration', input, clientId, 'owner']);
    await h.db.$executeRawUnsafe("UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=$1::uuid AND user_id=$2::uuid", runtime.WS03_IDS.tenantId, userId);
    await expect(current(input)).rejects.toMatchObject({ status: 404 });
    await h.db.$executeRawUnsafe("UPDATE tenant_memberships SET status='active' WHERE tenant_id=$1::uuid AND user_id=$2::uuid", runtime.WS03_IDS.tenantId, userId);
    await h.db.$executeRawUnsafe("UPDATE business_development_prospects SET status='archived' WHERE id=$1::uuid", prospectId);
    await expect(current(input)).rejects.toMatchObject({ status: 404 });
  });

  it('requires an active draft reader and editor rights before registration', async () => {
    const input = await source();
    await expect(read(input, false, 'user_unrelated')).rejects.toThrow();
    await h.db.wsCollaborator.create({ data: { tenantId: runtime.WS03_IDS.tenantId, draftId: input.draftId,
      subjectId: 'user_unrelated', role: 'viewer', status: 'active', invitedById: 'user_owner' } });
    expect((await read(input, false, 'user_unrelated')).role).toBe('viewer');
    await expect(read(input, true, 'user_unrelated')).rejects.toThrow();
    await h.db.wsCollaborator.deleteMany({ where: { draftId: input.draftId, subjectId: 'user_unrelated' } });
    await expect(read(input, false, 'user_unrelated')).rejects.toThrow();
  });

  it('does not retain a generation session after editor downgrade or source feature disablement', async () => {
    const input = await source(); await register(input);
    await h.db.wsDraft.update({ where: { id: input.draftId }, data: { ownerId: 'user_unrelated' } });
    await h.db.wsCollaborator.create({ data: { tenantId: runtime.WS03_IDS.tenantId, draftId: input.draftId,
      subjectId: 'user_owner', role: 'viewer', status: 'active', invitedById: 'user_unrelated' } });
    await expect(current(input)).rejects.toMatchObject({ status: 404 });
    await h.db.wsCollaborator.updateMany({ where: { draftId: input.draftId, subjectId: 'user_owner' }, data: { role: 'editor' } });
    expect((await current(input)).at(-1)).toBe('editor');
    await h.db.$executeRawUnsafe('UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid', '{}', runtime.WS03_IDS.tenantId);
    await expect(current(input)).rejects.toMatchObject({ status: 404 });
  });
});

import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { listAdminWorkflows, readWorkflowRequest, saveWorkflow } from './admin.js';
import { listRuntimeWorkflows, readRuntimeWorkflow } from './runtime.js';
import { workflowFixture } from './fixture.js';
import { workflowDatabase } from './postgres-fixture.js';

const url = process.env.SITE_WORKFLOW_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('workflow configuration using ordinary-role PostgreSQL', () => {
  let db: PrismaClient, scoped: PrismaService;
  beforeAll(async () => { ({ db, scoped } = await workflowDatabase(url!)); }, 60000);
  afterAll(async () => { await db?.$disconnect(); });
  async function fixture() {
    const tenantId = randomUUID(), userId = randomUUID(), clientId = randomUUID(), conversationId = randomUUID();
    await db.tenant.create({ data: { id: tenantId, slug: 'workflow-' + tenantId, name: 'Workflow fixture', status: 'active' } });
    await db.user.create({ data: { id: userId, clerkUserId: 'workflow-' + userId, email: userId + '@example.invalid' } });
    await db.tenantMembership.create({ data: { tenantId, userId, status: 'active', role: 'capiro_admin' } });
    await db.client.create({ data: { id: clientId, tenantId, name: 'Workflow fixture', memoryWall: true } });
    await db.clientMemoryAccess.create({ data: { tenantId, userId, clientId } });
    await db.clioConversation.create({ data: { id: conversationId, tenantId, userId, clientId, title: 'Workflow fixture' } });
    await db.clioConversationBootstrapReceipt.create({ data: { tenantId, actorUserId: userId, requestId: randomUUID(),
      conversationId, scopeKind: 'client', clientId } });
    const ctx = { tenantId, userId, role: 'capiro_admin' } as TenantContext;
    const request = (version = 1, enabled = true) => ({ requestId: randomUUID(), expectedVersion: version - 1,
      manifest: workflowFixture(version), enabled });
    const saved = await saveWorkflow(scoped, ctx, request());
    const selection = { siteId: saved.configuration.manifest.siteId, workflowId: saved.configuration.manifest.workflowId,
      version: 1, manifestSha256: saved.configuration.manifestSha256 };
    return { ctx, request, saved, clientId, read: { conversationId, selection } };
  }
  it('replays the original receipt after a lost response, refuses a changed reuse, and preserves history', async () => {
    const f = await fixture(), request = f.request(2), saved = await saveWorkflow(scoped, f.ctx, request);
    await saveWorkflow(scoped, f.ctx, f.request(3, false));
    expect(await saveWorkflow(scoped, f.ctx, request)).toEqual(saved);
    expect(await readWorkflowRequest(scoped, f.ctx, { requestId: request.requestId })).toEqual({ requestId: request.requestId, receipt: saved });
    await expect(saveWorkflow(scoped, f.ctx, { ...request, enabled: false })).rejects.toThrow('REQUEST_CONFLICT');
    expect((await listAdminWorkflows(scoped, f.ctx)).workflows[0]!.manifest.version).toBe(3);
  });
  it('allows exactly one concurrent successor at a base version', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([saveWorkflow(scoped, f.ctx, f.request(2)), saveWorkflow(scoped, f.ctx, f.request(2))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  });
  it('rechecks current administrator role despite an old privileged context', async () => {
    const f = await fixture();
    await db.tenantMembership.updateMany({ where: { tenantId: f.ctx.tenantId }, data: { role: 'standard_user' } });
    await expect(saveWorkflow(scoped, f.ctx, f.request(2))).rejects.toThrow('administrator');
    await expect(listAdminWorkflows(scoped, f.ctx)).rejects.toThrow('administrator');
    expect(await readRuntimeWorkflow(scoped, f.ctx, f.read)).toEqual(f.saved.configuration);
  });
  it('invalidates old selections after a revision or disable and omits disabled workflows from selection', async () => {
    const f = await fixture();
    expect((await listRuntimeWorkflows(scoped, f.ctx, { conversationId: f.read.conversationId })).workflows).toHaveLength(1);
    await saveWorkflow(scoped, f.ctx, f.request(2));
    await expect(readRuntimeWorkflow(scoped, f.ctx, f.read)).rejects.toThrow('STALE_VERSION');
    await saveWorkflow(scoped, f.ctx, f.request(3, false));
    await expect(readRuntimeWorkflow(scoped, f.ctx, f.read)).rejects.toThrow('DISABLED');
    expect((await listRuntimeWorkflows(scoped, f.ctx, { conversationId: f.read.conversationId })).workflows).toEqual([]);
  });
  it('blocks another actor, revoked membership, client wall withdrawal and archived chats', async () => {
    const f = await fixture();
    await expect(readRuntimeWorkflow(scoped, { ...f.ctx, userId: randomUUID() }, f.read)).rejects.toThrow();
    await db.clientMemoryAccess.deleteMany({ where: { tenantId: f.ctx.tenantId } });
    await expect(readRuntimeWorkflow(scoped, f.ctx, f.read)).rejects.toThrow('Chat not found');
    await db.clientMemoryAccess.create({ data: { tenantId: f.ctx.tenantId, userId: f.ctx.userId, clientId: f.clientId } });
    await db.clioConversation.update({ where: { id: f.read.conversationId }, data: { status: 'archived' } });
    await expect(readRuntimeWorkflow(scoped, f.ctx, f.read)).rejects.toThrow('Active chat');
    await db.clioConversation.update({ where: { id: f.read.conversationId }, data: { status: 'active' } });
    await db.tenantMembership.updateMany({ where: { tenantId: f.ctx.tenantId }, data: { status: 'removed' } });
    await expect(readRuntimeWorkflow(scoped, f.ctx, f.read)).rejects.toThrow('access unavailable');
    await expect(readWorkflowRequest(scoped, f.ctx, { requestId: f.saved.requestId })).rejects.toThrow('administrator');
  });
  it('enforces tenant RLS and immutable history for ordinary database writes', async () => {
    const f = await fixture(), other = await fixture();
    const rows = await scoped.withTenant(other.ctx.tenantId, tx =>
      tx.$queryRaw<Array<{ tenant_id: string }>>`SELECT tenant_id FROM meri_site_workflow_revisions`);
    expect(rows.length).toBeGreaterThan(0); expect(rows.every(row => row.tenant_id === other.ctx.tenantId)).toBe(true);
    await expect(scoped.withTenant(f.ctx.tenantId, tx =>
      tx.$executeRaw`UPDATE meri_site_workflow_revisions SET enabled=false WHERE tenant_id=${f.ctx.tenantId}::uuid`)).rejects.toThrow();
    await expect(scoped.withTenant(f.ctx.tenantId, tx =>
      tx.$executeRaw`DELETE FROM meri_site_workflow_revisions WHERE tenant_id=${f.ctx.tenantId}::uuid`)).rejects.toThrow();
    await expect(readRuntimeWorkflow(scoped, other.ctx, f.read)).rejects.toThrow();
  });
});


import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriV3VisualAnalysisService } from './meri-v3-visual-analysis.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Visual-analysis wall integration test requires local fixture Postgres');
}

describe('MeriV3 visual-analysis current ethical wall (local fixture DB)', () => {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const adminId = randomUUID();
  const clientId = randomUUID();
  const scopedConversationId = randomUUID();
  const unscopedConversationId = randomUUID();
  const slug = `meri-visual-wall-${tenantId}`;
  const ctx = { tenantId, tenantSlug: slug, userId, clerkUserId: userId,
    role: 'standard_user' } as TenantContext;
  const adminCtx = { ...ctx, userId: adminId, clerkUserId: adminId,
    role: 'user_admin' } as TenantContext;
  let prisma: PrismaService;
  let service: MeriV3VisualAnalysisService;
  let execute: jest.Mock;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({ data: { id: tenantId, slug, name: 'Visual wall fixture', status: 'active' } });
      for (const [id, role] of [[userId, 'standard_user'], [adminId, 'user_admin']] as const) {
        await tx.user.create({ data: { id, clerkUserId: id, email: `${id}@visual-wall.example.test` } });
        await tx.tenantMembership.create({ data: { tenantId, userId: id, role, status: 'active', joinedAt: new Date() } });
      }
      await tx.client.create({ data: { id: clientId, tenantId, name: 'Visual wall client' } });
      await tx.clioConversation.create({ data: { id: scopedConversationId, tenantId, userId, clientId, title: 'Scoped' } });
      await tx.clioConversation.create({ data: { id: unscopedConversationId, tenantId, userId, title: 'Unscoped' } });
    });
    execute = jest.fn(async () => ({ tool: 'run_analysis', ok: true, results: {},
      artifacts: [{ metadata: { imageBase64: 'cG5n' } }] }));
    service = new MeriV3VisualAnalysisService(prisma, {
      analysisSandboxEnabled: async () => true,
      executeFromAuthenticatedUser: execute,
    } as never);
  });

  afterAll(async () => {
    await prisma.withSystem((tx) => tx.tenant.delete({ where: { id: tenantId } })).catch(() => undefined);
    for (const id of [userId, adminId]) {
      await prisma.withSystem((tx) => tx.user.delete({ where: { id } })).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  async function run(user: TenantContext = ctx, conversationId: string = scopedConversationId) {
    return service.run(user, { conversationId, code: 'print(1)' });
  }

  test('unwalled client and null-client conversation allow visual persistence', async () => {
    await expect(run()).resolves.toMatchObject({ chartCount: 1 });
    await expect(run(ctx, unscopedConversationId)).resolves.toMatchObject({ chartCount: 1 });
  });

  test('wall denies ordinary user and admin without a grant before sandbox execution', async () => {
    await prisma.withSystem((tx) => tx.client.update({ where: { id: clientId }, data: { memoryWall: true } }));
    execute.mockClear();
    await expect(run()).rejects.toBeInstanceOf(NotFoundException);
    expect(execute).not.toHaveBeenCalled();
    await prisma.withSystem((tx) => tx.clioConversation.create({
      data: { tenantId, userId: adminId, clientId, title: 'Admin scoped' },
      select: { id: true },
    })).then(async ({ id }) => {
      await expect(run(adminCtx, id)).rejects.toBeInstanceOf(NotFoundException);
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test('grant allows a run; revocation during computation prevents artifact persistence', async () => {
    await prisma.withSystem((tx) => tx.clientMemoryAccess.create({
      data: { tenantId, clientId, userId, grantedBy: adminId },
    }));
    const allowed = await run() as { artifacts: Array<{ id: string }> };
    expect(allowed).toMatchObject({ chartCount: 1 });
    execute.mockImplementationOnce(async () => {
      await prisma.withSystem((tx) => tx.clientMemoryAccess.deleteMany({
        where: { tenantId, clientId, userId },
      }));
      return { tool: 'run_analysis', ok: true, results: {},
        artifacts: [{ metadata: { imageBase64: 'cG5n' } }] };
    });
    const before = await prisma.withSystem((tx) => tx.clioArtifact.count({
      where: { tenantId, conversationId: scopedConversationId, kind: 'analysis_chart' },
    }));
    await expect(run()).rejects.toBeInstanceOf(NotFoundException);
    const after = await prisma.withSystem((tx) => tx.clioArtifact.count({
      where: { tenantId, conversationId: scopedConversationId, kind: 'analysis_chart' },
    }));
    expect(after).toBe(before);
    const artifactId = allowed.artifacts[0]!.id;
    await expect(service.getArtifact(ctx, artifactId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getArtifactImage(ctx, artifactId)).rejects.toBeInstanceOf(NotFoundException);
  });
});

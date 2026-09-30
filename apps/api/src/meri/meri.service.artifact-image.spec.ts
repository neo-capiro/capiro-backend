import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';
import { generatedPngBase64 } from './meri-artifact-test-fixtures.js';
import { sha256Bytes } from './meri-artifact-integrity.js';

const ctx = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  tenantSlug: 'tenant-1',
  role: 'standard_user',
} as TenantContext;
const pngBase64 = generatedPngBase64();
const pngBytes = Buffer.from(pngBase64, 'base64');

function make(options: {
  artifact?: Record<string, unknown> | null;
  authorizedClientIds?: string[];
} = {}) {
  const artifact = options.artifact === undefined
    ? {
        contentType: 'image/png',
        metadata: { imageBase64: pngBase64, imageSha256: sha256Bytes(pngBytes) },
        clientId: 'client-1',
        conversation: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: 'client-1',
          archivedAt: null,
        },
      }
    : options.artifact;
  const findFirst = jest.fn(async () => artifact);
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) =>
      callback({ clioArtifact: { findFirst } }),
    ),
  };
  const securityEnvelope = jest.fn(async () => ({
    authorizedClientIds: options.authorizedClientIds ?? ['client-1'],
    authorizedMailboxConnectionIds: [],
  }));
  const service = Object.assign(Object.create(MeriService.prototype), {
    prisma,
    contextPlane: { securityEnvelope },
  }) as MeriService;
  return { service, findFirst, securityEnvelope };
}

describe('MeriService legacy artifact image readback', () => {
  test('returns validated persisted bytes only for the current tenant, user, conversation and client wall', async () => {
    const { service, findFirst, securityEnvelope } = make();
    await expect(service.getArtifactImage(ctx, 'chart-1')).resolves.toEqual({
      buffer: pngBytes,
      contentType: 'image/png',
      sha256: sha256Bytes(pngBytes),
      integrityPolicy: 'persisted_hash_match',
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'chart-1',
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        kind: 'analysis_chart',
      },
      select: {
        contentType: true,
        metadata: true,
        clientId: true,
        conversation: {
          select: { tenantId: true, userId: true, clientId: true, archivedAt: true },
        },
      },
    });
    expect(securityEnvelope).toHaveBeenCalledWith(ctx);
  });

  test('fails closed after conversation archival, client rebinding or wall revocation', async () => {
    const archived = make({ artifact: {
      contentType: 'image/png', metadata: { imageBase64: pngBase64 }, clientId: 'client-1',
      conversation: { tenantId: ctx.tenantId, userId: ctx.userId, clientId: 'client-1', archivedAt: new Date() },
    } });
    await expect(archived.service.getArtifactImage(ctx, 'chart-1')).resolves.toBeNull();
    expect(archived.securityEnvelope).not.toHaveBeenCalled();

    const rebound = make({ artifact: {
      contentType: 'image/png', metadata: { imageBase64: pngBase64 }, clientId: 'client-1',
      conversation: { tenantId: ctx.tenantId, userId: ctx.userId, clientId: 'client-2', archivedAt: null },
    } });
    await expect(rebound.service.getArtifactImage(ctx, 'chart-1')).resolves.toBeNull();
    expect(rebound.securityEnvelope).not.toHaveBeenCalled();

    const revoked = make({ authorizedClientIds: [] });
    await expect(revoked.service.getArtifactImage(ctx, 'chart-1')).resolves.toBeNull();
    expect(revoked.securityEnvelope).toHaveBeenCalledWith(ctx);
  });
});

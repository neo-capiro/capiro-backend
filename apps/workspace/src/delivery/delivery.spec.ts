// Delivery spec — tests share token hashing,
// expiration, revocation, and rate limiting. Mocks PrismaService.

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { ShareLinkService } from './share-link.service.js';

// ── Mock Prisma ─────────────────────────────────────────────────────────

function makeMockPrisma() {
  const shareLinks = new Map<string, Record<string, unknown>>();
  const drafts = new Map<string, Record<string, unknown>>();
  const docVersions = new Map<string, Record<string, unknown>>();
  const guestComments = new Map<string, Record<string, unknown>>();

  return {
    _shareLinks: shareLinks,
    _drafts: drafts,
    _docVersions: docVersions,
    _guestComments: guestComments,
    wsDraft: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; tenantId?: string } }) => {
        const d = drafts.get(where.id);
        if (!d) return null;
        if (where.tenantId && d.tenantId !== where.tenantId) return null;
        return { docTitle: "Title", config: {}, ask: null, documents: [], ...d, updatedAt: d.updatedAt ?? new Date() };
      }),
    },
    wsShareLink: {
      findFirst: jest.fn(async ({ where }: { where: { id?: string; tenantId?: string; draftId?: string; label?: string } }) => {
        for (const [, v] of shareLinks) {
          if (where.id && v.id !== where.id) continue;
          if (where.tenantId && v.tenantId !== where.tenantId) continue;
          if (where.draftId && v.draftId !== where.draftId) continue;
          if (where.label && v.label !== where.label) continue;
          return v;
        }
        return null;
      }),
      findMany: jest.fn(async ({ where }: { where: { tokenHash?: string } }) => {
        if (!where.tokenHash) return Array.from(shareLinks.values());
        return Array.from(shareLinks.values()).filter((v) => v.tokenHash === where.tokenHash);
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = 'share-' + shareLinks.size;
        shareLinks.set(id, { id, ...data });
        return shareLinks.get(id);
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = shareLinks.get(where.id);
        if (existing) shareLinks.set(where.id, { ...existing, ...data });
        return shareLinks.get(where.id);
      }),
    },
    wsDocVersion: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; tenantId?: string; draftId?: string } }) => {
        if (where.id === 'current-version') {
          const d = drafts.get(where.draftId!);
          if (!d || d.tenantId !== where.tenantId) return null;
          return { id: where.id, tenantId: where.tenantId, draftId: where.draftId,
            snapshot: { docTitle: d.docTitle ?? 'Title', config: d.config ?? {}, ask: d.ask ?? null, documents: d.documents ?? [] } };
        }
        const v = docVersions.get(where.id);
        if (!v) return null;
        if (where.tenantId && v.tenantId !== where.tenantId) return null;
        if (where.draftId && v.draftId !== where.draftId) return null;
        return v;
      }),
    },
    wsGuestComment: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = 'guest-comment-' + guestComments.size;
        guestComments.set(id, { id, ...data });
        return guestComments.get(id);
      }),
      findMany: jest.fn(async ({ where }: { where: { tenantId: string; draftId: string } }) =>
        Array.from(guestComments.values()).filter(
          (v) => v.tenantId === where.tenantId && v.draftId === where.draftId,
        ),
      ),
    },
  } as unknown as Record<string, unknown>
}

function makeMockCollaborators() {
  return {
    assertCan: jest.fn(async () => 'owner'),
  } as unknown as Record<string, unknown>
}

// ── Share Link Service tests ────────────────────────────────────────────

describe('ShareLinkService', () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let service: ShareLinkService;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = new ShareLinkService(prisma as never, makeMockCollaborators() as never);
  });

  it('creates a share link and returns the token once', async () => {
    (prisma as any)._drafts.set('draft-1', {
      id: 'draft-1',
      tenantId: 'tenant-1',
      config: {},
      updatedAt: new Date(),
    });
    const result = await service.createShareLink('tenant-1', 'draft-1', 'user-1', {
      expiresInDays: 7, versionId: 'current-version',
    });
    expect(result.token).toHaveLength(64); // 32 bytes hex
    expect(result.shareId).toBeDefined();
    expect(result.expiresAt).toBeDefined();
    // The stored record should have only the hash, not the token.
    const stored = (prisma as any)._shareLinks.get(result.shareId);
    expect(stored?.tokenHash).toBeDefined();
    expect(stored?.tokenHash).not.toBe(result.token);
  });

  it('returns 404 for expired share links', async () => {
    const token = 'expired-token';
    const tokenHash = service.hashToken(token);
    (prisma as any)._shareLinks.set('share-1', {
      id: 'share-1',
      tokenHash,
      draftId: 'draft-1',
      versionId: 'current-version',
      expiresAt: new Date(Date.now() - 1000), // expired
      revokedAt: null,
    });
    (prisma as any)._drafts.set('draft-1', {
      id: 'draft-1',
      tenantId: 'tenant-1',
      config: {},
      updatedAt: new Date(),
    });
    await expect(service.getByToken(token)).rejects.toThrow(/expired/i);
  });

  it('returns 404 for revoked share links', async () => {
    const token = 'revoked-token';
    const tokenHash = service.hashToken(token);
    (prisma as any)._shareLinks.set('share-2', {
      id: 'share-2',
      tokenHash,
      draftId: 'draft-1',
      versionId: 'current-version',
      expiresAt: null,
      revokedAt: new Date(), // revoked
    });
    (prisma as any)._drafts.set('draft-1', {
      id: 'draft-1',
      tenantId: 'tenant-1',
      config: {},
      updatedAt: new Date(),
    });
    await expect(service.getByToken(token)).rejects.toThrow(/revoked/i);
  });

  it('sanitizes public payload (no tenantId)', async () => {
    const token = 'valid-token';
    const tokenHash = service.hashToken(token);
    (prisma as any)._shareLinks.set('share-3', {
      id: 'share-3',
      tenantId: 'tenant-SECRET',
      createdById: 'user-1',
      tokenHash,
      draftId: 'draft-1',
      versionId: 'current-version',
      expiresAt: null,
      revokedAt: null,
    });
    (prisma as any)._drafts.set('draft-1', {
      id: 'draft-1',
      tenantId: 'tenant-SECRET',
      docTitle: 'Test Document',
      config: { sections: ['s1'], sectionContent: { s1: '<script>x</script>Content' } },
      updatedAt: new Date(),
    });
    const result = await service.getByToken(token);
    expect(result.draftId).toBe(''); // no tenantId leak
    expect(result.docTitle).toBeDefined();
    expect(result.sections[0]!.content).not.toContain('<script>');
  });

  it('rate limits guest comments (11th rejected)', () => {
    const tokenHash = 'rate-test';
    for (let i = 0; i < 10; i++) {
      expect(service.checkRateLimit(tokenHash)).toBe(true);
    }
    // 11th should be rejected.
    expect(service.checkRateLimit(tokenHash)).toBe(false);
  });

  it('sanitizes text (strips HTML, max 2000 chars)', () => {
    const long = 'a'.repeat(3000);
    const sanitized = service.sanitize(`<b>${long}</b>`);
    expect(sanitized).not.toContain('<b>');
    expect(sanitized).not.toContain('</b>');
    expect(sanitized.length).toBeLessThanOrEqual(2000);
  });

  it('serves the frozen version snapshot, not the live draft, when versionId is pinned', async () => {
    const token = 'pinned-token';
    const tokenHash = service.hashToken(token);
    (prisma as any)._shareLinks.set('share-4', {
      id: 'share-4',
      tokenHash,
      tenantId: 'tenant-1',
      draftId: 'draft-1',
      versionId: 'version-1',
      expiresAt: null,
      revokedAt: null,
    });
    (prisma as any)._drafts.set('draft-1', {
      id: 'draft-1',
      tenantId: 'tenant-1',
      docTitle: 'Live (edited after share)',
      config: { sections: ['s1'], sectionContent: { s1: 'Live content' } },
      updatedAt: new Date(),
    });
    (prisma as any)._docVersions.set('version-1', {
      id: 'version-1',
      tenantId: 'tenant-1',
      draftId: 'draft-1',
      snapshot: {
        docTitle: 'Frozen at share time',
        config: { sections: ['s1'], sectionContent: { s1: 'Frozen content' } },
      },
    });
    const result = await service.getByToken(token);
    expect(result.docTitle).toBe('Frozen at share time');
    expect(result.sections[0]!.content).toBe('Frozen content');
  });

  it('persists a guest comment durably with a real 429 when rate-limited', async () => {
    (prisma as any)._drafts.set('draft-1', { id: 'draft-1', tenantId: 'tenant-1', prospectId: null });
    const token = 'guest-comment-token';
    const tokenHash = service.hashToken(token);
    (prisma as any)._shareLinks.set('share-5', {
      id: 'share-5',
      tokenHash,
      tenantId: 'tenant-1',
      draftId: 'draft-1',
      versionId: 'current-version',
      expiresAt: null,
      revokedAt: null,
    });

    await service.addGuestComment(token, '<b>Nice work</b>', 'Jane');
    const stored = Array.from((prisma as any)._guestComments.values()) as any[];
    expect(stored).toHaveLength(1);
    expect(stored[0].tenantId).toBe('tenant-1');
    expect(stored[0].draftId).toBe('draft-1');
    expect(stored[0].shareLinkId).toBe('share-5');
    expect(stored[0].body).toBe('Nice work');
    expect(stored[0].guestName).toBe('Jane');

    for (let i = 0; i < 9; i++) {
      await service.addGuestComment(token, `comment ${i}`);
    }
    await expect(service.addGuestComment(token, 'one too many')).rejects.toMatchObject({
      status: 429,
    });
  });
});

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

  const prisma = {
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
          if ((where as any).kind && (v.kind ?? 'workspace_document') !== (where as any).kind) continue;
          if ((where as any).resourceId && (v.resourceId ?? v.draftId) !== (where as any).resourceId) continue;
          if ('operationKey' in where && (v.operationKey ?? null) !== (where as any).operationKey) continue;
          return { kind: 'workspace_document', resourceId: v.draftId, ...v };
        }
        return null;
      }),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        Array.from(shareLinks.values()).filter(v => Object.entries(where).every(([key, value]) => {
          const actual = key === 'kind' ? v.kind ?? 'workspace_document' : ['operationKey', 'requestHash', 'revokedAt'].includes(key) ? v[key] ?? null : v[key];
          return actual === value;
        })),
      ),
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
  } as unknown as Record<string, unknown>;
  prisma.$queryRaw = jest.fn(async () => []);
  let tail = Promise.resolve();
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const previous = tail; let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await fn(prisma); } finally { release(); }
  });
  return prisma;
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

  it('keeps a display label separate from an operation key and serializes retries', async () => {
    (prisma as any)._drafts.set('draft-1', { id: 'draft-1', tenantId: 'tenant-1', config: { sections: ['Body'], sectionContent: { Body: 'x'.repeat(4500) } } });
    const params = { label: 'For client', idempotencyKey: 'request-one', versionId: 'current-version', expiresInDays: 7 };
    const results = await Promise.all([service.createShareLink('tenant-1', 'draft-1', 'owner', params), service.createShareLink('tenant-1', 'draft-1', 'owner', params)]);
    expect(results.filter(result => result.token.length === 64)).toHaveLength(1);
    expect(results.map(result => result.shareId)).toEqual([results[0].shareId, results[0].shareId]);
    const rows = [...(prisma as any)._shareLinks.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'For client', operationKey: 'request-one', kind: 'workspace_document' });
    expect(rows[0].payload.sections[0].content).toHaveLength(4500);
    await expect(service.createShareLink('tenant-1', 'draft-1', 'owner', { ...params, expiresInDays: 8 })).rejects.toThrow('different immutable request');
    await expect(service.createShareLink('tenant-1', 'draft-1', 'owner', { ...params, label: 'Different display label' })).rejects.toThrow('different immutable request');
    expect((prisma as any)._shareLinks.size).toBe(1);
  });

  it('refuses ambiguous legacy label retries and unsupported complete content before insertion', async () => {
    (prisma as any)._drafts.set('draft-1', { id: 'draft-1', tenantId: 'tenant-1', config: {} });
    (prisma as any)._shareLinks.set('legacy', { id: 'legacy', tenantId: 'tenant-1', draftId: 'draft-1', label: 'old-key' });
    await expect(service.createShareLink('tenant-1', 'draft-1', 'owner', { versionId: 'current-version', idempotencyKey: 'old-key' })).rejects.toThrow('legacy share');
    (prisma as any)._drafts.get('draft-1').config = { mainBlocks: [{ type: 'photo', src: 'private-object' }] };
    await expect(service.createShareLink('tenant-1', 'draft-1', 'owner', { versionId: 'current-version', idempotencyKey: 'new-key' })).rejects.toThrow('unsupported photo block');
    expect((prisma as any)._shareLinks.size).toBe(1);
  });

  it('never admits a research portfolio capability to document reads or comments', async () => {
    const token = 'a'.repeat(64);
    (prisma as any)._shareLinks.set('research', { id: 'research', tenantId: 'tenant-1', kind: 'research_portfolio', resourceId: 'portfolio', tokenHash: service.hashToken(token), expiresAt: new Date(Date.now() + 10000) });
    await expect(service.getByToken(token)).rejects.toThrow('not found');
    await expect(service.addGuestComment(token, 'Must not persist', 'Guest')).rejects.toThrow('not found');
    expect((prisma as any)._guestComments.size).toBe(0);
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
    const token = '0000000000000000000000000000000000000000000000000000000000000001';
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
    const token = '0000000000000000000000000000000000000000000000000000000000000004';
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
    const token = '0000000000000000000000000000000000000000000000000000000000000005';
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
    const token = '0000000000000000000000000000000000000000000000000000000000000003';
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
    const token = '0000000000000000000000000000000000000000000000000000000000000002';
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

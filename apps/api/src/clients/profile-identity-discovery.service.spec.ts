jest.mock('./profile-identity-sources.service.js', () => ({
  ProfileIdentitySourcesService: class {},
}));
jest.mock('./profile-identity-claims.service.js', () => ({
  ProfileIdentityClaimsService: class {},
}));
jest.mock(
  '../engagement/attachments/profile-identity-upload.js',
  () => ({
    readIdentityUpload: jest.fn().mockResolvedValue({ indexSourceGeneration: 1 }),
    readIdentityUploadInTransaction: jest.fn().mockResolvedValue({ indexSourceGeneration: 1 }),
    sameIdentityUpload: jest.fn(),
  }),
  { virtual: true },
);
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ProfileIdentityDiscoveryService } from './profile-identity-discovery.service.js';
import { identityScore, type DiscoveredProfileIdentity } from './profile-identity.contracts.js';
import {
  readIdentityUpload,
  readIdentityUploadInTransaction,
  sameIdentityUpload,
} from '../engagement/attachments/profile-identity-upload.js';

const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000002',
  clerkUserId: 'fixture',
  role: 'standard_user',
} as TenantContext;
const selector = {
  source: 'sam' as const,
  externalId: 'ABCDE1234567',
  name: 'Fixture Engineering',
};
const request = { requestId: '10000000-0000-4000-8000-000000000003', sourceCandidate: selector };
const entity = {
  id: '10000000-0000-4000-8000-000000000004',
  canonicalName: selector.name,
  entityType: 'organization',
  metadata: {},
};
const found: DiscoveredProfileIdentity = {
  sourceCandidate: selector,
  sourceType: 'sam_entity',
  identifiers: [{ type: 'uei', value: selector.externalId }],
  evidence: [
    {
      label: 'SAM',
      url: 'https://sam.gov/entity/fixture',
      source: 'sam_entity',
      excerpt: selector.name,
      observedAt: '2026-11-04T00:00:00Z',
    },
  ],
  claims: [],
};
const unresolved = {
  status: 'unresolved',
  entity: null,
  candidates: [],
  resolutionMethod: 'unresolved',
  provenance: [],
};
function fixture() {
  const receipts = new Map<string, unknown>();
  const membership = jest.fn().mockResolvedValue({ role: ctx.role });
  const tx = {
    tenantMembership: { findFirst: membership },
    $queryRaw: jest.fn().mockResolvedValue([{ role: ctx.role }]),
    $executeRawUnsafe: jest.fn(),
    client: { findFirst: jest.fn().mockResolvedValue(null) },
    businessDevelopmentProspect: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: {
      findFirst: jest.fn(({ where }) => receipts.get(where.id) ?? null),
      create: jest.fn(async ({ data }) => {
        receipts.set(data.id, data);
        return data;
      }),
    },
  };
  const prisma = { withTenantUser: jest.fn((_tenant, _actor, work) => work(tx)) };
  const resolver = {
    preview: jest.fn().mockResolvedValue(unresolved),
    registerTenantPrivateEntity: jest.fn().mockResolvedValue(entity),
  };
  const registration = { registerGlobalPublicEntity: jest.fn().mockResolvedValue(entity) };
  const sources = {
    discover: jest.fn().mockResolvedValue({ candidates: [found], sourceGaps: [] }),
    refresh: jest.fn().mockResolvedValue(found),
    validateClaims: jest.fn().mockResolvedValue([]),
  };
  const claims = { retain: jest.fn() };
  return {
    service: new ProfileIdentityDiscoveryService(
      prisma as never,
      resolver as never,
      registration as never,
      sources as never,
      claims as never,
    ),
    membership,
    tx,
    resolver,
    registration,
    sources,
    claims,
  };
}
describe('profile identity acquisition and explicit confirmation', () => {
  beforeEach(() => {
    jest.mocked(readIdentityUpload).mockResolvedValue({ indexSourceGeneration: 1 } as never);
    jest
      .mocked(readIdentityUploadInTransaction)
      .mockResolvedValue({ indexSourceGeneration: 1 } as never);
    jest.mocked(sameIdentityUpload).mockReset();
  });
  it('locks and rechecks document scope and generation after waiting for confirmation ownership', async () => {
    const f = fixture();
    const sourceCandidate = {
      source: 'document' as const,
      externalId: request.requestId,
      name: selector.name,
    };
    jest
      .mocked(readIdentityUploadInTransaction)
      .mockRejectedValueOnce(new ForbiddenException('document revoked while waiting'));
    await expect(f.service.confirm(ctx, { ...request, sourceCandidate })).rejects.toThrow(
      'document revoked while waiting',
    );
    expect(readIdentityUploadInTransaction).toHaveBeenCalledWith(f.tx, ctx, request.requestId, {
      lock: true,
    });
    expect(f.registration.registerGlobalPublicEntity).not.toHaveBeenCalled();
    expect(f.claims.retain).not.toHaveBeenCalled();
  });
  it('rejects a source revision change before any identity or claim mutation', async () => {
    const f = fixture();
    jest.mocked(sameIdentityUpload).mockImplementationOnce(() => {
      throw new Error('source revision changed');
    });
    await expect(
      f.service.confirm(ctx, {
        ...request,
        claims: [
          {
            kind: 'parent',
            name: 'Parent Example',
            attachmentId: request.requestId,
            quote: 'Fixture Engineering is owned by Parent Example.',
          },
        ],
      }),
    ).rejects.toThrow('source revision changed');
    expect(f.registration.registerGlobalPublicEntity).not.toHaveBeenCalled();
  });
  it('keeps source acquisition read-only and requires a chooser for a name-only official record', async () => {
    const f = fixture();
    expect(await f.service.preview(ctx, { name: selector.name })).toMatchObject({
      status: 'ambiguous',
      candidates: [{ entity: { id: null }, sourceCandidate: selector }],
      requiresUserConfirmation: true,
    });
    expect(f.registration.registerGlobalPublicEntity).not.toHaveBeenCalled();
    expect(f.resolver.registerTenantPrivateEntity).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('permits document-only identity preview without a fabricated company name', async () => {
    const f = fixture();
    f.sources.discover.mockResolvedValue({ candidates: [], sourceGaps: [] });
    expect((await f.service.preview(ctx, { attachmentId: request.requestId })).status).toBe('none');
    expect(f.resolver.preview).not.toHaveBeenCalled();
    expect(f.sources.discover).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ name: '', attachmentId: request.requestId }),
      undefined,
    );
  });

  it('accepts a website alone while leaving company naming to source evidence', async () => {
    const f = fixture();
    f.sources.discover.mockResolvedValue({ candidates: [], sourceGaps: [] });
    expect((await f.service.preview(ctx, { website: 'fixture.example' })).status).toBe('none');
    expect(f.sources.discover).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ name: '', website: 'https://fixture.example/' }),
      undefined,
    );
  });

  it.each([false, true])(
    'returns source-supported website identity with document present=%s without creating or selecting a company',
    async (withDocument) => {
      const f = fixture();
      const website = {
        ...found,
        sourceType: 'person_confirmed_website' as const,
        identifiers: [],
        sourceCandidate: {
          source: 'website' as const,
          externalId: 'https://fixture.example/about',
          website: 'https://fixture.example/',
          name: selector.name,
        },
      };
      const document = {
        ...found,
        sourceType: 'person_confirmed_document' as const,
        identifiers: [],
        sourceCandidate: {
          source: 'document' as const,
          externalId: request.requestId,
          name: selector.name,
        },
        evidence: [
          {
            label: 'Uploaded document',
            source: 'document',
            attachmentId: request.requestId,
            excerpt: selector.name,
            observedAt: '2026-11-07T00:00:00Z',
          },
        ],
      };
      f.sources.discover.mockResolvedValue({
        candidates: withDocument ? [document, website] : [website],
        sourceGaps: [],
      });
      const input = {
        website: 'https://fixture.example/',
        ...(withDocument ? { name: selector.name, attachmentId: request.requestId } : {}),
      };
      const result = await f.service.preview(ctx, input);
      expect(result.status).toBe(withDocument ? 'exact' : 'ambiguous');
      expect(result.requiresUserConfirmation).toBe(true);
      expect(result.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceCandidate: website.sourceCandidate }),
        ]),
      );
      if (withDocument) {
        expect(result.candidates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceCandidate: document.sourceCandidate,
              evidence: document.evidence,
            }),
          ]),
        );
      }
      expect(f.sources.discover).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining(input),
        undefined,
      );
      expect(f.registration.registerGlobalPublicEntity).not.toHaveBeenCalled();
      expect(f.resolver.registerTenantPrivateEntity).not.toHaveBeenCalled();
      expect(f.claims.retain).not.toHaveBeenCalled();
      expect(f.tx.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it('offers known identities for document-derived names without silently merging a name-only match', async () => {
    const f = fixture();
    f.sources.discover.mockResolvedValue({
      candidates: [
        {
          ...found,
          identifiers: [],
          sourceType: 'person_confirmed_document',
          sourceCandidate: {
            source: 'document',
            externalId: request.requestId,
            name: selector.name,
          },
        },
      ],
      sourceGaps: [],
    });
    f.resolver.preview.mockResolvedValue({
      ...unresolved,
      status: 'resolved',
      entity,
      candidates: [
        {
          entity,
          confidence: 0.9,
          resolutionMethod: 'canonical_name_exact',
          reasons: [],
          provenance: [],
        },
      ],
    });
    const result = await f.service.preview(ctx, { attachmentId: request.requestId });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates.map((candidate) => candidate.entity.id)).toEqual([entity.id, null]);
    expect(f.resolver.preview).toHaveBeenCalledWith(
      ctx.tenantId,
      expect.objectContaining({ query: selector.name }),
    );
  });
  it('recognizes a literal exact identifier and domain plus company name', async () => {
    expect(
      (
        await fixture().service.preview(ctx, {
          name: selector.name,
          identifiers: [{ type: 'uei', value: selector.externalId }],
        })
      ).status,
    ).toBe('exact');
    expect(
      identityScore(
        { name: selector.name, website: 'https://fixture.example/' },
        {
          ...found,
          sourceCandidate: {
            source: 'website',
            name: selector.name,
            website: 'https://www.fixture.example/about',
            externalId: 'https://www.fixture.example/about',
          },
        },
      ),
    ).toBe(0.97);
  });

  it('combines About and Contact evidence for one domain/company instead of inventing ambiguity', async () => {
    const f = fixture();
    f.sources.discover.mockResolvedValue({
      candidates: ['/about', '/contact'].map((path) => ({
        ...found,
        identifiers: [],
        sourceType: 'person_confirmed_website',
        sourceCandidate: {
          source: 'website',
          name: selector.name,
          website: `https://fixture.example${path}`,
          externalId: `https://fixture.example${path}`,
        },
      })),
      sourceGaps: [],
    });
    const result = await f.service.preview(ctx, {
      name: selector.name,
      website: 'https://fixture.example',
    });
    expect(result.status).toBe('exact');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.evidence).toHaveLength(2);
  });

  it('preserves an authoritative canonical conflict even when one external source is confident', async () => {
    const f = fixture();
    f.resolver.preview.mockResolvedValue({
      ...unresolved,
      status: 'ambiguous',
      resolutionMethod: 'conflicting_identifiers',
    });
    const result = await f.service.preview(ctx, {
      name: selector.name,
      identifiers: [{ type: 'uei', value: selector.externalId }],
    });
    expect(result.status).toBe('ambiguous');
    expect(result.sourceGaps.join(' ')).toContain('identifiers conflict');
  });
  it('never treats conflicting authoritative identifiers as one confident identity', () => {
    expect(
      identityScore(
        {
          name: selector.name,
          identifiers: [
            { type: 'uei', value: selector.externalId },
            { type: 'cage', value: 'ZZZZZ' },
          ],
        },
        { ...found, identifiers: [...found.identifiers, { type: 'cage', value: 'ABC12' }] },
      ),
    ).toBeLessThan(0.95);
  });
  it('does not treat a known domain for another name as a confident match', async () => {
    const f = fixture();
    f.sources.discover.mockResolvedValue({ candidates: [], sourceGaps: [] });
    f.resolver.preview.mockResolvedValue({
      ...unresolved,
      status: 'resolved',
      entity,
      candidates: [
        {
          entity,
          confidence: 1,
          resolutionMethod: 'identifier_exact',
          reasons: [],
          provenance: [{ identifierType: 'domain' }],
        },
      ],
    });
    expect(
      (
        await f.service.preview(ctx, {
          name: 'A different organization',
          website: 'https://fixture.example',
        })
      ).status,
    ).toBe('ambiguous');
  });
  it('rechecks exact source identity before registration and returns a replayable existing receipt', async () => {
    const f = fixture();
    const result = await f.service.confirm(ctx, request);
    expect(result).toEqual({
      requestId: request.requestId,
      canonicalEntityId: entity.id,
      sourceCandidate: selector,
    });
    expect(f.sources.refresh).toHaveBeenCalledWith(ctx, selector, undefined);
    expect(f.registration.registerGlobalPublicEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalName: selector.name,
        resolutionMethod: 'sam_entity',
        identifiers: [
          expect.objectContaining({
            type: 'uei',
            value: selector.externalId,
            sourceType: 'sam_entity',
          }),
        ],
      }),
    );
    expect(await f.service.confirm(ctx, request)).toEqual(result);
    expect(f.sources.refresh).toHaveBeenCalledTimes(1);
    expect(f.registration.registerGlobalPublicEntity).toHaveBeenCalledTimes(1);
  });
  it('rejects reuse of a confirmation ID with a different selection before source work', async () => {
    const f = fixture();
    await f.service.confirm(ctx, request);
    await expect(
      f.service.confirm(ctx, { ...request, sourceCandidate: { ...selector, name: 'Other' } }),
    ).rejects.toThrow('another identity command');
    expect(f.sources.refresh).toHaveBeenCalledTimes(1);
  });
  it('does not register or return source output after current actor authority is revoked', async () => {
    const f = fixture();
    f.sources.refresh.mockImplementation(async () => {
      f.membership.mockResolvedValue(null);
      return found;
    });
    await expect(f.service.confirm(ctx, request)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.registration.registerGlobalPublicEntity).not.toHaveBeenCalled();
  });
  it('retains only explicitly selected validated claims through the tenant-scoped owner', async () => {
    const f = fixture();
    const claim = {
      kind: 'parent' as const,
      name: 'Parent Example',
      sourceUrl: 'https://fixture.example/about',
      quote: 'Fixture Engineering is a subsidiary of Parent Example.',
    };
    f.sources.validateClaims.mockResolvedValue([claim]);
    await f.service.confirm(ctx, { ...request, claims: [claim] });
    expect(f.claims.retain).toHaveBeenCalledWith(ctx, entity.id, [claim]);
  });
  it('does not silently attach a website source to a different identity sharing its domain', async () => {
    const f = fixture();
    const website = {
      ...found,
      sourceType: 'person_confirmed_website' as const,
      identifiers: [],
      sourceCandidate: {
        source: 'website' as const,
        externalId: 'https://fixture.example',
        website: 'https://fixture.example',
        name: 'Different company',
      },
    };
    f.sources.refresh.mockResolvedValue(website);
    f.resolver.preview.mockResolvedValue({
      ...unresolved,
      status: 'resolved',
      entity,
      candidates: [{ entity, resolutionMethod: 'identifier_exact' }],
    });
    await expect(
      f.service.confirm(ctx, { ...request, sourceCandidate: website.sourceCandidate }),
    ).rejects.toThrow('overlaps another known identity');
    expect(f.resolver.registerTenantPrivateEntity).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { SourceResolverService } from './source-resolver.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CollaboratorsService } from '../collaborators/collaborators.service.js';
import type { AttachmentResolver } from './source-resolver.service.js';

function createMockPrisma(): PrismaService {
  return {
    $queryRaw: jest.fn(async () => []),
    wsDraft: {
      findFirst: jest.fn(async () => null),
    },
    wsContextItem: {
      findFirst: jest.fn(async () => null),
    },
    wsBlueprintVersion: {
      findFirst: jest.fn(async () => ({
        id: 'bpv-1',
        version: 1,
        definition: {},
        definitionHash: 'hash',
        blueprintId: 'bp-1',
        status: 'published',
      })),
    },
  } as unknown as PrismaService;
}

function createMockCollaborators(): CollaboratorsService {
  return {
    resolveRole: jest.fn(async () => 'owner'),
    assertCan: jest.fn(async () => 'owner'),
  } as unknown as CollaboratorsService;
}

function createMockAttachmentResolver(): AttachmentResolver {
  return {
    resolveAttachment: jest.fn(async () => ({ status: 'not_implemented' })),
  } as unknown as AttachmentResolver;
}

describe('SourceResolverService', () => {
  let prisma: PrismaService;
  let collaborators: CollaboratorsService;
  let attachmentResolver: AttachmentResolver;
  let service: SourceResolverService;

  beforeEach(() => {
    prisma = createMockPrisma();
    collaborators = createMockCollaborators();
    attachmentResolver = createMockAttachmentResolver();
    service = new SourceResolverService(prisma, collaborators, attachmentResolver);
  });

  describe('resolve', () => {
    it('resolves a blueprint version as a structural source', async () => {
      const result = await service.resolve(
        'tenant-1',
        'actor-1',
        'draft-1',
        {
          goal: 'Test goal',
          blueprintVersionId: 'bpv-1',
          factualAttachmentIds: [],
          sampleAttachmentIds: [],
          priorWorkspaceDraftIds: [],
        },
      );
      expect(result).toBeDefined();
      expect(result.sources).toBeDefined();
      expect(result.sources.length).toBeGreaterThanOrEqual(1);
      // The blueprint version should be the first source
      expect(result.sources[0]!.sourceType).toContain('blueprint');
    });

    it('throws when the blueprint version is not published', async () => {
      const mockPrisma = createMockPrisma();
      (
        mockPrisma.wsBlueprintVersion.findFirst as ReturnType<typeof jest.fn>
      ).mockResolvedValue(null);
      const svc = new SourceResolverService(
        mockPrisma,
        collaborators,
        attachmentResolver,
      );
      await expect(
        svc.resolve('tenant-1', 'actor-1', 'draft-1', {
          goal: 'Test',
          blueprintVersionId: 'bad-bpv',
          factualAttachmentIds: [],
          sampleAttachmentIds: [],
          priorWorkspaceDraftIds: [],
        }),
      ).rejects.toThrow();
    });

    it('includes pasted context as a source', async () => {
      const result = await service.resolve(
        'tenant-1',
        'actor-1',
        'draft-1',
        {
          goal: 'Test goal',
          blueprintVersionId: 'bpv-1',
          factualAttachmentIds: [],
          sampleAttachmentIds: [],
          priorWorkspaceDraftIds: [],
          pastedContext: 'Some pasted context',
        },
      );
      const pasted = result.sources.find((s) => s.sourceType === 'pasted_text');
      expect(pasted).toBeDefined();
      expect(pasted!.factualUseAllowed).toBe(true);
    });

    it('includes pasted sample as style_only', async () => {
      const result = await service.resolve(
        'tenant-1',
        'actor-1',
        'draft-1',
        {
          goal: 'Test goal',
          blueprintVersionId: 'bpv-1',
          factualAttachmentIds: [],
          sampleAttachmentIds: [],
          priorWorkspaceDraftIds: [],
          pastedSample: 'Some sample text',
        },
      );
      const pasted = result.sources.find((s) => s.sourceType === 'pasted_text');
      expect(pasted).toBeDefined();
      expect(pasted!.factualUseAllowed).toBe(false);
    });
  });

  describe('sample citation rejection', () => {
    it('samples are always style_only and cannot be citation candidates', async () => {
      const result = await service.resolve(
        'tenant-1',
        'actor-1',
        'draft-1',
        {
          goal: 'Test goal',
          blueprintVersionId: 'bpv-1',
          factualAttachmentIds: [],
          sampleAttachmentIds: [],
          priorWorkspaceDraftIds: [],
          pastedSample: 'Sample text',
        },
      );
      const sample = result.sources.find(
        (s) => s.sourceType === 'pasted_text' && s.factualUseAllowed === false,
      );
      expect(sample).toBeDefined();
      expect(sample!.usePolicy).toContain('style');
    });
  });
});

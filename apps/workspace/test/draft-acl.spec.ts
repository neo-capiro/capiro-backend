import { ForbiddenException } from '@nestjs/common';
import { ContextService } from '../src/context/context.service';
import { VersionsService } from '../src/versions/versions.service';
import { ExportService } from '../src/export/export.service';
import { GenerationService } from '../src/generation/generation.service';
import { canEdit, canRead } from '../src/collaborators/role-policy';
import type { CollaboratorsService } from '../src/collaborators/collaborators.service';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * GAI-31 regression: the workspace private-draft ACL must be enforced at EVERY
 * subservice boundary — not only DraftsService. Before this fix, generation /
 * context / versions / export authorized on tenantId + draft UUID alone, so any
 * same-tenant non-collaborator with a UUID could generate into, read the
 * provenance of, snapshot/restore, or export another user's private draft.
 *
 * These are pure unit tests: CollaboratorsService.assertCan is mocked, so no DB
 * is required. They prove (a) the guarded methods call assertCan with the RIGHT
 * capability predicate (canRead vs canEdit), and (b) a denial (ForbiddenException
 * from assertCan) propagates — the mutation/read never proceeds.
 */
describe('GAI-31 workspace draft ACL enforcement at subservice boundaries', () => {
  const TENANT = 'tenant-1';
  const DRAFT = 'draft-1';
  const INTRUDER = 'user_not_a_collaborator';

  // A draft always resolves under the tenant scope (the OLD authorization) — the
  // new ACL is the only thing that can deny a same-tenant non-collaborator.
  function prismaWithDraft(): PrismaService {
    const draft = { id: DRAFT, tenantId: TENANT, config: {}, documents: [], ownerId: 'owner' };
    return {
      wsDraft: {
        findFirst: jest.fn().mockResolvedValue(draft),
        update: jest.fn().mockResolvedValue(draft),
      },
      wsContextItem: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue({ id: 'item-1' }),
        delete: jest.fn().mockResolvedValue({}),
      },
      wsDocVersion: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
  }

  // assertCan that ALWAYS denies — stands in for "actor is not a collaborator".
  function denier() {
    const assertCan = jest.fn(async () => {
      throw new ForbiddenException('denied');
    });
    return { assertCan } as unknown as CollaboratorsService & { assertCan: jest.Mock };
  }

  describe('ContextService', () => {
    it('listItems denies a non-collaborator (canRead) and never queries items', async () => {
      const collab = denier();
      const prisma = prismaWithDraft();
      const svc = new ContextService(prisma, collab);
      await expect(svc.listItems(TENANT, DRAFT, INTRUDER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(collab.assertCan.mock.calls[0]?.[3]).toBe(canRead);
      expect(prisma.wsContextItem.findMany as jest.Mock).not.toHaveBeenCalled();
    });

    it('addItem denies a non-collaborator (canEdit) and never writes', async () => {
      const collab = denier();
      const prisma = prismaWithDraft();
      const svc = new ContextService(prisma, collab);
      await expect(
        svc.addItem(TENANT, DRAFT, { kind: 'free-text', payload: { text: 'x' } }, INTRUDER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(collab.assertCan.mock.calls[0]?.[3]).toBe(canEdit);
      expect(prisma.wsContextItem.create as jest.Mock).not.toHaveBeenCalled();
    });

    it('removeItem denies a non-collaborator (canEdit) and never deletes', async () => {
      const collab = denier();
      const prisma = prismaWithDraft();
      const svc = new ContextService(prisma, collab);
      await expect(svc.removeItem(TENANT, DRAFT, 'item-1', INTRUDER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(collab.assertCan.mock.calls[0]?.[3]).toBe(canEdit);
      expect(prisma.wsContextItem.delete as jest.Mock).not.toHaveBeenCalled();
    });
  });

  describe('VersionsService', () => {
    it('list denies a non-collaborator (canRead)', async () => {
      const collab = denier();
      const svc = new VersionsService(prismaWithDraft(), collab);
      await expect(svc.list(TENANT, DRAFT, INTRUDER)).rejects.toBeInstanceOf(ForbiddenException);
      expect(collab.assertCan.mock.calls[0]?.[3]).toBe(canRead);
    });

    it('restore denies a non-collaborator (canEdit) and never overwrites the draft', async () => {
      const collab = denier();
      const prisma = prismaWithDraft();
      const svc = new VersionsService(prisma, collab);
      await expect(svc.restore(TENANT, DRAFT, 'ver-1', INTRUDER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(collab.assertCan.mock.calls[0]?.[3]).toBe(canEdit);
      expect(prisma.wsDraft.update as jest.Mock).not.toHaveBeenCalled();
    });

    it('create (snapshot) denies a non-editor (canEdit)', async () => {
      const collab = denier();
      const svc = new VersionsService(prismaWithDraft(), collab);
      await expect(svc.create(TENANT, DRAFT, INTRUDER, {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(collab.assertCan.mock.calls[0]?.[3]).toBe(canEdit);
    });
  });

  describe('ExportService', () => {
    it('buildDocx denies a non-collaborator (canRead) and never renders', async () => {
      const collab = denier();
      const svc = new ExportService(prismaWithDraft(), collab);
      await expect(svc.buildDocx(TENANT, DRAFT, undefined, INTRUDER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(collab.assertCan.mock.calls[0]?.[3]).toBe(canRead);
    });

    it('buildPdf denies a non-collaborator (canRead)', async () => {
      const collab = denier();
      const svc = new ExportService(prismaWithDraft(), collab);
      await expect(svc.buildPdf(TENANT, DRAFT, undefined, INTRUDER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(collab.assertCan.mock.calls[0]?.[3]).toBe(canRead);
    });
  });

  describe('GenerationService', () => {
    function makeGen(collab: CollaboratorsService) {
      return new GenerationService(
        prismaWithDraft(),
        {} as never, // AiCredentialService — never reached (ACL asserts first)
        {} as never, // PeResolverService
        {} as never, // MeriV2FlagsService
        {} as never, // MeriV2OrchestratorClient
        {} as never, // WorkspaceContextCompilerService
        collab,
      );
    }

    it('generateAllSections denies a non-editor (canEdit) before any generation/flag check', async () => {
      const collab = denier();
      const svc = makeGen(collab);
      await expect(svc.generateAllSections(TENANT, DRAFT, INTRUDER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(collab.assertCan.mock.calls[0]?.[3]).toBe(canEdit);
    });

    it('generateSection denies a non-editor (canEdit)', async () => {
      const collab = denier();
      const svc = makeGen(collab);
      await expect(svc.generateSection(TENANT, DRAFT, 'Summary', INTRUDER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(collab.assertCan.mock.calls[0]?.[3]).toBe(canEdit);
    });

    it('applyGeneratedSections denies a non-editor (canEdit) and never writes', async () => {
      const collab = denier();
      const prisma = prismaWithDraft();
      const svc = new GenerationService(
        prisma,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        collab,
      );
      await expect(
        svc.applyGeneratedSections(TENANT, DRAFT, { sectionContent: { Summary: 'x' } }, INTRUDER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(collab.assertCan.mock.calls[0]?.[3]).toBe(canEdit);
      expect(prisma.wsDraft.update as jest.Mock).not.toHaveBeenCalled();
    });

    it('getContextUsed denies a non-collaborator (canRead)', async () => {
      const collab = denier();
      const svc = makeGen(collab);
      await expect(svc.getContextUsed(TENANT, DRAFT, INTRUDER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(collab.assertCan.mock.calls[0]?.[3]).toBe(canRead);
    });
  });
});

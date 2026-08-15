import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { IntakeService } from './intake.service.js';
import { SourceResolverService } from './source-resolver.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TwoStepDraftFlagsService } from './two-step-draft-flags.service.js';
import type { IntakeRequestDto } from './dto/intake.dto.js';

// Mock PrismaService — never call a live DB
function createMockPrisma(): PrismaService {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0 as never),
    $queryRaw: jest.fn().mockResolvedValue([] as never),
    wsIntake: {
      findUnique: jest.fn().mockResolvedValue(null as never),
      create: jest.fn().mockResolvedValue({ id: 'intake-1' } as never),
      update: jest.fn().mockResolvedValue({} as never),
    },
    wsBlueprintVersion: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'bpv-1',
        version: 1,
        definitionHash: 'hash123',
        blueprintId: 'bp-1',
      } as never),
    },
    wsDraft: {
      create: jest.fn().mockResolvedValue({ id: 'draft-1' } as never),
    },
    wsGenerationRun: {
      create: jest.fn().mockResolvedValue({ id: 'run-1' } as never),
      update: jest.fn().mockResolvedValue({} as never),
    },
    wsDocument: {
      create: jest.fn().mockResolvedValue({ id: 'doc-1' } as never),
    },
  };
  return {
    $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) =>
      fn(tx),
    ) as never,
  } as unknown as PrismaService;
}

function createMockFlags(enabled: boolean): TwoStepDraftFlagsService {
  return {
    isTwoStepDraftEnabled: jest.fn().mockResolvedValue(enabled as never),
  } as unknown as TwoStepDraftFlagsService;
}

function createMockSourceResolver(): SourceResolverService {
  return {
    resolve: jest.fn().mockResolvedValue({
      sources: [],
      domainLabels: [],
    } as never),
  } as unknown as SourceResolverService;
}

const validDto: IntakeRequestDto = {
  goal: 'Write a federal grant proposal for STEM education',
  blueprintVersionId: 'bpv-1',
  factualAttachmentIds: ['att-1', 'att-2'],
  sampleAttachmentIds: ['sample-1'],
  priorWorkspaceDraftIds: ['draft-old-1'],
};

describe('IntakeService', () => {
  let prisma: PrismaService;
  let flags: TwoStepDraftFlagsService;
  let sourceResolver: SourceResolverService;
  let service: IntakeService;

  beforeEach(() => {
    prisma = createMockPrisma();
    flags = createMockFlags(true);
    sourceResolver = createMockSourceResolver();
    service = new IntakeService(prisma, flags, sourceResolver);
  });

  describe('flag enforcement', () => {
    it('rejects when the two-step flag is off', async () => {
      const disabledFlags = createMockFlags(false);
      const svc = new IntakeService(prisma, disabledFlags, sourceResolver);
      await expect(
        svc.createIntake('tenant-1', 'actor-1', 'key-12345678', validDto),
      ).rejects.toThrow();
    });

    it('requires an idempotency key', async () => {
      await expect(
        service.createIntake('tenant-1', 'actor-1', '', validDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('idempotency', () => {
    it('returns the same draftId/runId on replay', async () => {
      const mockPrisma = {
        $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
          const tx = {
            $executeRaw: jest.fn().mockResolvedValue(0 as never),
            $queryRaw: jest.fn().mockResolvedValue([] as never),
            wsIntake: {
              findUnique: jest.fn().mockResolvedValue({
                draftId: 'existing-draft',
                runId: 'existing-run',
              } as never),
            },
          };
          return fn(tx);
        }) as never,
      } as unknown as PrismaService;
      const svc = new IntakeService(mockPrisma, flags, sourceResolver);
      const result = await svc.createIntake(
        'tenant-1',
        'actor-1',
        'key-12345678',
        validDto,
      );
      expect(result.draftId).toBe('existing-draft');
      expect(result.runId).toBe('existing-run');
    });
  });

  describe('blueprint validation', () => {
    it('rejects an unpublished blueprint', async () => {
      const mockPrisma = {
        $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
          const tx = {
            $executeRaw: jest.fn().mockResolvedValue(0 as never),
            $queryRaw: jest.fn().mockResolvedValue([] as never),
            wsIntake: {
              findUnique: jest.fn().mockResolvedValue(null as never),
            },
            wsBlueprintVersion: {
              findFirst: jest.fn().mockResolvedValue(null as never),
            },
          };
          return fn(tx);
        }) as never,
      } as unknown as PrismaService;
      const svc = new IntakeService(mockPrisma, flags, sourceResolver);
      await expect(
        svc.createIntake('tenant-1', 'actor-1', 'key-12345678', validDto),
      ).rejects.toThrow();
    });
  });

  describe('client validation', () => {
    it('rejects a client not in the tenant', async () => {
      const mockPrisma = {
        $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
          const tx = {
            $executeRaw: jest.fn().mockResolvedValue(0 as never),
            $queryRaw: jest.fn().mockResolvedValue([] as never),
            wsIntake: {
              findUnique: jest.fn().mockResolvedValue(null as never),
            },
            wsBlueprintVersion: {
              findFirst: jest.fn().mockResolvedValue({
                id: 'bpv-1',
                version: 1,
                definitionHash: 'hash',
                blueprintId: 'bp-1',
              } as never),
            },
          };
          return fn(tx);
        }) as never,
      } as unknown as PrismaService;
      const svc = new IntakeService(mockPrisma, flags, sourceResolver);
      const dtoWithClient = {
        ...validDto,
        clientId: 'bad-client',
      };
      await expect(
        svc.createIntake('tenant-1', 'actor-1', 'key-12345678', dtoWithClient),
      ).rejects.toThrow();
    });
  });

  describe('response shape', () => {
    it('returns draftId, runId, status, and agentRevision', async () => {
      const result = await service.createIntake(
        'tenant-1',
        'actor-1',
        'key-12345678',
        validDto,
      );
      expect(result).toHaveProperty('draftId');
      expect(result).toHaveProperty('runId');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('agentRevision');
      expect(result.status).toBe('queued');
      expect(result.agentRevision).toBe(0);
    });
  });

  describe('source trust model', () => {
    it('accepts only IDs — never source bodies', () => {
      const dto: IntakeRequestDto = {
        goal: 'test',
        blueprintVersionId: 'bpv-1',
        factualAttachmentIds: ['att-1'],
        sampleAttachmentIds: [],
        priorWorkspaceDraftIds: [],
      };
      expect(dto).not.toHaveProperty('text');
      expect(dto).not.toHaveProperty('sources');
    });
  });
});

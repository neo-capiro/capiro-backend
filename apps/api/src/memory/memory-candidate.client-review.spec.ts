import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { AppConfig } from '../config/config.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryCandidateService } from './memory-candidate.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CANDIDATE = '22222222-2222-4222-8222-222222222222';
const PROPOSER = '33333333-3333-4333-8333-333333333333';
const REVIEWER = '44444444-4444-4444-8444-444444444444';
const CLIENT = '55555555-5555-4555-8555-555555555555';
const MEMORY = '66666666-6666-4666-8666-666666666666';

const ctx: Pick<TenantContext, 'tenantId' | 'userId' | 'role'> = {
  tenantId: TENANT,
  userId: REVIEWER,
  role: 'standard_user',
};

function withAuthorization<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.MEMORY_GOVERNANCE_ENFORCE;
  const priorLifecycle = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
  delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  return fn().finally(() => {
    if (prior === undefined) delete process.env.MEMORY_GOVERNANCE_ENFORCE;
    else process.env.MEMORY_GOVERNANCE_ENFORCE = prior;
    if (priorLifecycle === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    else process.env.MEMORY_GOVERNANCE_LIFECYCLE = priorLifecycle;
  });
}

function harness(allowed: boolean) {
  const order: string[] = [];
  let candidateStatus = 'pending';
  let memoryCreated = false;

  const tx = {
    memoryCandidate: {
      update: jest.fn(async () => {
        order.push('decision');
        candidateStatus = 'approved';
        return {};
      }),
    },
    clioMemory: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => {
        order.push('memory');
        memoryCreated = true;
        return { id: MEMORY };
      }),
      update: jest.fn(async () => ({})),
    },
    $queryRaw: jest.fn(async (strings: unknown, ...params: unknown[]) => {
      const raw = (strings as { raw?: string[] }).raw;
      const sql = Array.isArray(raw) ? raw.join('?') : String(strings);
      if (/FOR UPDATE/i.test(sql)) {
        order.push('lock');
        if (candidateStatus !== 'pending') return [];
        return [
          {
            id: CANDIDATE,
            payload: {
              key: 'client-priority:fy27',
              value: 'Protect the FY27 request.',
              source: 'settings_memory_editor',
              scope: 'client',
              ownerUserId: null,
              clientId: CLIENT,
            },
            proposedBy: PROPOSER,
            scope: 'client',
            sourceKind: 'settings_sections',
          },
        ];
      }
      if (/updated_at\s+FROM\s+clio_memory/i.test(sql)) {
        return [{ updated_at: new Date('2026-07-31T12:00:00.000Z') }];
      }
      return [];
    }),
    $executeRaw: jest.fn(async () => 1),
  };

  const prisma = {
    withTenantUser: jest.fn(
      async <T>(
        tenantId: string,
        userId: string,
        fn: (value: Prisma.TransactionClient) => Promise<T>,
      ) => {
        expect(tenantId).toBe(TENANT);
        expect(userId).toBe(REVIEWER);
        return fn(tx as unknown as Prisma.TransactionClient);
      },
    ),
    withSystem: jest.fn(async (fn: (value: Prisma.TransactionClient) => unknown) =>
      fn({ $executeRaw: jest.fn(async () => 1) } as unknown as Prisma.TransactionClient),
    ),
  } as unknown as PrismaService;

  const authorization = {
    loadCandidateInTx: jest.fn(async () => {
      order.push('load-auth');
      return {
        id: CANDIDATE,
        tenantId: TENANT,
        clientId: CLIENT,
        ownerUserId: PROPOSER,
        proposedByUserId: PROPOSER,
        memoryClass: 'client_steering',
        scope: 'client',
        status: 'pending_review',
        legalHold: false,
        clientStatus: 'active',
      };
    }),
    evaluateInTx: jest.fn(async () => {
      order.push('authorize');
      return allowed
        ? { allowed: true, basis: 'explicit_grant' }
        : { allowed: false, reason: 'missing_grant' };
    }),
  } as unknown as MemoryAuthorizationService;

  const ingest = {
    projectClioMemory: jest.fn(async () => undefined),
  } as unknown as MemoryIngestService;
  const config = { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>;
  const service = new MemoryCandidateService(
    prisma,
    ingest,
    config,
    undefined,
    undefined,
    authorization,
  );

  return {
    service,
    order,
    memoryCreated: () => memoryCreated,
    candidateStatus: () => candidateStatus,
    authorization,
    prisma,
  };
}

describe('MemoryCandidateService — Phase 12 client reviewer', () => {
  it('allows a standard client reviewer only after authorization under the row lock', async () => {
    await withAuthorization(async () => {
      const h = harness(true);
      await expect(h.service.approve(TENANT, CANDIDATE, REVIEWER, ctx)).resolves.toEqual({
        memoryId: MEMORY,
      });
      expect(h.order.slice(0, 4)).toEqual(['lock', 'load-auth', 'authorize', 'memory']);
      expect(h.order).toContain('decision');
      expect(h.memoryCreated()).toBe(true);
      expect(h.candidateStatus()).toBe('approved');
      expect(h.authorization.evaluateInTx).toHaveBeenCalledWith(
        expect.anything(),
        ctx,
        expect.objectContaining({ clientId: CLIENT }),
        'approve',
      );
      expect(h.prisma.withTenantUser).toHaveBeenCalledTimes(1);
    });
  });

  it('denies without the grant and performs no canonical memory mutation', async () => {
    await withAuthorization(async () => {
      const h = harness(false);
      await expect(h.service.approve(TENANT, CANDIDATE, REVIEWER, ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(h.order).toEqual(['lock', 'load-auth', 'authorize']);
      expect(h.memoryCreated()).toBe(false);
      expect(h.candidateStatus()).toBe('pending');
      expect(h.prisma.withTenantUser).toHaveBeenCalledTimes(1);
    });
  });
});

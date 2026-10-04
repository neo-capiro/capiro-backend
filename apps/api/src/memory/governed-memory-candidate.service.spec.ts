import { describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AppConfig } from '../config/config.schema.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import type { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import { GovernedMemoryCandidateService } from './governed-memory-candidate.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROPOSER = '22222222-2222-4222-8222-222222222222';
const REVIEWER = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const CANDIDATE = '55555555-5555-4555-8555-555555555555';

const proposerCtx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'test',
  userId: PROPOSER,
  clerkUserId: 'user_proposer',
  role: 'standard_user',
};

const reviewerCtx: TenantContext = {
  ...proposerCtx,
  userId: REVIEWER,
  clerkUserId: 'user_reviewer',
};

function withReviewSurface<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  const prior = {
    lifecycle: process.env.MEMORY_GOVERNANCE_LIFECYCLE,
    enforce: process.env.MEMORY_GOVERNANCE_ENFORCE,
    review: process.env.MEMORY_CLIENT_REVIEW,
  };
  if (enabled) {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
    process.env.MEMORY_CLIENT_REVIEW = 'enforce';
  } else {
    delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    delete process.env.MEMORY_GOVERNANCE_ENFORCE;
    delete process.env.MEMORY_CLIENT_REVIEW;
  }
  return fn().finally(() => {
    if (prior.lifecycle === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    else process.env.MEMORY_GOVERNANCE_LIFECYCLE = prior.lifecycle;
    if (prior.enforce === undefined) delete process.env.MEMORY_GOVERNANCE_ENFORCE;
    else process.env.MEMORY_GOVERNANCE_ENFORCE = prior.enforce;
    if (prior.review === undefined) delete process.env.MEMORY_CLIENT_REVIEW;
    else process.env.MEMORY_CLIENT_REVIEW = prior.review;
  });
}

function sqlText(strings: TemplateStringsArray | unknown): string {
  return Array.isArray((strings as { raw?: string[] }).raw)
    ? (strings as { raw: string[] }).raw.join('?')
    : String(strings);
}

function harness(
  options: {
    proposedBy?: string;
    scope?: 'firm' | 'client';
    wallAllowed?: boolean;
    reviewerAllowed?: boolean;
    recordedSources?: Record<string, { sourceType?: unknown; sourceId?: unknown }>;
  } = {},
) {
  const state = {
    status: 'pending',
    governedStatus: 'pending_review',
    proposedBy: options.proposedBy ?? PROPOSER,
    scope: options.scope ?? 'client',
    clientId: options.scope === 'firm' ? null : CLIENT,
    sourceKind: 'settings_sections',
    decidedBy: null as string | null,
    decidedAt: null as Date | null,
  };
  const audits: Array<Record<string, unknown>> = [];
  const payload = {
    key: 'settings-file:client-soul:client-1',
    value: 'proposed value',
    canonicalItem: null,
  };
  const findFirst = jest.fn(async (args?: { where?: { id?: string }; select?: Record<string, boolean> }) => ({
    payload: { ...payload, sourceExcerpt: 'must not be copied', sourceRef: 'https://must-not-leak.invalid' },
    ...(options.recordedSources?.[args?.where?.id ?? ''] ?? {}),
  }));

  const tx = {
    client: {
      findFirst: jest.fn(async () => ({ id: CLIENT })),
      findMany: jest.fn(async () => [{ id: CLIENT, name: 'Test Client' }]),
    },
    memoryCandidate: {
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        state.status = String(args.data.status ?? state.status);
        state.governedStatus = String(args.data.governedStatus ?? state.governedStatus);
        state.decidedBy = (args.data.decidedBy as string | null) ?? state.decidedBy;
        state.decidedAt = (args.data.decidedAt as Date | null) ?? state.decidedAt;
        return {};
      }),
      findMany: jest.fn(async () => [
        {
          id: CANDIDATE,
          clientId: state.clientId,
          proposedBy: state.proposedBy,
          sourceKind: state.sourceKind,
          scope: state.scope,
          status: state.status,
          createdAt: new Date('2026-07-31T12:00:00.000Z'),
          decidedAt: state.decidedAt,
        },
      ]),
      findFirst,
    },
    memoryTransitionAudit: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data);
        return { id: `audit-${audits.length}` };
      }),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = sqlText(strings);
      if (/FOR UPDATE/i.test(sql)) {
        return state.status === 'pending'
          ? [
              {
                id: CANDIDATE,
                proposedBy: state.proposedBy,
                scope: state.scope,
                sourceKind: state.sourceKind,
                clientId: state.clientId,
              },
            ]
          : [];
      }
      if (/governed_status/i.test(sql)) {
        return [
          {
            scope: state.scope,
            source_kind: state.sourceKind,
            client_id: state.clientId,
            governed_status: state.governedStatus,
            expires_at: null,
          },
        ];
      }
      return [];
    }),
    $queryRawUnsafe: jest.fn(async () =>
      options.wallAllowed === false ? [] : [{ allowed: true }],
    ),
  };

  const prisma = {
    withTenantUser: jest.fn(
      async (_tenant: string, _user: string, fn: (value: typeof tx) => unknown) => fn(tx),
    ),
  } as unknown as PrismaService;
  const authorization = {
    loadCandidateInTx: jest.fn(async () => ({
      id: CANDIDATE,
      tenantId: TENANT,
      clientId: state.clientId,
      ownerUserId: state.proposedBy,
      proposedByUserId: state.proposedBy,
      memoryClass: state.scope === 'client' ? 'client_steering' : 'institutional_authoritative',
      scope: state.scope,
      status: 'pending_review',
      legalHold: false,
      clientStatus: state.scope === 'client' ? 'active' : null,
    })),
    evaluateInTx: jest.fn(async () =>
      options.reviewerAllowed === false
        ? { allowed: false, reason: 'missing_grant' }
        : { allowed: true, basis: 'explicit_grant' },
    ),
  } as unknown as MemoryAuthorizationService;

  const service = new GovernedMemoryCandidateService(
    prisma,
    {} as MemoryIngestService,
    { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>,
    new MemoryTransitionAuditService(),
    {} as MemoryCleanupOutboxService,
    authorization,
  );

  return { service, state, audits, tx, authorization, findFirst };
}

describe('GovernedMemoryCandidateService Phase 13 dispositions', () => {
  it('lets the proposer withdraw atomically with distinct status and audit reason', async () => {
    await withReviewSurface(true, async () => {
      const h = harness();
      await expect(h.service.withdraw(proposerCtx, CANDIDATE)).resolves.toBeUndefined();
      expect(h.state).toMatchObject({
        status: 'withdrawn',
        governedStatus: 'rejected',
        decidedBy: PROPOSER,
      });
      expect(h.audits).toHaveLength(1);
      expect(h.audits[0]).toMatchObject({
        reasonCode: 'withdrawn_by_proposer',
        actorUserId: PROPOSER,
        fromStatus: 'pending_review',
        toStatus: 'rejected',
      });
      expect(JSON.stringify(h.audits)).not.toContain('proposed value');
    });
  });

  it('shows withdrawal and reviewer rejection as distinct proposer history outcomes', async () => {
    await withReviewSurface(true, async () => {
      const withdrawn = harness();
      await withdrawn.service.withdraw(proposerCtx, CANDIDATE);
      await expect(withdrawn.service.listOwnProposals(proposerCtx)).resolves.toEqual({
        enabled: true,
        candidates: [
          expect.objectContaining({
            id: CANDIDATE,
            status: 'withdrawn',
            clientName: 'Test Client',
            capabilities: { withdraw: false },
          }),
        ],
      });

      expect(withdrawn.tx.client.findMany).toHaveBeenCalledWith({
        where: { tenantId: TENANT, id: { in: [CLIENT] } },
        select: { id: true, name: true },
      });

      const rejected = harness();
      await rejected.service.reject(TENANT, CANDIDATE, REVIEWER, reviewerCtx);
      await expect(rejected.service.listOwnProposals(proposerCtx)).resolves.toEqual({
        enabled: true,
        candidates: [
          expect.objectContaining({
            id: CANDIDATE,
            status: 'rejected',
            clientName: 'Test Client',
            capabilities: { withdraw: false },
          }),
        ],
      });
    });
  });

  it('keeps the unpaged contract unchanged and keyset-pages candidate 51', async () => {
    await withReviewSurface(true, async () => {
      const h = harness({ scope: 'firm' });
      const rows = Array.from({ length: 51 }, (_, index) => ({
        id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
        clientId: null,
        proposedBy: PROPOSER,
        sourceKind: 'settings_sections',
        scope: 'firm' as const,
        status: 'pending',
        createdAt: new Date(Date.UTC(2026, 6, 31, 12, 0, 51 - index)),
        decidedAt: null,
      }));
      h.tx.memoryCandidate.findMany
        .mockImplementationOnce(async () => rows.slice(0, 50))
        .mockImplementationOnce(async () => rows.slice(0, 51))
        .mockImplementationOnce(async () => rows.slice(50));

      const legacy = await h.service.listOwnProposals(proposerCtx);
      expect(legacy).toEqual({ enabled: true, candidates: expect.any(Array) });
      expect(legacy).not.toHaveProperty('nextCursor');

      const first = await h.service.listOwnProposals(proposerCtx, { limit: 50 });
      expect(first.candidates).toHaveLength(50);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = await h.service.listOwnProposals(proposerCtx, {
        limit: 50,
        cursor: first.nextCursor!,
      });
      expect(second.candidates.map((candidate) => candidate.id)).toEqual([rows[50]!.id]);
      expect(second.nextCursor).toBeNull();
      expect(h.tx.memoryCandidate.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          take: 51,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          where: expect.objectContaining({ OR: expect.any(Array) }),
        }),
      );
    });
  });

  it('denies withdrawal by anybody other than the proposer', async () => {
    await withReviewSurface(true, async () => {
      const h = harness();
      await expect(h.service.withdraw(reviewerCtx, CANDIDATE)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(h.state.status).toBe('pending');
      expect(h.audits).toHaveLength(0);
    });
  });

  it('filters selected client and pending state in the owner query before the page limit', async () => {
    await withReviewSurface(true, async () => {
      const h = harness();
      await h.service.listOwnProposals(proposerCtx, { clientId: CLIENT, status: 'pending', limit: 1 });
      expect(h.tx.memoryCandidate.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          tenantId: TENANT, proposedBy: PROPOSER, scope: { in: ['firm', 'client', 'personal'] },
          status: 'pending', AND: [{ OR: [{ clientId: CLIENT }, { clientId: null }] }],
        }, take: 2,
      }));
      await h.service.listOwnProposals({ ...proposerCtx, tenantId: 'another-tenant', userId: 'another-user' }, { status: 'pending' });
      expect(h.tx.memoryCandidate.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'another-tenant', proposedBy: 'another-user', status: 'pending' }),
      }));
    });
  });

  it('binds scoped cursors to the tenant, proposer, client and pending filter', async () => {
    await withReviewSurface(true, async () => {
      const h = harness();
      const rows = await h.tx.memoryCandidate.findMany();
      const firstRow = rows[0];
      if (!firstRow) throw new Error('Expected the owned proposal fixture row');
      h.tx.memoryCandidate.findMany.mockImplementation(async () => [...rows, { ...firstRow, id: REVIEWER }]);
      const first = await h.service.listOwnProposals(proposerCtx, { clientId: CLIENT, status: 'pending', limit: 1 });
      expect(first.nextCursor).toEqual(expect.any(String));
      await expect(h.service.listOwnProposals(proposerCtx, { clientId: CLIENT, status: 'pending', cursor: first.nextCursor! })).resolves.toMatchObject({ enabled: true });
      for (const [actor, filter] of [
        [reviewerCtx, { clientId: CLIENT, status: 'pending' }],
        [{ ...proposerCtx, tenantId: 'other' }, { clientId: CLIENT, status: 'pending' }],
        [proposerCtx, { clientId: REVIEWER, status: 'pending' }],
        [proposerCtx, { clientId: CLIENT }],
      ] as const) {
        await expect(h.service.listOwnProposals(actor, { ...filter, cursor: first.nextCursor! })).rejects.toThrow('current proposal scope');
      }
    });
  });

  it('keeps scoped pending bodies and client names redacted after an ethical-wall revocation', async () => {
    await withReviewSurface(true, async () => {
      const h = harness({ wallAllowed: false });
      const page = await h.service.listOwnProposals(proposerCtx, { clientId: CLIENT, status: 'pending' });
      expect(page.candidates[0]).toMatchObject({ status: 'pending', restricted: true, proposal: null, clientName: null });
      expect(h.findFirst).not.toHaveBeenCalled();
      expect(page.candidates[0]).not.toHaveProperty('recordedSource');
      expect(h.tx.client.findMany).not.toHaveBeenCalled();
    });
  });

  it('refuses an unknown or other-tenant selected client before querying proposals', async () => {
    await withReviewSurface(true, async () => {
      const h = harness();
      h.tx.client.findFirst.mockResolvedValueOnce(null as never);
      await expect(h.service.listOwnProposals(proposerCtx, { clientId: CLIENT, status: 'pending' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.tx.client.findFirst).toHaveBeenCalledWith({ where: { id: CLIENT, tenantId: TENANT }, select: { id: true } });
      expect(h.tx.memoryCandidate.findMany).not.toHaveBeenCalled();
    });
  });

  it('forces an admin or granted proposer to use withdraw instead of reviewer rejection', async () => {
    await withReviewSurface(true, async () => {
      const h = harness();
      await expect(
        h.service.reject(TENANT, CANDIDATE, PROPOSER, proposerCtx),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.authorization.evaluateInTx).not.toHaveBeenCalled();
      expect(h.state.status).toBe('pending');
    });
  });

  it('lets an independent authorized reviewer reject with a distinct audit reason', async () => {
    await withReviewSurface(true, async () => {
      const h = harness();
      await expect(
        h.service.reject(TENANT, CANDIDATE, REVIEWER, reviewerCtx),
      ).resolves.toBeUndefined();
      expect(h.state.status).toBe('rejected');
      expect(h.audits[0]).toMatchObject({
        reasonCode: 'rejected_by_reviewer',
        actorUserId: REVIEWER,
      });
    });
  });

  it('cannot withdraw a terminal candidate twice', async () => {
    await withReviewSurface(true, async () => {
      const h = harness();
      await h.service.withdraw(proposerCtx, CANDIDATE);
      await expect(h.service.withdraw(proposerCtx, CANDIDATE)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(h.audits).toHaveLength(1);
    });
  });

  it('redacts a walled proposal body but still lets its proposer withdraw it', async () => {
    await withReviewSurface(true, async () => {
      const h = harness({ wallAllowed: false });
      const listed = await h.service.listOwnProposals(proposerCtx);
      expect(listed).toEqual({
        enabled: true,
        candidates: [
          expect.objectContaining({
            id: CANDIDATE,
            status: 'pending',
            restricted: true,
            clientName: null,
            proposal: null,
            capabilities: { withdraw: true },
          }),
        ],
      });
      expect(h.findFirst).not.toHaveBeenCalled();
      expect(h.tx.client.findMany).not.toHaveBeenCalled();
      await expect(h.service.withdraw(proposerCtx, CANDIDATE)).resolves.toBeUndefined();
    });
  });

  it('stays dark and mutation-free until the review surface is explicitly armed', async () => {
    await withReviewSurface(false, async () => {
      const h = harness();
      await expect(h.service.listOwnProposals(proposerCtx)).resolves.toEqual({
        enabled: false,
        candidates: [],
      });
      await expect(h.service.withdraw(proposerCtx, CANDIDATE)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(h.tx.memoryCandidate.update).not.toHaveBeenCalled();
    });
  });

  it('returns six distinct recorded references only for own proposals and never copies payload provenance', async () => {
    await withReviewSurface(true, async () => {
      const ids = Array.from({ length: 6 }, (_, index) =>
        `66666666-6666-4666-8666-${String(index + 1).padStart(12, '0')}`,
      );
      const recordedSources = Object.fromEntries(ids.map((id, index) => [id, {
        sourceType: 'meri_synthetic_fixture', sourceId: String(index + 1).repeat(64),
      }]));
      const h = harness({ recordedSources });
      h.tx.memoryCandidate.findMany.mockResolvedValue(ids.map((id, index) => ({
        id, clientId: CLIENT, proposedBy: PROPOSER, sourceKind: 'model_extraction', scope: 'client',
        status: 'pending', createdAt: new Date(Date.UTC(2026, 6, 31, 12, index)), decidedAt: null,
      })) as never);
      const page = await h.service.listOwnProposals(proposerCtx);
      expect(page.candidates.map((row) => row.recordedSource?.sourceId)).toEqual(
        Array.from({ length: 6 }, (_, index) => String(index + 1).repeat(64)),
      );
      expect(new Set(page.candidates.map((row) => row.recordedSource?.sourceId)).size).toBe(6);
      expect(h.tx.memoryCandidate.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, proposedBy: PROPOSER }),
      }));
      expect(h.findFirst).toHaveBeenCalledWith({
        where: { id: ids[0], tenantId: TENANT, proposedBy: PROPOSER },
        select: { payload: true, sourceType: true, sourceId: true },
      });
      expect(h.findFirst).toHaveBeenCalledTimes(6);
      expect(JSON.stringify(page)).not.toContain('sourceExcerpt');
      expect(JSON.stringify(page)).not.toContain('must-not-leak.invalid');
    });
  });

  it('retains a supported recorded UUID without reading its underlying content', async () => {
    await withReviewSurface(true, async () => {
      const h = harness({ recordedSources: { [CANDIDATE]: { sourceType: 'chat', sourceId: CLIENT } } });
      const page = await h.service.listOwnProposals(proposerCtx);
      expect(page.candidates[0]?.recordedSource).toEqual({ sourceType: 'chat', sourceId: CLIENT });
      expect(h.findFirst).toHaveBeenCalledWith({
        where: { id: CANDIDATE, tenantId: TENANT, proposedBy: PROPOSER },
        select: { payload: true, sourceType: true, sourceId: true },
      });
      expect(JSON.stringify(page)).not.toContain('sourceExcerpt');
      expect(JSON.stringify(page)).not.toContain('must-not-leak.invalid');
    });
  });

  it.each<[string, { sourceType?: unknown; sourceId?: unknown }]>([
    ['unknown type', { sourceType: 'unknown', sourceId: 'a'.repeat(64) }],
    ['unsupported type', { sourceType: 'UpperCase', sourceId: 'a'.repeat(64) }],
    ['malformed id', { sourceType: 'meri_synthetic_fixture', sourceId: 'A'.repeat(64) }],
    ['unsupported id', { sourceType: 'meri_synthetic_fixture', sourceId: 'source-ref' }],
    ['type newline', { sourceType: 'meri_synthetic_fixture\n', sourceId: 'a'.repeat(64) }],
    ['id newline', { sourceType: 'meri_synthetic_fixture', sourceId: 'a'.repeat(64) + '\n' }],
    ['oversized type', { sourceType: 'a'.repeat(41), sourceId: 'a'.repeat(64) }],
    ['URL id', { sourceType: 'chat', sourceId: 'https://example.invalid/private' }],
    ['missing type', { sourceId: 'a'.repeat(64) }],
    ['missing id', { sourceType: 'chat' }],
  ])('omits recorded provenance for %s', async (_label, source) => {
    await withReviewSurface(true, async () => {
      const h = harness({ recordedSources: { [CANDIDATE]: source } });
      const page = await h.service.listOwnProposals(proposerCtx);
      expect(page.candidates[0]).not.toHaveProperty('recordedSource');
    });
  });
});

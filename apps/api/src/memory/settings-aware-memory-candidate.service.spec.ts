import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  ImmutableMemoryVersionService,
  VersionCandidateDecisionResult,
} from './immutable-memory-version.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import type { PendingSettingsCandidate } from './memory-candidate.service.js';
import type { MemorySettingsReviewReadinessService } from './memory-settings-review-readiness.service.js';
import { SettingsAwareMemoryCandidateService } from './settings-aware-memory-candidate.service.js';
import type { SettingsMemoryVersionCandidateService } from './settings-memory-version-candidate.service.js';
import type { MemoryTransitionAuditService } from './memory-transition-audit.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_1',
  role: 'user_admin',
};

const input = {
  type: 'firm-soul' as const,
  slug: 'firm',
  title: 'Firm Soul',
  scope: 'firm' as const,
  clientId: null,
  sections: [{ key: 'who', heading: 'Who', owner: 'human' as const, body: 'Updated.' }],
};

function harness() {
  // Untyped jest.fn() infers its resolved value as `never`, so mockResolvedValue
  // of a real payload fails TS2345. Pin each mock to the service's return type.
  const proposeExistingCorrection = jest.fn<() => Promise<PendingSettingsCandidate | null>>();
  const findPendingSettingsCorrection = jest.fn<() => Promise<PendingSettingsCandidate | null>>();
  const isImmutableVersionCandidate = jest.fn<() => Promise<boolean>>();
  const approveCandidate = jest.fn<() => Promise<VersionCandidateDecisionResult>>();
  const rejectCandidate = jest.fn<() => Promise<VersionCandidateDecisionResult>>();
  const assertSubmissionReady = jest.fn<() => Promise<{ eligibleReviewers: [] }>>();
  const describePendingCandidate = jest.fn<
    (
      tenantId: string,
      userId: string,
      pending: PendingSettingsCandidate,
      options?: { reviewEnabled?: boolean },
    ) => Promise<PendingSettingsCandidate>
  >(async (_tenantId, _userId, pending, options) =>
    options?.reviewEnabled === false
      ? ({
          ...pending,
          blocked: true,
          nextAction: 'Shared memory review is currently unavailable.',
        } as PendingSettingsCandidate)
      : pending,
  );
  assertSubmissionReady.mockResolvedValue({ eligibleReviewers: [] });

  const settings = {
    proposeExistingCorrection,
    findPendingSettingsCorrection,
    isImmutableVersionCandidate,
  } as unknown as SettingsMemoryVersionCandidateService;
  const versions = {
    approveCandidate,
    rejectCandidate,
  } as unknown as ImmutableMemoryVersionService;
  const readiness = {
    assertSubmissionReady,
    describePendingCandidate,
  } as unknown as MemorySettingsReviewReadinessService;
  const query = jest.fn<() => Promise<Array<{ id: string; created_at: Date }>>>();
  query.mockResolvedValue([]);
  const tx = { $queryRaw: query };
  const withTenantUser = jest.fn(
    async (_tenantId: string, _userId: string, work: (value: typeof tx) => unknown) => work(tx),
  );
  const service = new SettingsAwareMemoryCandidateService(
    { withTenantUser } as unknown as PrismaService,
    {} as MemoryIngestService,
    { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>,
    {} as MemoryTransitionAuditService,
    {} as MemoryCleanupOutboxService,
    {} as MemoryAuthorizationService,
    settings,
    versions,
    readiness,
  );
  return {
    service,
    settings: {
      proposeExistingCorrection,
      findPendingSettingsCorrection,
      isImmutableVersionCandidate,
    },
    versions: { approveCandidate, rejectCandidate },
    readiness: { assertSubmissionReady, describePendingCandidate },
    inherited: { withTenantUser, query: tx.$queryRaw },
  };
}

function enableForTenant(tenantId = ctx.tenantId): void {
  process.env.MEMORY_CLIENT_REVIEW = 'enforce';
  process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
  process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
  process.env.MEMORY_GOVERNANCE_TENANTS = tenantId;
}

afterEach(() => {
  delete process.env.MEMORY_CLIENT_REVIEW;
  delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  delete process.env.MEMORY_GOVERNANCE_ENFORCE;
  delete process.env.MEMORY_GOVERNANCE_TENANTS;
  jest.restoreAllMocks();
});

describe('SettingsAwareMemoryCandidateService', () => {
  it('preflights and routes an existing shared Settings file to an immutable correction candidate', async () => {
    enableForTenant();
    const h = harness();
    h.settings.proposeExistingCorrection.mockResolvedValue({
      candidateId: 'candidate-1',
      status: 'pending_review',
      submittedAt: '2026-08-01T00:00:00.000Z',
    });

    await expect(h.service.proposeSettingsSections(ctx, input)).resolves.toMatchObject({
      candidateId: 'candidate-1',
      status: 'pending_review',
    });
    expect(h.readiness.assertSubmissionReady).toHaveBeenCalledWith(ctx, input);
    expect(h.settings.proposeExistingCorrection).toHaveBeenCalledTimes(1);
  });

  it('creates no candidate when review readiness fails', async () => {
    enableForTenant();
    const h = harness();
    h.readiness.assertSubmissionReady.mockRejectedValue(
      new ConflictException('No eligible independent reviewer.'),
    );

    await expect(h.service.proposeSettingsSections(ctx, input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(h.settings.proposeExistingCorrection).not.toHaveBeenCalled();
    expect(h.inherited.withTenantUser).not.toHaveBeenCalled();
  });

  it('routes compatibility approval through immutable activation', async () => {
    enableForTenant();
    const h = harness();
    h.settings.isImmutableVersionCandidate.mockResolvedValue(true);
    h.versions.approveCandidate.mockResolvedValue({
      candidateId: 'candidate-1',
      outcome: 'activated',
      memoryItemId: 'memory-item-2',
      controllingItemId: 'memory-item-2',
    });

    await expect(h.service.approve(ctx.tenantId, 'candidate-1', ctx.userId, ctx)).resolves.toEqual({
      memoryId: 'memory-item-2',
    });
    expect(h.versions.approveCandidate).toHaveBeenCalledWith(ctx, 'candidate-1');
  });

  it('surfaces an enriched pending immutable Settings correction on reload', async () => {
    enableForTenant();
    const h = harness();
    const pending = {
      candidateId: 'candidate-1',
      status: 'pending_review' as const,
      submittedAt: '2026-08-01T00:00:00.000Z',
    };
    h.settings.findPendingSettingsCorrection.mockResolvedValue(pending);
    h.readiness.describePendingCandidate.mockResolvedValue({
      ...pending,
      nextAction: 'Waiting for another administrator.',
    } as PendingSettingsCandidate);

    await expect(
      h.service.findPendingSettingsCandidate(ctx.tenantId, ctx.userId, 'firm-soul', 'firm'),
    ).resolves.toMatchObject({ candidateId: 'candidate-1' });
    expect(h.readiness.describePendingCandidate).toHaveBeenCalledWith(
      ctx.tenantId,
      ctx.userId,
      pending,
      { reviewEnabled: true },
    );
  });

  it('marks an existing pending proposal blocked when the review surface is disabled', async () => {
    const h = harness();
    const pending = {
      candidateId: 'candidate-1',
      status: 'pending_review' as const,
      submittedAt: '2026-08-01T00:00:00.000Z',
    };
    h.inherited.query.mockResolvedValue([
      { id: pending.candidateId, created_at: new Date(pending.submittedAt) },
    ]);

    await expect(
      h.service.findPendingSettingsCandidate(ctx.tenantId, ctx.userId, 'firm-soul', 'firm'),
    ).resolves.toMatchObject({
      candidateId: 'candidate-1',
      blocked: true,
      nextAction: expect.stringContaining('currently unavailable'),
    });
    expect(h.readiness.describePendingCandidate).toHaveBeenCalledWith(
      ctx.tenantId,
      ctx.userId,
      pending,
      { reviewEnabled: false },
    );
  });

  it('delegates to the inherited query for an unselected tenant', async () => {
    enableForTenant('33333333-3333-4333-8333-333333333333');
    const h = harness();

    await expect(
      h.service.findPendingSettingsCandidate(ctx.tenantId, ctx.userId, 'firm-soul', 'firm'),
    ).resolves.toBeNull();
    expect(h.settings.findPendingSettingsCorrection).not.toHaveBeenCalled();
    expect(h.inherited.withTenantUser).toHaveBeenCalledTimes(1);
    expect(h.inherited.query).toHaveBeenCalledTimes(1);
    expect(h.readiness.describePendingCandidate).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
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

function harness() {
  const settings = {
    proposeExistingCorrection: jest.fn(),
    findPendingSettingsCorrection: jest.fn(),
    isImmutableVersionCandidate: jest.fn(),
  } as unknown as SettingsMemoryVersionCandidateService;
  const versions = {
    approveCandidate: jest.fn(),
    rejectCandidate: jest.fn(),
  } as unknown as ImmutableMemoryVersionService;
  const service = new SettingsAwareMemoryCandidateService(
    {} as PrismaService,
    {} as MemoryIngestService,
    { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>,
    {} as MemoryTransitionAuditService,
    {} as MemoryCleanupOutboxService,
    {} as MemoryAuthorizationService,
    settings,
    versions,
  );
  return {
    service,
    settings: settings as unknown as {
      proposeExistingCorrection: jest.Mock;
      findPendingSettingsCorrection: jest.Mock;
      isImmutableVersionCandidate: jest.Mock;
    },
    versions: versions as unknown as {
      approveCandidate: jest.Mock;
      rejectCandidate: jest.Mock;
    },
  };
}

describe('SettingsAwareMemoryCandidateService', () => {
  it('routes an existing shared Settings file to an immutable correction candidate', async () => {
    const h = harness();
    h.settings.proposeExistingCorrection.mockResolvedValue({
      candidateId: 'candidate-1',
      status: 'pending_review',
      submittedAt: '2026-08-01T00:00:00.000Z',
    });

    await expect(
      h.service.proposeSettingsSections(ctx, {
        type: 'firm-soul',
        slug: 'firm',
        title: 'Firm Soul',
        scope: 'firm',
        clientId: null,
        sections: [{ key: 'who', heading: 'Who', owner: 'human', body: 'Updated.' }],
      }),
    ).resolves.toMatchObject({ candidateId: 'candidate-1', status: 'pending_review' });
  });

  it('routes compatibility approval through immutable activation', async () => {
    const h = harness();
    h.settings.isImmutableVersionCandidate.mockResolvedValue(true);
    h.versions.approveCandidate.mockResolvedValue({
      candidateId: 'candidate-1',
      outcome: 'activated',
      memoryItemId: 'memory-item-2',
      controllingItemId: 'memory-item-2',
    });

    await expect(
      h.service.approve(ctx.tenantId, 'candidate-1', ctx.userId, ctx),
    ).resolves.toEqual({ memoryId: 'memory-item-2' });
    expect(h.versions.approveCandidate).toHaveBeenCalledWith(ctx, 'candidate-1');
  });

  it('surfaces a pending immutable Settings correction on reload', async () => {
    const h = harness();
    h.settings.findPendingSettingsCorrection.mockResolvedValue({
      candidateId: 'candidate-1',
      status: 'pending_review',
      submittedAt: '2026-08-01T00:00:00.000Z',
    });

    await expect(
      h.service.findPendingSettingsCandidate(ctx.tenantId, ctx.userId, 'firm-soul', 'firm'),
    ).resolves.toMatchObject({ candidateId: 'candidate-1' });
  });
});

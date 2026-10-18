import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException, type Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { GovernedMemoryCandidateService } from './governed-memory-candidate.service.js';
import { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryCandidateService } from './memory-candidate.service.js';
import { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import { MemoryIngestService } from './memory-ingest.service.js';
import { MemoryModule } from './memory.module.js';
import { MemorySettingsReviewReadinessService } from './memory-settings-review-readiness.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import { SettingsAwareMemoryCandidateService } from './settings-aware-memory-candidate.service.js';
import { SettingsMemoryVersionCandidateService } from './settings-memory-version-candidate.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const candidateId = '44444444-4444-4444-8444-444444444444';

/** Use the provider aliases declared by MemoryModule, then inject only the
 * service's dependencies. This exercises the production SettingsAware →
 * Governed reject override rather than constructing the base class. */
async function injectedCandidate() {
  const declared = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MemoryModule) as Provider[];
  const candidateProviders = declared.filter((provider) =>
    provider === SettingsAwareMemoryCandidateService ||
    (typeof provider === 'object' && provider !== null && 'provide' in provider &&
      (provider.provide === GovernedMemoryCandidateService || provider.provide === MemoryCandidateService)),
  );
  expect(candidateProviders).toHaveLength(3);

  const update = jest.fn(async () => ({}));
  const tx = {
    $queryRaw: jest.fn(async () => [{
      id: candidateId, proposedBy: ownerId, scope: 'personal', sourceKind: 'explicit_user',
      sourceType: 'meri', clientId: null,
    }]),
    memoryCandidate: { update },
  };
  const withTenantUser = jest.fn(async (_tenant: string, _user: string, work: (tx: typeof tx) => Promise<unknown>) => work(tx));
  const moduleRef = await Test.createTestingModule({
    providers: [
      ...candidateProviders,
      { provide: PrismaService, useValue: { withTenantUser } },
      { provide: MemoryIngestService, useValue: {} },
      { provide: ConfigService, useValue: { get: () => undefined } },
      { provide: MemoryTransitionAuditService, useValue: {} },
      { provide: MemoryCleanupOutboxService, useValue: {} },
      { provide: MemoryAuthorizationService, useValue: {} },
      { provide: SettingsMemoryVersionCandidateService, useValue: { isImmutableVersionCandidate: async () => false } },
      { provide: ImmutableMemoryVersionService, useValue: {} },
      { provide: MemorySettingsReviewReadinessService, useValue: {} },
    ],
  }).compile();
  const service = moduleRef.get(MemoryCandidateService);
  expect(service).toBeInstanceOf(SettingsAwareMemoryCandidateService);
  expect(moduleRef.get(GovernedMemoryCandidateService)).toBe(service);
  return { service, update, moduleRef };
}

afterEach(() => {
  delete process.env.MEMORY_GOVERNANCE_ENFORCE;
  delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  delete process.env.MEMORY_GOVERNANCE_TENANTS;
});

describe('MemoryModule injected personal Meri rejection', () => {
  it('refuses a different reviewer before any update while governance enforcement is dark', async () => {
    delete process.env.MEMORY_GOVERNANCE_ENFORCE;
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    process.env.MEMORY_GOVERNANCE_TENANTS = tenantId;
    const { service, update, moduleRef } = await injectedCandidate();
    try {
      await expect(service.reject(tenantId, candidateId, otherId)).rejects.toBeInstanceOf(ForbiddenException);
      expect(update).not.toHaveBeenCalled();
    } finally {
      await moduleRef.close();
    }
  });

  it('allows the personal owner to reject on the same injected path', async () => {
    delete process.env.MEMORY_GOVERNANCE_ENFORCE;
    delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    const { service, update, moduleRef } = await injectedCandidate();
    try {
      await expect(service.reject(tenantId, candidateId, ownerId)).resolves.toBeUndefined();
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'rejected' }) }));
    } finally {
      await moduleRef.close();
    }
  });
});

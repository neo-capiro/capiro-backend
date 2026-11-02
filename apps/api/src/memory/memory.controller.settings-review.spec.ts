import { describe, expect, it, jest } from '@jest/globals';
import { GoneException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { MemoryController } from './memory.controller.js';
import type { MemoryStoreService } from './memory-store.service.js';
import type { MemoryCandidateService } from './memory-candidate.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'admin',
  role: 'user_admin',
};

function harness(opts: { existing?: any; wallAllowed?: boolean; pending?: any } = {}) {
  const getByTypeSlug = jest.fn(async () => opts.existing ?? null);
  const clientMemoryAllowedForCurrentUser = jest.fn(async () => opts.wallAllowed ?? true);
  const findPendingSettingsCandidate = jest.fn(async () => opts.pending ?? null);
  const requireItem = jest.fn(async () => undefined);
  const store = {
    getByTypeSlug,
    clientMemoryAllowedForCurrentUser,
  };
  const candidates = { findPendingSettingsCandidate };
  const controller = new MemoryController(
    store as unknown as MemoryStoreService,
    {} as any,
    {} as any,
    {} as any,
    candidates as unknown as MemoryCandidateService,
    {} as any,
    { requireItem } as unknown as MemoryAuthorizationService,
    {} as any,
    {} as any,
    { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>,
    {} as never,
  );
  return {
    controller,
    getByTypeSlug,
    clientMemoryAllowedForCurrentUser,
    findPendingSettingsCandidate,
  };
}

describe('Settings shared-memory review lifecycle', () => {
  it('returns an explicit 410 without reading or writing through any provider, including repeats', async () => {
    const touched = jest.fn((name: string) => {
      throw new Error('Unexpected provider: ' + name);
    });
    const provider = new Proxy({}, { get: (_target, property) => touched(String(property)) });
    const controller = new MemoryController(
      provider as never,
      provider as never,
      provider as never,
      provider as never,
      provider as never,
      provider as never,
      provider as never,
      provider as never,
      provider as never,
      provider as never,
      provider as never,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(controller.updateSections()).rejects.toBeInstanceOf(GoneException);
      await expect(controller.updateSections()).rejects.toMatchObject({
        status: 410,
        response: {
          code: 'MEMORY_SETTINGS_DRAFT_REQUIRED',
          message: expect.stringContaining('private memory draft'),
        },
      });
    }
    expect(touched).not.toHaveBeenCalled();
  });

  it('returns pending state on reload without replacing active sections', async () => {
    const pending = {
      candidateId: 'cand-1',
      status: 'pending_review',
      submittedAt: '2026-07-30T00:00:00.000Z',
    };
    const active = {
      title: 'Firm Soul',
      visibility: 'tenant',
      clientId: null,
      updatedAt: 'now',
      sections: [{ key: 'mission', heading: 'Mission', owner: 'human', body: 'Current' }],
    };
    const h = harness({ existing: active, pending });
    const result = await h.controller.itemSections(ctx, 'firm-soul', 'firm');
    expect(result.pendingReview).toEqual(pending);
    expect(result.sections[0]?.body).toBe('Current');
  });
});

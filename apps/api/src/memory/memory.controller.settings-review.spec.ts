import { describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
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
const CLIENT = '33333333-3333-4333-8333-333333333333';
const sections = [{ key: 'mission', body: 'Protect the active truth.' }];

function harness(opts: { existing?: any; wallAllowed?: boolean; pending?: any } = {}) {
  const getByTypeSlug = jest.fn(async () => opts.existing ?? null);
  const upsertSectionsForCurrentTenant = jest.fn(async () => ({
    updatedAt: '2026-07-30T00:00:00.000Z',
  }));
  const clientMemoryAllowedForCurrentUser = jest.fn(async () => opts.wallAllowed ?? true);
  const proposeSettingsSections = jest.fn(async () => ({
    candidateId: '44444444-4444-4444-8444-444444444444',
    status: 'pending_review',
    submittedAt: '2026-07-30T00:00:00.000Z',
  }));
  const findPendingSettingsCandidate = jest.fn(async () => opts.pending ?? null);
  const requireItem = jest.fn(async () => undefined);
  const store = {
    getByTypeSlug,
    upsertSectionsForCurrentTenant,
    clientMemoryAllowedForCurrentUser,
  };
  const candidates = { proposeSettingsSections, findPendingSettingsCandidate };
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
  );
  return {
    controller,
    getByTypeSlug,
    upsertSectionsForCurrentTenant,
    clientMemoryAllowedForCurrentUser,
    proposeSettingsSections,
    findPendingSettingsCandidate,
  };
}

describe('Settings shared-memory review lifecycle', () => {
  it('creates a firm candidate and leaves the active item unchanged', async () => {
    const active = {
      id: 'item-1',
      title: 'Firm Soul',
      sections: [{ key: 'mission', heading: 'Mission', owner: 'human', body: 'Current' }],
    };
    const h = harness({ existing: active });
    await expect(
      h.controller.updateSections(ctx, 'firm-soul', 'firm', { sections }),
    ).resolves.toEqual({
      status: 'pending_review',
      candidateId: '44444444-4444-4444-8444-444444444444',
      activeItemUnchanged: true,
    });
    expect(h.proposeSettingsSections).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ type: 'firm-soul', slug: 'firm', scope: 'firm' }),
    );
    expect(h.upsertSectionsForCurrentTenant).not.toHaveBeenCalled();
    expect(active.sections[0]?.body).toBe('Current');
  });

  it('creates only a candidate for a first-time shared file', async () => {
    const h = harness();
    await h.controller.updateSections(ctx, 'firm-soul', 'firm', { sections });
    expect(h.proposeSettingsSections).toHaveBeenCalledTimes(1);
    expect(h.upsertSectionsForCurrentTenant).not.toHaveBeenCalled();
  });

  it('fails closed on a client ethical wall before creating a candidate', async () => {
    const h = harness({ wallAllowed: false });
    await expect(
      h.controller.updateSections(ctx, 'client-soul', CLIENT, { sections }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.proposeSettingsSections).not.toHaveBeenCalled();
  });

  it('keeps owner-only user files on the immediate save path', async () => {
    const userCtx = { ...ctx, role: 'standard_user' as const };
    const h = harness();
    await expect(
      h.controller.updateSections(userCtx, 'user-profile', 'spoofed', { sections }),
    ).resolves.toMatchObject({ ok: true });
    expect(h.upsertSectionsForCurrentTenant).toHaveBeenCalledWith(
      'user-profile',
      userCtx.userId,
      'user',
      null,
      sections,
      expect.any(Set),
    );
    expect(h.proposeSettingsSections).not.toHaveBeenCalled();
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

import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import { MemoryVersionController, versionContent } from './memory-version.controller.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_admin',
  role: 'user_admin',
};

describe('MemoryVersionController Phase 15 contract', () => {
  it('accepts the Governance Center content alias but keeps newContent authoritative', () => {
    expect(versionContent({ content: 'Governance Center correction' })).toBe(
      'Governance Center correction',
    );
    expect(
      versionContent({
        newContent: 'Canonical correction',
        content: 'Browser alias cannot override this',
      }),
    ).toBe('Canonical correction');
    expect(() => versionContent({})).toThrow(BadRequestException);
  });

  it('delegates alias-backed corrections and returns an honest pending outcome', async () => {
    const proposeCorrection = jest.fn(async () => ({
      status: 'pending_review' as const,
      title: 'Firm Compass',
      candidateId: 'candidate-1',
      activeItemUnchanged: true as const,
    }));
    const proposeContradiction = jest.fn(async () => ({
      status: 'pending_review' as const,
      title: 'Firm Compass',
      candidateId: 'candidate-2',
      activeItemUnchanged: true as const,
    }));
    const versions = {
      proposeCorrection,
      proposeContradiction,
    } as unknown as ImmutableMemoryVersionService;
    const controller = new MemoryVersionController(versions);

    await expect(
      controller.proposeCorrection(ctx, 'item-1', { content: 'Corrected institutional truth.' }),
    ).resolves.toMatchObject({
      found: true,
      status: 'pending_review',
      outcome: 'pending_review',
      candidateId: 'candidate-1',
      activeItemUnchanged: true,
    });
    await expect(
      controller.proposeContradiction(ctx, 'item-1', {
        newContent: 'A competing sourced interpretation.',
      }),
    ).resolves.toMatchObject({
      found: true,
      status: 'pending_review',
      outcome: 'pending_review',
      candidateId: 'candidate-2',
      activeItemUnchanged: true,
    });

    expect(proposeCorrection).toHaveBeenCalledWith(
      ctx,
      'item-1',
      'Corrected institutional truth.',
    );
    expect(proposeContradiction).toHaveBeenCalledWith(
      ctx,
      'item-1',
      'A competing sourced interpretation.',
    );
  });

  it('preserves the existing found/legal-hold response shape with honest outcomes', async () => {
    const missing = new MemoryVersionController({
      proposeRestore: jest.fn(async () => ({ status: 'not_found' as const })),
    } as unknown as ImmutableMemoryVersionService);
    await expect(missing.proposeRestore(ctx, 'missing-item')).resolves.toEqual({
      found: false,
      outcome: 'not_found',
    });

    const held = new MemoryVersionController({
      proposeCorrection: jest.fn(async () => ({
        status: 'legal_hold' as const,
        title: 'Held memory',
      })),
    } as unknown as ImmutableMemoryVersionService);
    await expect(
      held.proposeCorrection(ctx, 'held-item', { content: 'Attempted correction' }),
    ).resolves.toEqual({
      found: true,
      blockedByLegalHold: true,
      outcome: 'legal_hold',
      title: 'Held memory',
    });
  });
});

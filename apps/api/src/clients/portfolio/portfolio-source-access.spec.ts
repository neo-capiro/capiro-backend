jest.mock('../profile-subject.js', () => ({ requireProfileSubject: jest.fn() }));
import { requireProfileSubject } from '../profile-subject.js';
import {
  portfolioEvidenceVisible,
  visibleCapabilityProvenance,
  visiblePortfolioHistory,
} from './portfolio-source-access.js';
const ctx = { tenantId: 'fixture-tenant', userId: 'fixture-user' } as never;
const evidence = [{ attachmentId: 'fixture-file', excerpt: 'Restricted fixture content' }];
describe('portfolio derived source visibility', () => {
  it('redacts historical prior payload and excerpts after document access is removed', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      engagementAttachment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const event = {
      action: 'edited',
      actorUserId: 'fixture-user',
      at: '2026-01-01T00:00:00Z',
      previousPayload: { description: 'Restricted fixture content' },
      previousEvidence: evidence,
    };
    const result = await visiblePortfolioHistory(tx as never, ctx, 'fixture-client', [event]);
    expect(JSON.stringify(result)).not.toContain('Restricted fixture content');
    expect(result).toEqual([
      expect.objectContaining({ action: 'edited', sourceUnavailable: true }),
    ]);
  });
  it('retains provenance when canonical attachment sharing and lifecycle permit access', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      engagementAttachment: { findFirst: jest.fn().mockResolvedValue({ id: 'fixture-file' }) },
    };
    await expect(
      portfolioEvidenceVisible(tx as never, ctx, 'fixture-client', evidence),
    ).resolves.toBe(true);
    expect(tx.engagementAttachment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'fixture-tenant',
          clientId: 'fixture-client',
          viewerMode: 'all',
          lifecycleStatus: { in: ['ready', 'legacy_ready'] },
        }),
      }),
    );
  });
  it('redacts current capability source text without erasing the recorded provenance origin', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      engagementAttachment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      visibleCapabilityProvenance(tx as never, ctx, 'fixture-client', [
        { ...evidence[0], origin: 'research_reviewed' },
      ]),
    ).resolves.toEqual([{ origin: 'research_reviewed', sourceUnavailable: true }]);
  });
  it('retains the original prospect owner when reading a converted document link', async () => {
    const authorize = jest.mocked(requireProfileSubject);
    authorize.mockResolvedValue(undefined);
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ prospectId: 'fixture-source-prospect' }]),
      engagementAttachment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      portfolioEvidenceVisible(tx as never, ctx, 'fixture-client', evidence),
    ).resolves.toBe(true);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('a.prospect_id=l.prospect_id'),
      'fixture-tenant',
      'fixture-client',
      'fixture-file',
    );
    expect(authorize).toHaveBeenCalledWith(tx, ctx, {
      kind: 'prospect',
      id: 'fixture-source-prospect',
    });
    authorize.mockRejectedValueOnce(new Error('source revoked'));
    await expect(
      portfolioEvidenceVisible(tx as never, ctx, 'fixture-client', evidence),
    ).resolves.toBe(false);
  });
  it('also enforces the legacy nested attachment evidence shape', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      engagementAttachment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      visibleCapabilityProvenance(tx as never, ctx, 'fixture-client', [
        {
          origin: 'research_reviewed',
          excerpt: 'Legacy private excerpt',
          metadata: { attachmentId: 'fixture-file' },
        },
      ]),
    ).resolves.toEqual([{ origin: 'research_reviewed', sourceUnavailable: true }]);
  });
});

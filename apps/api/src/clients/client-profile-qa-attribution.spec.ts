import { BadRequestException } from '@nestjs/common';
import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';

describe('Advocacy discovery and acceptance identity checks', () => {
  const ctx = { tenantId: 'tenant', userId: 'user' } as any;
  const service = () => {
    const prisma = { $queryRawUnsafe: jest.fn(), withTenant: jest.fn() };
    const s: any = new ClientProfileFillCompletionService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    s.resolveClientNameForDiscovery = jest.fn(async () => 'L3 Harris');
    s.getConfirmedIntelMappingKeys = jest.fn(async () => new Set());
    s.emitDiscoveryFinding = jest.fn(async () => true);
    return s;
  };
  it('does not propose unrelated FARA records even with high trigram similarity', async () => {
    const s = service();
    s.prisma.$queryRawUnsafe.mockResolvedValue([
      {
        registrationNumber: '1',
        registrantName: 'Harris St. Laurent & Wechsler LLP',
        foreignPrincipal: 'Unrelated company',
        registrantSimilarity: 0.95,
        principalSimilarity: 0,
      },
    ]);
    const result = await s.gatherFaraAdvocacyCandidates(ctx, 'client', 'run', 0);
    expect(result.count).toBe(0);
    expect(s.emitDiscoveryFinding).not.toHaveBeenCalled();
  });
  it('keeps a full organization match pending and explicitly inferred', async () => {
    const s = service();
    s.prisma.$queryRawUnsafe.mockResolvedValue([
      {
        registrationNumber: '1',
        registrantName: 'Agent LLC',
        foreignPrincipal: 'L3Harris Inc.',
        registrantSimilarity: 0,
        principalSimilarity: 0.9,
        registrationDate: null,
      },
    ]);
    await s.gatherFaraAdvocacyCandidates(ctx, 'client', 'run', 0);
    expect(s.emitDiscoveryFinding).toHaveBeenCalledWith(
      ctx,
      'client',
      'run',
      expect.objectContaining({
        isConfirmed: false,
        proposedValue: expect.objectContaining({ evidenceClass: 'INFERRED' }),
      }),
    );
  });
  it.each(['fara', 'testimony'])(
    'blocks accepting an old %s name-only suggestion before any write',
    async (sourceType) => {
      const s = service();
      const finding = {
        proposedValue: {
          externalKey: 'source:1',
          title: 'Unrelated record',
          recordType: 'testimony',
          sourceType,
          metadata: {
            registrationNumber: '1',
            hearingId: 'h1',
            witness: 'Carol Harris, GAO',
            clientMatch: { method: 'name_similarity' },
          },
        },
      };
      await expect(s.applyAdvocacyRecord(ctx, 'client', finding)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(s.prisma.withTenant).not.toHaveBeenCalled();
    },
  );
});

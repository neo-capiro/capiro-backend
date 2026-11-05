import { BadRequestException } from '@nestjs/common';
import { stageProfileCapabilityFinding } from '../profile-capability-stage.js';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  clerkUserId: 'fixture',
  tenantSlug: 'fixture',
  role: 'user_admin',
} as const;
const subject = { kind: 'client', id: '30000000-0000-4000-8000-000000000003' } as const;
const input = {
  kind: 'capability',
  source: 'public_web',
  proposedValue: {
    name: 'Fixture named component',
    type: 'component',
    description: 'Recorded fixture',
  },
  evidence: [
    {
      label: 'Fixture source',
      url: 'https://example.gov/fixture',
      excerpt: 'Test evidence, not a quote attributed to a real office.',
      observedAt: '2026-01-01T00:00:00Z',
    },
  ],
};
describe('existing durable extraction to capability review bridge', () => {
  it('stages through the same attempt-fenced transaction without inference or canonical approval', async () => {
    const tx = {};
    const review = {
      stageExtractedCapabilitiesInTransaction: jest
        .fn()
        .mockResolvedValue([{ id: 'proposal', status: 'proposed' }]),
    };
    await expect(
      stageProfileCapabilityFinding(tx as never, ctx, subject, input, review),
    ).resolves.toMatchObject({ status: 'proposed' });
    expect(review.stageExtractedCapabilitiesInTransaction).toHaveBeenCalledWith(
      tx,
      ctx,
      subject.id,
      [
        expect.objectContaining({
          kind: 'capability',
          payload: expect.objectContaining({ type: 'component', lifecycle: 'unspecified' }),
          evidence: [
            expect.objectContaining({
              excerpt: input.evidence[0]!.excerpt,
              observedAt: input.evidence[0]!.observedAt,
            }),
          ],
        }),
      ],
    );
  });
  it('does not invent missing dates/excerpts or silently map a family/technology into a product', async () => {
    const review = { stageExtractedCapabilitiesInTransaction: jest.fn() };
    await expect(
      stageProfileCapabilityFinding(
        {} as never,
        ctx,
        subject,
        { ...input, evidence: [{ label: 'Fixture source', url: input.evidence[0]!.url }] },
        review,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      stageProfileCapabilityFinding(
        {} as never,
        ctx,
        subject,
        { ...input, proposedValue: { ...input.proposedValue, type: 'technology' } },
        review,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(review.stageExtractedCapabilitiesInTransaction).not.toHaveBeenCalled();
  });
  it('never creates capabilities or hidden client rows for a prospect', async () => {
    const review = { stageExtractedCapabilitiesInTransaction: jest.fn() };
    await expect(
      stageProfileCapabilityFinding(
        {} as never,
        ctx,
        { kind: 'prospect', id: subject.id },
        input,
        review,
      ),
    ).resolves.toBeNull();
    expect(review.stageExtractedCapabilitiesInTransaction).not.toHaveBeenCalled();
  });
});

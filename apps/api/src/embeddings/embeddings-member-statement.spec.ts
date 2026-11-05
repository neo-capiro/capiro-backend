import { EmbeddingsService } from './embeddings.service.js';
import { embedAndUpsert } from './embedder.js';
jest.mock('./embedder.js', () => ({
  buildCapabilityText: jest.fn(),
  normalize: (value: string) => value.replace(/\s+/g, ' ').trim(),
  embedAndUpsert: jest.fn().mockResolvedValue('inserted'),
}));
const item = {
  id: '10000000-0000-4000-8000-000000000001',
  bioguideId: 'fixture-member',
  title: 'Sourced radar statement',
  summary: 'Fixture official summary.',
  link: 'https://fixture.house.gov/radar',
  publishedAt: new Date('2026-01-01'),
};
describe('canonical member statements reuse context embeddings', () => {
  beforeEach(() => jest.clearAllMocks());
  it('uses public canonical text with source date and URL and rechecks authority plus source after provider completion', async () => {
    const provider = { metadata: { model: 'fixture' } };
    const prisma = { memberPressItem: { findUnique: jest.fn().mockResolvedValue(item) } };
    const service = new EmbeddingsService(prisma as never, provider as never),
      fence = jest.fn();
    await service.embedMemberStatementImmediate(item.id, fence);
    const args = jest.mocked(embedAndUpsert).mock.calls[0]![1];
    expect(args).toEqual(
      expect.objectContaining({
        tenantId: null,
        sourceType: 'member_statement',
        sourceId: item.id,
      }),
    );
    expect(args.text).toContain(item.link);
    expect(args.text).toContain('2026-01-01');
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: item.id }]),
      memberPressItem: { findUnique: jest.fn().mockResolvedValue(item) },
    };
    expect(await args.beforeWrite!(tx as never)).toBe(true);
    expect(fence).toHaveBeenCalledWith(tx);
    tx.memberPressItem.findUnique.mockResolvedValue({
      ...item,
      summary: 'Changed after provider call',
    });
    expect(await args.beforeWrite!(tx as never)).toBe(false);
    fence.mockRejectedValue(new Error('attempt revoked'));
    await expect(args.beforeWrite!(tx as never)).rejects.toThrow('attempt revoked');
  });
  it('compares full source identity when a long summary exceeds the embedding limit', async () => {
    const longItem = { ...item, summary: 'A long canonical summary. '.repeat(600) };
    const service = new EmbeddingsService(
      { memberPressItem: { findUnique: jest.fn().mockResolvedValue(longItem) } } as never,
      {} as never,
    );
    await service.embedMemberStatementImmediate(item.id, jest.fn());
    const args = jest.mocked(embedAndUpsert).mock.calls[0]![1];
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: item.id }]),
      memberPressItem: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...longItem, link: 'https://example.com/changed' }),
      },
    };
    expect(await args.beforeWrite!(tx as never)).toBe(false);
  });
  it('does not embed unsupported, undated, or future sources', async () => {
    for (const delta of [
      { link: 'https://example.com/social' },
      { publishedAt: null },
      { publishedAt: new Date('2999-01-01') },
    ]) {
      const service = new EmbeddingsService(
        {
          memberPressItem: { findUnique: jest.fn().mockResolvedValue({ ...item, ...delta }) },
        } as never,
        {} as never,
      );
      expect(await service.embedMemberStatementImmediate(item.id, jest.fn())).toBe('skipped');
    }
    expect(embedAndUpsert).not.toHaveBeenCalled();
  });
});

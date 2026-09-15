import { BadRequestException } from '@nestjs/common';
import { ClientProfileFillWorkflowService } from './client-profile-fill-workflow.service.js';

/**
 * Retry-scope contract for the advanced Fill workflow (core-fill-retry item):
 * an explicit sources:[] is meaningful (legacy document-only run) and must
 * NOT be widened into the full connected-source set; sources:[] with no
 * attachments is meaningless and must fail at the edge; omitted sources keep
 * the existing default. These behaviors were the difference between a
 * durable document retry and a silent broaden into web research.
 */

function makeService() {
  const prisma = {
    withTenant: async (_t: string, run: (tx: unknown) => Promise<unknown>) =>
      run({
        $queryRawUnsafe: async () => [],
        client: { findFirst: async () => ({ id: 'c' }) },
      }),
    withSystem: async (run: (tx: unknown) => Promise<unknown>) =>
      run({ $queryRawUnsafe: async () => [] }),
  };
  const service = new ClientProfileFillWorkflowService(
    prisma as never,
    {} as never,
    { resolve: async () => ({}) } as never,
    {} as never,
    {} as never,
    {} as never,
    { httpAdapter: null } as never,
  );
  return service;
}

describe('ClientProfileFillWorkflowService — sources scope contract', () => {
  test('explicit sources:[] normalizes to [] (document-only), not the full set', () => {
    const service = makeService();
    const normalize = (service as never as { normalizeSources: (s?: string[]) => string[] }).normalizeSources;
    expect(normalize.call(service, [])).toEqual([]);
  });

  test('omitted sources normalizes to the full connected-source set (default preserved)', () => {
    const service = makeService();
    const normalize = (service as never as { normalizeSources: (s?: string[]) => string[] }).normalizeSources;
    const all = normalize.call(service, undefined);
    expect(all.length).toBeGreaterThan(1);
    expect(all).toContain('public_web');
  });

  test('startRun rejects sources:[] with no attachments — a meaningless zero-task request', async () => {
    const service = makeService();
    await expect(
      service.startRun({ tenantId: 't', userId: 'u' } as never, 'client-1', {
        sources: [],
        attachmentIds: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

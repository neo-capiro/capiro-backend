import type { TenantContext } from '@capiro/shared';
import { ContextPacketPersistenceError } from '@capiro/meriv2-core';
import {
  createGovernedAlertMemoService,
  createGovernedDistrictBriefService,
} from './governed-alert-deliverables.factory.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;

function compiler(result: unknown = { rendered: [], exclusions: [] }) {
  return { compile: jest.fn().mockResolvedValue(result) };
}

type MemoLoader = (
  value: TenantContext,
  clientId: string,
  clientName: string,
) => Promise<{
  steering: string;
  memoryFilesUsed: string[];
  contextExcluded: Array<{ title: string; reason: string }>;
}>;

type BriefLoader = (
  value: TenantContext,
  clientId: string,
  clientName: string,
) => Promise<{ steering: string; memoryFilesUsed: string[] }>;

describe('governed alert deliverable context loaders', () => {
  it.each(['memo', 'district-brief'] as const)(
    'rethrows a required %s persistence failure before generation',
    async (surface) => {
      const failure = new ContextPacketPersistenceError(
        'context_packet_error',
        'attempt-1',
        surface,
      );
      const contextCompiler = compiler();
      contextCompiler.compile.mockRejectedValueOnce(failure);

      if (surface === 'memo') {
        const service = createGovernedAlertMemoService(
          {} as never,
          contextCompiler as never,
        ) as unknown as { loadSteering: MemoLoader };
        await expect(service.loadSteering(ctx, 'client-1', 'Acme')).rejects.toBe(failure);
      } else {
        const service = createGovernedDistrictBriefService(
          {} as never,
          contextCompiler as never,
        ) as unknown as { loadSteering: BriefLoader };
        await expect(service.loadSteering(ctx, 'client-1', 'Acme')).rejects.toBe(failure);
      }
    },
  );

  it('retains neutral memo fallback for an ordinary context outage', async () => {
    const contextCompiler = compiler();
    contextCompiler.compile.mockRejectedValueOnce(new Error('temporarily unavailable'));
    const service = createGovernedAlertMemoService(
      {} as never,
      contextCompiler as never,
    ) as unknown as { loadSteering: MemoLoader };

    const result = await service.loadSteering(ctx, 'client-1', 'Acme');
    expect(result.steering).toContain('No client knowledge files on record for Acme');
    expect(result.memoryFilesUsed).toEqual([]);
    expect(result.contextExcluded).toEqual([]);
  });

  it('retains neutral district-brief fallback for an ordinary context outage', async () => {
    const contextCompiler = compiler();
    contextCompiler.compile.mockRejectedValueOnce(new Error('temporarily unavailable'));
    const service = createGovernedDistrictBriefService(
      {} as never,
      contextCompiler as never,
    ) as unknown as { loadSteering: BriefLoader };

    const result = await service.loadSteering(ctx, 'client-1', 'Acme');
    expect(result.steering).toContain('No client knowledge files on record for Acme');
    expect(result.memoryFilesUsed).toEqual([]);
  });

  it('composes memo steering in canonical order and withholds restricted identity', async () => {
    const contextCompiler = compiler({
      rendered: [
        { type: 'playbook', title: 'Playbook', body: 'Firm instructions.' },
        { type: 'client-compass', title: 'Compass', body: 'Strategic direction.' },
        { type: 'client-soul', title: 'Soul', body: 'Client identity.' },
        { type: 'client-people', title: 'People', body: 'Relationships.' },
      ],
      exclusions: [
        { type: 'playbook', slug: 'old', reason: 'superseded' },
        { reason: 'unauthorized' },
      ],
    });
    const service = createGovernedAlertMemoService(
      {} as never,
      contextCompiler as never,
    ) as unknown as { loadSteering: MemoLoader };

    const result = await service.loadSteering(ctx, 'client-1', 'Acme');
    expect(result.steering.indexOf('## Soul')).toBeLessThan(result.steering.indexOf('## Compass'));
    expect(result.steering.indexOf('## Compass')).toBeLessThan(
      result.steering.indexOf('## People'),
    );
    expect(result.steering.indexOf('## People')).toBeLessThan(
      result.steering.indexOf('## Playbook'),
    );
    expect(result.memoryFilesUsed).toEqual([
      'client-soul',
      'client-compass',
      'client-people',
      'firm-playbook',
    ]);
    expect(result.contextExcluded).toEqual([
      { title: 'firm-playbook', reason: 'superseded' },
      { title: 'Restricted item', reason: 'unauthorized' },
    ]);
    expect(contextCompiler.compile).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'memo',
        render: 'all',
        charBudget: 8000,
      }),
    );
  });

  it('composes district-brief steering from the same governed sources', async () => {
    const contextCompiler = compiler({
      rendered: [
        { type: 'client-soul', title: 'Soul', body: 'Client identity.' },
        { type: 'playbook', title: 'Playbook', body: 'Firm instructions.' },
      ],
      exclusions: [],
    });
    const service = createGovernedDistrictBriefService(
      {} as never,
      contextCompiler as never,
    ) as unknown as { loadSteering: BriefLoader };

    const result = await service.loadSteering(ctx, 'client-1', 'Acme');
    expect(result.steering).toBe(
      '## Soul\nClient identity.\n\n## Playbook\nFirm instructions.',
    );
    expect(result.memoryFilesUsed).toEqual(['client-soul', 'firm-playbook']);
    expect(contextCompiler.compile).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'district-brief',
        render: 'all',
        charBudget: 8000,
      }),
    );
  });
});

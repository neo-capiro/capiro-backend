import type { MeriContext } from '@capiro/meriv2-core';
import { MeriRetrievalCoordinator } from '../retrieval/meri-retrieval-coordinator.js';
import { MeriV3ManagedMcpAssistantService } from './meriv3-managed-mcp-assistant.service.js';
import { MeriV3RetrievalAssistantService } from './meriv3-retrieval-assistant.service.js';
import { MeriV3ResearchRuntimeStore } from './meriv3-research-runtime.store.js';
import type { MeriV3ChatResult } from './meriv3.types.js';

function make() {
  const registryService = { registry: { list: () => [], get: () => undefined } };
  const config = { get: jest.fn(() => 'http://api.test') };
  return new MeriV3RetrievalAssistantService(
    registryService as never,
    {} as never,
    {} as never,
    {} as never,
    config as never,
    {} as never,
    {} as never,
    new MeriRetrievalCoordinator(),
  );
}

const context = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  clientRoster: [{ name: 'Aperture Defense Systems', status: 'active' }],
} as unknown as MeriContext;

const result: MeriV3ChatResult = {
  reply: 'draft',
  runtime: 'meriv3',
  model: 'gpt-test',
  reasoningMode: 'deep',
  reasoningEffort: 'high',
};

describe('MeriV3 Research Director integration', () => {
  afterEach(() => jest.restoreAllMocks());

  test('elevates comprehensive strategy work, installs the director contract, and forces the recipe', async () => {
    const seenRuntime: Array<ReturnType<typeof MeriV3ResearchRuntimeStore.current>> = [];
    const downstream = jest
      .spyOn(MeriV3ManagedMcpAssistantService.prototype, 'run')
      .mockImplementation(async () => {
        seenRuntime.push(MeriV3ResearchRuntimeStore.current());
        return result;
      });
    const service = make();

    const output = await service.run(context, {
      reasoningMode: 'fast',
      messages: [
        {
          role: 'user',
          text: 'Give me a comprehensive strategy on kindeticindustries.inc. Tell me what Program Elements, grants, or government contracts they should pursue.',
        },
      ],
    });

    const [, scopedDto] = downstream.mock.calls[0] ?? [];
    expect(scopedDto?.reasoningMode).toBe('deep');
    expect(scopedDto?.skillAddendum).toContain('Call research_federal_market_strategy FIRST.');
    expect(scopedDto?.skillAddendum).toContain(
      '# Research Director — mandatory comprehensive workflow',
    );
    expect(scopedDto?.skillAddendum).toContain('Required research waves');
    expect(scopedDto?.skillAddendum).toContain('CONGRESSIONAL');
    expect(seenRuntime[0]).toEqual(
      expect.objectContaining({
        forcedFirstTool: 'research_federal_market_strategy',
        criticInstructions: expect.stringContaining('senior federal capture executive'),
        synthesisInstructions: expect.stringContaining('ARTIFACT-QUALITY FEDERAL STRATEGY'),
      }),
    );
    expect(output.retrieval?.plan.recipeTool).toBe('research_federal_market_strategy');
  });

  test('preserves Max as the user-selected tier', async () => {
    const downstream = jest
      .spyOn(MeriV3ManagedMcpAssistantService.prototype, 'run')
      .mockResolvedValue({ ...result, reasoningMode: 'max', reasoningEffort: 'max' });
    const service = make();

    await service.run(context, {
      reasoningMode: 'max',
      messages: [
        {
          role: 'user',
          text: 'Build a comprehensive federal growth strategy for Anduril.',
        },
      ],
    });

    const [, scopedDto] = downstream.mock.calls[0] ?? [];
    expect(scopedDto?.reasoningMode).toBe('max');
  });
});

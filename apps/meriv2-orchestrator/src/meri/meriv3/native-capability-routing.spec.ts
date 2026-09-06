import type { ConfigService } from '@nestjs/config';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { MERI_CAPABILITY_REGISTRY } from '@capiro/shared';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { ChatAssistantService } from '../chat/chat-assistant.service.js';
import { runWithGovernedMeriContext } from '../meri-governed-context.runtime.js';
import type { MeriRegistryService } from '../meri-registry.service.js';
import { MeriV3AssistantService } from './meriv3-assistant.service.js';
import { MeriV3ManagedMcpAssistantService } from './meriv3-managed-mcp-assistant.service.js';
import { MeriV3CleanAssistantService } from './meriv3-clean-assistant.service.js';
import { MeriV3RetrievalAssistantService } from './meriv3-retrieval-assistant.service.js';

// Exercise the real chained schema-fetch implementations. Transport, model and
// persistence are inert; capability filtering and runtime wrappers are not mocked.
const config = { get: () => undefined } as unknown as ConfigService;
const registry = {
  registry: { list: () => MERI_CAPABILITY_REGISTRY.map((tool) => tool.name) },
} as unknown as MeriRegistryService;
const nativeSchemas = MERI_CAPABILITY_REGISTRY.map(({ name, description }) => ({
  name,
  description,
  input_schema: { type: 'object', properties: {} },
}));
const managed = { schemas: jest.fn().mockResolvedValue([]) };
const analysis = { available: jest.fn().mockResolvedValue(false) };

function schemas(service: unknown): Promise<Array<{ name: string }>> {
  return (service as { fetchToolSchemas(): Promise<Array<{ name: string }>> }).fetchToolSchemas();
}

describe('canonical capability availability across full-chat runtime layers', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([true, false])(
    'preserves every enabled capability across runtime wrappers (analysis available: %s)',
    async (analysisEnabled) => {
      analysis.available.mockResolvedValue(analysisEnabled);
      jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ schemas: [...nativeSchemas, { name: 'unreviewed_api_write' }] }),
      } as Response);
      const unused = undefined as never;
      const services = [
        new ChatAssistantService(registry, config, unused, unused, unused),
        new MeriV3AssistantService(registry, unused, unused, unused, config),
        new MeriV3ManagedMcpAssistantService(
          registry,
          unused,
          unused,
          unused,
          config,
          managed as never,
          analysis as never,
        ),
        new MeriV3RetrievalAssistantService(
          registry,
          unused,
          unused,
          unused,
          config,
          managed as never,
          analysis as never,
          unused,
        ),
        new MeriV3CleanAssistantService(
          registry,
          unused,
          unused,
          unused,
          config,
          managed as never,
          analysis as never,
          unused,
        ),
      ];
      await RequestCredentialsStore.run({ bearerToken: 'test-token' }, async () => {
        await runWithGovernedMeriContext(
          { prompt: '', contextPacket: {} } as MeriGovernedTurnContext,
          async () => {
            for (const service of services) {
              const names = (await schemas(service)).map((tool) => tool.name);
              const expected = nativeSchemas
                .filter(
                  (schema) =>
                    schema.name !== 'run_analysis' ||
                    analysisEnabled ||
                    !(service instanceof MeriV3ManagedMcpAssistantService),
                )
                .map((tool) => tool.name);
              expect([...names].sort()).toEqual(expected.sort());
              expect(names).not.toContain('unreviewed_api_write');
              expect(names).not.toContain('research_federal_market_strategy');
            }
          },
        );
      });
    },
  );
});

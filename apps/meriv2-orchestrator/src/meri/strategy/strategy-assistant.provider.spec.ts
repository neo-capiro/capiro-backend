import type { ConfigService } from '@nestjs/config';
import type { MeriContext } from '@capiro/meriv2-core';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { MeriRegistryService } from '../meri-registry.service.js';
import { RequestScopedLlmClient } from '../request-scoped-llm.client.js';
import { StrategyAssistantService } from './strategy-assistant.service.js';
import type { StrategyContextPackService } from './strategy-context-pack.service.js';
import { sanitizePlanEdits, type StrategyAssistantInput } from './strategy-prompt.js';

// Real assistant, prompt, provider adapter and sanitizer. Only network, context
// retrieval and metering are stubbed; no live model or customer plan is changed.
describe('Strategy Assistant Sonnet 5 provider regression', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns all requested owner edits without triggering strict schema compilation', async () => {
    const nodes = ['step-1', 'step-2', 'step-3'].map((id) => ({
      id,
      kind: 'action',
      subject: 'deliverable',
      title: id,
      status: 'draft',
      startsOn: '2027-01-01',
      ownerUserId: null,
    }));
    const edits = nodes.map(({ id }) => ({ op: 'update', nodeId: id, ownerUserId: 'user_neo' }));
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('claude-sonnet-5');
      // Actual production rejection on 2026-09-16. Applying strict grammar
      // compilation to the patch schema must not recur after a model upgrade.
      if (body.tools[0].strict)
        return new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Schema is too complex.' },
          }),
          { status: 400 },
        );
      expect(body.tools[0].name).toBe('propose_plan_edits');
      expect(
        body.tools[0].input_schema.properties.edits.items.properties.ownerUserId,
      ).toBeDefined();
      expect(JSON.stringify(body.system)).toContain('user_neo');
      expect(JSON.stringify(body.system)).toContain('Neo Martinez');
      expect(body.messages[0].content).toBe('add neo martinez as the owner for all steps');
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'propose_plan_edits',
              input: {
                reply: 'Assigned Neo Martinez to all 3 steps.',
                edits,
              },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 100 },
        }),
        { status: 200 },
      );
    });
    const llm = new RequestScopedLlmClient('test-key', 'claude-sonnet-5');
    const service = new StrategyAssistantService(
      { llm } as MeriRegistryService,
      { get: () => undefined } as unknown as ConfigService,
      { withTenant: jest.fn(), withSystem: jest.fn() } as unknown as PrismaService,
      {
        compile: async () => ({
          text: 'Client context',
          provenance: { sections: [], omitted: [] },
          health: { status: 'ok', missingRequired: [], omittedOptional: [] },
        }),
      } as unknown as StrategyContextPackService,
    );
    const result = await service.assistant(
      { tenantId: 'tenant-1', userId: 'user-1' } as MeriContext,
      {
        scope: 'strategy',
        instruction: 'add neo martinez as the owner for all steps',
        clientId: 'client-1',
        strategy: { id: 'strategy-1', title: 'Funding plan', type: 'appropriations', nodes },
        ownerNames: { user_neo: 'Neo Martinez' },
      } as StrategyAssistantInput,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe('Assigned Neo Martinez to all 3 steps.');
    expect(result.edits).toEqual(edits);
    expect(result.edits.every((edit) => Object.keys(edit).length === 3)).toBe(true);
  });

  it('preserves explicit unassignment and omitted-owner patch semantics', () => {
    expect(
      sanitizePlanEdits([
        { op: 'update', nodeId: 'step-1', ownerUserId: null },
        { op: 'update', nodeId: 'step-2', note: 'Keep its owner' },
      ]),
    ).toEqual([
      { op: 'update', nodeId: 'step-1', ownerUserId: null },
      { op: 'update', nodeId: 'step-2', note: 'Keep its owner' },
    ]);
  });
});

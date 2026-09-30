import type { MeriContext } from '@capiro/meriv2-core';
import { buildDraftSystemPrompt, type StrategyDraftInput } from './strategy-prompt.js';
import { StrategyAssistantService } from './strategy-assistant.service.js';
import type { MeriRegistryService } from '../meri-registry.service.js';
import type { ConfigService } from '@nestjs/config';

const input: StrategyDraftInput = { clientId: 'client-1', type: 'legislative', goal: 'Submit' };
const deadline = {
  id: 'DIU:close',
  title: 'DIU',
  at: '2026-11-15T04:59:59.999Z',
  dateOnly: '2026-11-14',
  timeZone: 'America/New_York',
  daysRemaining: 65,
  status: 'open' as const,
};

describe('strategy schedule prompt and verifier wiring', () => {
  const originalEnv = process.env;
  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  test('legacy prompt is unchanged unless deadline facts are explicitly supplied', () => {
    const fixedInput = { ...input, fiscal: { today: '2026-09-10' } };
    const legacy = buildDraftSystemPrompt(fixedInput, 'PACK');
    expect(legacy).not.toContain('Schedule constraints (computed)');
    expect(
      buildDraftSystemPrompt({ ...fixedInput, scheduleDeadlines: [deadline] }, 'PACK'),
    ).toContain('Schedule constraints (computed): today=2026-09-10 UTC; DIU:');
    expect(buildDraftSystemPrompt(fixedInput, 'PACK')).toBe(legacy);
  });

  test('off mode passes enforcePastDates false to the real draft verifier path', async () => {
    process.env = { ...originalEnv, MERI_EVIDENCE_ACCURACY_MODE: 'off' };
    const completeWithTools = jest.fn().mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: '1',
          name: 'propose_strategy_draft',
          input: {
            summary: 'Plan',
            nodes: [
              {
                id: 'm1',
                kind: 'milestone',
                subject: 'submission',
                title: 'Submit',
                status: 'draft',
                startsOn: '2026-09-09',
              },
            ],
          },
        },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'test',
      usedTenantKey: false,
    });
    const service = new StrategyAssistantService(
      { llm: { completeWithTools } } as unknown as MeriRegistryService,
      { get: () => undefined } as unknown as ConfigService,
      { withTenant: jest.fn(), withSystem: jest.fn() } as never,
      {
        compile: jest.fn().mockResolvedValue({
          text: 'PACK',
          health: { status: 'ok', missingRequired: [], omittedOptional: [] },
          provenance: { sections: [], omitted: [] },
        }),
      } as never,
    );
    const result = await service.draft(
      {
        tenantId: 'tenant-1',
        userId: 'u1',
        clerkUserId: 'c1',
        role: 'standard_user',
      } as MeriContext,
      {
        ...input,
        fiscal: { today: '2026-09-10', fys: [2027], fyLabels: ['FY27'], focalFy: 'FY27' },
      },
    );
    expect(result.violations.map((item: { code: string }) => item.code)).not.toContain(
      'milestone-past-date',
    );
    expect(completeWithTools).toHaveBeenCalledTimes(1);
  });
});

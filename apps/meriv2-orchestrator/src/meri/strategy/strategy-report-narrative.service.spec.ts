import {
  composeReportNarrativePrompt,
  parseReportNarrativeInput,
  PROPOSE_REPORT_NARRATIVE_TOOL,
  type ReportNarrativeInput,
} from './strategy-report-narrative.prompt.js';
import {
  sanitizeSections,
  StrategyReportNarrativeService,
} from './strategy-report-narrative.service.js';
import type { MeriRegistryService } from '../meri-registry.service.js';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { MeriContext } from '@capiro/meriv2-core';

const input: ReportNarrativeInput = {
  audience: 'client',
  strategy: {
    title: 'Authorization Strategy',
    type: 'Authorization',
    clientName: 'Northstar Systems',
    asOf: 'Aug 30, 2026',
  },
  sections: ['executive_summary', 'situation'],
  maxParagraphsPerSection: 4,
  evidence: [
    { id: 'plan:strategy', text: 'Strategy title: Authorization Strategy. Target date: Dec 15, 2026.' },
    { id: 'plan:health', text: 'Delivery readiness score 84 of 100 (On track).' },
  ],
};

const ctx = { tenantId: 'tenant-1', userId: 'user-1', clerkUserId: 'clerk-1', role: 'admin' } as unknown as MeriContext;

function toolResponse(sections: unknown, overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'tool_use', name: PROPOSE_REPORT_NARRATIVE_TOOL.name, input: { sections } }],
    stopReason: 'tool_use',
    usage: { inputTokens: 100, outputTokens: 50 },
    model: 'claude-test',
    usedTenantKey: false,
    ...overrides,
  };
}

function build(completeWithTools: jest.Mock) {
  const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;
  const prisma = {
    withSystem: jest.fn(async () => undefined),
    withTenant: jest.fn(async () => undefined),
  } as unknown as PrismaService;
  return new StrategyReportNarrativeService(
    { llm: { completeWithTools } } as unknown as MeriRegistryService,
    config,
    prisma,
  );
}

describe('parseReportNarrativeInput', () => {
  it('accepts a well-formed packet and normalises optional fields', () => {
    const parsed = parseReportNarrativeInput({
      audience: 'internal',
      strategy: { title: 'T', clientName: 'C' },
      evidence: [{ id: 'a', text: 'x' }, { id: 'a', text: 'dup' }, { id: 'bad id!', text: 'y' }],
      maxParagraphsPerSection: 9,
    });
    expect(parsed).toEqual({
      audience: 'internal',
      strategy: { title: 'T', type: 'Strategy', clientName: 'C', asOf: 'today' },
      sections: [
        'executive_summary',
        'situation',
        'objectives_and_ask',
        'stakeholders',
        'constraints_and_timing',
        'decisions_and_risks',
        'roadmap_outlook',
      ],
      maxParagraphsPerSection: 4,
      evidence: [{ id: 'a', text: 'x' }],
    });
  });

  it('rejects packets without an audience, strategy identity or evidence', () => {
    expect(parseReportNarrativeInput(null)).toBeNull();
    expect(parseReportNarrativeInput({ audience: 'client', strategy: { title: 'T' }, evidence: [] })).toBeNull();
    expect(
      parseReportNarrativeInput({ audience: 'nobody', strategy: { title: 'T', clientName: 'C' }, evidence: [{ id: 'a', text: 'x' }] }),
    ).toBeNull();
    expect(
      parseReportNarrativeInput({ audience: 'client', strategy: { title: 'T', clientName: 'C' }, sections: ['made_up'], evidence: [{ id: 'a', text: 'x' }] }),
    ).toBeNull();
  });
});

describe('composeReportNarrativePrompt', () => {
  it('embeds every evidence entry with its id and the grounding rules', () => {
    const { system, user } = composeReportNarrativePrompt(input);
    expect(system).toContain('Never add a fact');
    expect(user).toContain('[plan:strategy] Strategy title: Authorization Strategy.');
    expect(user).toContain('[plan:health]');
    expect(user).toContain('Audience: the CLIENT');
    expect(user).toContain(`Call the ${PROPOSE_REPORT_NARRATIVE_TOOL.name} tool`);
  });
});

describe('sanitizeSections', () => {
  it('keeps valid paragraphs and reports every structural problem', () => {
    const result = sanitizeSections(
      {
        sections: [
          {
            id: 'executive_summary',
            paragraphs: [
              { text: 'Northstar Systems is on track with a readiness score of 84 of 100.', evidenceIds: ['plan:health'] },
              { text: 'short', evidenceIds: ['plan:health'] },
              { text: 'No citation for this otherwise reasonable paragraph.', evidenceIds: [] },
              { text: '- bullet style paragraph that should be rejected', evidenceIds: ['plan:health'] },
            ],
          },
          { id: 'stakeholders', paragraphs: [{ text: 'Not requested section content.', evidenceIds: ['plan:health'] }] },
          { id: 'executive_summary', paragraphs: [{ text: 'Duplicate section that must be ignored entirely.', evidenceIds: ['plan:health'] }] },
        ],
      },
      input,
    );
    expect(result.sections).toEqual([
      {
        id: 'executive_summary',
        paragraphs: [
          { text: 'Northstar Systems is on track with a readiness score of 84 of 100.', evidenceIds: ['plan:health'] },
        ],
      },
    ]);
    expect(result.problems).toEqual([
      'executive_summary: paragraph text must be 20–1400 characters',
      'executive_summary: a paragraph cited no evidence ids',
      'executive_summary: prose must be plain text without markdown, bullets or brackets',
      'unknown section id "stakeholders"',
      'duplicate section "executive_summary"',
    ]);
  });
});

describe('StrategyReportNarrativeService', () => {
  it('forces the terminal tool once and drops paragraphs that fail the citation gate', async () => {
    const completeWithTools = jest.fn(async () =>
      toolResponse([
        {
          id: 'executive_summary',
          paragraphs: [
            { text: 'Northstar Systems is on track at 84 of 100.', evidenceIds: ['plan:health'] },
            { text: 'This cites an id that does not exist in the packet.', evidenceIds: ['plan:missing'] },
            { text: 'The brief says "the sky is falling" which is not in the evidence.', evidenceIds: ['plan:strategy'] },
          ],
        },
      ]),
    );
    const service = build(completeWithTools);

    const result = await service.generate(ctx, input);

    expect(completeWithTools).toHaveBeenCalledTimes(1);
    const [call] = completeWithTools.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call.toolChoice).toEqual({ type: 'tool', name: PROPOSE_REPORT_NARRATIVE_TOOL.name });
    expect(result.sections).toEqual([
      {
        id: 'executive_summary',
        paragraphs: [{ text: 'Northstar Systems is on track at 84 of 100.', evidenceIds: ['plan:health'] }],
      },
    ]);
    expect(result.droppedParagraphs).toBe(2);
    expect(result.model).toBe('claude-test');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(result.attempts).toBe(1);
    expect(result.usedFallback).toBe(false);
  });

  it('re-prompts once when the first tool input is structurally unusable', async () => {
    const completeWithTools = jest
      .fn()
      .mockResolvedValueOnce(toolResponse([{ id: 'nope', paragraphs: [] }]))
      .mockResolvedValueOnce(
        toolResponse([
          {
            id: 'situation',
            paragraphs: [{ text: 'The plan targets Dec 15, 2026 for completion.', evidenceIds: ['plan:strategy'] }],
          },
        ]),
      );
    const service = build(completeWithTools);

    const result = await service.generate(ctx, input);

    expect(completeWithTools).toHaveBeenCalledTimes(2);
    const retry = completeWithTools.mock.calls[1]![0] as { system: string };
    expect(retry.system).toContain('did not match the required shape');
    expect(result.attempts).toBe(2);
    expect(result.sections).toHaveLength(1);
  });

  it('returns an empty narrative (never throws) on a refusal', async () => {
    const completeWithTools = jest.fn(async () =>
      toolResponse([], { content: [{ type: 'text', text: 'no' }], stopReason: 'refusal', stopDetails: { category: 'x', explanation: null } }),
    );
    const service = build(completeWithTools);

    const result = await service.generate(ctx, input);

    expect(result.sections).toEqual([]);
    expect(result.usedFallback).toBe(true);
  });
});

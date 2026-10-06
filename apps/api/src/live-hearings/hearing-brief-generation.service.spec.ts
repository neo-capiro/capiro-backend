import { ServiceUnavailableException } from '@nestjs/common';
import {
  HearingBriefGenerationService,
  normalizeSections,
  resolveSpeaker,
  selectBriefExcerpt,
} from './hearing-brief-generation.service.js';

jest.mock('@capiro/shared', () => {
  const actual = jest.requireActual('@capiro/shared');
  return { ...actual, recordAiUsageEvent: jest.fn(async () => undefined) };
});

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;

function prefill(findings: Array<Record<string, unknown>> = []) {
  return {
    draft: { docTitle: 'Hearing brief — Defense posture', client: 'Acme Aerospace' },
    context: {
      source: 'legiwatch-hearing',
      hearing: {
        id: 'hearing-1',
        title: 'Defense posture',
        chamber: 'Senate',
        committeeName: 'Armed Services',
        calendarDate: '2026-09-22',
        eventStatus: 'scheduled',
        witnesses: ['Gen. Ada Lin'],
        detailPath: '/legiwatch/hearings/hearing-1',
        officialPageUrl: 'https://www.armed-services.senate.gov/hearings/x',
      },
      client: { id: 'client-1', name: 'Acme Aerospace' },
      findings,
    },
    sources: [{ kind: 'hearing', id: 'hearing-1', path: '/legiwatch/hearings/hearing-1' }],
  };
}

function harness(input: {
  segments?: Array<{
    sequence: number;
    startMs: number;
    text: string;
    speakerLabel: string | null;
  }>;
  completion?: string | Error;
  credential?: null;
  findings?: Array<Record<string, unknown>>;
  truncated?: boolean;
}) {
  const wave1 = { buildBriefPrefill: jest.fn(async () => prefill(input.findings)) };
  const client = {
    id: 'client-1',
    name: 'Acme Aerospace',
    description: 'Tier-2 defense supplier',
    productDescription: 'Composite airframe parts',
    sectorTag: 'defense',
    issueCodes: ['DEF'],
    intakeData: { priorities: ['FY27 procurement'] },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, fn: (tx: unknown) => unknown) =>
      fn({ client: { findFirst: jest.fn(async () => client) } }),
    ),
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      if (sql.includes('FROM public_hearing_capture'))
        return input.segments ? [{ id: 'cap-1', status: 'COMPLETE', gaps: [] }] : [];
      if (sql.includes('FROM public_hearing_transcript_segment')) return input.segments ?? [];
      return [];
    }),
  };
  const credentials = {
    resolveProvider: jest.fn(async () =>
      input.credential === null
        ? null
        : { provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5', usedTenantKey: true },
    ),
  };
  const llm = {
    complete: jest.fn(async (_req: { userStatic: string; userVolatile: string }) => {
      if (input.completion instanceof Error) throw input.completion;
      return {
        text:
          input.completion ??
          JSON.stringify({
            title: 'Acme Aerospace — Defense posture hearing recap',
            sections: (_req.userVolatile.match(/Sections, in order: (.*)\./)?.[1] ?? '')
              .split(' | ')
              .map((name) => ({
                name,
                content: input.segments?.length
                  ? 'Recorded exchange [00:00].'
                  : 'Agenda and client profile.',
              })),
            keyMoments: [
              { startMs: 5000, speaker: 'Jane Q. Smith', summary: 'Opened the hearing' },
            ],
            sources: ['Official page'],
          }),
        raw: { usage: { input_tokens: 10, output_tokens: 20 } },
        usage: {},
        stopReason: 'end_turn',
        truncated: input.truncated ?? false,
      };
    }),
  };
  const speakers = {
    resolve: jest.fn(async () => ({ resolved: 0, ran: false })),
    speakerMap: jest.fn(async () => new Map([['0', 'Jane Q. Smith']])),
    loadRoster: jest.fn(async () => ({
      members: [{ name: 'Jane Q. Smith', role: 'Chair', personRef: 'S000001' }],
      witnesses: ['Gen. Ada Lin'],
    })),
  };
  const service = new HearingBriefGenerationService(
    prisma as never,
    wave1 as never,
    credentials as never,
    llm as never,
    speakers as never,
  );
  return { service, wave1, prisma, credentials, llm, speakers };
}

describe('resolveSpeaker', () => {
  const map = new Map([['0', 'Jane Q. Smith']]);
  it('maps indices through the speaker map and hides unmapped indices', () => {
    expect(resolveSpeaker('0', map)).toBe('Jane Q. Smith');
    expect(resolveSpeaker('3', map)).toBeNull();
    expect(resolveSpeaker('CHAIR', map)).toBe('CHAIR');
    expect(resolveSpeaker(null, map)).toBeNull();
  });
});

describe('selectBriefExcerpt', () => {
  it('prefers turns cited by findings and stays within bounds', () => {
    const turns = Array.from({ length: 500 }, (_, i) => ({
      label: String(i % 2),
      sequence: i,
      startMs: i * 10_000,
      text: `turn ${i} `.repeat(20),
    }));
    const lines = selectBriefExcerpt(turns, [4_990_000], new Map([['0', 'Jane Q. Smith']]));
    expect(lines.length).toBeLessThanOrEqual(600);
    expect(lines.join('\n').length).toBeLessThanOrEqual(120_000);
    expect(lines.some((line) => line.includes('turn 499 '))).toBe(true);
    expect(lines[0]).toMatch(/^\[00:00\] Jane Q\. Smith: /);
    expect(lines.some((line) => line.includes('Speaker 2:'))).toBe(true);
  });

  it('returns nothing without turns', () => {
    expect(selectBriefExcerpt([], [], new Map())).toEqual([]);
  });
});

describe('normalizeSections', () => {
  it('orders sections as expected and marks missing ones incomplete', () => {
    const result = normalizeSections(
      [
        { name: 'key exchanges', content: 'B' },
        { name: 'Executive summary', content: 'A' },
      ],
      ['Executive summary', 'Key exchanges', 'Sources and limitations'],
    );
    expect(result.complete).toBe(false);
    expect(result.sections.map((s) => s.content)).toEqual([
      'A',
      'B',
      'The packet did not contain enough information for this section.',
    ]);
  });
});

describe('HearingBriefGenerationService.generate', () => {
  it('writes a preparation brief when no transcript exists', async () => {
    const { service, llm } = harness({});
    const brief = await service.generate(ctx, 'hearing-1', {
      clientId: 'client-1',
      focus: 'FY27 marks',
    });
    expect(brief.mode).toBe('preparation');
    expect(brief.sections.map((s) => s.name)).toEqual([
      'Hearing overview',
      'Why it matters to Acme Aerospace',
      'Members to watch',
      'Witnesses and expected positions',
      'Likely questions and suggested asks',
      'Preparation checklist',
      'Sources and limitations',
    ]);
    const request = llm.complete.mock.calls[0]![0];
    expect(request.userVolatile).toContain('PREPARATION brief');
    expect(request.userVolatile).toContain('FY27 marks');
    expect(request.userStatic).toContain('Composite airframe parts');
    expect(brief.contextPacket).toMatchObject({ mode: 'preparation', focus: 'FY27 marks' });
    expect(brief.lowConfidence).toBe(false);
  });

  it('writes a recap brief with resolved speaker names when a transcript exists', async () => {
    const { service, llm, speakers } = harness({
      segments: [
        { sequence: 1, startMs: 0, text: 'The committee will come to order.', speakerLabel: '0' },
        { sequence: 2, startMs: 5000, text: 'Thank you, Chair.', speakerLabel: '1' },
      ],
      findings: [
        {
          id: 'f1',
          insightType: 'COMMITMENT',
          title: 'Committed to a report',
          summary: 'Report by March',
          evidenceText: null,
          speakerName: '0',
          segmentId: 'seg-1',
          startMs: 0,
        },
      ],
    });
    const brief = await service.generate(ctx, 'hearing-1', { clientId: 'client-1' });
    expect(brief.mode).toBe('recap');
    expect(speakers.resolve).toHaveBeenCalledWith('hearing-1', { force: false, ctx });
    const request = llm.complete.mock.calls[0]![0];
    expect(request.userVolatile).toContain(
      '[00:00] Jane Q. Smith: The committee will come to order.',
    );
    expect(request.userVolatile).toContain('[00:05] Speaker 2: Thank you, Chair.');
    expect(request.userVolatile).toContain('"speakerName":"Jane Q. Smith"');
    expect(request).toMatchObject({
      provider: 'anthropic',
      timeoutMs: 300_000,
      maxTokens: 6000,
      system: expect.stringContaining('1,000–1,400 words'),
    });
    expect(brief.title).toBe('Acme Aerospace — Defense posture hearing recap');
    expect(brief.keyMoments).toEqual([
      { startMs: 5000, speaker: 'Speaker 2', summary: 'Opened the hearing' },
    ]);
    expect(brief.sources).toEqual([
      { kind: 'hearing', id: 'hearing-1', path: '/legiwatch/hearings/hearing-1' },
    ]);
  });

  it('generates without a client (an All-Clients or automated request with only a focus)', async () => {
    const { service, speakers } = harness({});
    const brief = await service.generate(ctx, 'hearing-1', { focus: 'FY27 marks' });
    expect(brief.mode).toBe('preparation');
    // Falls back to the prefill's own client (possibly null) and to whatever
    // witnesses loadRoster returned, rather than throwing on the absent client.
    expect(brief.contextPacket).toMatchObject({
      client: { id: 'client-1', name: 'Acme Aerospace' },
    });
    expect(speakers.loadRoster).toHaveBeenCalledWith('hearing-1');
  });

  it('generates with neither a client nor any roster witnesses, without throwing', async () => {
    const noWitnesses = {
      resolve: jest.fn(async () => ({ resolved: 0, ran: false })),
      speakerMap: jest.fn(async () => new Map()),
      loadRoster: jest.fn(async () => ({ members: [], witnesses: [] })),
    };
    const noClientPrefill = {
      ...prefill([]),
      context: {
        ...prefill([]).context,
        client: null,
        hearing: { ...prefill([]).context.hearing, witnesses: [] },
      },
    };
    const wave1 = { buildBriefPrefill: jest.fn(async () => noClientPrefill) };
    const noClientPrisma = {
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({ client: { findFirst: jest.fn(async () => null) } }),
      ),
      $queryRawUnsafe: jest.fn(async () => []),
    };
    const credentials = {
      resolveProvider: jest.fn(async () => ({
        provider: 'anthropic',
        apiKey: 'k',
        model: 'claude-sonnet-5',
        usedTenantKey: true,
      })),
    };
    const llm = {
      complete: jest.fn(async () => ({
        text: JSON.stringify({
          title: 'Preparation brief',
          sections: [
            'Hearing overview',
            'Why it matters to the client',
            'Members to watch',
            'Witnesses and expected positions',
            'Likely questions and suggested asks',
            'Preparation checklist',
            'Sources and limitations',
          ].map((name) => ({ name, content: 'Agenda context.' })),
          keyMoments: [],
          sources: [],
        }),
        raw: {},
        usage: {},
        stopReason: 'end_turn',
        truncated: false,
      })),
    };
    const noClientService = new HearingBriefGenerationService(
      noClientPrisma as never,
      wave1 as never,
      credentials as never,
      llm as never,
      noWitnesses as never,
    );
    const brief = await noClientService.generate(ctx, 'hearing-1', {});
    expect(brief.mode).toBe('preparation');
    expect(brief.contextPacket).toMatchObject({ client: null, witnesses: [] });
  });

  it('fails fast with 503 when the tenant has no AI credential', async () => {
    const { service, llm } = harness({ credential: null });
    await expect(
      service.generate(ctx, 'hearing-1', { clientId: 'client-1' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('withholds a draft when the provider fails', async () => {
    const { service } = harness({ completion: new Error('upstream 529') });
    await expect(
      service.generate(ctx, 'hearing-1', { clientId: 'client-1' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('withholds incomplete or truncated output rather than saving a scaffold', async () => {
    for (const input of [{ truncated: true }, { completion: '{"sections":[]}' }]) {
      const { service } = harness(input);
      await expect(
        service.generate(ctx, 'hearing-1', { clientId: 'client-1' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });

  it('does not label a completed hearing with no transcript as preparation', async () => {
    const { service, wave1, llm } = harness({});
    const packet = prefill();
    packet.context.hearing.eventStatus = 'completed';
    wave1.buildBriefPrefill.mockResolvedValue(packet);
    await expect(service.generate(ctx, 'hearing-1', {})).rejects.toThrow('usable transcript');
    expect(llm.complete).not.toHaveBeenCalled();
  });
});

import { EngagementAiService, type MeetingPrepInput } from './engagement-ai.service.js';
import { prepEvidenceSources, validatePrepGrounding } from './meeting-prep-grounding.js';

const input: MeetingPrepInput = {
  meeting: { id: 'm1', subject: 'Meeting with Mia LaPinta', startsAt: '2026-09-08T16:00:00Z' },
  client: { id: 'c1', name: 'Client' },
  attendees: [{ id: 'a1', name: 'Mia LaPinta', email: 'mia@example.com' }],
  congressionalDirectoryMatches: [],
  recentMeetings: [],
  recentThreads: [],
  tasks: [],
  steeringContext: 'Governed background includes email evidence.',
  evidenceSources: [
    {
      id: 'mail:mail1',
      kind: 'mail',
      title: 'Timeline request',
      recordId: 'mail1',
      observedAt: '2026-09-07',
      excerpt: 'Mia asked for an implementation timeline.',
    },
  ],
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'Meet with Mia LaPinta.',
    agenda: [],
    talkingPoints: ['Propose sharing the requested implementation timeline.'],
    risks: [],
    followUps: [],
    emailEvidence: [],
    attendeeReferences: [{ attendeeId: 'a1', name: 'Mia LaPinta' }],
    evidenceReferences: [
      { section: 'summary', itemIndex: 0, sourceIds: ['attendee:a1'] },
      { section: 'talkingPoints', itemIndex: 0, sourceIds: ['mail:mail1'] },
    ],
    limitations: [],
    ...overrides,
  };
}

describe('meeting prep grounding', () => {
  test('rejects changed attendee names without rewriting them', () => {
    expect(() =>
      validatePrepGrounding(
        input,
        result({ attendeeReferences: [{ attendeeId: 'a1', name: 'Laura LaPinta' }] }),
      ),
    ).toThrow('attendee names did not match');
  });

  test('rejects fabricated source IDs and invalid claim indexes', () => {
    for (const ref of [
      { section: 'summary', itemIndex: 0, sourceIds: ['query_intelligence:fake'] },
      { section: 'talkingPoints', itemIndex: 2, sourceIds: ['mail:mail1'] },
    ])
      expect(() => validatePrepGrounding(input, result({ evidenceReferences: [ref] }))).toThrow(
        'unavailable source reference',
      );
  });

  test('persists only cited allowlisted records with their original titles/excerpts', () => {
    const grounding = validatePrepGrounding(input, result());
    expect(grounding.sources.map((source) => source.id)).toEqual(['attendee:a1', 'mail:mail1']);
    expect(grounding.sources[1]).toEqual(input.evidenceSources![0]);
    expect(grounding.attendees[0]!.name).toBe('Mia LaPinta');
    expect(grounding.contentEdited).toBe(false);
  });

  test('uncited text is refused before persistence', () => {
    expect(() => validatePrepGrounding(input, result({ evidenceReferences: [] }))).toThrow(
      'missing source links',
    );
  });

  test('empty list entries cannot silently shift citation indexes', () => {
    expect(() =>
      validatePrepGrounding(input, result({ talkingPoints: ['', 'Valid point'] })),
    ).toThrow('incomplete content');
  });

  test('the provider prompt recognizes governed mail and prioritizes the actual attendee roster', () => {
    const service = Object.create(EngagementAiService.prototype) as any;
    const prompt = service.buildPrompt(input);
    expect(prompt).toContain('CANONICAL ATTENDEE ROSTER');
    expect(prompt).toContain('Mia LaPinta');
    expect(prompt).toContain('never substitute a different first name');
    expect(prompt).toContain('mail:mail1');
    expect(prompt).not.toContain('INSUFFICIENT CONTEXT');
    expect(prompt).not.toContain('no email threads are linked');
    expect(prepEvidenceSources(input).some((source) => source.kind === 'mail')).toBe(true);
  });

  test('the source reviewer sees the same resolved local logistics as the generation prompt', () => {
    const meetingInput = {
      ...input,
      meeting: { ...input.meeting, endsAt: '2026-09-08T17:00:00Z', timeZone: 'America/New_York' },
    };
    const source = prepEvidenceSources(meetingInput).find((item) => item.kind === 'meeting')!;
    const logistics = JSON.parse(source.excerpt);
    expect(logistics.timeZone).toBe('America/New_York');
    expect(logistics.endsAt).toBe('2026-09-08T17:00:00Z');
    expect(logistics.formattedTime).toContain('12:00 PM');
    const service = Object.create(EngagementAiService.prototype) as any;
    expect(service.buildPrompt(meetingInput)).toContain(logistics.formattedTime);
  });

  test.each(['openai', 'anthropic'])(
    '%s request asks for citation/identity schema and validates response',
    async (provider) => {
      const json =
        provider === 'openai'
          ? { output_text: JSON.stringify(result()) }
          : { content: [{ type: 'text', text: JSON.stringify(result()) }] };
      const fetch = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue({ ok: true, json: async () => json } as Response);
      try {
        const service = Object.create(EngagementAiService.prototype) as any;
        const method = provider === 'openai' ? 'generateWithOpenAi' : 'generateWithAnthropic';
        const output = await service[method](input, {
          provider,
          apiKey: 'fake-key',
          model: 'test-model',
        });
        const request = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
        const prompt = provider === 'openai' ? request.input : request.messages[0].content;
        expect(prompt).toContain('evidenceReferences');
        expect(prompt).toContain('attendeeReferences');
        if (provider === 'openai')
          expect(request.text.format.schema.required).toContain('evidenceReferences');
        expect(output.grounding.sources).toHaveLength(2);
        expect(output.summary).toBe(result().summary);
      } finally {
        fetch.mockRestore();
      }
    },
  );

  test.each([
    ['wrong attendee prose', false, true],
    ['unrelated source cited for a factual claim', true, false],
  ])(
    'provider review refuses %s despite valid metadata',
    async (_label, attendeeNamesConsistent, factualClaimsSupported) => {
      const service = Object.create(EngagementAiService.prototype) as any;
      const generated = {
        ...result(),
        summary: 'Meeting with Laura LaPinta.',
        grounding: validatePrepGrounding(input, result()),
      };
      service.buildFederalContextBlock = async () => '';
      service.withCredentialFallback = async (
        _label: string,
        _ctx: unknown,
        callback: (cred: unknown) => unknown,
      ) => callback({ provider: 'openai', model: 'test', apiKey: 'fake' });
      service.generateWithOpenAi = async () => generated;
      service.llm = {
        complete: jest.fn(async () => ({
          text: JSON.stringify({
            attendeeNamesConsistent,
            factualClaimsSupported,
            issues: ['Mismatch in actual prose'],
          }),
          truncated: false,
          usage: { inputTokens: 2, outputTokens: 3 },
        })),
      };
      await expect(service.generateMeetingPrep(input)).rejects.toThrow(
        'did not pass the attendee and source review',
      );
      const request = service.llm.complete.mock.calls[0][0] as any;
      expect(request.userVolatile).toContain('Meeting with Laura LaPinta.');
      expect(request.userVolatile).toContain('Mia LaPinta');
      expect(request.userStatic).toContain('EVERY sentence');
    },
  );

  test('passing provider review records the review and combines generation/review usage', async () => {
    const service = Object.create(EngagementAiService.prototype) as any;
    service.buildFederalContextBlock = async () => '';
    service.withCredentialFallback = async (
      _label: string,
      _ctx: unknown,
      callback: (cred: unknown) => unknown,
    ) => callback({ provider: 'anthropic', model: 'test', apiKey: 'fake' });
    service.generateWithAnthropic = async () => ({
      ...result(),
      grounding: validatePrepGrounding(input, result()),
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    service.llm = {
      complete: jest.fn(async () => ({
        text: JSON.stringify({
          attendeeNamesConsistent: true,
          factualClaimsSupported: true,
          issues: [],
        }),
        truncated: false,
        usage: { inputTokens: 2, outputTokens: 3 },
      })),
    };
    const generated = await service.generateMeetingPrep(input);
    expect(generated.grounding.review).toEqual({
      attendeeNamesConsistent: true,
      factualClaimsSupported: true,
    });
    expect(generated.usage).toEqual(expect.objectContaining({ inputTokens: 12, outputTokens: 8 }));
  });
});

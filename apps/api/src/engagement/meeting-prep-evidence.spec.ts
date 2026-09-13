import { EngagementAiService, type MeetingPrepInput } from './engagement-ai.service.js';
import { buildPrepEvidence, prepEvidenceSources } from './meeting-prep-grounding.js';
import { MEETING_PREP_POLICY } from './meeting-prep-policy.js';
import { withMeetingPrepExecution } from './meeting-prep-job-runtime.js';
import { LlmCompletionService } from './llm-completion.service.js';
import { Agent } from 'undici';
import { createServer } from 'node:http';

const input: MeetingPrepInput = {
  meeting: { id: 'm1', subject: 'Meeting with Mia LaPinta', startsAt: '2026-09-08T16:00:00Z' },
  client: { id: 'c1', name: 'Client' },
  attendees: [{ id: 'a1', name: 'Mia LaPinta', email: 'mia@example.com' }],
  congressionalDirectoryMatches: [],
  recentMeetings: [],
  recentThreads: [],
  tasks: [],
  evidenceSources: [
    {
      id: 'mail:mail1',
      kind: 'mail',
      title: 'Timeline request',
      recordId: 'mail1',
      observedAt: '2026-09-07',
      excerpt: 'Mia asked for an implementation timeline.',
      access: { mail: ['mail1'], clients: ['c1'] },
    },
  ],
};
const draft = () => ({
  summary: 'Meet with Laura LaPinta.',
  agenda: [],
  talkingPoints: ['Discuss the timeline.'],
  risks: [],
  followUps: [],
  emailEvidence: [],
  evidenceReferences: [],
  limitations: [],
});

describe('meeting prep evidence display without a quality gate', () => {
  test('missing citations do not reject prose or rewrite attendee names', () => {
    const raw = draft();
    const metadata = buildPrepEvidence(input, raw);
    expect(raw.summary).toBe('Meet with Laura LaPinta.');
    expect(metadata.attendees[0]?.name).toBe('Mia LaPinta');
    expect(metadata.references).toEqual([]);
    expect(metadata).not.toHaveProperty('review');
  });
  test('unknown links are omitted; real supplied source metadata is preserved', () => {
    const metadata = buildPrepEvidence(input, {
      ...draft(),
      evidenceReferences: [
        { section: 'summary', itemIndex: 0, sourceIds: ['invented', 'mail:mail1', 'mail:mail1'] },
        { section: 'summary', itemIndex: 99, sourceIds: ['mail:mail1'] },
        null,
      ],
    });
    expect(metadata.sources).toEqual(input.evidenceSources);
    expect(metadata.references).toEqual([
      { section: 'summary', itemIndex: 0, sourceIds: ['mail:mail1'] },
    ]);
  });
  test('links keep the correct bullet after empty items are normalized away', () => {
    const metadata = buildPrepEvidence(input, {
      ...draft(),
      talkingPoints: ['', 'Discuss the timeline.'],
      evidenceReferences: [{ section: 'talkingPoints', itemIndex: 1, sourceIds: ['mail:mail1'] }],
    });
    expect(metadata.references[0]?.itemIndex).toBe(0);
  });
  test.each([undefined, null, {}, 'invalid'])(
    'malformed optional citation metadata (%p) cannot fail generation',
    (evidenceReferences) => {
      expect(buildPrepEvidence(input, { ...draft(), evidenceReferences }).references).toEqual([]);
    },
  );
  test('authorization provenance survives even when no display citation was returned', () => {
    const metadata = withMeetingPrepExecution(
      {
        jobId: 'job',
        depth: 'standard',
        deadlineAt: Date.now() + 3600000,
        signal: new AbortController().signal,
        checkpoint: jest.fn(),
        loadCheckpoint: () => undefined,
        commit: jest.fn(),
      },
      () => buildPrepEvidence(input, draft()),
    );
    expect(metadata.sources).toEqual([]);
    expect(metadata.accessSources).toContainEqual({ access: input.evidenceSources![0]!.access });
    expect(JSON.stringify(metadata.accessSources)).not.toContain('Mia asked');
  });
  test('prompt still uses the current roster and governed evidence without requesting a duplicate attendee response', () => {
    const service = Object.create(EngagementAiService.prototype) as any;
    const prompt = service.buildPrompt(input);
    expect(prompt).toContain('Mia LaPinta');
    expect(prompt).toContain('mail:mail1');
    expect(prompt).not.toContain('attendeeReferences');
    expect(prompt).toContain('what we committed to doing for the client');
    expect(prompt).toContain('OWNERS & COMMITMENTS');
    expect(prompt).toContain('never turn them into talking points');
    const logistics = JSON.parse(
      prepEvidenceSources(input).find((source) => source.kind === 'meeting')!.excerpt,
    );
    expect(prompt).toContain(logistics.formattedTime);
  });
  test('thread and prior-meeting excerpts keep their messages and debriefs, and history appears once in the prompt', () => {
    const long = 'x'.repeat(8_000);
    const history: MeetingPrepInput = {
      ...input,
      recentThreads: [
        { id: 't1', subject: 'Timeline thread', messageHighlights: [{ quote: `UNIQUE-QUOTE-MARKER ${long}` }] },
      ],
      recentMeetings: [{ id: 'm0', subject: 'Kickoff', debriefs: [{ id: 'd1', body: long }] }],
      tasks: [{ id: 'k1', title: 'Send timeline', description: long }],
    };
    const sources = prepEvidenceSources(history);
    const excerpt = (id: string) => sources.find((source) => source.id === id)!.excerpt.length;
    expect(excerpt('mail:t1')).toBe(5_000);
    expect(excerpt('prior-meeting:m0')).toBe(7_000);
    expect(excerpt('task:k1')).toBe(1_800);
    const service = Object.create(EngagementAiService.prototype) as any;
    const prompt: string = service.buildPrompt(history);
    expect(prompt.split('UNIQUE-QUOTE-MARKER').length - 1).toBe(1);
    expect(prompt).not.toContain('Email thread highlights');
  });
  test.each(['openai', 'anthropic'])(
    '%s returns uncited content after one generation call, without a reviewer',
    async (provider) => {
      const service = Object.create(EngagementAiService.prototype) as any;
      service.buildFederalContextBlock = async () => '';
      service.withCredentialFallback = async (
        _label: string,
        _ctx: unknown,
        callback: (credential: unknown) => unknown,
      ) => callback({ provider, model: 'test', apiKey: 'test-only' });
      service.llm = {
        complete: jest.fn(async () => ({
          text: JSON.stringify(draft()),
          usage: { inputTokens: 10, outputTokens: 5 },
          raw: {},
        })),
      };
      const result = await service.generateMeetingPrep(input);
      expect(result.summary).toBe('Meet with Laura LaPinta.');
      expect(result.grounding.references).toEqual([]);
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
      expect(service.llm.complete).toHaveBeenCalledTimes(1);
      const request = service.llm.complete.mock.calls[0][0];
      expect(request.jsonSchema.properties).not.toHaveProperty('attendeeReferences');
      expect(request.runtimeAction).toBe('meeting_prep_generate');
      expect(request.timeoutMs).toBe(MEETING_PREP_POLICY.legacyProviderMs);
      expect(request.maxRetries).toBe(0);
    },
  );
  test('provider calls use the remaining overall budget', async () => {
    jest.useFakeTimers();
    try {
      const service = Object.create(EngagementAiService.prototype) as any;
      service.llm = {
        complete: jest.fn(async () => ({ text: JSON.stringify(draft()), usage: {}, raw: {} })),
      };
      await service.generatePrepWithProvider(
        input,
        { provider: 'openai', model: 'test', apiKey: 'test-only' },
        Date.now() + 10000,
      );
      expect(service.llm.complete.mock.calls[0][0].timeoutMs).toBe(10000);
      await expect(
        service.generatePrepWithProvider(input, { provider: 'openai' }, Date.now() - 1),
      ).rejects.toThrow('time budget');
      expect(service.llm.complete).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
  test.each(['openai', 'anthropic'])(
    '%s response bodies can finish beyond the old 30/90-second limits',
    async (provider) => {
      jest.useFakeTimers();
      try {
        let signal: AbortSignal | null | undefined;
        let finishBody: (body: unknown) => void = () => {};
        const fetchImpl = jest.fn(async (_url, init) => {
          signal = init.signal;
          return {
            status: 200,
            json: () =>
              new Promise((resolve, reject) => {
                finishBody = resolve;
                signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
              }),
          } as Response;
        });
        const service = Object.create(EngagementAiService.prototype) as any;
        service.llm = new LlmCompletionService({ fetchImpl: fetchImpl as typeof fetch });
        const pending = service.generatePrepWithProvider(
          input,
          { provider, model: 'test', apiKey: 'test-only' },
          Date.now() + MEETING_PREP_POLICY.legacyDeadlineMs,
        );
        await jest.advanceTimersByTimeAsync(120000);
        expect(signal?.aborted).toBe(false);
        finishBody(
          provider === 'openai'
            ? { status: 'completed', output_text: JSON.stringify(draft()) }
            : {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: JSON.stringify(draft()) }],
              },
        );
        await jest.advanceTimersByTimeAsync(0);
        await expect(pending).resolves.toMatchObject({ summary: draft().summary });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    },
  );
  test('a stalled response body still ends at the extended provider ceiling', async () => {
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | null | undefined;
      const service = Object.create(EngagementAiService.prototype) as any;
      service.llm = new LlmCompletionService({
        fetchImpl: (async (_url, init) => {
          signal = init?.signal;
          return {
            status: 200,
            json: () =>
              new Promise((_resolve, reject) => {
                signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
              }),
          } as Response;
        }) as typeof fetch,
      });
      const pending = service.generatePrepWithProvider(
        input,
        { provider: 'openai', model: 'test', apiKey: 'test-only' },
        Date.now() + MEETING_PREP_POLICY.legacyDeadlineMs,
      );
      const failure = expect(pending).rejects.toThrow('timed out after 1500s');
      await jest.advanceTimersByTimeAsync(MEETING_PREP_POLICY.legacyProviderMs - 1);
      expect(signal?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await failure;
      expect(signal?.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
  test('prep disables shorter native HTTP limits locally and destroys its dispatcher', async () => {
    const dispatch = jest.spyOn(Agent.prototype, 'dispatch').mockReturnValue(true);
    const destroy = jest.spyOn(Agent.prototype, 'destroy');
    try {
      const fetchImpl = jest.fn(async (_url, init) => {
        init.dispatcher.dispatch(
          {
            origin: 'https://provider.example.test',
            path: '/',
            method: 'POST',
            headersTimeout: 300000,
            bodyTimeout: 300000,
          },
          {},
        );
        return {
          status: 200,
          json: async () => ({ output_text: JSON.stringify(draft()) }),
        } as Response;
      });
      const service = Object.create(EngagementAiService.prototype) as any;
      service.llm = new LlmCompletionService({ fetchImpl: fetchImpl as typeof fetch });
      await service.generatePrepWithProvider(
        input,
        { provider: 'openai', model: 'test', apiKey: 'test-only' },
        Date.now() + MEETING_PREP_POLICY.legacyDeadlineMs,
      );
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ headersTimeout: 0, bodyTimeout: 0 }),
        {},
      );
      expect(destroy).toHaveBeenCalled();
      const destroyCalls = destroy.mock.calls.length;
      const unrelatedFetch = jest.fn(async (_url, init) => {
        expect(init).not.toHaveProperty('dispatcher');
        return { status: 200, json: async () => ({ output_text: '{}' }) } as Response;
      });
      await new LlmCompletionService({ fetchImpl: unrelatedFetch as typeof fetch }).complete({
        provider: 'openai',
        model: 'test',
        apiKey: 'test-only',
        system: '',
        userStatic: '',
        userVolatile: '',
        jsonSchema: {},
      });
      expect(destroy).toHaveBeenCalledTimes(destroyCalls);
    } finally {
      dispatch.mockRestore();
      destroy.mockRestore();
    }
  });
  test('the prep dispatcher works with native fetch over a real local HTTP connection', async () => {
    const server = createServer((request, response) => {
      request.resume();
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ status: 'completed', output_text: JSON.stringify(draft()) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing local server port');
      const service = Object.create(EngagementAiService.prototype) as any;
      service.llm = new LlmCompletionService({
        fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init),
      });
      await expect(
        service.generatePrepWithProvider(
          input,
          { provider: 'openai', model: 'test', apiKey: 'test-only' },
          Date.now() + 10000,
        ),
      ).resolves.toMatchObject({ summary: draft().summary });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

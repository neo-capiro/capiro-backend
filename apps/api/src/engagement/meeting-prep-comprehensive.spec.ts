import {
  parseBriefingDraft,
  parseBriefingFacts,
  generateComprehensiveMeetingPrep,
} from './meeting-prep-comprehensive.js';
import { MEETING_BRIEFING_SECTIONS, MEETING_PREP_POLICY } from './meeting-prep-policy.js';
import { prepStageTimeout, withMeetingPrepExecution } from './meeting-prep-job-runtime.js';
import { runWithMeetingGovernedContext } from './meeting-context-runtime.js';
import type { PrepEvidenceSource } from './meeting-prep-grounding.js';

const source: PrepEvidenceSource = {
  id: 'mail:old',
  kind: 'mail',
  recordId: 'old',
  title: 'Old promise',
  observedAt: null,
  excerpt: 'We will deliver the memo on Friday. The memo was delivered on Friday.',
};
const fact = {
  section: 'commitments',
  text: 'The memo was delivered.',
  sourceId: source.id,
  quote: 'The memo was delivered on Friday.',
  importance: 'critical',
  state: 'resolved',
  eventAt: null,
};

describe('comprehensive meeting prep', () => {
  test('increases history, reasoning and wall-clock budgets without changing interactive defaults', () => {
    expect(MEETING_PREP_POLICY.standard).toMatchObject({
      meetings: 25,
      meetingDays: 180,
      threads: 100,
      emailDays: 90,
      messages: 1000,
      deadlineMs: 3600000,
    });
    expect(MEETING_PREP_POLICY.deep).toMatchObject({
      meetings: 100,
      threads: 300,
      emailDays: 365,
      messages: 3000,
      deadlineMs: 7200000,
    });
    expect(MEETING_PREP_POLICY.outputTokens).toBe(32768);
  });
  test('invalid citation metadata does not reject fact text or fabricate display evidence', () => {
    expect(parseBriefingFacts([fact], [source])).toHaveLength(1);
    expect(parseBriefingFacts([{ ...fact, sourceId: 'mail:secret' }], [source])[0]).toMatchObject({
      text: fact.text,
      sourceId: '',
      quote: '',
    });
    expect(
      parseBriefingFacts([{ ...fact, quote: 'The client approved a $5M contract.' }], [source])[0],
    ).toMatchObject({ text: fact.text, sourceId: source.id, quote: '' });
  });
  test('accepts any exact chunk of a long source with a stable source identity', () => {
    expect(
      parseBriefingFacts([fact], [source, { ...source, excerpt: 'A different later chunk.' }]),
    ).toHaveLength(1);
  });
  test('requires all seven sections and an explicit explanation for empty sections', () => {
    const facts = parseBriefingFacts([fact], [source]);
    const draft = {
      takeaways: [{ text: fact.text, factIds: [facts[0]!.id] }],
      sections: Object.fromEntries(
        MEETING_BRIEFING_SECTIONS.map((key) => [
          key,
          { status: 'no_evidence', items: [], gap: 'No evidence was found in the searched scope.' },
        ]),
      ),
      limitations: [],
    };
    expect(() => parseBriefingDraft(draft, facts)).not.toThrow();
    delete draft.sections.decisions;
    expect(() => parseBriefingDraft(draft, facts)).toThrow('missing_section');
  });
  test('reserves downstream time and immediately honors cancellation', () => {
    const controller = new AbortController();
    const execution = {
      jobId: 'job',
      depth: 'standard' as const,
      deadlineAt: Date.now() + 100000,
      signal: controller.signal,
      checkpoint: jest.fn(),
      loadCheckpoint: () => undefined,
      commit: jest.fn(),
    };
    withMeetingPrepExecution(execution, () => {
      expect(prepStageTimeout(600000, 10000)).toBeLessThanOrEqual(90000);
      expect(() => prepStageTimeout(600000, 200000)).toThrow('deadline');
      controller.abort();
      expect(() => prepStageTimeout(600000)).toThrow();
    });
  });
  test.each(['omission', 'uncited', 'unknown-source', 'unmatched-quote', 'unknown-fact'])(
    'comprehensive generation retains coverage work without a citation/identity gate: %s',
    async (variant) => {
      const controller = new AbortController();
      const extractionFact =
        variant === 'unknown-source'
          ? { ...fact, sourceId: 'invented' }
          : variant === 'unmatched-quote'
            ? { ...fact, quote: 'An invented quote.' }
            : fact;
      const extracted = parseBriefingFacts([extractionFact], [source]);
      const factIds =
        variant === 'uncited' ? [] : variant === 'unknown-fact' ? ['invented'] : [extracted[0]!.id];
      const draft = {
        takeaways: [{ text: fact.text, factIds }],
        sections: Object.fromEntries(
          MEETING_BRIEFING_SECTIONS.map((key) => [
            key,
            {
              status: key === 'commitments' ? 'evidence_found' : 'no_evidence',
              items: key === 'commitments' ? [{ text: fact.text, factIds }] : [],
              gap: key === 'commitments' ? '' : 'No evidence was found in the searched scope.',
            },
          ]),
        ),
        limitations: [],
      };
      let reviewCount = 0;
      const complete = jest.fn(async (request) => ({
        text: JSON.stringify(
          request.jsonSchemaName.endsWith('extracting')
            ? { facts: [extractionFact], limitations: [] }
            : request.jsonSchemaName.endsWith('checking_coverage')
              ? {
                  omittedFactIds:
                    reviewCount++ === 0 && variant === 'omission' ? [extracted[0]!.id] : [],
                }
              : draft,
        ),
        usage: { inputTokens: 10, outputTokens: 10 },
        truncated: false,
        stopReason: 'end_turn',
        raw: {},
      }));
      const input = {
        meeting: { id: 'meeting', subject: 'Client strategy', startsAt: '2026-09-12T15:00:00Z' },
        client: null,
        attendees: [],
        congressionalDirectoryMatches: [],
        recentMeetings: [],
        recentThreads: [],
        tasks: [],
        evidenceSources: [source],
      };
      const result = await runWithMeetingGovernedContext(
        {
          kind: 'governed_packet',
          mode: 'prep',
          meetingId: 'meeting',
          clientId: null,
          packetId: 'packet',
          traceHash: 'trace',
          modelContextBlock: '',
          coverage: {
            complete: true,
            requestedDomains: ['mail'],
            searchedDomains: ['mail'],
            missingDomains: [],
            partialDomains: [],
            recordsReturned: 1,
            paginationComplete: true,
            truncated: false,
            stopReason: 'complete',
          },
        },
        () =>
          withMeetingPrepExecution(
            {
              jobId: 'job',
              depth: 'standard',
              requestedAt: Date.parse('2026-09-12T15:00:00Z'),
              deadlineAt: Date.now() + 3600000,
              signal: controller.signal,
              checkpoint: jest.fn(),
              loadCheckpoint: () => undefined,
              commit: jest.fn(),
            },
            () =>
              generateComprehensiveMeetingPrep(
                input,
                {
                  provider: 'openai',
                  apiKey: 'test-only',
                  model: 'gpt-4.1-mini',
                  usedTenantKey: false,
                } as never,
                { complete } as never,
              ),
          ),
      );
      expect(reviewCount).toBe(variant === 'omission' ? 2 : 1);
      expect(JSON.parse(complete.mock.calls[0]![0].userVolatile).asOf).toBe(
        '2026-09-12T15:00:00.000Z',
      );
      expect(result.briefing?.coverage.reviewedFactCount).toBe(1);
      expect(result.briefing?.sections.commitments.items[0]?.text).toBe(fact.text);
      expect(result.grounding?.sources[0]?.excerpt).toBe(
        variant === 'omission' ? fact.quote : variant === 'unmatched-quote' ? '' : undefined,
      );
      expect(result.grounding).not.toHaveProperty('review');
      expect(result.grounding?.accessSources?.length).toBeGreaterThan(0);
      expect(
        complete.mock.calls.every(
          ([request]) =>
            request.signal === controller.signal &&
            request.runtimeAction === 'meeting_prep_generate',
        ),
      ).toBe(true);
      const reviewPayload = JSON.parse(
        complete.mock.calls.find(([request]) =>
          request.jsonSchemaName.endsWith('checking_coverage'),
        )![0].userVolatile,
      );
      expect(reviewPayload.ledger[0].state).toBe('resolved');
      expect(reviewPayload).not.toHaveProperty('attendees');
      const schema = complete.mock.calls.find(([request]) =>
        request.jsonSchemaName.endsWith('checking_coverage'),
      )![0].jsonSchema;
      expect(Object.keys(schema.properties)).toEqual(['omittedFactIds']);
    },
  );
});

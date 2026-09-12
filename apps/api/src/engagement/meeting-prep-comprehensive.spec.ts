import {
  validateBriefingDraft,
  validateBriefingFacts,
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
      deadlineMs: 1800000,
    });
    expect(MEETING_PREP_POLICY.deep).toMatchObject({
      meetings: 100,
      threads: 300,
      emailDays: 365,
      messages: 3000,
      deadlineMs: 3600000,
    });
    expect(MEETING_PREP_POLICY.outputTokens).toBe(32768);
  });
  test('rejects invented source IDs and non-verbatim supporting spans', () => {
    expect(validateBriefingFacts([fact], [source])).toHaveLength(1);
    expect(() => validateBriefingFacts([{ ...fact, sourceId: 'mail:secret' }], [source])).toThrow(
      'unverifiable',
    );
    expect(() =>
      validateBriefingFacts([{ ...fact, quote: 'The client approved a $5M contract.' }], [source]),
    ).toThrow('unverifiable');
  });
  test('accepts any exact chunk of a long source with a stable source identity', () => {
    expect(
      validateBriefingFacts([fact], [source, { ...source, excerpt: 'A different later chunk.' }]),
    ).toHaveLength(1);
  });
  test('requires all seven sections and an explicit explanation for empty sections', () => {
    const facts = validateBriefingFacts([fact], [source]);
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
    expect(() => validateBriefingDraft(draft as never, facts)).not.toThrow();
    delete draft.sections.decisions;
    expect(() => validateBriefingDraft(draft as never, facts)).toThrow('missing_section');
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
  test('reviews the complete ledger and repairs a missing old commitment', async () => {
    const controller = new AbortController();
    const extracted = validateBriefingFacts([fact], [source]);
    const draft = {
      takeaways: [{ text: fact.text, factIds: [extracted[0]!.id] }],
      sections: Object.fromEntries(
        MEETING_BRIEFING_SECTIONS.map((key) => [
          key,
          {
            status: key === 'commitments' ? 'evidence_found' : 'no_evidence',
            items: key === 'commitments' ? [{ text: fact.text, factIds: [extracted[0]!.id] }] : [],
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
          ? { facts: [fact], limitations: [] }
          : request.jsonSchemaName.endsWith('reviewing')
            ? {
                supported: true,
                attendeeNamesConsistent: true,
                omittedFactIds: reviewCount++ === 0 ? [extracted[0]!.id] : [],
                issues: [],
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
            deadlineAt: Date.now() + 1800000,
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
    expect(reviewCount).toBe(2);
    expect(result.briefing?.coverage.reviewedFactCount).toBe(1);
    expect(result.briefing?.sections.commitments.items[0]?.text).toBe(fact.text);
    expect(result.grounding?.sources[0]?.excerpt).toBe(fact.quote);
    expect(
      complete.mock.calls.every(
        ([request]) =>
          request.signal === controller.signal && request.runtimeAction === 'meeting_prep_generate',
      ),
    ).toBe(true);
    const reviewPayload = JSON.parse(
      complete.mock.calls.find(([request]) => request.jsonSchemaName.endsWith('reviewing'))![0]
        .userVolatile,
    );
    expect(reviewPayload.ledger[0].state).toBe('resolved');
  });
});

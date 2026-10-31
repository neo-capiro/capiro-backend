import { describe, expect, it } from '@jest/globals';
import {
  boundDebriefContext,
  debriefContextTokens,
  type MeetingDebriefContextInput,
} from './meeting-debrief-context.js';
import { MEETING_DEBRIEF_POLICY, conservativeTokens } from './meeting-prep-policy.js';

const sentence =
  'We discussed the fiscal year markup schedule, the client asked whether the subcommittee would take up the ' +
  'reauthorization before recess, and the team agreed to send the revised one-pager to the staff director. ';

/** A realistic single-meeting transcript: ~4.4k bytes, i.e. a normal 45-minute meeting. */
const realisticTranscript = Array.from({ length: 26 }, () => sentence).join('');
/** A deliberately unbounded transcript, the shape that produced a 53k-token prompt. */
const oversizedTranscript = Array.from({ length: 300 }, () => sentence).join('');

function input(overrides: Partial<MeetingDebriefContextInput> = {}): MeetingDebriefContextInput {
  return {
    meeting: {
      id: 'meeting-1',
      subject: 'Markup schedule with the client',
      startsAt: '2026-10-12T13:00:00.000Z',
      endsAt: '2026-10-12T14:00:00.000Z',
      location: 'Zoom',
      status: 'scheduled',
      description: 'Weekly check-in',
    },
    client: { id: 'client-1', name: 'Synthetic Strategies', sectorTag: 'defense' },
    attendees: [
      { name: 'Ada Example', email: 'ada@example.test', role: 'client' },
      { name: 'Ben Example', email: 'ben@example.test', role: 'staff' },
    ],
    prep: {
      id: 'prep-1',
      status: 'approved',
      summary: 'Client wants the reauthorization moved before recess.',
      agenda: ['Markup schedule', 'Staff outreach'],
      talkingPoints: [],
      risks: [],
      followUps: ['Send the revised one-pager'],
    },
    source: { method: 'upload', text: realisticTranscript },
    visibleNotes: [{ body: 'Client flagged the recess timing twice.', createdAt: '2026-10-12T14:05:00Z' }],
    openTasks: [
      { title: 'Send revised one-pager', status: 'open', dueOn: '2026-10-20' },
      { title: 'Confirm staff director availability', status: 'open', dueOn: null },
    ],
    recentDebriefs: [
      { createdAt: '2026-10-05T15:00:00.000Z', recap: 'Prior debrief: agreed to share the funding table.' },
    ],
    steeringContext: 'Firm voice: precise, understated.',
    ...overrides,
  };
}

describe('D2 bounded debrief context', () => {
  it('keeps a realistic full-length transcript intact and under the 8k bound', () => {
    const assembled = boundDebriefContext(input());
    expect(assembled.summary.boundTokens).toBe(MEETING_DEBRIEF_POLICY.contextTokens);
    expect(assembled.summary.totalTokens).toBeLessThanOrEqual(
      MEETING_DEBRIEF_POLICY.contextTokens,
    );
    expect(debriefContextTokens(assembled.input)).toBeLessThanOrEqual(
      MEETING_DEBRIEF_POLICY.contextTokens,
    );
    // The reviewed source is never dropped or shortened while everything else fits.
    expect(assembled.summary.sourceTruncated).toBe(false);
    expect(assembled.input.source.text).toBe(realisticTranscript);
    expect(assembled.summary.sections.find((s) => s.name === 'source')?.state).toBe('kept');
  });

  it('never admits mail threads, mail bodies or a client timeline', () => {
    // The pre-fix context carried recentThreads and mail bodies into the prompt.
    const contaminated = {
      ...input(),
      recentThreads: [
        {
          id: 'thread-1',
          subject: 'Re: confidential acquisition chatter',
          snippet: 'MAIL-BODY-MARKER the buyer is circling',
        },
      ],
    } as unknown as MeetingDebriefContextInput;
    const assembled = boundDebriefContext(contaminated);
    const serialized = JSON.stringify(assembled.input);
    expect('recentThreads' in assembled.input).toBe(false);
    expect(serialized).not.toContain('MAIL-BODY-MARKER');
    expect(serialized).not.toContain('confidential acquisition chatter');
    // Only the D2 fields exist on the assembled context.
    expect(Object.keys(assembled.input).sort()).toEqual(
      [
        'attendees',
        'client',
        'meeting',
        'openTasks',
        'prep',
        'recentDebriefs',
        'source',
        'steeringContext',
        'visibleNotes',
      ].sort(),
    );
  });

  it('shortens the source only when it alone exceeds the bound, and records it', () => {
    const assembled = boundDebriefContext(
      input({ source: { method: 'upload', text: oversizedTranscript } }),
    );
    expect(assembled.summary.totalTokens).toBeLessThanOrEqual(
      MEETING_DEBRIEF_POLICY.contextTokens,
    );
    expect(assembled.summary.sourceTruncated).toBe(true);
    expect(assembled.input.source.text.length).toBeLessThan(oversizedTranscript.length);
    expect(assembled.input.source.text).toContain('transcript truncated');
    expect(assembled.summary.sections.find((s) => s.name === 'source')?.state).toBe('shortened');
  });

  it('gives up lower-priority sections before touching the source', () => {
    const assembled = boundDebriefContext(
      input({
        source: { method: 'upload', text: realisticTranscript },
        visibleNotes: [{ body: 'note '.repeat(4_000), createdAt: '2026-10-12T14:05:00Z' }],
        steeringContext: 'voice '.repeat(500),
        recentDebriefs: [{ createdAt: '2026-10-01T00:00:00.000Z', recap: 'prior '.repeat(400) }],
        openTasks: Array.from({ length: 20 }, (_, index) => ({
          title: `task ${index} `.repeat(20),
          status: 'open',
          dueOn: null,
        })),
      }),
    );
    expect(assembled.summary.totalTokens).toBeLessThanOrEqual(
      MEETING_DEBRIEF_POLICY.contextTokens,
    );
    expect(assembled.summary.sourceTruncated).toBe(false);
    expect(assembled.input.source.text).toBe(realisticTranscript);
    const state = (name: string) => assembled.summary.sections.find((s) => s.name === name)?.state;
    // Continuity and voice were reduced; the source was not.
    expect(state('steeringContext')).not.toBe('kept');
    expect(state('recentDebriefs')).not.toBe('kept');
  });

  it('bounds continuity to the configured number of prior debriefs', () => {
    const assembled = boundDebriefContext(
      input({
        recentDebriefs: Array.from({ length: 10 }, (_, index) => ({
          createdAt: `2026-10-0${(index % 9) + 1}T00:00:00.000Z`,
          recap: `debrief ${index}`,
        })),
      }),
    );
    expect(assembled.input.recentDebriefs.length).toBeLessThanOrEqual(
      MEETING_DEBRIEF_POLICY.recentDebriefs,
    );
  });

  it('reports a section token count that matches the conservative byte bound', () => {
    const assembled = boundDebriefContext(input());
    const source = assembled.summary.sections.find((s) => s.name === 'source');
    expect(source?.tokens).toBe(conservativeTokens(assembled.input.source.text));
  });
});

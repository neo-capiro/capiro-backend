import {
  HearingSpeakerAttributionService,
  acceptSpeakerEntries,
  groupTurns,
  isAttributionDue,
  isDiarizationIndex,
  labelsWithNamingCue,
  selectCueTurns,
} from './hearing-speaker-attribution.service.js';

jest.mock('@capiro/shared', () => {
  const actual = jest.requireActual('@capiro/shared');
  return { ...actual, recordAiUsageEvent: jest.fn(async () => undefined) };
});
import { recordAiUsageEvent } from '@capiro/shared';

const now = new Date('2026-09-22T15:00:00Z');

function segment(sequence: number, label: string | null, text: string, startMs = sequence * 5_000) {
  return { sequence, startMs, text, speakerLabel: label };
}

describe('isDiarizationIndex', () => {
  it('recognizes only bare numeric labels', () => {
    expect(isDiarizationIndex('0')).toBe(true);
    expect(isDiarizationIndex(' 12 ')).toBe(true);
    expect(isDiarizationIndex('CHAIR')).toBe(false);
    expect(isDiarizationIndex('')).toBe(false);
    expect(isDiarizationIndex(null)).toBe(false);
  });
});

describe('isAttributionDue', () => {
  const base = { domainStatus: 'COMPLETE', speakersResolvedAt: null, throughSequence: null };

  it('is due for a terminal capture that was never resolved', () => {
    expect(isAttributionDue({ capture: base, maxSequence: 10, unresolvedLabels: 3, now })).toBe(true);
  });

  it('is never due when every label already has a name', () => {
    expect(isAttributionDue({ capture: base, maxSequence: 10, unresolvedLabels: 0, now })).toBe(false);
  });

  it('is not due again for a terminal capture with no new segments', () => {
    const capture = { ...base, speakersResolvedAt: new Date('2026-09-22T14:00:00Z'), throughSequence: 10 };
    expect(isAttributionDue({ capture, maxSequence: 10, unresolvedLabels: 1, now })).toBe(false);
    expect(isAttributionDue({ capture, maxSequence: 14, unresolvedLabels: 1, now })).toBe(true);
  });

  it('re-runs an active capture only after ten minutes and new turns', () => {
    const active = {
      domainStatus: 'CAPTURING',
      speakersResolvedAt: new Date('2026-09-22T14:55:00Z'),
      throughSequence: 40,
    };
    expect(isAttributionDue({ capture: active, maxSequence: 80, unresolvedLabels: 2, now })).toBe(false);
    const older = { ...active, speakersResolvedAt: new Date('2026-09-22T14:40:00Z') };
    expect(isAttributionDue({ capture: older, maxSequence: 80, unresolvedLabels: 2, now })).toBe(true);
    expect(isAttributionDue({ capture: older, maxSequence: 40, unresolvedLabels: 2, now })).toBe(false);
  });
});

describe('groupTurns', () => {
  it('merges contiguous same-label segments and skips non-index labels', () => {
    const turns = groupTurns([
      segment(1, '0', 'The committee will come to order.'),
      segment(2, '0', 'We welcome our witness.'),
      segment(3, '1', 'Thank you, Chairman Smith.'),
      segment(4, 'CHAIR', 'legacy label'),
      segment(5, null, 'no label'),
      segment(6, '0', 'You are recognized.'),
    ]);
    expect(turns.map((t) => [t.label, t.sequence])).toEqual([
      ['0', 1],
      ['1', 3],
      ['0', 6],
    ]);
    expect(turns[0]!.text).toBe('The committee will come to order. We welcome our witness.');
  });
});

describe('selectCueTurns', () => {
  it('keeps each label’s first two turns plus cued turns, within bounds', () => {
    const turns = [];
    for (let i = 0; i < 200; i++) {
      turns.push({
        label: String(i % 3),
        sequence: i,
        startMs: i * 1000,
        text: i === 50 ? 'I recognize the gentlelady from Florida.' : `filler ${i} `.repeat(30),
      });
    }
    const selected = selectCueTurns(turns);
    expect(selected.length).toBeLessThanOrEqual(60);
    expect(selected.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(24_000);
    expect(selected.some((t) => t.sequence === 50)).toBe(true);
    expect(selected.some((t) => t.sequence === 51)).toBe(true);
    expect(selected.every((t) => t.text.length <= 401)).toBe(true);
    for (const label of ['0', '1', '2']) {
      expect(selected.filter((t) => t.label === label).length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('acceptSpeakerEntries', () => {
  const roster = {
    members: [
      { name: 'Jane Q. Smith', role: 'Chair', personRef: 'S000001', party: 'R' },
      { name: 'Robert Lee', role: 'Ranking Member', personRef: 'L000002', party: 'D' },
    ],
    witnesses: ['Dr. Amaya Patel'],
  };
  const labels = new Set(['0', '1', '2']);
  const cuedLabels = new Set(['0', '1', '2', '9']);

  it('accepts roster and witness matches above the floor and drops the rest', () => {
    const accepted = acceptSpeakerEntries(
      {
        speakers: [
          { label: '0', displayName: 'Chairman Smith', role: 'Chair', personRef: 'S000001', confidence: 0.9 },
          { label: '1', displayName: 'Amaya Patel', role: 'Witness', personRef: null, confidence: 0.6 },
          { label: '2', displayName: 'Someone Unlisted', role: null, personRef: null, confidence: 0.7 },
          { label: '9', displayName: 'Robert Lee', role: null, personRef: 'L000002', confidence: 1 },
          { label: '1', displayName: 'Amaya Patel', role: 'Witness', personRef: 'BOGUS', confidence: 0.95 },
        ],
      },
      labels,
      roster,
      cuedLabels,
    );
    expect(accepted).toEqual([
      expect.objectContaining({ speakerLabel: '0', displayName: 'Chairman Smith', personRef: 'S000001' }),
      expect.objectContaining({ speakerLabel: '1', displayName: 'Amaya Patel', personRef: null, confidence: 0.95 }),
    ]);
  });

  it('accepts a name outside the roster only with high confidence', () => {
    const accepted = acceptSpeakerEntries(
      { speakers: [{ label: '2', displayName: 'Mayor Dana Ortiz', role: null, personRef: null, confidence: 0.85 }] },
      labels,
      roster,
      cuedLabels,
    );
    expect(accepted).toHaveLength(1);
  });

  it('tolerates malformed model output', () => {
    expect(acceptSpeakerEntries(null, labels, roster, cuedLabels)).toEqual([]);
    expect(acceptSpeakerEntries({ speakers: [null, 'x', { label: '0' }] }, labels, roster, cuedLabels)).toEqual([]);
  });

  it('rejects an identification with no textual cue, even at maximum self-reported confidence', () => {
    // A transcript could be crafted to make the model emit a high-confidence
    // claim for a label with zero grounding — a real roster member's name and
    // personRef assigned to an unrelated speaker. Without a naming cue
    // anywhere near that label's own speech, it must never be accepted.
    const accepted = acceptSpeakerEntries(
      {
        speakers: [
          { label: '2', displayName: 'Jane Q. Smith', role: 'Chair', personRef: 'S000001', confidence: 1 },
        ],
      },
      labels,
      roster,
      new Set(['0', '1']), // label '2' has no naming cue
    );
    expect(accepted).toEqual([]);
  });
});

describe('labelsWithNamingCue', () => {
  it('flags a label whose own turn contains a cue, and the label immediately following a cue turn, but not an uncued label after an uncued turn', () => {
    const turns = [
      { label: '0', sequence: 1, startMs: 0, text: 'I now recognize the next speaker.' },
      { label: '1', sequence: 2, startMs: 5000, text: 'Weather patterns this quarter have been unusual.' },
      { label: '2', sequence: 3, startMs: 10000, text: 'Rainfall totals were also above average this year.' },
    ];
    // '0' cues via its own text ("recognize"); '1' cues only because it
    // immediately follows '0's cued turn; '2' has no cue of its own and
    // follows an UNCUED turn, so it is correctly excluded.
    expect(labelsWithNamingCue(turns)).toEqual(new Set(['0', '1']));
  });
});

describe('HearingSpeakerAttributionService', () => {
  function harness(input: {
    capture?: Record<string, unknown> | null;
    segments?: ReturnType<typeof segment>[];
    existing?: Array<Record<string, unknown>>;
    completion?: string;
    credential?: Record<string, unknown> | null;
  }) {
    const capture =
      input.capture === null
        ? null
        : {
            id: 'cap-1',
            hearingId: 'hearing-1',
            domainStatus: 'COMPLETE',
            speakersResolvedAt: null,
            throughSequence: null,
            ...(input.capture ?? {}),
          };
    const segments = input.segments ?? [
      segment(1, '0', 'The committee will come to order. I am Chairman Smith.'),
      segment(2, '1', 'Thank you, Chairman Smith. My name is Amaya Patel.'),
    ];
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const prisma = {
      $queryRawUnsafe: jest.fn(async (sql: string, ...params: unknown[]) => {
        if (sql.includes('FROM public_hearing_capture')) return capture ? [capture] : [];
        if (sql.includes('FROM public_hearing_transcript_segment')) return segments;
        if (sql.includes('FROM public_hearing_speaker')) return input.existing ?? [];
        if (sql.includes('FROM committee_hearing')) {
          return [
            {
              committeeSystemCode: 'ssju00',
              subcommitteeSystemCode: null,
              stateCommitteeId: null,
              witnesses: ['Dr. Amaya Patel'],
            },
          ];
        }
        return [];
      }),
      $executeRawUnsafe: jest.fn(async (sql: string, ...params: unknown[]) => {
        executed.push({ sql, params });
        return 1;
      }),
      congressCommitteeMembership: {
        findMany: jest.fn(async () => [
          { id: 'm1', systemCode: 'ssju00', bioguideId: 'S000001', side: 'majority', rank: 1, title: 'Chair' },
        ]),
      },
      congressMember: {
        findMany: jest.fn(async () => [{ bioguideId: 'S000001', fullName: 'Jane Q. Smith', party: 'R' }]),
      },
      stateCommitteeMembership: { findMany: jest.fn(async () => []) },
    };
    const credentials = {
      resolveProvider: jest.fn(async () =>
        input.credential === null
          ? null
          : { provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5', usedTenantKey: false, ...(input.credential ?? {}) },
      ),
    };
    const llm = {
      complete: jest.fn(async (_req: { userStatic: string; userVolatile: string }) => ({
        text:
          input.completion ??
          JSON.stringify({
            speakers: [
              { label: '0', displayName: 'Jane Q. Smith', role: 'Chair', personRef: 'S000001', confidence: 0.95 },
              { label: '1', displayName: 'Dr. Amaya Patel', role: 'Witness', personRef: null, confidence: 0.9 },
            ],
          }),
        raw: {},
        usage: {},
        stopReason: 'end_turn',
        truncated: false,
      })),
    };
    const service = new HearingSpeakerAttributionService(
      prisma as never,
      credentials as never,
      llm as never,
    );
    return { service, prisma, credentials, llm, executed };
  }

  it('resolves a terminal capture once and protects manual names on conflict', async () => {
    const { service, executed, llm } = harness({});
    const result = await service.resolve('hearing-1', { force: false, now });
    expect(result).toEqual({ resolved: 2, ran: true });
    expect(llm.complete).toHaveBeenCalledTimes(1);
    const request = llm.complete.mock.calls[0]![0];
    expect(request.userStatic).toContain('Jane Q. Smith');
    expect(request.userVolatile).toContain('Speaker 0:');
    const upserts = executed.filter((e) => e.sql.includes('INSERT INTO public_hearing_speaker'));
    expect(upserts).toHaveLength(2);
    expect(upserts[0]!.sql).toContain("WHERE public_hearing_speaker.source <> 'manual'");
    expect(executed.at(-1)!.sql).toContain('speakers_resolved_at=now()');
    expect(executed.at(-1)!.params).toEqual(['cap-1', 2]);
    // Recorded even without a ctx (the fire-and-forget resolveIfDue path) —
    // system-attributed usage, not silently unmetered spend.
    expect(recordAiUsageEvent).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: null, userId: null },
      'hearing_speaker_attribution',
      expect.objectContaining({ provider: 'anthropic' }),
    );
  });

  it('records usage against the caller tenant when resolved with a ctx', async () => {
    const { service } = harness({});
    await service.resolve('hearing-1', { force: false, now, ctx: { tenantId: 't1', userId: 'u1' } as never });
    expect(recordAiUsageEvent).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: 't1', userId: 'u1' },
      'hearing_speaker_attribution',
      expect.anything(),
    );
  });

  it('serializes concurrent resolve() calls for the same capture into a single LLM call', async () => {
    const { service, llm } = harness({});
    const [a, b, c] = await Promise.all([
      service.resolve('hearing-1', { force: false, now }),
      service.resolve('hearing-1', { force: false, now }),
      service.resolve('hearing-1', { force: false, now }),
    ]);
    const ran = [a, b, c].filter((r) => r.ran);
    const inFlightSkipped = [a, b, c].filter((r) => r.reason === 'in_flight');
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(ran).toHaveLength(1);
    expect(inFlightSkipped).toHaveLength(2);
  });

  it('does nothing when there is no capture, no labels, or the run is not due', async () => {
    expect(await harness({ capture: null }).service.resolve('h', { force: false, now })).toMatchObject({
      ran: false,
      reason: 'no_capture',
    });
    expect(
      await harness({ segments: [segment(1, 'CHAIR', 'x')] }).service.resolve('h', { force: false, now }),
    ).toMatchObject({ ran: false, reason: 'no_labels' });
    const resolved = harness({
      capture: { speakersResolvedAt: new Date('2026-09-22T14:00:00Z'), throughSequence: 2 },
    });
    expect(await resolved.service.resolve('h', { force: false, now })).toMatchObject({
      ran: false,
      reason: 'not_due',
    });
    expect(resolved.llm.complete).not.toHaveBeenCalled();
  });

  it('runs when forced even if not due', async () => {
    const forced = harness({
      capture: { speakersResolvedAt: new Date('2026-09-22T14:00:00Z'), throughSequence: 2 },
    });
    expect(await forced.service.resolve('h', { force: true, now })).toMatchObject({ ran: true });
  });

  it('backs off without stamping the capture when no credential is configured', async () => {
    const { service, executed, llm } = harness({ credential: null });
    expect(await service.resolve('h', { force: false, now })).toMatchObject({ ran: false, reason: 'no_credential' });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);
    expect(await service.resolve('h', { force: false, now })).toMatchObject({ reason: 'backoff' });
  });

  it('stamps the capture even when the model output is unusable', async () => {
    const { service, executed } = harness({ completion: 'I cannot tell.' });
    expect(await service.resolve('h', { force: false, now })).toEqual({ resolved: 0, ran: true });
    expect(executed).toHaveLength(1);
    expect(executed[0]!.sql).toContain('speakers_resolved_at=now()');
  });

  it('renames a label manually', async () => {
    const { service, executed } = harness({});
    const row = await service.rename('hearing-1', '1', '  Dr. Amaya Patel ', { tenantId: 't', userId: 'u' });
    expect(row).toMatchObject({ speakerLabel: '1', displayName: 'Dr. Amaya Patel', source: 'manual' });
    expect(executed[0]!.sql).toContain("source='manual'");
    expect(executed[0]!.params).toEqual(['cap-1', '1', 'Dr. Amaya Patel', 't:u']);
  });

  it('resolveIfDue never throws', () => {
    const { service, prisma } = harness({});
    prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('db down'));
    expect(() => service.resolveIfDue('hearing-1')).not.toThrow();
  });
});

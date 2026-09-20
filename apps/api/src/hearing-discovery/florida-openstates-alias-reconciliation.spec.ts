import {
  classifyFloridaAgendaRelocations,
  classifyFloridaCandidateRelocations,
  calendarProjectionFingerprint,
  floridaAliasConfirmation,
  targetCalendarRevision,
  verifyFloridaAliasMediaEvidence,
  type CalendarProjection,
} from './florida-openstates-alias-reconciliation.js';
import type { FloridaOpenstatesAliasReview } from './florida-openstates-alias-review.js';

const aliasId = `state-fl-${'a'.repeat(32)}`;
const canonicalId = `state-fl-${'b'.repeat(32)}`;

const review: FloridaOpenstatesAliasReview = {
  repairId: 'fl-openstates-tfc-2026-09-20',
  aliasId,
  canonicalId,
  externalEventId: 'ocd-event/00000000-0000-4000-8000-000000000001',
  publisherMediaEntryId: '1_sharedentry',
  session: '2026',
  date: '2026-02-04',
  chamber: 'senate',
  stateCommitteeId: 'FL-upper-appropriations',
  bodySourceKey: 'fl:senate:appropriations',
  aliasEvidenceUrl: 'https://www.flsenate.gov/media/video/123',
  canonicalEvidenceUrl: 'https://thefloridachannel.org/videos/2-4-26-appropriations/',
  reason: 'Exact shared publisher media identity reviewed by the operator.',
};

describe('Florida OpenStates alias reconciliation safety', () => {
  const projection = (changed: Partial<CalendarProjection> = {}): CalendarProjection => ({
    calendarRevision: 2,
    calendarSnapshot: { title: 'Committee hearing' },
    calendarProvenance: { title: { source: 'openstates' } },
    calendarCheckedAt: new Date('2026-02-05T12:00:00Z'),
    calendarCheckState: 'complete',
    timePrecision: 'instant',
    scheduledEnd: new Date('2026-02-04T16:00:00Z'),
    committeeName: 'Appropriations',
    title: 'Committee hearing',
    date: new Date('2026-02-04T00:00:00Z'),
    time: '10:00 AM',
    startsAt: new Date('2026-02-04T15:00:00Z'),
    location: 'Room 412 Knott Building',
    type: 'committee',
    url: 'https://openstates.org/event',
    timezone: 'America/New_York',
    eventStatus: 'scheduled',
    syncedAt: new Date('2026-02-05T12:00:00Z'),
    ...changed,
  });

  it('hashes only calendar projection fields and preserves monotonic revisions', () => {
    const source = projection({ calendarRevision: 2 });
    expect(
      calendarProjectionFingerprint({
        ...source,
        stateCommitteeId: 'ignored-extra-runtime-field',
      } as CalendarProjection),
    ).toBe(calendarProjectionFingerprint(source));
    expect(targetCalendarRevision(source, projection({ calendarRevision: 5 }))).toBe(5);
    expect(
      targetCalendarRevision(
        projection({ calendarRevision: 2, title: 'Updated title' }),
        projection({ calendarRevision: 2 }),
      ),
    ).toBe(3);
    expect(
      targetCalendarRevision(
        projection({ calendarRevision: 2, calendarSnapshot: { agenda: ['SB 1'] } }),
        projection({ calendarRevision: 2 }),
      ),
    ).toBe(3);
  });

  it('moves non-overlapping agenda and retains only semantic equivalents', () => {
    const base = {
      position: 1,
      kind: 'bill',
      title: 'SB 1',
      billScope: 'state',
      stateBillKey: 'FL-2026-SB1',
      federalBillId: null,
      sourceUrl: 'https://openstates.org/event',
      evidence: { provider: 'openstates' },
      active: true,
    };
    const result = classifyFloridaAgendaRelocations(aliasId, canonicalId, [
      { id: 'a1', hearingId: aliasId, itemKey: 'same', ...base },
      { id: 'c1', hearingId: canonicalId, itemKey: 'same', ...base },
      { id: 'a2', hearingId: aliasId, itemKey: 'move', ...base, title: 'SB 2' },
    ]);
    expect(result).toEqual({
      moved: ['a2'],
      retainedEquivalent: ['a1'],
      conflicts: [],
    });
  });

  it('blocks a non-equivalent agenda collision', () => {
    const base = {
      position: 1,
      kind: 'other',
      billScope: null,
      stateBillKey: null,
      federalBillId: null,
      sourceUrl: 'https://openstates.org/event',
      evidence: {},
      active: true,
    };
    const result = classifyFloridaAgendaRelocations(aliasId, canonicalId, [
      { id: 'a1', hearingId: aliasId, itemKey: 'same', title: 'First', ...base },
      { id: 'c1', hearingId: canonicalId, itemKey: 'same', title: 'Different', ...base },
    ]);
    expect(result.conflicts).toEqual([{ sourceId: 'a1', targetId: 'c1', key: 'same' }]);
  });

  it('deduplicates exact stream identity and moves distinct publisher pages', () => {
    const base = {
      provider: 'florida-channel',
      mediaUrl: null,
      mediaType: 'video',
      priority: 20,
      resolutionState: 'NOT_CHECKED',
      capturePolicy: 'BROWSER_CAPTURE_ONLY',
      sourceId: null,
      expiresAt: null,
      failureReason: null,
    };
    const result = classifyFloridaCandidateRelocations(aliasId, canonicalId, [
      { id: 'a1', hearingId: aliasId, officialPageUrl: 'https://fl.gov/a', ...base },
      { id: 'c1', hearingId: canonicalId, officialPageUrl: 'https://fl.gov/a', ...base },
      { id: 'a2', hearingId: aliasId, officialPageUrl: 'https://fl.gov/b', ...base },
    ]);
    expect(result.moved).toEqual(['a2']);
    expect(result.retainedEquivalent).toEqual(['a1']);
    expect(result.conflicts).toEqual([]);
  });

  it('uses the runtime media identity even when official pages differ', () => {
    const base = {
      provider: 'florida-channel',
      mediaUrl: 'https://cdn.example/video.m3u8',
      mediaType: 'hls',
      priority: 20,
      resolutionState: 'READY',
      capturePolicy: 'BROWSER_CAPTURE_ONLY',
      sourceId: null,
      expiresAt: null,
      failureReason: null,
    };
    const result = classifyFloridaCandidateRelocations(aliasId, canonicalId, [
      { id: 'a1', hearingId: aliasId, officialPageUrl: 'https://fl.gov/a', ...base },
      { id: 'c1', hearingId: canonicalId, officialPageUrl: 'https://fl.gov/b', ...base },
    ]);
    expect(result.moved).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        sourceId: 'a1',
        targetId: 'c1',
        key: JSON.stringify(['florida-channel', 'media', 'https://cdn.example/video.m3u8']),
      },
    ]);
  });

  it('requires both publisher pages to resolve to the reviewed Kaltura entry', async () => {
    const fetchPage = jest.fn(async () => new TextEncoder().encode('entry=1_sharedentry'));
    const result = await verifyFloridaAliasMediaEvidence(
      [review],
      fetchPage,
      (html) => /1_[a-z]+/.exec(html)?.[0] ?? null,
    );
    expect(result[0]).toMatchObject({
      aliasEntry: '1_sharedentry',
      canonicalEntry: '1_sharedentry',
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('emits a repair-specific apply token', () => {
    expect(floridaAliasConfirmation(review.repairId)).toBe(
      'fl-openstates-tfc-2026-09-20:apply-reviewed-aliases',
    );
  });
});

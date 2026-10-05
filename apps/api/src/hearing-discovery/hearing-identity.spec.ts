/**
 * Canonical identity is the property the whole phase rests on: one official
 * event → one canonical hearing, no matter how many sources report it. These
 * tests pin the rules that make that true, especially the two that would
 * silently fork duplicates if they regressed:
 *
 *   1. Congress.gov / docs.house.gov events MUST mint `cm-{congress}-{eventId}`,
 *      the id the pre-existing `sync-hearings.ts` has been writing for months.
 *      A different scheme here would create a second row for every hearing
 *      already in the corpus.
 *   2. Ids must be deterministic — same input, same id, every run, forever.
 */
import {
  CONGRESS_GOV_ADAPTER,
  COMMITTEE_SITE_ADAPTER,
  HOUSE_REPOSITORY_ADAPTER,
  SENATE_SCHEDULE_ADAPTER,
  canonicalHearingId,
  clockKey,
  contentHash,
  dayKey,
  displayChamber,
  inferVisibility,
  isoDay,
  matchKeys,
  observationIdentityCompatible,
  normalizeChamber,
  normalizeEventStatus,
  normalizeEventType,
  normalizedTitleKey,
  observationExternalId,
  stableStringify,
} from './hearing-identity.js';
import type { SourceEvent } from './hearing-discovery.types.js';

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

function event(overrides: Partial<SourceEvent> = {}): SourceEvent {
  return {
    externalEventId: '119504',
    congress: 119,
    chamber: 'house',
    committeeSystemCode: 'hsif00',
    calendarDate: day('2026-09-17'),
    startsAt: new Date('2026-09-17T14:00:00.000Z'), // 10:00 ET
    title: 'Oversight of the Nuclear Regulatory Commission',
    ...overrides,
  };
}

describe('canonicalHearingId', () => {
  it('mints the legacy cm-{congress}-{eventId} id for Congress.gov events', () => {
    expect(canonicalHearingId(event(), CONGRESS_GOV_ADAPTER)).toBe('cm-119-119504');
  });

  it('mints the SAME id for the House repository, so the two sources merge', () => {
    const fromApi = canonicalHearingId(event(), CONGRESS_GOV_ADAPTER);
    const fromClerk = canonicalHearingId(event(), HOUSE_REPOSITORY_ADAPTER);
    expect(fromClerk).toBe(fromApi);
  });

  it('keys a Senate event on the feed own stable <identifier>', () => {
    const senate = event({
      externalEventId: '338724',
      chamber: 'senate',
      committeeSystemCode: 'ssas00',
      startsAt: new Date('2026-09-17T13:30:00.000Z'), // 09:30 ET
    });
    const id = canonicalHearingId(senate, SENATE_SCHEDULE_ADAPTER);
    expect(id).toBe('sen-119-338724');
    // Same input, same id — the property that stops a re-run duplicating.
    expect(canonicalHearingId(senate, SENATE_SCHEDULE_ADAPTER)).toBe(id);
  });

  it('keeps a Senate id STABLE across a reschedule', () => {
    // REGRESSION GUARD. The id used to be derived from (day, ET clock), so moving
    // a hearing changed its id, the reconciler saw an unknown event, and it
    // forked a duplicate canonical row. Caught by the disposable-Postgres
    // verification (scripts/verify-legiwatch-phase3.ts, section H).
    const base = event({
      externalEventId: '338999',
      chamber: 'senate',
      committeeSystemCode: 'ssas00',
      calendarDate: day('2026-10-01'),
      startsAt: new Date('2026-10-01T14:00:00.000Z'),
    });
    const moved = event({
      ...base,
      calendarDate: day('2026-10-08'),
      startsAt: new Date('2026-10-08T14:00:00.000Z'),
    });
    expect(canonicalHearingId(moved, SENATE_SCHEDULE_ADAPTER)).toBe(
      canonicalHearingId(base, SENATE_SCHEDULE_ADAPTER),
    );
  });

  it('falls back to a (committee, day, ET clock) key when the Senate feed gives no identifier', () => {
    const noId = event({
      externalEventId: 'ssas00-2026-09-17',
      chamber: 'senate',
      committeeSystemCode: 'ssas00',
      startsAt: new Date('2026-09-17T13:30:00.000Z'),
    });
    expect(canonicalHearingId(noId, SENATE_SCHEDULE_ADAPTER)).toBe('sen-119-ssas00-20260917-0930');
  });

  it('keys the ET clock, not UTC, so an evening hearing is not filed a day late', () => {
    // 00:30Z on the 18th IS 8:30 PM ET on the 17th. Exercised through the
    // no-identifier fallback, which is the branch that embeds the clock.
    const evening = event({
      externalEventId: 'ssas00-evening',
      chamber: 'senate',
      committeeSystemCode: 'ssas00',
      calendarDate: day('2026-09-17'),
      startsAt: new Date('2026-09-18T00:30:00.000Z'),
    });
    expect(canonicalHearingId(evening, SENATE_SCHEDULE_ADAPTER)).toBe(
      'sen-119-ssas00-20260917-2030',
    );
  });

  it('distinguishes two same-hour committee-site events by title fingerprint', () => {
    const a = canonicalHearingId(event({ title: 'Markup of H.R. 1' }), COMMITTEE_SITE_ADAPTER);
    const b = canonicalHearingId(event({ title: 'Markup of H.R. 2' }), COMMITTEE_SITE_ADAPTER);
    expect(a).not.toBe(b);
  });

  it('marks a date-only record with the `d` clock rather than a fabricated midnight', () => {
    const dateOnly = event({
      externalEventId: 'ssas00-dateonly',
      chamber: 'senate',
      startsAt: null,
    });
    expect(canonicalHearingId(dateOnly, SENATE_SCHEDULE_ADAPTER)).toContain('-d');
  });
});

describe('observationExternalId', () => {
  it('uses the source own event id when there is one', () => {
    expect(observationExternalId(event(), CONGRESS_GOV_ADAPTER)).toBe('119504');
  });

  it('falls back to the canonical id so the ledger stays idempotent without one', () => {
    const anonymous = event({ externalEventId: '  ', chamber: 'senate' });
    expect(observationExternalId(anonymous, SENATE_SCHEDULE_ADAPTER)).toBe(
      canonicalHearingId(anonymous, SENATE_SCHEDULE_ADAPTER),
    );
  });
});

describe('matchKeys', () => {
  it('always offers the exact id first', () => {
    const keys = matchKeys(event(), CONGRESS_GOV_ADAPTER);
    expect(keys[0]).toEqual({ kind: 'id', id: 'cm-119-119504' });
  });

  it('offers a natural (committee + day + ET clock) rung so a Senate feed row can find the Congress.gov row', () => {
    const keys = matchKeys(
      event({ chamber: 'senate', committeeSystemCode: 'ssas00', externalEventId: '' }),
      SENATE_SCHEDULE_ADAPTER,
    );
    const natural = keys.find((k) => k.kind === 'natural');
    expect(natural?.predicate).toMatchObject({
      chamber: 'Senate',
      committeeSystemCode: 'ssas00',
      clock: '1000',
    });
  });

  it('omits the natural rung for a date-only observation', () => {
    const keys = matchKeys(event({ startsAt: null }), SENATE_SCHEDULE_ADAPTER);
    expect(keys.some((k) => k.kind === 'natural')).toBe(false);
  });

  it('omits the title rung for a title too short to be discriminating', () => {
    const keys = matchKeys(event({ title: 'Markup' }), COMMITTEE_SITE_ADAPTER);
    expect(keys.some((k) => k.kind === 'title')).toBe(false);
  });

  it('stops at the id rung when there is no calendar date to match structurally', () => {
    const keys = matchKeys(event({ calendarDate: null }), CONGRESS_GOV_ADAPTER);
    expect(keys).toHaveLength(1);
  });

  it('orders rungs from strongest to weakest evidence', () => {
    const keys = matchKeys(event({ externalEventId: '' }), CONGRESS_GOV_ADAPTER).map((k) => k.kind);
    expect(keys).toEqual(['id', 'natural', 'day', 'title']);
  });
  it('never falls back to committee/date similarity for an official event ID', () => {
    expect(
      matchKeys(event({ chamber: 'senate', externalEventId: '338783' }), SENATE_SCHEDULE_ADAPTER),
    ).toEqual([
      { kind: 'id', id: 'sen-119-338783' },
      { kind: 'id', id: 'cm-119-338783' },
    ]);
    expect(
      observationIdentityCompatible(
        event({ externalEventId: '338783' }),
        SENATE_SCHEDULE_ADAPTER,
        'sen-119-338784',
      ),
    ).toBe(false);
    expect(
      observationIdentityCompatible(
        event({ externalEventId: '338783' }),
        SENATE_SCHEDULE_ADAPTER,
        'cm-119-338783',
      ),
    ).toBe(true);
    expect(
      canonicalHearingId(
        event({ chamber: 'joint', externalEventId: '338796' }),
        SENATE_SCHEDULE_ADAPTER,
      ),
    ).toBe('cm-119-338796');
  });
});

describe('normalizedTitleKey', () => {
  it('strips the bracketed status prefix the legacy sync writes into titles', () => {
    expect(normalizedTitleKey('[Postponed] Oversight of the FAA')).toBe('oversight of the faa');
  });

  it('folds smart punctuation and collapses whitespace', () => {
    expect(normalizedTitleKey('The  Nation’s   Grid — Part II')).toBe('the nation s grid part ii');
  });

  it('folds a dotted initialism to its undotted form, so two sources agree on a bill reference', () => {
    expect(normalizedTitleKey('Markup of H.R. 1')).toBe(normalizedTitleKey('MARKUP OF HR 1'));
    expect(normalizedTitleKey('Markup of H.R. 1')).toBe('markup of hr 1');
  });

  it('leaves multi-letter words alone when rejoining initialisms', () => {
    expect(normalizedTitleKey('Oversight of the FAA - Part II')).toBe(
      'oversight of the faa part ii',
    );
  });
});

describe('contentHash / stableStringify', () => {
  it('hashes identically regardless of property order', () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });

  it('ignores undefined-valued properties so an optional field appearing does not look like a change', () => {
    expect(contentHash({ a: 1, b: undefined })).toBe(contentHash({ a: 1 }));
  });

  it('distinguishes genuinely different payloads', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('serializes Dates stably', () => {
    const d = new Date('2026-09-17T14:00:00.000Z');
    expect(stableStringify({ d })).toBe('{"d":"2026-09-17T14:00:00.000Z"}');
  });

  it('hashes nested arrays order-sensitively (witness order is meaningful)', () => {
    expect(contentHash({ w: ['a', 'b'] })).not.toBe(contentHash({ w: ['b', 'a'] }));
  });
});

describe('chamber conversion', () => {
  it('round-trips between the display case in committee_hearing and the lowercase registry form', () => {
    expect(displayChamber('senate')).toBe('Senate');
    expect(displayChamber('House')).toBe('House');
    expect(normalizeChamber('Senate')).toBe('senate');
    expect(normalizeChamber(null)).toBe('joint');
  });
});

describe('normalizeEventStatus', () => {
  it.each([
    ['Cancelled', 'canceled'],
    ['Canceled', 'canceled'],
    ['Postponed', 'postponed'],
    ['Rescheduled', 'postponed'],
    ['Scheduled', 'scheduled'],
    ['Open Hearing', 'scheduled'],
  ])('maps %s to %s', (raw, expected) => {
    expect(normalizeEventStatus(raw)).toBe(expected);
  });

  it('returns null for wording it does not recognise, so silence is distinguishable from "scheduled"', () => {
    // This matters: only an explicit 'scheduled' should be allowed to clear a
    // previously-observed cancellation.
    expect(normalizeEventStatus(null)).toBeNull();
    expect(normalizeEventStatus('')).toBeNull();
    expect(normalizeEventStatus('Closed Hearing')).toBeNull();
  });
});

describe('inferVisibility', () => {
  it('marks closed and executive sessions private', () => {
    expect(inferVisibility('Closed Briefing on Force Posture', 'Closed Hearing')).toBe('private');
    expect(inferVisibility('Business Meeting', 'Executive Session')).toBe('private');
  });

  it('defaults to public, which is what most committee business is', () => {
    expect(inferVisibility('Oversight of the FAA', 'Hearing')).toBe('public');
  });
});

describe('normalizeEventType', () => {
  it.each([
    ['Markup', 'markup'],
    ['Mark-up', 'markup'],
    ['Hearing', 'hearing'],
    ['Field Hearing', 'hearing'],
    ['Business Meeting', 'meeting'],
    ['', 'meeting'],
  ])('maps %s to %s', (raw, expected) => {
    expect(normalizeEventType(raw)).toBe(expected);
  });
});

describe('day and clock keys', () => {
  it('formats a UTC-midnight day', () => {
    expect(dayKey(day('2026-09-17'))).toBe('20260917');
    expect(isoDay(day('2026-09-17'))).toBe('2026-09-17');
  });

  it('renders the ET clock for a real instant and `d` for none', () => {
    expect(clockKey(new Date('2026-09-17T14:00:00.000Z'))).toBe('1000');
    expect(clockKey(null)).toBe('d');
  });

  it('treats Congress.gov 00:00Z (its "date known, time unknown" sentinel) as no clock', () => {
    expect(clockKey(new Date('2026-09-17T00:00:00.000Z'))).toBe('d');
  });
});

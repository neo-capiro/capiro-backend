import { describe, expect, it } from 'vitest';
import type { FeedItem } from '../../../../pages/clients/tracker/intel-feed-api.js';
import {
  feedHearingDetailHref,
  parseCongressEventHearingId,
  resolveFeedHearingId,
} from './feed-hearing-link.js';

function item(partial: Partial<FeedItem> & { sourceType: string; evidence?: FeedItem['evidence'] }): FeedItem {
  return {
    id: 'a1',
    clientId: 'c1',
    title: 'Some hearing title that must NEVER be used for resolution',
    sourceRef: 's1',
    severity: 'medium',
    status: 'new',
    score: 0.5,
    createdAt: '2026-09-01T00:00:00Z',
    ...partial,
    sourceType: partial.sourceType as FeedItem['sourceType'],
  } as FeedItem;
}

describe('parseCongressEventHearingId', () => {
  it('parses house and senate event URLs into cm-{congress}-{eventId}', () => {
    expect(
      parseCongressEventHearingId(
        'https://www.congress.gov/event/119th-congress/house-event/119533',
      ),
    ).toBe('cm-119-119533');
    expect(
      parseCongressEventHearingId(
        'https://www.congress.gov/event/119th-Congress/senate-event/338672?foo=1',
      ),
    ).toBe('cm-119-338672');
  });

  it('returns null for non-event URLs', () => {
    expect(parseCongressEventHearingId('https://www.congress.gov/bill/119th-congress/house-bill/1')).toBeNull();
    expect(parseCongressEventHearingId(null)).toBeNull();
  });
});

describe('resolveFeedHearingId — bounded, never title-fuzzy (§12)', () => {
  it('prefers evidence.hearing.hearingId', () => {
    expect(
      resolveFeedHearingId(
        item({
          sourceType: 'hearing',
          evidence: { hearing: { sessionId: 's1', hearingId: 'cm-119-119533', title: 'X', committeeId: null, occurredAt: null, mentions: [] } },
        }),
      ),
    ).toBe('cm-119-119533');
  });

  it('parses official congress.gov URL when hearingId is missing (legacy row)', () => {
    expect(
      resolveFeedHearingId(
        item({
          sourceType: 'hearing',
          evidence: {
            hearing: {
              sessionId: 's-legacy',
              hearingId: null,
              title: 'Industrial Base and Workforce Development for Skilled Trades',
              committeeId: null,
              occurredAt: null,
              mentions: [],
              officialPageUrl: 'https://www.congress.gov/event/119th-congress/house-event/119533',
            } as never,
            provenance: { sourceUrl: null, triggerKey: null, tone: null, band: null, jurisdiction: 'US', writerShape: 'nested' },
          },
        }),
      ),
    ).toBe('cm-119-119533');
  });

  it('falls back to provenance.sourceUrl', () => {
    expect(
      resolveFeedHearingId(
        item({
          sourceType: 'hearing',
          evidence: {
            hearing: { sessionId: 's2', hearingId: null, title: 'Anything', committeeId: null, occurredAt: null, mentions: [] },
            provenance: {
              sourceUrl: 'https://www.congress.gov/event/119th-congress/house-event/119528',
              triggerKey: null,
              tone: null,
              band: null,
              jurisdiction: 'US',
              writerShape: 'nested',
            },
          },
        }),
      ),
    ).toBe('cm-119-119528');
  });

  it('parses officialEventId + congress into the canonical cm- id when hearingId is missing', () => {
    expect(
      resolveFeedHearingId(
        item({
          sourceType: 'hearing',
          evidence: {
            hearing: {
              sessionId: 's4',
              hearingId: null,
              title: 'Anything',
              committeeId: null,
              occurredAt: null,
              mentions: [],
              officialEventId: '119533',
              congress: 119,
            } as never,
          },
        }),
      ),
    ).toBe('cm-119-119533');
  });

  it('prefers the explicit hearingId when a conflicting congress.gov URL is present (precedence, never ambiguous mix)', () => {
    expect(
      resolveFeedHearingId(
        item({
          sourceType: 'hearing',
          evidence: {
            hearing: {
              sessionId: 's5',
              hearingId: 'cm-119-119533',
              title: 'Conflicting anchors',
              committeeId: null,
              occurredAt: null,
              mentions: [],
              officialPageUrl: 'https://www.congress.gov/event/119th-congress/house-event/999999',
            } as never,
          },
        }),
      ),
    ).toBe('cm-119-119533');
  });

  it('returns null for malformed or non-congress-gov URLs (host-pinned, never guessed)', () => {
    for (const bad of [
      'https://www.congress.gov/event/119th-congress/house-event/', // truncated
      'https://www.congress.gov/event/119th-congress/house-bill/119533', // wrong segment
      'https://congress.gov.evil.example/event/119th-congress/house-event/119533', // host mismatch
      'not a url at all',
    ]) {
      expect(
        resolveFeedHearingId(
          item({
            sourceType: 'hearing',
            evidence: {
              hearing: { sessionId: 's6', hearingId: null, title: 'X', committeeId: null, occurredAt: null, mentions: [], officialPageUrl: bad } as never,
            },
          }),
        ),
      ).toBeNull();
    }
  });

  it('returns null when only a title is present — never fuzzy-match', () => {
    expect(
      resolveFeedHearingId(
        item({
          sourceType: 'hearing',
          evidence: {
            hearing: {
              sessionId: 's3',
              hearingId: null,
              title: 'Industrial Base and Workforce Development for Skilled Trades',
              committeeId: null,
              occurredAt: null,
              mentions: [],
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it('returns null for sessionId-only legacy rows (backend must resolve, web stays honest)', () => {
    expect(
      resolveFeedHearingId(
        item({
          sourceType: 'hearing',
          evidence: {
            hearing: { sessionId: 'sess-only', hearingId: null, title: null, committeeId: null, occurredAt: null, mentions: [] },
          },
        }),
      ),
    ).toBeNull();
  });

  it('ignores non-hearing source types', () => {
    expect(
      resolveFeedHearingId(
        item({
          sourceType: 'bill',
          evidence: { hearing: { sessionId: 's', hearingId: 'cm-119-1', title: null, committeeId: null, occurredAt: null, mentions: [] } },
        }),
      ),
    ).toBeNull();
  });

  it('builds the detail href', () => {
    expect(
      feedHearingDetailHref(
        item({
          sourceType: 'hearing',
          evidence: { hearing: { sessionId: 's', hearingId: 'cm-119-119533', title: null, committeeId: null, occurredAt: null, mentions: [] } },
        }),
      ),
    ).toBe('/legiwatch/hearings/cm-119-119533');
  });
});

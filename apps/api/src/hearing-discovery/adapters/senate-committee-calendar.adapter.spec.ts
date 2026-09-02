import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SenateCommitteeCalendarAdapter,
  normalizePageStatus,
  parsePageDatetime,
  parseSenateCommitteePage,
} from './senate-committee-calendar.adapter.js';
import type { SourceDescriptor } from '../hearing-discovery.types.js';

/**
 * Fixtures are the REAL official pages fetched 2026-09-01 (budget.senate.gov and
 * judiciary.senate.gov hearings indexes), reduced to the structural subset the
 * parser reads. They are committed so the parser's contract is pinned to the
 * published markup, not to a synthetic guess of it.
 */
function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

function source(overrides: Partial<SourceDescriptor> = {}): SourceDescriptor {
  return {
    id: 'src-test-1',
    adapterKey: 'senate-committee-calendar',
    sourceType: 'COMMITTEE_SITE',
    sourceUrl: 'https://www.example.gov/hearings',
    committeeSystemCode: 'ssju00',
    chamber: 'senate',
    priority: 60,
    enabled: true,
    parserVersion: null,
    ...overrides,
  } as SourceDescriptor;
}

const ctx = { since: null, daysAhead: 0, delayMs: 0, log: () => {} };

describe('parseSenateCommitteePage (Judiciary LegislationList shape)', () => {
  const html = fixture('judiciary-hearings.sample.html');

  it('extracts events with UTC datetimes, slugs, and official URLs', () => {
    const rows = parseSenateCommitteePage(html, 'https://www.judiciary.senate.gov/hearings');
    const sunshine = rows.find((r) => r.slug === 'prescribing-sunshine-how-competition-and-transparency-lowers-prescription-drug-costs');
    expect(sunshine).toBeDefined();
    expect(sunshine?.title).toBe('Prescribing Sunshine: How Competition & Transparency Lowers Prescription Drug Costs');
    expect(sunshine?.datetimeRaw).toBe('2026-08-04T14:15:00Z');
    expect(sunshine?.startsAt.toISOString()).toBe('2026-08-04T14:15:00.000Z');
    expect(sunshine?.officialPageUrl).toBe(
      'https://www.judiciary.senate.gov/committee-activity/hearings/prescribing-sunshine-how-competition-and-transparency-lowers-prescription-drug-costs',
    );
    expect(sunshine?.calendarDate.toISOString().slice(0, 10)).toBe('2026-08-04');
  });

  it('preserves the POSTPONED status prefix instead of normalizing it away', () => {
    const rows = parseSenateCommitteePage(html, 'https://www.judiciary.senate.gov/hearings');
    const meeting = rows.find((r) => r.slug === 'executive-business-meeting-07-30-2026');
    expect(meeting).toBeDefined();
    expect(meeting?.statusPrefix?.toLowerCase()).toContain('postponed');
    expect(meeting?.title.toLowerCase()).not.toContain('postponed');
  });

  it('dedupes repeated entries by slug', () => {
    const rows = parseSenateCommitteePage(html, 'https://www.judiciary.senate.gov/hearings');
    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('ignores non-event anchors (nav, scripts) — only time-anchored entries count', () => {
    const rows = parseSenateCommitteePage(html, 'https://www.judiciary.senate.gov/hearings');
    for (const row of rows) {
      expect(row.officialPageUrl).toMatch(/judiciary\.senate\.gov\/committee-activity\/(hearings|business-meetings)\//);
    }
  });
});

describe('parseSenateCommitteePage (Budget hCalendar vevent shape)', () => {
  const html = fixture('budget-hearings.sample.html');

  it('interprets naive datetimes as Eastern wall clock', () => {
    const rows = parseSenateCommitteePage(html, 'https://www.budget.senate.gov/hearings');
    const rescheduled = rows.find((r) => r.slug.endsWith('deputy-director-omb_07-22'));
    expect(rescheduled).toBeDefined();
    // 2026-07-22T10:00 ET == 14:00Z (EDT, UTC-4)
    expect(rescheduled?.startsAt.toISOString()).toBe('2026-07-22T14:00:00.000Z');
    expect(rescheduled?.calendarDate.toISOString().slice(0, 10)).toBe('2026-07-22');
  });

  it('splits the inline CANCELLED prefix from the title', () => {
    const rows = parseSenateCommitteePage(html, 'https://www.budget.senate.gov/hearings');
    const cancelled = rows.find((r) => r.slug === 'business-meeting-to-consider-mr-hal-duncan-to-be-deputy-director-omb');
    expect(cancelled).toBeDefined();
    expect(cancelled?.statusPrefix?.toLowerCase()).toBe('cancelled:');
    expect(cancelled?.title).toBe('Business Meeting to Consider Mr. Hal Duncan to be Deputy Director OMB');
  });
});

describe('status semantics', () => {
  it('maps published prefixes honestly', () => {
    expect(normalizePageStatus('CANCELLED:')).toBe('canceled');
    expect(normalizePageStatus('CANCELED:')).toBe('canceled');
    expect(normalizePageStatus('POSTPONED:')).toBe('postponed');
    expect(normalizePageStatus('TIME CHANGE:')).toBe('postponed');
    expect(normalizePageStatus(null)).toBeNull();
  });

  it('parses Z datetimes as instants and naive ones as Eastern wall clock', () => {
    expect(parsePageDatetime('2026-08-04T18:30:00Z')?.toISOString()).toBe('2026-08-04T18:30:00.000Z');
    // 09:30 ET (EDT) == 13:30Z
    expect(parsePageDatetime('2026-09-17T09:30')?.toISOString()).toBe('2026-09-17T13:30:00.000Z');
    expect(parsePageDatetime('garbage')).toBeNull();
  });
});

describe('SenateCommitteeCalendarAdapter.discoverEvents', () => {
  it('emits SourceEvents with committee code from the source row and slug as external id', async () => {
    const adapter = new SenateCommitteeCalendarAdapter({ congress: 119 });
    const events = await adapter.discoverEvents(
      source({ sourceUrl: 'https://www.judiciary.senate.gov/hearings' }),
      ctx,
    );
    const sunshine = events.find((e) => e.externalEventId === 'prescribing-sunshine-how-competition-and-transparency-lowers-prescription-drug-costs');
    expect(sunshine).toBeDefined();
    expect(sunshine?.committeeSystemCode).toBe('ssju00');
    expect(sunshine?.chamber).toBe('senate');
    expect(sunshine?.eventStatus).toBe('postponed');
    expect(sunshine?.visibility).toBe('public');
  });

  it('throws on fetch failure so source health records it', async () => {
    const adapter = new SenateCommitteeCalendarAdapter({ congress: 119 });
    await expect(
      adapter.discoverEvents(
        source({ sourceUrl: 'https://invalid.example.gov/hearings', id: 'bad' } as SourceDescriptor),
        ctx,
      ),
    ).rejects.toThrow(/fetch failed|fetch failed/i);
  });
});

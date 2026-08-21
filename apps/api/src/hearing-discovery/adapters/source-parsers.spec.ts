/**
 * Regression guard for the parsers Phase 3 MOVED out of
 * `apps/api/scripts/sync-hearings.ts` into this shared discovery core.
 *
 * That extraction touched a job that runs daily in production, and those
 * functions had no direct test coverage before. These tests pin the behaviours
 * the original code documented, so the move is provably behaviour-preserving and
 * a future edit cannot quietly change what the live sync ingests:
 *
 *   - the api_key-bearing URL must NEVER be stored (it renders API_KEY_MISSING
 *     in a browser);
 *   - relatedItems.bills tolerates the nested `{ bill: [...] }` envelope;
 *   - the docs.house.gov ByDay row shape, whose EventID is what makes the House
 *     Clerk feed merge with Congress.gov instead of duplicating.
 */
import {
  advertisedVideoCandidates,
  formatLocation,
  formatWitnesses,
  meetingPublicUrl,
  relatedAgendaBills,
} from './congress-gov-parse.js';
import { byDayUrl, houseDayId, inferHouseType, parseByDay } from './house-docs-parse.js';
import { cleanText, decodeEntities } from './source-http.js';

describe('relatedAgendaBills', () => {
  it('builds canonical congress_bill ids from the inline array', () => {
    expect(
      relatedAgendaBills({
        relatedItems: { bills: [{ type: 'HR', number: 8800, congress: 119 }] },
      }),
    ).toEqual([{ billId: '119-hr-8800', congress: 119 }]);
  });

  it('strips dots and spaces from the bill type', () => {
    expect(
      relatedAgendaBills({
        relatedItems: { bills: [{ type: 'H.R.', number: '1', congress: 119 }] },
      }),
    ).toEqual([{ billId: '119-hr-1', congress: 119 }]);
  });

  it('tolerates the nested { bill: [...] } envelope Congress.gov sometimes uses', () => {
    expect(
      relatedAgendaBills({
        relatedItems: { bills: { bill: [{ type: 'S', number: 42, congress: 119 }] } },
      }),
    ).toEqual([{ billId: '119-s-42', congress: 119 }]);
  });

  it('skips rows missing any of congress/type/number rather than minting a partial id', () => {
    expect(
      relatedAgendaBills({
        relatedItems: {
          bills: [
            { type: 'HR', number: 1 },
            { type: '', number: 2, congress: 119 },
            { type: 'HR', number: '', congress: 119 },
          ],
        },
      }),
    ).toEqual([]);
  });

  it('de-duplicates repeated references', () => {
    expect(
      relatedAgendaBills({
        relatedItems: {
          bills: [
            { type: 'HR', number: 1, congress: 119 },
            { type: 'hr', number: '1', congress: 119 },
          ],
        },
      }),
    ).toHaveLength(1);
  });

  it('returns an empty list when relatedItems is absent', () => {
    expect(relatedAgendaBills({})).toEqual([]);
  });
});

describe('formatLocation', () => {
  it('joins building and room in the shape the UI expects', () => {
    expect(formatLocation({ building: 'Rayburn HOB', room: '2123' })).toBe(
      'Rayburn HOB, Room 2123',
    );
  });

  it('handles a partial location', () => {
    expect(formatLocation({ building: 'Rayburn HOB', room: null })).toBe('Rayburn HOB');
    expect(formatLocation({ building: null, room: '2123' })).toBe('Room 2123');
  });

  it('returns null for nothing, not an empty string', () => {
    expect(formatLocation(null)).toBeNull();
    expect(formatLocation({})).toBeNull();
  });
});

describe('meetingPublicUrl', () => {
  it('prefers a congress.gov/event link the API already gave us', () => {
    expect(
      meetingPublicUrl(
        { videos: [{ url: 'https://www.congress.gov/event/119th-Congress/house-event/999' }] },
        119,
        'House',
        '999',
      ),
    ).toBe('https://www.congress.gov/event/119th-Congress/house-event/999');
  });

  it('constructs the canonical public URL when the API gave none', () => {
    expect(meetingPublicUrl({ videos: [] }, 119, 'Senate', '338724')).toBe(
      'https://www.congress.gov/event/119th-Congress/senate-event/338724',
    );
  });

  it('never returns an api.congress.gov URL, which needs an api_key to render', () => {
    const url = meetingPublicUrl(
      { videos: [{ url: 'https://api.congress.gov/v3/committee-meeting/119/house/999' }] },
      119,
      'House',
      '999',
    );
    expect(url).not.toContain('api.congress.gov');
    expect(url).toBe('https://www.congress.gov/event/119th-Congress/house-event/999');
  });

  it('returns null for a chamber with no public event-page form', () => {
    expect(meetingPublicUrl({ videos: [] }, 119, 'Joint', '1')).toBeNull();
  });
});

describe('formatWitnesses', () => {
  it('renders "Name, Position, Organization"', () => {
    expect(formatWitnesses([{ name: 'Jane Doe', position: 'Chair', organization: 'NRC' }])).toEqual(
      ['Jane Doe, Chair, NRC'],
    );
  });

  it('omits absent parts without leaving stray commas', () => {
    expect(formatWitnesses([{ name: 'Jane Doe', position: null, organization: 'NRC' }])).toEqual([
      'Jane Doe, NRC',
    ]);
  });

  it('drops entirely empty entries', () => {
    expect(formatWitnesses([{ name: null }, { name: '  ' }])).toEqual([]);
  });

  it('handles a null witnesses array', () => {
    expect(formatWitnesses(null)).toEqual([]);
  });
});

describe('advertisedVideoCandidates', () => {
  it('classifies a congress.gov/event link as the official PAGE, not media', () => {
    const out = advertisedVideoCandidates(
      { videos: [{ url: 'https://www.congress.gov/event/119th-Congress/house-event/999' }] },
      null,
    );
    expect(out).toEqual([
      {
        provider: 'congress-gov',
        officialPageUrl: 'https://www.congress.gov/event/119th-Congress/house-event/999',
        mediaUrl: null,
      },
    ]);
  });

  it('classifies anything else as a media candidate hung off the official page', () => {
    const out = advertisedVideoCandidates(
      { videos: [{ url: 'https://houselive.example/stream.m3u8' }] },
      'https://www.congress.gov/event/119th-Congress/house-event/999',
    );
    expect(out[0]).toMatchObject({
      mediaUrl: 'https://houselive.example/stream.m3u8',
      officialPageUrl: 'https://www.congress.gov/event/119th-Congress/house-event/999',
    });
  });

  it('ignores empty video entries', () => {
    expect(advertisedVideoCandidates({ videos: [{ url: '  ' }, {}] }, null)).toEqual([]);
  });
});

describe('docs.house.gov ByDay parsing', () => {
  // Shaped exactly like the GridView markup the ByDay page emits.
  const ROW = `
    <tr>
      <td>
        <a href="ByEvent.aspx?EventID=119504" title="Oversight of the FAA">Oversight of the FAA</a>
        <span class="text-tiny" title="Committee on Transportation and Infrastructure">T&amp;I</span>
      </td>
      <td>10:00 AM</td>
      <td>2167 Rayburn</td>
    </tr>`;

  it('extracts EventID, committee, title, time and location', () => {
    const rows = parseByDay(ROW);
    expect(rows).toEqual([
      {
        eventId: '119504',
        committee: 'Committee on Transportation and Infrastructure',
        title: 'Oversight of the FAA',
        time: '10:00 AM',
        location: '2167 Rayburn',
      },
    ]);
  });

  it('is re-runnable — the module-level regex lastIndex does not leak between calls', () => {
    // The original carried an explicit `BYDAY_ROW.lastIndex = 0` for this reason;
    // losing it would make every second parse return nothing.
    expect(parseByDay(ROW)).toHaveLength(1);
    expect(parseByDay(ROW)).toHaveLength(1);
  });

  it('returns nothing for markup with no rows, rather than throwing', () => {
    expect(parseByDay('<html><body>No meetings.</body></html>')).toEqual([]);
  });

  it('builds the ByDay URL with the MMDDYYYY DayID the page expects', () => {
    const day = new Date(Date.UTC(2026, 8, 17));
    expect(houseDayId(day)).toBe('09172026');
    expect(byDayUrl(day)).toBe(
      'https://docs.house.gov/Committee/Calendar/ByDay.aspx?DayID=09172026',
    );
  });
});

describe('inferHouseType', () => {
  it.each([
    ['Markup of H.R. 1', '', 'markup'],
    ['Marking up several bills', '', 'markup'],
    ['Business Meeting', '', 'meeting'],
    ['Oversight of the FAA', '', 'hearing'],
  ])('classifies %s as %s', (title, committee, expected) => {
    expect(inferHouseType(title, committee)).toBe(expected);
  });
});

describe('cleanText / decodeEntities', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeEntities('A&amp;B &#39;q&#39; &#x2014;')).toBe("A&B 'q' —");
  });

  it('strips tags, folds typography to ASCII and collapses whitespace', () => {
    expect(cleanText('<b>The  Nation&rsquo;s</b>\n  Grid &mdash; Part II')).toBe(
      "The Nation's Grid - Part II",
    );
  });

  it('leaves an unknown entity intact rather than mangling it', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;');
  });
});

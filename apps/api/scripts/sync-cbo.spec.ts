/**
 * sync-cbo RSS item parsing (Bucket-#3 C4.F2, SC2.4). Fixtures are
 * verbatim-shaped items from the live feed (2026-07-06).
 */
import { parseCboRssItem, congressForDate } from './sync-cbo';

const COST_ESTIMATE_ITEM = `
  <title>H.R. 5999, Veteran Opioid Emergency Treatment Act</title>
  <link>https://www.cbo.gov/publication/62521</link>
  <description>As ordered reported by the House Committee on Veterans’ Affairs on May 14, 2026</description>
  <pubDate>Thu, 02 Jul 2026 14:44:00 -0400</pubDate>
    <dc:creator>webmaster@cbo.gov (Webmaster)</dc:creator>
    <guid isPermaLink="true">https://www.cbo.gov/publication/62521</guid>
    </item>`;

const SENATE_ITEM = `
  <title>S. 663, Federal Grant Accountability Act</title>
  <link>https://www.cbo.gov/publication/62480</link>
  <description>As ordered reported by the Senate Committee on Homeland Security and Governmental Affairs</description>
  <pubDate>Mon, 29 Jun 2026 10:00:00 -0400</pubDate>
    </item>`;

const NON_ESTIMATE_ITEM = `
  <title>The Budget and Economic Outlook: 2026 to 2036</title>
  <link>https://www.cbo.gov/publication/62400</link>
  <description>CBO's annual outlook report</description>
  <pubDate>Wed, 24 Jun 2026 09:00:00 -0400</pubDate>
    </item>`;

describe('parseCboRssItem', () => {
  it('parses a House cost estimate into a bill-linked row', () => {
    const est = parseCboRssItem(COST_ESTIMATE_ITEM);
    expect(est).not.toBeNull();
    expect(est).toMatchObject({
      publicationId: '62521',
      billId: '119-hr-5999',
      congress: 119,
      billType: 'hr',
      billNumber: '5999',
      cboUrl: 'https://www.cbo.gov/publication/62521',
    });
    expect(est!.title).toBe('H.R. 5999, Veteran Opioid Emergency Treatment Act');
    expect(est!.pubDate.toISOString()).toBe('2026-07-02T18:44:00.000Z');
  });

  it('parses a Senate designation', () => {
    const est = parseCboRssItem(SENATE_ITEM);
    expect(est?.billId).toBe('119-s-663');
    expect(est?.billType).toBe('s');
  });

  it('skips non-bill publications (outlooks, reports)', () => {
    expect(parseCboRssItem(NON_ESTIMATE_ITEM)).toBeNull();
  });

  it('skips items with no publication id or an invalid date', () => {
    expect(
      parseCboRssItem(
        '<title>H.R. 1, X</title><link>https://www.cbo.gov/topics</link><pubDate>Thu, 02 Jul 2026 14:44:00 -0400</pubDate>',
      ),
    ).toBeNull();
    expect(
      parseCboRssItem(
        '<title>H.R. 1, X</title><link>https://www.cbo.gov/publication/1</link><pubDate>not a date</pubDate>',
      ),
    ).toBeNull();
  });
});

describe('congressForDate', () => {
  it.each([
    ['2025-03-01', 119],
    ['2026-07-06', 119],
    ['2027-02-01', 120],
    ['2024-11-01', 118],
  ])('%s -> %ith congress', (iso, expected) => {
    expect(congressForDate(new Date(iso))).toBe(expected);
  });
});

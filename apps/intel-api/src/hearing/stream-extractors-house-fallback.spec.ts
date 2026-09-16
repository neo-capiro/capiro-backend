/**
 * Bounded first-party House fallback extractors (event119529 regression).
 *
 * The old resolver dead-ends a Congress.gov House event with no videos[] entry
 * ("No video links"). But the official record DOES have video: the House
 * repository (docs.house.gov) event page links the owning committee, and the
 * committee's own event page embeds the player. These pure functions implement
 * the BOUNDED chain — every hop is keyed on the EXACT Congress event id, never
 * a title match:
 *
 *   Congress event id → docs.house.gov event page → committee source linked
 *   there → that committee's hearing/event links → accept ONLY the event page
 *   whose outgoing official repository/Congress event id EXACTLY matches.
 *
 * No hardcoded 119529; the id is always the input. No title-only acceptance.
 */
import {
  extractDocsHouseEventLinks,
  extractHouseCommitteeEventLinks,
  houseDocsEventUrl,
  houseEventIdMatches,
} from './stream-extractors.js';

const EVENT_ID = '119529';

describe('houseDocsEventUrl', () => {
  it('builds the docs.house.gov event page url for a congress event id', () => {
    expect(houseDocsEventUrl(EVENT_ID)).toBe(
      'https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529',
    );
  });
});

describe('extractDocsHouseEventLinks', () => {
  it('pulls the committee event-page link from a docs.house.gov event page', () => {
    const html = `
      <html><body>
        <a href="https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=419048">
          Natural Resources Committee Hearing
        </a>
        <a href="https://www.congress.gov/event/119th-congress/house-event/119529">Congress.gov</a>
      </body></html>`;
    const links = extractDocsHouseEventLinks(html);
    expect(links).toContain(
      'https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=419048',
    );
  });

  it('honors the ACTUAL "Visit Committee Site" anchor FIRST — bare-origin http homepage', () => {
    // Verbatim-reduced from the live docs event page (event 119529): the old
    // regex required a character AFTER the final slash and missed this link,
    // returning only https://www.house.gov/accessibility.
    const html = `
      <div class="button-row">
        <a id="MainContent_LinkButtonDownloadMtgXML" class="btn" href="javascript:__doPostBack(&#39;ctl00$MainContent$LinkButtonDownloadMtgXML&#39;,&#39;&#39;)">Download Meeting XML (.xml)</a>&nbsp;&nbsp;
        <a id="MainContent_HyperLinKCommittee" class="btn" href="http://naturalresources.house.gov/" target="_blank">Visit Committee Site</a>
      </div>
      <div class="footer-text">
        <a href="http://clerk.house.gov/" title="Office of the Clerk">Office of the Clerk</a>
        <a href="https://www.house.gov/accessibility" target="_blank">Accessibility</a>
      </div>`;
    const links = extractDocsHouseEventLinks(html);
    // http on an official host normalizes to https; exact host + path identity.
    expect(links[0]).toBe('https://naturalresources.house.gov/');
    expect(links).toHaveLength(1);
    expect(links).not.toContain('https://www.house.gov/accessibility');
  });

  it('honors a Rules Committee "Visit Committee Site" anchor (Rules is a real owner)', () => {
    const html = `
      <div class="button-row">
        <a id="MainContent_HyperLinKCommittee" class="btn" href="http://rules.house.gov/" target="_blank">Visit Committee Site</a>
      </div>
      <ul class="nav">
        <li><a href="http://rules.house.gov/" title="Committee on Rules" target="_blank">Rules</a></li>
        <li><a href="http://clerk.house.gov/" title="Office of the Clerk" target="_blank">Clerk</a></li>
      </ul>`;
    const links = extractDocsHouseEventLinks(html);
    // The authoritative owner anchor wins; the generic Rules/Clerk NAV is
    // suppressed, so the single validated Rules homepage is returned once.
    expect(links).toEqual(['https://rules.house.gov/']);
  });

  it('suppresses generic Rules/Clerk/www.house.gov nav when there is no owner anchor', () => {
    const html = `
      <ul class="nav">
        <li><a href="http://rules.house.gov/" title="Committee on Rules" target="_blank">Rules</a></li>
        <li><a href="http://clerk.house.gov/" title="Office of the Clerk" target="_blank">Clerk</a></li>
        <li><a href="http://house.gov/" title="U.S. House of Representatives" target="_blank">House</a></li>
      </ul>`;
    expect(extractDocsHouseEventLinks(html)).toEqual([]);
  });

  it('decodes HTML entities in hrefs, preserving exact query identity', () => {
    const html = `
      <a href="https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=419048&amp;foo=bar">event</a>`;
    expect(extractDocsHouseEventLinks(html)).toEqual([
      'https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=419048&foo=bar',
    ]);
  });

  it('ignores non-committee links, docs self-links/PDFs, and javascript: hrefs', () => {
    const html = `
      <a href="javascript:void(0)">print</a>
      <a href="https://www.google.com/calendar/event">Add to calendar</a>
      <a href="/Committee/Calendar/ByEvent.aspx?EventID=119529">self</a>
      <a href="http://docs.house.gov/meetings/II/II13/20260916/119529/HHRG-119-II13-Wstate-MikoD-20260916.pdf">PDF</a>
      <a href="http://docs.house.gov/floor/">floor</a>`;
    expect(extractDocsHouseEventLinks(html)).toEqual([]);
  });

  it('rejects spoofed hosts, credentials, and non-http(s) schemes', () => {
    const html = `
      <a href="https://fake-naturalresources.house.gov.evil.example/calendar/eventsingle.aspx?EventID=419048">spoof</a>
      <a href="https://user:pass@naturalresources.house.gov/calendar/eventsingle.aspx?EventID=419048">creds</a>
      <a href="ftp://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=419048">ftp</a>`;
    expect(extractDocsHouseEventLinks(html)).toEqual([]);
  });
});

describe('extractHouseCommitteeEventLinks', () => {
  it('pulls candidate hearing/event page links from a committee site page', () => {
    const html = `
      <a href="/calendar/eventsingle.aspx?EventID=419048">Oversight Hearing</a>
      <a href="/calendar/eventsingle.aspx?EventID=419049">Another Hearing</a>
      <a href="https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=419048">dup</a>`;
    const links = extractHouseCommitteeEventLinks(
      html,
      'https://naturalresources.house.gov',
    );
    expect(links).toContain(
      'https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=419048',
    );
    expect(links).toContain(
      'https://naturalresources.house.gov/calendar/eventsingle.aspx?EventID=419049',
    );
  });
});

describe('houseEventIdMatches', () => {
  it('accepts a committee event page that links back to the EXACT Congress event id', () => {
    const html = `
      <html><body>
        <iframe src="https://www.youtube.com/embed/a-NiTQf_8Zs"></iframe>
        <a href="https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529">House Repository</a>
        <a href="https://www.congress.gov/event/119th-congress/house-event/119529">Congress.gov</a>
      </body></html>`;
    expect(houseEventIdMatches(html, EVENT_ID)).toBe(true);
  });

  it('supports an entity-encoded ampersand, query order, and key casing', () => {
    const encoded = `
      <a href="https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529&amp;foo=bar">x</a>`;
    expect(houseEventIdMatches(encoded, EVENT_ID)).toBe(true);
    const reordered = `
      <a href="https://docs.house.gov/Committee/Calendar/ByEvent.aspx?foo=bar&EventID=119529">x</a>`;
    expect(houseEventIdMatches(reordered, EVENT_ID)).toBe(true);
    const lowerKey = `
      <a href="https://docs.house.gov/Committee/Calendar/ByEvent.aspx?eventid=119529">x</a>`;
    expect(houseEventIdMatches(lowerKey, EVENT_ID)).toBe(true);
    const singleQuoted = `
      <a href='https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529'>x</a>`;
    expect(houseEventIdMatches(singleQuoted, EVENT_ID)).toBe(true);
  });

  it('rejects a page that only mentions a DIFFERENT event id (no title-only match)', () => {
    const html = `
      <a href="https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=999999">other</a>`;
    expect(houseEventIdMatches(html, EVENT_ID)).toBe(false);
  });

  it('rejects a page with no official event-id link at all', () => {
    const html = `<html><body><h1>Oversight of the Department</h1></body></html>`;
    expect(houseEventIdMatches(html, EVENT_ID)).toBe(false);
  });

  it('rejects a spoofed docs host (fake-docs.house.gov)', () => {
    const html = `
      <a href="https://fake-docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529">x</a>`;
    expect(houseEventIdMatches(html, EVENT_ID)).toBe(false);
  });

  it('rejects a suffix-attack host (docs.house.gov.evil.example)', () => {
    const html = `
      <a href="https://docs.house.gov.evil.example/Committee/Calendar/ByEvent.aspx?EventID=119529">x</a>`;
    expect(houseEventIdMatches(html, EVENT_ID)).toBe(false);
  });

  it('rejects a wrong docs path even with the exact EventID', () => {
    const html = `
      <a href="https://docs.house.gov/Committee/Calendar/ByDay.aspx?EventID=119529">x</a>`;
    expect(houseEventIdMatches(html, EVENT_ID)).toBe(false);
  });

  it('rejects a non-numeric or extended id (119529x, 1195290)', () => {
    expect(
      houseEventIdMatches(
        '<a href="https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529x">x</a>',
        EVENT_ID,
      ),
    ).toBe(false);
    expect(
      houseEventIdMatches(
        '<a href="https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=1195290">x</a>',
        EVENT_ID,
      ),
    ).toBe(false);
  });

  it('rejects plain text mentions of the id (no raw substring matching)', () => {
    const html = `<p>See docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529 for details</p>`;
    expect(houseEventIdMatches(html, EVENT_ID)).toBe(false);
    expect(houseEventIdMatches('<p>house-event/119529</p>', EVENT_ID)).toBe(false);
  });

  it('rejects credentials-bearing and non-http(s) hrefs', () => {
    expect(
      houseEventIdMatches(
        '<a href="https://user:pass@docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529">x</a>',
        EVENT_ID,
      ),
    ).toBe(false);
    expect(
      houseEventIdMatches(
        '<a href="ftp://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529">x</a>',
        EVENT_ID,
      ),
    ).toBe(false);
  });

  it('accepts a congress.gov house-event path with the exact id; rejects a different one', () => {
    expect(
      houseEventIdMatches(
        '<a href="https://www.congress.gov/event/119th-congress/house-event/119529">x</a>',
        EVENT_ID,
      ),
    ).toBe(true);
    expect(
      houseEventIdMatches(
        '<a href="https://www.congress.gov/event/119th-congress/house-event/1195290">x</a>',
        EVENT_ID,
      ),
    ).toBe(false);
    expect(
      houseEventIdMatches(
        '<a href="https://www.congress.gov/event/119th-congress/senate-event/119529">x</a>',
        EVENT_ID,
      ),
    ).toBe(false);
  });

  it('rejects a non-numeric eventId input', () => {
    expect(
      houseEventIdMatches(
        '<a href="https://docs.house.gov/Committee/Calendar/ByEvent.aspx?EventID=119529">x</a>',
        'abc',
      ),
    ).toBe(false);
  });
});

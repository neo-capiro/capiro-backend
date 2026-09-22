import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  OfficialArchiveReplayLink,
  OfficialHearingLinks,
} from './OfficialHearingLinks.js';

function hrefCount(html: string): number {
  return (html.match(/href=/g) ?? []).length;
}

describe('OfficialHearingLinks', () => {
  it.each([
    'https://localhost/watch',
    'https://127.0.0.1/watch',
    'http://www.flsenate.gov/watch',
    'https://www.flsenate.gov:8443/watch',
    'https://www.flsenate.gov/live/master.m3u8',
    'https://www.flsenate.gov/watch?auth=secret',
    'https://www.flsenate.gov/watch?auth_token=secret',
    'https://www.flsenate.gov/watch?access_token=secret',
    'https://www.flsenate.gov/watch?jwt=secret',
    'https://www.flsenate.gov/watch?hdnea=secret',
    'https://www.flsenate.gov/watch?hdnts=secret',
  ])('never renders unsafe source %s', (url) => {
    const html = renderToStaticMarkup(
      <dl>
        <OfficialHearingLinks
          officialPageUrl={url}
          officialPlaybackUrl={url}
          officialPlaybackKind="official_player_page"
          eventStatus="completed"
        />
      </dl>,
    );
    expect(html).not.toContain('href=');
    expect(html).not.toContain('secret');
  });

  it('canonicalizes equivalent URLs and renders only one external link', () => {
    const html = renderToStaticMarkup(
      <dl>
        <OfficialHearingLinks
          officialPageUrl="HTTPS://WWW.FLSENATE.GOV:443/Media/VideoPlayer/1/#source"
          officialPlaybackUrl="https://www.flsenate.gov/Media/VideoPlayer/1"
          officialPlaybackKind="official_player_page"
          eventStatus="completed"
        />
      </dl>,
    );
    expect(hrefCount(html)).toBe(1);
    expect(html).toContain('Replay on official site');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it('renders distinct safe player and notice pages as external links only', () => {
    const html = renderToStaticMarkup(
      <dl>
        <OfficialHearingLinks
          officialPageUrl="https://www.flsenate.gov/Committees/Show/AP/MeetingNotice/7001"
          officialPlaybackUrl="https://www.flsenate.gov/Media/VideoPlayer/6382"
          officialPlaybackKind="official_player_page"
          eventStatus="scheduled"
        />
      </dl>,
    );
    expect(hrefCount(html)).toBe(2);
    expect(html).toContain('Watch on official site');
    expect(html).toContain('Official event page');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<video');
  });

  it('renders archive replay only for a safe official player page', () => {
    const safe = renderToStaticMarkup(
      <OfficialArchiveReplayLink
        url="https://thefloridachannel.org/videos/example-event/"
        kind="official_player_page"
      />,
    );
    const unsafe = renderToStaticMarkup(
      <OfficialArchiveReplayLink
        url="https://thefloridachannel.org/videos/feed/"
        kind="official_player_page"
      />,
    );
    expect(safe).toContain('Replay on official site');
    expect(unsafe).not.toContain('href=');
  });
});

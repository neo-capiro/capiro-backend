import { describe, expect, it } from 'vitest';
import { safeOfficialEmbedUrl } from './LiveHearingsV2BroadcastPanel.js';

describe('Live Hearings official broadcast allowlist', () => {
  it('allows a first-party Senate ISVP embed page', () => {
    expect(
      safeOfficialEmbedUrl('https://www.senate.gov/isvp/?comm=armed&filename=armed'),
    ).toBe('https://www.senate.gov/isvp/?comm=armed&filename=armed');
  });

  it('does not inline arbitrary official committee pages', () => {
    expect(
      safeOfficialEmbedUrl('https://armedservices.house.gov/hearings/example'),
    ).toBeUndefined();
  });

  it('does not inline YouTube or C-SPAN even when they are public URLs', () => {
    expect(safeOfficialEmbedUrl('https://www.youtube.com/watch?v=abc')).toBeUndefined();
    expect(safeOfficialEmbedUrl('https://www.c-span.org/event/?123')).toBeUndefined();
  });

  it('rejects credentials and non-http schemes', () => {
    expect(safeOfficialEmbedUrl('https://user:pass@www.senate.gov/isvp/example')).toBeUndefined();
    expect(safeOfficialEmbedUrl('javascript:alert(1)')).toBeUndefined();
  });
});

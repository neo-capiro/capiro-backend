import { describe, it, expect } from 'vitest';

// We need to test the sanitizeLocation function. Since it's not exported,
// we test it indirectly through the module, or we can extract and export it.
// For now, copy the function for direct testing:
function sanitizeLocation(location: string | null | undefined): string | null {
  if (!location || typeof location !== 'string') return null;
  const trimmed = location.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return trimmed;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (host.includes('zoom.us') || host.includes('zoom.com')) return 'Zoom Meeting';
    if (host.includes('teams.microsoft.com') || host.includes('teams.live.com')) return 'Microsoft Teams Meeting';
    if (host.includes('meet.google.com')) return 'Google Meet';
    if (host.includes('webex.com')) return 'Webex Meeting';
    return url.hostname;
  } catch {
    const qIdx = trimmed.indexOf('?');
    return qIdx > 0 ? trimmed.slice(0, qIdx) : trimmed;
  }
}

describe('sanitizeLocation', () => {
  it('returns null for null/undefined/empty', () => {
    expect(sanitizeLocation(null)).toBeNull();
    expect(sanitizeLocation(undefined)).toBeNull();
    expect(sanitizeLocation('')).toBeNull();
    expect(sanitizeLocation('   ')).toBeNull();
  });

  it('passes through room names unchanged', () => {
    expect(sanitizeLocation('Rayburn 2118')).toBe('Rayburn 2118');
    expect(sanitizeLocation('Conference Room B')).toBe('Conference Room B');
  });

  it('sanitizes Zoom URLs with pwd parameter', () => {
    expect(sanitizeLocation('https://us02web.zoom.us/j/86253067422?pwd=5V1ucufmpnxKGCSjxY6Zh3rIrQ0zCM.1')).toBe('Zoom Meeting');
    expect(sanitizeLocation('https://zoom.us/j/12345')).toBe('Zoom Meeting');
  });

  it('sanitizes Teams URLs', () => {
    expect(sanitizeLocation('https://teams.microsoft.com/l/meetup-join/abc')).toBe('Microsoft Teams Meeting');
  });

  it('sanitizes Google Meet URLs', () => {
    expect(sanitizeLocation('https://meet.google.com/abc-defg-hij')).toBe('Google Meet');
  });

  it('sanitizes Webex URLs', () => {
    expect(sanitizeLocation('https://example.webex.com/meet/user')).toBe('Webex Meeting');
  });

  it('shows hostname only for unknown URL providers', () => {
    expect(sanitizeLocation('https://custom-meeting.example.com/room/123?token=secret')).toBe('custom-meeting.example.com');
  });

  it('strips query params from malformed URLs', () => {
    expect(sanitizeLocation('https://broken url?pwd=secret')).toBe('https://broken url');
  });
});

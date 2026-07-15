import { describe, expect, it } from '@jest/globals';
import { GOOGLE_WORKSPACE_SCOPES } from '@capiro/shared';
import { parseAddressList, parseCalendarDateTime } from './google-sync.service.js';
import { GOOGLE_SCOPES } from './google-oauth.service.js';

describe('parseAddressList', () => {
  it('parses a display-name + angle-bracket address', () => {
    expect(parseAddressList('Alice Example <alice@example.com>')).toEqual([
      { email: 'alice@example.com', name: 'Alice Example' },
    ]);
  });

  it('parses a bare address with no display name', () => {
    expect(parseAddressList('bob@example.com')).toEqual([{ email: 'bob@example.com', name: null }]);
  });

  it('parses a comma-separated list and lowercases emails', () => {
    expect(parseAddressList('Alice <ALICE@Example.com>, bob@example.com')).toEqual([
      { email: 'alice@example.com', name: 'Alice' },
      { email: 'bob@example.com', name: null },
    ]);
  });

  it('strips surrounding quotes from a display name', () => {
    expect(parseAddressList('"Alice Example" <alice@example.com>')).toEqual([
      { email: 'alice@example.com', name: 'Alice Example' },
    ]);
  });

  it('de-duplicates repeated addresses', () => {
    expect(parseAddressList('a@x.com, a@x.com')).toEqual([{ email: 'a@x.com', name: null }]);
  });

  it('returns [] for null / empty / malformed input', () => {
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList('not-an-email')).toEqual([]);
  });
});

describe('parseCalendarDateTime', () => {
  it('parses a timed event (dateTime with offset)', () => {
    const d = parseCalendarDateTime({ dateTime: '2026-07-12T15:30:00-04:00' });
    expect(d?.toISOString()).toBe('2026-07-12T19:30:00.000Z');
  });

  it('parses an all-day event (date only) as UTC midnight', () => {
    const d = parseCalendarDateTime({ date: '2026-07-12' });
    expect(d?.toISOString()).toBe('2026-07-12T00:00:00.000Z');
  });

  it('returns null for missing or invalid input', () => {
    expect(parseCalendarDateTime(null)).toBeNull();
    expect(parseCalendarDateTime({})).toBeNull();
    expect(parseCalendarDateTime({ dateTime: 'nonsense' })).toBeNull();
  });
});

describe('GOOGLE_SCOPES', () => {
  // Scope drift after the OAuth consent screen is verified forces a new
  // verification review, so guard the exact set the integration depends on.
  it('requests the restricted Gmail read scope (drives CASA)', () => {
    expect(GOOGLE_SCOPES).toContain('https://www.googleapis.com/auth/gmail.readonly');
  });

  it('requests gmail.send and calendar.readonly', () => {
    expect(GOOGLE_SCOPES).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(GOOGLE_SCOPES).toContain('https://www.googleapis.com/auth/calendar.readonly');
  });

  it('requests identity scopes for account resolution', () => {
    expect(GOOGLE_SCOPES).toContain('openid');
    expect(GOOGLE_SCOPES).toContain('email');
  });

  it('exactly matches the shared source of truth (onboarding IT-admin verify requests the same set)', () => {
    // The onboarding test-connect (apps/onboard-api it-admin.service) verifies a
    // customer Workspace by requesting GOOGLE_WORKSPACE_SCOPES. If this
    // engagement list ever diverges from that shared constant, the verification
    // would pass while real mailbox connects request a different set and fail —
    // so pin them equal here (onboard-api imports the shared constant directly).
    expect(GOOGLE_SCOPES).toEqual([...GOOGLE_WORKSPACE_SCOPES]);
  });
});

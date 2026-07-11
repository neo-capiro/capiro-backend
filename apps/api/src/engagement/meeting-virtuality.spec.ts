import { describe, expect, test } from '@jest/globals';
import {
  deriveMeetingVirtuality,
  detectMeetingProvider,
  eligibleForMeri,
  extractMeetingJoinUrl,
  isSupportedMeetingJoinUrl,
} from '@capiro/shared';

// Meetings v2 §5,§7 — the single source of truth for virtual-meeting
// classification, consumed by the Graph sync (persistGraphEvent) and manual
// createMeeting. These lock the behavior the stored Meeting.{isVirtual,joinLink,
// provider} columns depend on.
describe('meeting join-link detection (@capiro/shared)', () => {
  test('isSupportedMeetingJoinUrl accepts the supported hosts and rejects look-alikes', () => {
    expect(isSupportedMeetingJoinUrl('https://us02web.zoom.us/j/123')).toBe(true);
    expect(isSupportedMeetingJoinUrl('https://agency.zoomgov.com/j/1')).toBe(true);
    expect(isSupportedMeetingJoinUrl('https://gov.teams.microsoft.us/l/meetup-join/x')).toBe(true);
    expect(isSupportedMeetingJoinUrl('https://app.slack.com/huddle/T1/C1')).toBe(true);
    // Look-alike host and a non-huddle Slack link are NOT meetings.
    expect(isSupportedMeetingJoinUrl('https://zoom.us.evil.com/j/1')).toBe(false);
    expect(isSupportedMeetingJoinUrl('https://app.slack.com/client/T1/C1')).toBe(false);
    // The Outlook calendar webLink is not a join link.
    expect(isSupportedMeetingJoinUrl('https://outlook.office365.com/owa/?itemid=A')).toBe(false);
    expect(isSupportedMeetingJoinUrl('not a url')).toBe(false);
  });

  test('extractMeetingJoinUrl prefers a supported webLink, then location, then body (unescaping &amp;)', () => {
    // webLink wins only when it is itself a supported join URL.
    expect(
      extractMeetingJoinUrl({
        metadata: { webLink: 'https://teams.microsoft.com/l/meetup-join/x' },
      }),
    ).toBe('https://teams.microsoft.com/l/meetup-join/x');
    // A calendar-item webLink is ignored; falls through to location.
    expect(
      extractMeetingJoinUrl({
        metadata: { webLink: 'https://outlook.office365.com/owa/?itemid=A' },
        location: 'Join here https://us02web.zoom.us/j/999 now',
      }),
    ).toBe('https://us02web.zoom.us/j/999');
    // Outlook HTML-escapes & in the invite body — the match is unescaped.
    expect(
      extractMeetingJoinUrl({
        description: 'link https://teams.microsoft.com/l/meetup-join/19%3ameeting?a=1&amp;b=2 end',
      }),
    ).toBe('https://teams.microsoft.com/l/meetup-join/19%3ameeting?a=1&b=2');
    expect(extractMeetingJoinUrl({ location: 'Conf Room B', description: 'no link' })).toBeNull();
  });

  test('detectMeetingProvider returns the coarse provider label', () => {
    expect(detectMeetingProvider('https://us02web.zoom.us/j/1')).toBe('zoom');
    expect(detectMeetingProvider('https://meet.google.com/abc-defg-hij')).toBe('meet');
    expect(detectMeetingProvider('https://teams.microsoft.com/l/meetup-join/x')).toBe('teams');
    expect(detectMeetingProvider('https://example.com/x')).toBeNull();
  });
});

describe('deriveMeetingVirtuality (@capiro/shared)', () => {
  test('prefers the structured Graph onlineMeeting.joinUrl when supported', () => {
    expect(
      deriveMeetingVirtuality({
        onlineMeetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
        location: 'ignored https://us02web.zoom.us/j/1',
      }),
    ).toEqual({
      isVirtual: true,
      joinLink: 'https://teams.microsoft.com/l/meetup-join/abc',
      provider: 'teams',
    });
  });

  test('falls back to scanning location/description free text', () => {
    expect(deriveMeetingVirtuality({ location: 'Zoom: https://us02web.zoom.us/j/42' })).toEqual({
      isVirtual: true,
      joinLink: 'https://us02web.zoom.us/j/42',
      provider: 'zoom',
    });
  });

  test('an online meeting with no parseable link is virtual but not Meri-eligible', () => {
    const v = deriveMeetingVirtuality({
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
      location: 'Microsoft Teams Meeting',
    });
    expect(v).toEqual({ isVirtual: true, joinLink: null, provider: 'teams' });
    expect(eligibleForMeri(v)).toBe(false);
  });

  test('in-person meeting → not virtual, not eligible', () => {
    const v = deriveMeetingVirtuality({
      location: 'Rayburn HOB 2118',
      description: 'Hill meeting',
    });
    expect(v).toEqual({ isVirtual: false, joinLink: null, provider: null });
    expect(eligibleForMeri(v)).toBe(false);
  });

  test('eligibleForMeri requires both isVirtual and a joinLink', () => {
    expect(eligibleForMeri({ isVirtual: true, joinLink: 'https://us02web.zoom.us/j/1' })).toBe(
      true,
    );
    expect(eligibleForMeri({ isVirtual: true, joinLink: null })).toBe(false);
    expect(eligibleForMeri({ isVirtual: false, joinLink: 'https://us02web.zoom.us/j/1' })).toBe(
      false,
    );
  });
});

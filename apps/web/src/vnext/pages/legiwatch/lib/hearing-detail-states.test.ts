import { describe, expect, it } from 'vitest';
import type { CanonicalHearingEvent } from '../../../../pages/radar/live-hearings/live-hearings.types.js';
import {
  accessPillLabel,
  classifyPublicAccess,
  hearingNavigationTarget,
  isClosedSession,
  transcriptAvailability,
} from './hearing-detail-states.js';

function event(
  partial: Partial<CanonicalHearingEvent> & { publicAccessStatus?: string | null },
): CanonicalHearingEvent {
  return {
    id: 'cm-119-test',
    calendarDate: '2026-09-04',
    title: 'Test proceeding',
    chamber: 'House',
    eventType: 'HEARING',
    eventStatus: 'SCHEDULED',
    publicAccessStatus: 'PUBLIC',
    timeZone: 'America/New_York',
    ...partial,
  } as CanonicalHearingEvent;
}

describe('hearing detail — public-access classification (LW-QA-002)', () => {
  it('CLOSED / PRIVATE are closed sessions', () => {
    expect(classifyPublicAccess('CLOSED')).toBe('closed');
    expect(classifyPublicAccess('PRIVATE')).toBe('closed');
    expect(isClosedSession('CLOSED')).toBe(true);
    expect(accessPillLabel('CLOSED')).toBe('CLOSED SESSION');
  });

  it('PUBLIC is public', () => {
    expect(classifyPublicAccess('PUBLIC')).toBe('public');
    expect(isClosedSession('PUBLIC')).toBe(false);
    expect(accessPillLabel('PUBLIC')).toBe('PUBLIC');
  });

  it('UNKNOWN / missing are unverified — never closed', () => {
    expect(classifyPublicAccess('UNKNOWN')).toBe('unverified');
    expect(classifyPublicAccess(null)).toBe('unverified');
    expect(isClosedSession('UNKNOWN')).toBe(false);
    expect(accessPillLabel('UNKNOWN')).toBe('ACCESS UNVERIFIED');
    expect(accessPillLabel(null)).not.toMatch(/CLOSED/i);
  });
});

describe('hearing detail — transcript availability matrix (LW-QA-003)', () => {
  it('upcoming / postponed: not-yet-occurred', () => {
    expect(transcriptAvailability(event({ eventStatus: 'SCHEDULED' })).state).toBe('not-yet-occurred');
    expect(transcriptAvailability(event({ eventStatus: 'POSTPONED' })).state).toBe('not-yet-occurred');
    expect(transcriptAvailability(event({ eventStatus: 'SCHEDULED' })).available).toBe(false);
  });

  it('canceled: canceled', () => {
    const r = transcriptAvailability(event({ eventStatus: 'CANCELED' }));
    expect(r.state).toBe('canceled');
    expect(r.note).toMatch(/canceled/i);
  });

  it('closed session: closed (verified negative only)', () => {
    const r = transcriptAvailability(event({ eventStatus: 'COMPLETED', publicAccessStatus: 'CLOSED' }));
    expect(r.state).toBe('closed');
    expect(r.note).toMatch(/Closed session/i);
  });

  it('UNKNOWN access is NOT closed — access-unverified', () => {
    const r = transcriptAvailability(event({ eventStatus: 'COMPLETED', publicAccessStatus: 'UNKNOWN' }));
    expect(r.state).toBe('access-unverified');
    expect(r.note).not.toMatch(/Closed session/i);
    expect(r.note).toMatch(/unverified/i);
  });

  it('no-public-stream / capture-failed', () => {
    const r = transcriptAvailability(
      event({
        eventStatus: 'COMPLETED',
        publicAccessStatus: 'PUBLIC',
        capture: { status: 'FAILED', failureReason: 'NO_PUBLIC_STREAM' } as never,
      }),
    );
    expect(r.state).toBe('capture-failed');
    expect(r.note).toMatch(/NO_PUBLIC_STREAM/);
    expect(r.available).toBe(true);
    expect(r.note).not.toMatch(/no transcript was produced/i);
  });

  it('capture in progress (scheduled/preparing/waiting/ready/capturing)', () => {
    for (const status of ['SCHEDULED', 'PREPARING', 'WAITING_FOR_STREAM', 'READY', 'CAPTURING', 'RECORDING', 'RECOVERING']) {
      const r = transcriptAvailability(
        event({
          eventStatus: 'IN_PROGRESS',
          publicAccessStatus: 'PUBLIC',
          capture: { status } as never,
        }),
      );
      expect(r.state).toBe('capture-in-progress');
      expect(r.available).toBe(true);
    }
  });

  it('recorded capture takes precedence over stale calendar metadata, while private access still gates it', () => {
    for (const status of ['CAPTURING', 'RECORDING', 'COMPLETE', 'ENDED', 'FAILED']) {
      expect(transcriptAvailability(event({ eventStatus: 'SCHEDULED', capture: { status } as never })).available).toBe(true);
      expect(transcriptAvailability(event({ eventStatus: 'SCHEDULED', publicAccessStatus: 'PRIVATE', capture: { status } as never })).available).toBe(false);
    }
  });

  it('a recovered capture with historical failure details retains its transcript', () => {
    const result = transcriptAvailability(event({
      eventStatus: 'COMPLETED',
      capture: { status: 'COMPLETE_WITH_GAPS', failureReason: 'STREAM_DISCONNECTED' } as never,
    }));
    expect(result.available).toBe(true);
    expect(result.state).toBe('transcript-ready');
  });

  it('completed without capture', () => {
    const r = transcriptAvailability(
      event({
        eventStatus: 'COMPLETED',
        publicAccessStatus: 'PUBLIC',
        capture: { status: 'NOT_SCHEDULED' } as never,
      }),
    );
    expect(r.state).toBe('completed-without-capture');
  });

  it('transcript-ready when completed + complete capture', () => {
    const r = transcriptAvailability(
      event({
        eventStatus: 'COMPLETED',
        publicAccessStatus: 'PUBLIC',
        capture: { status: 'COMPLETE' } as never,
      }),
    );
    expect(r.state).toBe('transcript-ready');
    expect(r.available).toBe(true);
  });

  it('transcript-ready with gaps still available (gap markers live in segments)', () => {
    const r = transcriptAvailability(
      event({
        eventStatus: 'COMPLETED',
        publicAccessStatus: 'PUBLIC',
        capture: { status: 'COMPLETE_WITH_GAPS', gapSeconds: 90 } as never,
      }),
    );
    expect(r.state).toBe('transcript-ready');
    expect(r.available).toBe(true);
  });
});

describe('hearingNavigationTarget — reachability contracts (§11)', () => {
  it('calendar chip / list row → detail by canonical id', () => {
    expect(hearingNavigationTarget({ id: 'cm-119-119528', eventStatus: 'SCHEDULED' })).toEqual({
      kind: 'detail',
      hearingId: 'cm-119-119528',
    });
  });
  it('completed / canceled → detail (honest states live there)', () => {
    expect(hearingNavigationTarget({ id: 'cm-119-1', eventStatus: 'COMPLETED' }).kind).toBe('detail');
    expect(hearingNavigationTarget({ id: 'cm-119-2', eventStatus: 'CANCELED' }).kind).toBe('detail');
  });
  it('in_progress → live-room (keeps the room route)', () => {
    expect(hearingNavigationTarget({ id: 'cm-119-3', eventStatus: 'in_progress' })).toEqual({
      kind: 'live-room',
    });
  });
  it('IN_PROGRESS uppercase does not false-route to live (matches HearingsTab wire form)', () => {
    expect(hearingNavigationTarget({ id: 'x', eventStatus: 'IN_PROGRESS' }).kind).toBe('detail');
  });
});

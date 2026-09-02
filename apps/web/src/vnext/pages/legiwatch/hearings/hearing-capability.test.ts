/**
 * LW-QA-002 review item A — UNKNOWN access is NOT a closed session.
 *
 * A closed session is a VERIFIED negative (official metadata says closed) and
 * is refused with honest closed-session copy. An unverified one has simply not
 * had its public access confirmed: capture fails CLOSED (no affordance, consent
 * inert) but the product must never claim it is a closed session.
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalHearingEvent } from '../../../../pages/radar/live-hearings/live-hearings.types.js';
import { canonicalCapability } from './HearingsTab.js';

function event(publicAccessStatus: string | null): CanonicalHearingEvent {
  return {
    id: 'cm-119-test',
    calendarDate: '2026-09-04',
    title: 'Test proceeding',
    chamber: 'House',
    eventType: 'HEARING',
    eventStatus: 'SCHEDULED',
    publicAccessStatus,
    timeZone: 'America/New_York',
  } as CanonicalHearingEvent;
}

describe('canonicalCapability — public-access classification', () => {
  it('CLOSED: labeled closed session, no capture capability', () => {
    const r = canonicalCapability(event('CLOSED'));
    expect(r.closed).toBe(true);
    expect(r.capability).toBe('unavailable');
    expect(r.reason).toMatch(/[Cc]losed session/);
  });

  it('PRIVATE (canonical visibility): labeled closed session', () => {
    const r = canonicalCapability(event('PRIVATE'));
    expect(r.closed).toBe(true);
    expect(r.capability).toBe('unavailable');
  });

  it('UNKNOWN: public access UNVERIFIED — never labeled a closed session', () => {
    const r = canonicalCapability(event('UNKNOWN'));
    expect(r.closed).toBe(false); // the core assertion: UNKNOWN ≠ CLOSED
    expect(r.capability).toBe('unavailable'); // …but capture still fails closed
    expect(r.reason).toMatch(/[Uu]nverified/);
    expect(r.reason).not.toMatch(/[Cc]losed session/i);
  });

  it('missing access metadata defaults to unverified, not closed', () => {
    const r = canonicalCapability(event(null));
    expect(r.closed).toBe(false);
    expect(r.capability).toBe('unavailable');
  });
});

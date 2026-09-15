import { describe, expect, test } from 'vitest';
import {
  normalizeCalendarPage,
  normalizeCanonicalHearingEvent,
  normalizeCommitteeSourceCoverage,
  normalizeHearingUpdate,
} from './live-hearings-api.js';

describe('Live Hearings API normalization', () => {
  test('normalizes canonical and legacy field aliases without inventing values', () => {
    const event = normalizeCanonicalHearingEvent({
      hearingId: 'h-1',
      name: 'Budget oversight',
      chamber: 'senate',
      type: 'hearing',
      status: 'scheduled',
      publicAccess: 'public',
      scheduledAt: '2026-08-25T14:00:00Z',
      committeeName: 'Budget',
      streamAvailability: 'waiting_for_stream',
      capturePolicy: 'server_capture_allowed',
      witnesses: [{ fullName: 'A. Witness', organizationName: 'Department of Example' }],
      documents: [{ name: 'Witness statement', url: 'https://budget.senate.gov/doc.pdf' }],
      subscription: { scheduled: true },
    });

    expect(event).toEqual(
      expect.objectContaining({
        id: 'h-1',
        title: 'Budget oversight',
        chamber: 'senate',
        eventType: 'hearing',
        eventStatus: 'scheduled',
        publicAccessStatus: 'public',
        committee: expect.objectContaining({ name: 'Budget' }),
        streamState: 'waiting_for_stream',
        capturePolicy: 'server_capture_allowed',
        subscription: expect.objectContaining({ scheduled: true }),
      }),
    );
    expect(event.witnesses).toHaveLength(1);
    expect(event.documents).toHaveLength(1);
  });

  test('reads the real LiveHearingsService field names for start time, not only the legacy aliases', () => {
    // The real backend (apps/api/src/live-hearings/live-hearings.service.ts
    // CalendarEvent) names the event's own start `startsAt`, and puts the
    // capture's actual start/end INSIDE `capture` — never as a bare top-level
    // `scheduledStart`/`actualStart`/`actualEnd`. Missing `startsAt` here left
    // every real Master Calendar row's time as "Time not announced" and the
    // week grid unable to bucket a single real event into a day column.
    const event = normalizeCanonicalHearingEvent({
      id: 'h-1',
      title: 'Real-shape hearing',
      committeeName: 'Armed Services',
      startsAt: '2026-08-12T14:00:00.000Z',
      capture: {
        status: 'capturing',
        actualStart: '2026-08-12T14:02:00.000Z',
        actualEnd: null,
      },
    });
    expect(event.scheduledStart).toBe('2026-08-12T14:00:00.000Z');
    expect(event.actualStart).toBe('2026-08-12T14:02:00.000Z');
  });

  test('accepts both an array and a paged envelope', () => {
    const row = {
      id: 'h-1',
      title: 'Hearing',
      chamber: 'HOUSE',
      committee: { name: 'Judiciary' },
    };
    expect(normalizeCalendarPage([row])).toEqual(
      expect.objectContaining({ total: 1, items: [expect.objectContaining({ id: 'h-1' })] }),
    );
    expect(
      normalizeCalendarPage({
        items: [row],
        total: 17,
        nextCursor: 'next',
        sourceHealth: { healthy: 42, expected: 46, complete: false },
      }),
    ).toEqual(
      expect.objectContaining({
        total: 17,
        nextCursor: 'next',
        sourceHealth: expect.objectContaining({ healthy: 42, expected: 46 }),
      }),
    );
  });

  test('keeps page provenance separate from media transport by exposing only the official page', () => {
    const event = normalizeCanonicalHearingEvent({
      id: 'h-1',
      title: 'Hearing',
      committeeName: 'Science',
      officialPageUrl: 'https://science.house.gov/hearings/1',
      mediaUrl: 'https://googlevideo.com/private-token/master.m3u8',
      streamUrl: 'https://another.example/stream',
    });
    expect(event.officialPageUrl).toBe('https://science.house.gov/hearings/1');
    expect(event).not.toHaveProperty('mediaUrl');
    expect(event).not.toHaveProperty('streamUrl');
  });

  test('drops tenant/client fields from public intelligence payloads', () => {
    const event = normalizeCanonicalHearingEvent({
      id: 'h-1',
      title: 'Hearing',
      committeeName: 'Armed Services',
      intelligence: [
        {
          id: 'i-1',
          type: 'COMMITMENT',
          title: 'Commitment',
          summary: 'The witness will provide the report.',
          clientName: 'Private client',
          tenantId: 'private-tenant',
        },
      ],
    });
    expect(event.intelligence).toHaveLength(1);
    expect(event.intelligence?.[0]).not.toHaveProperty('clientName');
    expect(event.intelligence?.[0]).not.toHaveProperty('tenantId');
  });

  test('normalizes official site updates and requires stable identity plus title', () => {
    expect(
      normalizeHearingUpdate({
        contentHash: 'abc',
        type: 'date_changed',
        summary: 'Time moved to 10:30 a.m.',
        sourceUrl: 'https://committee.house.gov/event',
      }),
    ).toEqual(
      expect.objectContaining({
        id: 'abc',
        updateType: 'date_changed',
        title: 'Time moved to 10:30 a.m.',
      }),
    );
    expect(normalizeHearingUpdate({ type: 'date_changed' })).toBeNull();
  });

  test('normalizes committee source coverage without fabricating a derived capture/resolution reading', () => {
    const withCandidate = normalizeCommitteeSourceCoverage({
      id: 'src-1',
      committeeSystemCode: 'hsas00',
      committeeName: 'House Armed Services',
      chamber: 'house',
      sourceType: 'COMMITTEE_SITE',
      sourceUrl: 'https://armedservices.house.gov/hearings',
      adapterKey: 'house-committee-v3',
      enabled: true,
      priority: 100,
      sourceHealth: 'healthy',
      lastCheckedAt: '2026-08-21T12:00:00Z',
      lastSuccessAt: '2026-08-21T12:00:00Z',
      recentCapturePolicy: 'SERVER_CAPTURE_ALLOWED',
      recentResolutionState: 'READY',
    });
    expect(withCandidate).toEqual(
      expect.objectContaining({
        id: 'src-1',
        committeeName: 'House Armed Services',
        sourceHealth: 'healthy',
        recentCapturePolicy: 'SERVER_CAPTURE_ALLOWED',
        recentResolutionState: 'READY',
      }),
    );

    const withoutCandidate = normalizeCommitteeSourceCoverage({
      id: 'src-2',
      chamber: 'senate',
      sourceType: 'SENATE_SCHEDULE',
      sourceUrl: 'https://www.senate.gov/committees/schedule.htm',
      adapterKey: 'senate-schedule-v1',
      sourceHealth: 'unknown',
    });
    // No stream candidate has ever cited this source — the field must stay
    // undefined (truthfully unavailable), never default to any status string.
    expect(withoutCandidate?.recentCapturePolicy).toBeUndefined();
    expect(withoutCandidate?.recentResolutionState).toBeUndefined();
    expect(withoutCandidate?.committeeName).toBeUndefined();

    expect(normalizeCommitteeSourceCoverage({ id: 'src-3' })).toBeNull();
  });

  // ── LW-QA-025: official root-level committee codes ────────────────────────
  // The real LiveHearingsService CalendarEvent carries `committeeSystemCode` /
  // `subcommitteeSystemCode` at the ROOT of the flat row and sends NO nested
  // `committee` object. The normalizer used to read codes only from the nested
  // value, so every real event's committee ref lost its official code and the
  // detail route could not render the existing Committee Room link.

  test('preserves the root committeeSystemCode from the real flat Judiciary response', () => {
    // Field-for-field the actual canonical GET for the retained Judiciary
    // event 4c575634-5154-4052-8f46-000000338740 (see
    // committee-normalization-current.json): root code, no nested committee.
    const event = normalizeCanonicalHearingEvent({
      id: '4c575634-5154-4052-8f46-000000338740',
      title: 'Nominations',
      chamber: 'senate',
      committeeName: 'Senate Committee on Judiciary',
      committeeSystemCode: 'ssju00',
      subcommitteeSystemCode: null,
    });
    expect(event.committee.systemCode).toBe('ssju00');
    expect(event.committee.name).toBe('Senate Committee on Judiciary');
    // The code — not the name — is what the existing detail route turns into
    // the Committee Room href `/legiwatch/committees/:systemCode`.
    expect(event.subcommittee).toBeUndefined();
  });

  test('keeps nested committee/subcommittee codes ahead of the root-level fallback', () => {
    const event = normalizeCanonicalHearingEvent({
      id: 'h-nested',
      title: 'Oversight hearing',
      committeeName: 'Root Name',
      committeeSystemCode: 'root00',
      subcommitteeSystemCode: 'root01',
      committee: { systemCode: 'hsju00', name: 'Judiciary' },
      subcommittee: { systemCode: 'hsju10', name: 'Courts Subcommittee' },
    });
    expect(event.committee.systemCode).toBe('hsju00');
    expect(event.subcommittee?.systemCode).toBe('hsju10');
  });

  test('retains a code-only root subcommittee with the honest unknown name, never a fabricated one', () => {
    const event = normalizeCanonicalHearingEvent({
      id: 'h-sub',
      title: 'Hearing',
      committeeName: 'Senate Committee on Judiciary',
      committeeSystemCode: 'ssju00',
      subcommitteeSystemCode: 'ssju22',
    });
    expect(event.subcommittee?.systemCode).toBe('ssju22');
    // No child name was supplied: the ref must NOT invent one from the parent
    // name, the title, or the code itself.
    expect(event.subcommittee?.name).toBe('Committee not identified');
    // The parent code must never be copied onto the child or vice versa.
    expect(event.committee.systemCode).toBe('ssju00');
  });

  test('leaves codes undefined when neither nested nor root values exist (no name-derived guessing)', () => {
    const event = normalizeCanonicalHearingEvent({
      id: 'h-unknown',
      title: 'Senate Judiciary markup',
      committeeName: 'Senate Judiciary',
      stateCommitteeId: 'state-123',
    });
    expect(event.committee.systemCode).toBeUndefined();
    expect(event.committee.name).toBe('Senate Judiciary');
    expect(event.subcommittee).toBeUndefined();
  });
});

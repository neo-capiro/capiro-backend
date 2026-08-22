import { describe, expect, it } from 'vitest';
import {
  normalizePhase7Capture,
  normalizePhase7ListEvent,
  normalizePhase7Room,
  normalizePhase7Transcript,
} from './live-hearings-phase7-api.js';

describe('Phase 7 Live Hearings API contracts', () => {
  it('normalizes exact domain capture state and explicit outcome reasons', () => {
    expect(
      normalizePhase7Capture({
        id: 'capture-1',
        status: 'COMPLETE_WITH_GAPS',
        transcriptGapSeconds: 14,
        reconnectCount: 2,
        terminalReasonCode: 'CAPTURE_COMPLETE_WITH_GAPS',
        resolutionReasonCode: 'FIRST_PARTY_STREAM_READY',
      }),
    ).toEqual(
      expect.objectContaining({
        id: 'capture-1',
        status: 'COMPLETE_WITH_GAPS',
        transcriptGapSeconds: 14,
        reconnectCount: 2,
        terminalReasonCode: 'CAPTURE_COMPLETE_WITH_GAPS',
      }),
    );
  });

  it('normalizes the canonical room without media URLs or tenant-derived intelligence', () => {
    const room = normalizePhase7Room({
      event: {
        id: 'h-1',
        title: 'Oversight hearing',
        chamber: 'House',
        committeeName: 'House Armed Services',
        committeeSystemCode: 'hsas00',
        eventStatus: 'in_progress',
        eventType: 'hearing',
        startsAt: '2026-08-25T14:00:00Z',
        streamAvailability: 'live_only',
      },
      participation: { scheduled: true, scheduledByUser: true, followed: true },
      capture: { id: 'capture-1', status: 'CAPTURING' },
      browser: {
        mode: 'ATTACH_CANONICAL',
        hearingId: 'h-1',
        captureId: 'capture-1',
        captureStatus: 'CAPTURING',
        reasonCode: 'CANONICAL_CAPTURE_ACTIVE',
      },
      witnesses: ['Jane Doe — Department of Example'],
      documents: [
        {
          id: 'doc-1',
          title: 'Witness testimony',
          documentType: 'witness_testimony_published',
          sourceUrl: 'https://armedservices.house.gov/testimony.pdf',
        },
      ],
      members: [{ id: 'm-1', name: 'Member One', party: 'D', role: 'Chair' }],
      updates: [],
      intelligence: { status: 'PHASE_8_PERSISTENCE_NOT_ENABLED', items: [] },
    });

    expect(room.event.committee.systemCode).toBe('hsas00');
    expect(room.participation.scheduled).toBe(true);
    expect(room.browser.mode).toBe('ATTACH_CANONICAL');
    expect(room.witnesses).toEqual(['Jane Doe — Department of Example']);
    expect(room.documents).toHaveLength(1);
    expect(room.intelligenceStatus).toBe('PHASE_8_PERSISTENCE_NOT_ENABLED');
    expect(JSON.stringify(room)).not.toContain('mediaUrl');
  });

  it('preserves transcript gap markers and pagination state', () => {
    const transcript = normalizePhase7Transcript({
      hearingId: 'h-1',
      capture: { id: 'capture-1', status: 'RECOVERING' },
      items: [
        {
          id: 's-1',
          sequence: 7,
          startMs: 1000,
          endMs: 2000,
          text: 'Recovered segment',
          speakerName: 'Witness',
          confidence: 0.91,
          isFinal: true,
          hasGapBefore: true,
        },
      ],
      total: 12,
      nextCursor: 'opaque',
      hasMore: true,
    });
    expect(transcript.items[0]).toMatchObject({
      id: 's-1',
      sequence: 7,
      gapBefore: true,
      speakerName: 'Witness',
    });
    expect(transcript.hasMore).toBe(true);
    expect(transcript.nextCursor).toBe('opaque');
  });

  it('normalizes scheduled/archive list rows without requiring a tenant capture copy', () => {
    expect(
      normalizePhase7ListEvent({
        id: 'h-1',
        title: 'Markup',
        chamber: 'House',
        committeeName: 'Rules',
        eventStatus: 'scheduled',
        date: '2026-08-25',
        timezone: 'America/New_York',
        streamAvailability: 'unknown',
        coverageStatus: 'discovered',
        capture: { id: 'capture-global', status: 'SCHEDULED' },
        scheduleSource: { byUser: true, byRule: false },
      }),
    ).toEqual(
      expect.objectContaining({
        id: 'h-1',
        capture: expect.objectContaining({ id: 'capture-global' }),
        scheduleSource: expect.objectContaining({ byUser: true }),
      }),
    );
  });
});

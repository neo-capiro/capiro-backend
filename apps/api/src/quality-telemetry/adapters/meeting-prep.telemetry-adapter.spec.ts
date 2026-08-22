import { describe, expect, it } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { buildMeetingPrepTelemetryEvent } from './meeting-prep.telemetry-adapter.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
const observedAt = new Date('2026-08-21T00:00:00.000Z');

describe('buildMeetingPrepTelemetryEvent', () => {
  it.each(['generated', 'edited', 'approved'] as const)('builds a "%s" event for the meetings surface', (eventType) => {
    const event = buildMeetingPrepTelemetryEvent(ctx, { prepId: 'prep-1', clientId: 'client-1' }, eventType, observedAt);
    expect(event.surface).toBe('meetings');
    expect(event.eventType).toBe(eventType);
    expect(event.artifactType).toBe('meeting_prep');
    expect(event.artifactId).toBe('prep-1');
    expect(event.clientId).toBe('client-1');
    expect(event.contextPacketId).toBeNull();
  });
});

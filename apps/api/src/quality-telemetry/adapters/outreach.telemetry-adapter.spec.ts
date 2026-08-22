import { describe, expect, it } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import {
  buildOutreachApprovalTelemetryEvent,
  buildOutreachVersionTelemetryEvent,
} from './outreach.telemetry-adapter.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
const observedAt = new Date('2026-08-21T00:00:00.000Z');

describe('buildOutreachVersionTelemetryEvent', () => {
  it('maps generationStatus "generated" to eventType "generated"', () => {
    const event = buildOutreachVersionTelemetryEvent(
      ctx,
      { versionId: 'v-1', artifactId: 'a-1', version: 1, generationStatus: 'generated', contextPacketId: 'p-1' },
      null,
      observedAt,
    );
    expect(event.eventType).toBe('generated');
    expect(event.contextPacketId).toBe('p-1');
    expect(event.artifactType).toBe('outreach_draft_version');
    expect(event.editMetrics).toEqual({ versionsCount: 1 });
  });

  it('maps any other generationStatus (e.g. "manually_authored") to eventType "edited"', () => {
    const event = buildOutreachVersionTelemetryEvent(
      ctx,
      { versionId: 'v-2', artifactId: 'a-1', version: 2, generationStatus: 'manually_authored', contextPacketId: null },
      { percentChanged: 12.5, normalizedEditDistance: 0.125 },
      observedAt,
    );
    expect(event.eventType).toBe('edited');
    expect(event.contextPacketId).toBeNull();
    expect(event.editMetrics).toEqual({ percentChanged: 12.5, normalizedEditDistance: 0.125, versionsCount: 2 });
  });
});

describe('buildOutreachApprovalTelemetryEvent', () => {
  it('builds an "approved" event with the packet reference used at generation time', () => {
    const event = buildOutreachApprovalTelemetryEvent(
      ctx,
      { versionId: 'v-1', artifactId: 'a-1', contextPacketId: 'p-1' },
      observedAt,
    );
    expect(event.eventType).toBe('approved');
    expect(event.surface).toBe('outreach');
    expect(event.artifactId).toBe('v-1');
    expect(event.contextPacketId).toBe('p-1');
  });
});

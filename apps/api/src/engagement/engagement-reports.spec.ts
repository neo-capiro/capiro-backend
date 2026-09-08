// Reports vNext reskin (2026-08-16): reportOverview() used to collapse three
// independently-tracked override booleans (storedPrepStatus/
// storedOutreachStatus/storedSubmissionStatus) into a single
// `manuallyOverridden` flag before the response reached the client — not
// enough to build the design's per-cell override-marker dot (README §10.2),
// which needs to know WHICH cell was overridden, not just whether any of the
// three was. This suite pins the additive fix: `prepOverridden`/
// `outreachOverridden`/`submissionOverridden` are now returned per-row
// alongside the untouched `manuallyOverridden`, computed independently per
// field rather than collapsed. Uses the same minimal-harness pattern as
// engagement-meetings.spec.ts (real prototype over a stub prisma) so the
// heavy constructor graph isn't wired.
import { describe, expect, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx: TenantContext = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as TenantContext;

function serviceWith(tx: Record<string, unknown>): EngagementService {
  const prisma = {
    withTenant: (_tenantId: string, fn: (scoped: unknown) => unknown) => fn(tx),
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  (service as unknown as { prisma: unknown }).prisma = prisma;
  return service;
}

// A stored target-office row shaped like reportOverview()'s own
// `tx.engagementReportTargetOffice.findMany(...)` select (id/clientId/client
// relation/scopeKey/officeKey/memberPrincipal/committee/staffer/building/
// leadOwner/source/prepStatus/outreachStatus/submissionStatus). No meetings
// or messages are needed to exercise this: a manual target office's fields
// come entirely from the stored row itself, independent of any real
// engagement activity.
function targetOfficeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    clientId: null,
    client: null,
    scopeKey: 'all',
    officeKey: 'manual:office-1',
    memberPrincipal: 'Rep. Jane Smith (D-CA-12)',
    committee: 'HASC',
    staffer: 'Priya Anand',
    building: 'Rayburn',
    leadOwner: 'Neo',
    source: 'manual',
    prepStatus: 'auto',
    outreachStatus: 'auto',
    submissionStatus: 'auto',
    ...overrides,
  };
}

// reportOverview() also queries meeting/mailMessage/engagementTask — none of
// those tables matter for a manual target office with no linked activity, so
// every one of these stubs is a real, empty result rather than an unused
// mock, keeping directoryMatchesForReport's own email-driven directory
// lookup unreached (it short-circuits on an empty email list, so `this
// .directory` never needs stubbing either).
function servicePinnedTo(targets: Array<Record<string, unknown>>): EngagementService {
  return serviceWith({
    engagementReportTargetOffice: { findMany: async () => targets },
    meeting: { findMany: async () => [] },
    mailMessage: { findMany: async () => [] },
    engagementTask: { findMany: async () => [] },
  });
}

describe('reportOverview — per-field override flags (additive)', () => {
  test('cancelled calendar meetings are not counted as held meetings', async () => {
    const meetings = ['confirmed', 'canceled', 'cancelled', ' Cancelled '].map((status, index) => ({
      id: `m-${index}`,
      status,
      startsAt: new Date('2026-01-01T12:00:00Z'),
      endsAt: new Date('2026-01-01T13:00:00Z'),
      attendees: [],
      preps: [],
      tasks: [],
    }));
    const service = serviceWith({
      engagementReportTargetOffice: { findMany: async () => [] },
      meeting: { findMany: async () => meetings },
      mailMessage: { findMany: async () => [] },
      engagementTask: { findMany: async () => [] },
    });

    const report = await service.reportOverview(ctx, {});

    expect(report.summary.meetingsHeld).toBe(1);
  });

  test('a row with ONLY prep and submission manually overridden reports each field independently, not collapsed', async () => {
    const service = servicePinnedTo([
      targetOfficeRow({ prepStatus: 'complete', outreachStatus: 'auto', submissionStatus: 'in_progress' }),
    ]);

    const report = await service.reportOverview(ctx, {});

    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    // The resolved statuses reflect the stored override where one exists,
    // falling back to the (here, zero-activity) automatic value otherwise.
    expect(row.prepStatus).toBe('complete');
    expect(row.outreachStatus).toBe('not_started'); // auto — no meetings/messages
    expect(row.submissionStatus).toBe('in_progress');
    // The three NEW per-field flags — the actual point of this change.
    expect(row.prepOverridden).toBe(true);
    expect(row.outreachOverridden).toBe(false);
    expect(row.submissionOverridden).toBe(true);
    // The ORIGINAL collapsed flag stays exactly as before — untouched
    // behavior for the canonical ReportsView's own single "Manual override"
    // tag, which still reads only this field.
    expect(row.manuallyOverridden).toBe(true);
  });

  test('a row with nothing overridden reports all three new flags false, and the original flag stays false too', async () => {
    const service = servicePinnedTo([targetOfficeRow()]);

    const report = await service.reportOverview(ctx, {});

    const row = report.rows[0]!;
    expect(row.prepOverridden).toBe(false);
    expect(row.outreachOverridden).toBe(false);
    expect(row.submissionOverridden).toBe(false);
    expect(row.manuallyOverridden).toBe(false);
  });

  test('a row overridden on all three fields reports all three flags true (not just the collapsed one)', async () => {
    const service = servicePinnedTo([
      targetOfficeRow({ prepStatus: 'complete', outreachStatus: 'complete', submissionStatus: 'complete' }),
    ]);

    const report = await service.reportOverview(ctx, {});

    const row = report.rows[0]!;
    expect(row.prepOverridden).toBe(true);
    expect(row.outreachOverridden).toBe(true);
    expect(row.submissionOverridden).toBe(true);
    expect(row.manuallyOverridden).toBe(true);
  });

  test('the additive fields do not replace or rename any existing row field', async () => {
    const service = servicePinnedTo([
      targetOfficeRow({ prepStatus: 'complete', outreachStatus: 'auto', submissionStatus: 'auto' }),
    ]);

    const report = await service.reportOverview(ctx, {});
    const row = report.rows[0]!;

    // Every field the canonical ReportsView (EngagementPage.tsx) already
    // reads is still present, unrenamed, alongside the three new ones.
    for (const key of [
      'targetId',
      'clientId',
      'clientName',
      'scopeKey',
      'officeKey',
      'memberPrincipal',
      'committee',
      'staffer',
      'building',
      'leadOwner',
      'meetingsHeld',
      'outreachSent',
      'pendingActions',
      'prepStatus',
      'outreachStatus',
      'submissionStatus',
      'source',
      'manuallyOverridden',
      'meetings',
    ]) {
      expect(row).toHaveProperty(key);
    }
  });
});

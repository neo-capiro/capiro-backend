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
import { afterEach, describe, expect, jest, test } from '@jest/globals';
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
    archivedAt: null,
    displayOverrides: [],
    firstReportYear: 2000,
    annualOverrides: [{
      reportYear: new Date().getUTCFullYear(),
      prepStatus: overrides.prepStatus ?? 'auto',
      outreachStatus: overrides.outreachStatus ?? 'auto',
      submissionStatus: overrides.submissionStatus ?? 'auto',
    }],
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
    engagementReportTargetOffice: { findMany: async ({ where, include }: any) => targets.filter((target) => !where.clientId || target.clientId === where.clientId).map((target: any) => ({ ...target, annualOverrides: target.annualOverrides.filter((value: any) => value.reportYear === include.annualOverrides.where.reportYear) })) },
    client: { findFirst: async () => ({ id: 'client-a' }) },
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


describe('report years, client identity and archive history', () => {
  afterEach(() => { jest.useRealTimers(); });

  test('advancing across UTC New Year changes current override selection without losing the plan', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T23:59:59Z'));
    const service = servicePinnedTo([targetOfficeRow({ clientId: 'client-a', scopeKey: 'client-a',
      annualOverrides: [
        { reportYear: 2026, prepStatus: 'complete', outreachStatus: 'auto', submissionStatus: 'auto' },
        { reportYear: 2027, prepStatus: 'in_progress', outreachStatus: 'auto', submissionStatus: 'auto' },
      ],
    })]);
    expect((await service.reportOverview(ctx, {})).rows[0]?.prepStatus).toBe('complete');
    jest.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    const current = await service.reportOverview(ctx, {});
    expect(current.cycle.reportYear).toBe(2027);
    expect(current.rows[0]?.prepStatus).toBe('in_progress');
    expect((await service.reportOverview(ctx, { period: 'previous' })).rows[0]?.prepStatus).toBe('complete');
    expect((await service.reportOverview(ctx, { period: 'all' })).rows[0]?.prepOverridden).toBe(false);
  });

  test('legacy unassigned plans appear only in All clients with a reconciliation marker', async () => {
    const service = servicePinnedTo([targetOfficeRow(), targetOfficeRow({ id: 'assigned', clientId: 'client-a', scopeKey: 'client-a' })]);
    const scoped = await service.reportOverview(ctx, { clientId: 'client-a' });
    expect(scoped.rows.map((row) => row.targetId)).toEqual(['assigned']);
    expect(scoped.rows[0]?.requiresClientAssignment).toBe(false);
    const all = await service.reportOverview(ctx, {});
    expect(all.rows.find((row) => row.targetId === 't-1')?.requiresClientAssignment).toBe(true);
  });

  test('archive removes active rows while retaining prior-cycle and All-time export rows', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-08T12:00:00Z'));
    const service = servicePinnedTo([targetOfficeRow({ archivedAt: new Date('2026-09-08T11:00:00Z'),
      annualOverrides: [{ reportYear: 2025, prepStatus: 'complete', outreachStatus: 'auto', submissionStatus: 'complete' }],
    })]);
    expect((await service.reportOverview(ctx, {})).rows).toHaveLength(0);
    const previous = await service.reportOverview(ctx, { period: 'previous' });
    expect(previous.rows[0]?.submissionStatus).toBe('complete');
    expect(previous.rows[0]?.archivedAt).toEqual(new Date('2026-09-08T11:00:00Z'));
    expect((await service.reportOverview(ctx, { period: 'all' })).rows).toHaveLength(1);
  });

  test('a plan starting this year is not retroactively added to an earlier report', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-08T12:00:00Z'));
    const service = servicePinnedTo([targetOfficeRow({ firstReportYear: 2026 })]);
    expect((await service.reportOverview(ctx, {})).rows).toHaveLength(1);
    expect((await service.reportOverview(ctx, { period: 'previous' })).rows).toHaveLength(0);
  });
});


function serviceWithDirectoryActivity(targets: any[], status = 'confirmed', messages: any[] = []) {
  const meeting = {
    id: 'meeting-a', clientId: 'client-a', client: { name: 'Client A' }, status,
    startsAt: new Date('2026-04-01T12:00:00Z'), endsAt: new Date('2026-04-01T13:00:00Z'),
    subject: 'Office meeting', location: null, metadata: {}, organizerEmail: null,
    attendees: [{ email: 'staff@example.org' }], preps: [{ status: 'approved' }], tasks: [],
  };
  const service = serviceWith({
    engagementReportTargetOffice: { findMany: async () => targets },
    meeting: { findMany: async () => messages.length ? [] : [meeting] },
    mailMessage: { findMany: async () => messages }, engagementTask: { findMany: async () => [] },
  });
  (service as any).directoryMatchesForReport = async () => [{
    directoryContactId: 'member-123', attendeeEmail: 'staff@example.org',
    member: { fullName: 'Avery Member', partyName: 'Democratic', chamber: 'House', state: 'CA', district: '12',
      committees: [], officeLocation: '123 Rayburn HOB', addresses: [] },
    staff: { id: 'staff-1', fullName: 'Alex Staffer', officeLocation: '123 Rayburn HOB' },
  }];
  return service;
}

describe('Directory activity contributes to the correct planned identity', () => {
  test('planned office picks up staff activity without duplicating or overwriting edited fields', async () => {
    const service = serviceWithDirectoryActivity([targetOfficeRow({ officeKey: 'directory:member-123', clientId: 'client-a', scopeKey: 'client-a',
      memberPrincipal: 'Edited Avery', building: null, displayOverrides: ['building'],
    })]);
    const report = await service.reportOverview(ctx, {});
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ memberPrincipal: 'Edited Avery', building: null, meetingsHeld: 1, prepStatus: 'complete', source: 'manual' });
  });

  test('cancelled meetings with approved preps never advance ordinary report progress', async () => {
    const service = serviceWithDirectoryActivity([targetOfficeRow({ officeKey: 'directory:member-123', clientId: 'client-a', scopeKey: 'client-a' })], ' Cancelled ');
    const report = await service.reportOverview(ctx, {});
    expect(report.rows[0]).toMatchObject({ meetingsHeld: 0, prepStatus: 'not_started', meetings: [] });
  });

  test('archived canonical targets cannot regenerate from activity as ghost planning rows', async () => {
    const service = serviceWithDirectoryActivity([targetOfficeRow({ officeKey: 'directory:member-123', clientId: 'client-a', scopeKey: 'client-a',
      archivedAt: new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)),
    })]);
    const report = await service.reportOverview(ctx, {});
    expect(report.rows).toHaveLength(0);
    expect(report.summary.meetingsHeld).toBe(1);
  });

  test('mail-only activity carries its actual client name and identity', async () => {
    const service = serviceWithDirectoryActivity([], 'confirmed', [{
      id: 'message-a', threadId: 'thread-a', fromEmail: 'staff@example.org', toRecipients: [], ccRecipients: [], bccRecipients: [],
      sentAt: new Date(), receivedAt: null, metadata: {}, connection: null,
      thread: { clientId: 'client-a', client: { name: 'Client A' } },
    }]);
    expect((await service.reportOverview(ctx, {})).rows[0]).toMatchObject({ clientId: 'client-a', clientName: 'Client A', scopeKey: 'client-a' });
  });
});

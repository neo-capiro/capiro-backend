import type { TenantContext } from '@capiro/shared';
import { LegiWatchWave1Service } from '../live-hearings/legiwatch-wave1.service.js';
import { LiveHearingsService } from '../live-hearings/live-hearings.service.js';
import { calendarUid } from '../live-hearings/legiwatch-calendar-export.js';

describe('existing calendar subscriptions after hearing reconciliation', () => {
  const aliasId = 'cm-119-338740',
    canonicalId = 'sen-119-338740';
  const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as TenantContext;
  const canonical = {
    id: canonicalId,
    canonicalHearingId: null,
    geographicJurisdiction: 'US',
    title: 'Updated official proceeding',
    date: new Date('2026-09-15'),
    startsAt: new Date('2026-09-15T13:00:00Z'),
    timezone: 'America/New_York',
    visibility: 'public',
    eventStatus: 'scheduled',
    calendarRevision: 3,
    sourceRevision: 2,
    committeeName: 'Senate Judiciary',
    subcommitteeSystemCode: null,
  };
  const alias = {
    ...canonical,
    id: aliasId,
    canonicalHearingId: canonicalId,
    calendarRevision: 100,
    sourceRevision: 10,
  };
  function service() {
    const prisma = {
      committeeHearing: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          where.id === aliasId ? alias : where.id === canonicalId ? canonical : null,
        ),
      },
    };
    return new LegiWatchWave1Service(prisma as never, {} as never, {} as never, {} as never);
  }
  afterEach(() => {
    jest.restoreAllMocks();
    canonical.sourceRevision = 2;
    canonical.calendarRevision = 3;
  });
  it('keeps the single-event UID and advances sequence for every subsequent federal source change', async () => {
    const api = service();
    const first = await api.calendarExport(ctx, aliasId, 'https://os.capiro.ai');
    expect(first.uid).toBe(calendarUid(aliasId));
    expect(first.ics).toContain('SEQUENCE:116');
    canonical.sourceRevision++;
    const next = await api.calendarExport(ctx, aliasId, 'https://os.capiro.ai');
    expect(next.uid).toBe(first.uid);
    expect(next.ics).toContain('SEQUENCE:117');
    expect(next.detailUrl).toContain(canonicalId);
  });
  it('keeps an explicitly selected old UID in bulk and emits one canonical UID if both IDs are selected', async () => {
    jest.spyOn(LiveHearingsService.prototype, 'calendar').mockResolvedValue({
      rows: [{ id: canonicalId }] as never,
      total: 1,
      page: 1,
      pageSize: 200,
    });
    const api = service();
    const oldSelection = await api.calendarExportBulk(
      ctx,
      { hearingIds: [aliasId] },
      'https://os.capiro.ai',
    );
    expect(oldSelection.ics).toContain(`UID:${calendarUid(aliasId)}`);
    expect(oldSelection.ics).toContain('SEQUENCE:116');
    expect(oldSelection.skipped).toEqual([]);
    for (const hearingIds of [
      [aliasId, canonicalId],
      [canonicalId, aliasId],
    ]) {
      const both = await api.calendarExportBulk(ctx, { hearingIds }, 'https://os.capiro.ai');
      expect(both.includedCount).toBe(1);
      expect(both.ics).toContain(`UID:${calendarUid(canonicalId)}`);
      expect(both.ics).not.toContain(`UID:${calendarUid(aliasId)}`);
      expect(both.skipped).toEqual([]);
    }
  });
});

import { describe, expect, jest, test } from '@jest/globals';
import { TrackerService } from './tracker.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { IntelligenceService } from '../intelligence/intelligence.service.js';

/**
 * Regression for the legacy-tracker drawer defect: BillUpdatesDrawer already
 * consumes optional `latestActionText` / `latestActionDate` / `canonicalStatus`
 * / `note` on a board card, but TrackerService.getBoard never populated them —
 * the congress_bill latest-action fields were selected by fetchBillRows and
 * then dropped, and the tracked row's own `note` was never read. Opening a
 * tracked bill's drawer therefore showed "No official action recorded" and no
 * analyst note despite congress_bill.latest_action_text/date/status and
 * tracked_bill.note all being populated. Pin: getBoard surfaces all four on
 * every card, latestActionDate as ISO YYYY-MM-DD, and they stay null (never
 * fabricated) when the source columns are null.
 */
describe('TrackerService.getBoard — drawer fields', () => {
  const tenantId = 'tenant-1';
  const clientId = 'client-1';
  const userId = 'user-1';

  function makeService(opts: {
    tracked: Array<Record<string, unknown>>;
    bills: Array<Record<string, unknown>>;
  }) {
    const tx = {
      trackedBill: { findMany: jest.fn(async () => opts.tracked) },
      trackerFeedback: { findMany: jest.fn(async () => [] as Array<Record<string, unknown>>) },
      clientWatchlist: { findFirst: jest.fn(async () => null) },
      client: { findFirst: jest.fn(async () => ({ sectorTag: null })) },
      clientCapability: { findMany: jest.fn(async () => [] as Array<Record<string, unknown>>) },
    };
    const prisma = {
      withTenant: jest.fn(async (_t: string, run: (tx: unknown) => unknown) => run(tx)),
      intelligenceChange: { findMany: jest.fn(async () => [] as Array<Record<string, unknown>>) },
      $queryRaw: jest.fn(async () => opts.bills),
    };
    const service = new TrackerService(
      prisma as unknown as PrismaService,
      {} as IntelligenceService,
    );
    return { service };
  }

  const trackedRow = {
    id: 'tb-1',
    tenantId,
    clientId,
    billId: '119-hr-99001',
    note: 'Watch the floor schedule for this one.',
    source: 'manual_search',
    createdBy: userId,
    createdAt: new Date('2026-09-01T12:00:00Z'),
    updatedAt: new Date('2026-09-01T12:00:00Z'),
  };

  const billRow = {
    id: '119-hr-99001',
    title: 'QA Ground Autonomy Research Act',
    status: 'committee',
    action_texts: ['Referred to the House Committee on Armed Services.'],
    latest_action_text: 'Ordered to be Reported by Voice Vote.',
    latest_action_date: new Date('2026-09-10T00:00:00Z'),
    subjects: [],
    policy_area: null,
    sponsor_name: null,
    sponsor_party: null,
    cosponsors_count: 0,
  };

  test('every card carries canonicalStatus, latestActionText, latestActionDate (ISO date) and the tracked note', async () => {
    const { service } = makeService({ tracked: [trackedRow], bills: [billRow] });
    const board = await service.getBoard(clientId, tenantId, userId);
    const cards = board.columns.flatMap((c) => c.bills);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      billId: '119-hr-99001',
      canonicalStatus: 'committee',
      latestActionText: 'Ordered to be Reported by Voice Vote.',
      latestActionDate: '2026-09-10',
      note: 'Watch the floor schedule for this one.',
    });
  });

  test('null source columns stay null — never fabricated or coerced to empty strings', async () => {
    const { service } = makeService({
      tracked: [{ ...trackedRow, note: null }],
      bills: [{ ...billRow, status: null, latest_action_text: null, latest_action_date: null }],
    });
    const board = await service.getBoard(clientId, tenantId, userId);
    const card = board.columns.flatMap((c) => c.bills)[0];
    expect(card).toBeDefined();
    expect(card!.canonicalStatus).toBeNull();
    expect(card!.latestActionText).toBeNull();
    expect(card!.latestActionDate).toBeNull();
    expect(card!.note).toBeNull();
  });
});

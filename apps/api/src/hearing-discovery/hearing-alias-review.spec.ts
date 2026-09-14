import type { Prisma } from '@prisma/client';
import {
  validateOfficialAliasReview,
  type AliasReview,
  type ReviewedHearing,
} from './hearing-alias-review.js';
import { reconcileReviewedAliases } from './hearing-alias-reconciliation.js';

const review: AliasReview = {
  aliasId: 'cm-119-338740',
  canonicalId: 'sen-119-338740',
  reason: 'Exact official event ID confirmed in both sources',
  evidenceUrls: [
    'https://www.congress.gov/event/119th-Congress/senate-event/338740',
    'https://www.senate.gov/general/committee_schedules/hearings.xml',
  ],
};
const canonical: ReviewedHearing = {
  id: review.canonicalId,
  congress: 119,
  chamber: 'Senate',
  visibility: 'public',
  geographicJurisdiction: 'US',
  committeeSystemCode: 'ssju00',
  canonicalHearingId: null,
  title: 'Oversight of the Federal Bureau of Investigation',
  date: new Date('2026-09-15'),
  startsAt: new Date('2026-09-15T13:00:00Z'),
};
const alias: ReviewedHearing = {
  ...canonical,
  id: review.aliasId,
  congress: null,
  committeeSystemCode: null,
  committeeCode: 'ssju00',
};

describe('reviewed official hearing merge', () => {
  it('accepts exact publisher ID with legacy scope fields and independently qualified canonical row', () => {
    expect(() => validateOfficialAliasReview(review, alias, canonical)).not.toThrow();
  });
  it.each([
    ['different source ID', { id: 'cm-119-338741' }],
    ['different Congress', { congress: 118 }],
    ['state jurisdiction', { geographicJurisdiction: 'FL' }],
    ['different chamber', { chamber: 'House' }],
    ['private material into a public event', { visibility: 'private' }],
    ['unknown visibility', { visibility: 'unknown' }],
    ['different child committee', { subcommitteeSystemCode: 'ssju01' }],
    ['missing committee identity', { committeeCode: null }],
    ['different day', { date: new Date('2026-09-16') }],
    ['different time', { startsAt: new Date('2026-09-15T14:00:00Z') }],
    ['missing time', { startsAt: null }],
    ['different title', { title: 'Business meeting' }],
    ['existing alias chain', { canonicalHearingId: canonical.id }],
  ])('refuses %s', (_label, patch) => {
    expect(() => validateOfficialAliasReview(review, { ...alias, ...patch }, canonical)).toThrow();
  });
  it('rejects a lookalike publisher or a Congress URL for another event', () => {
    for (const url of [
      'https://senate.gov.example.org/338740',
      'https://www.congress.gov/event/119th-Congress/senate-event/338741',
    ])
      expect(() =>
        validateOfficialAliasReview(
          { ...review, evidenceUrls: [url, review.evidenceUrls[1]!] },
          alias,
          canonical,
        ),
      ).toThrow();
  });
});

function transaction() {
  return {
    $executeRawUnsafe: jest.fn(async (_sql: string, ..._values: unknown[]) => 1),
    $queryRaw: jest.fn(async () => [{ tableName: 'hearing_follow', columnName: 'hearing_id' }]),
    $queryRawUnsafe: jest.fn(async () => [{ source: 2n, target: 1n }]),
    committeeHearing: {
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === alias.id ? alias : canonical,
      ),
      count: jest.fn(async () => 0),
      update: jest.fn(async () => ({})),
    },
  };
}
describe('alias reconciliation deployment safety', () => {
  it('dry-run inventories references and a review hash without updating rows', async () => {
    const tx = transaction();
    const result = await reconcileReviewedAliases(
      tx as unknown as Prisma.TransactionClient,
      [review],
      { apply: false },
    );
    expect(result.mode).toBe('dry-run');
    expect(result.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tx.committeeHearing.update).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
  it('moves reference values without deleting reference rows and then records the retained alias', async () => {
    const tx = transaction();
    const dry = await reconcileReviewedAliases(
      tx as unknown as Prisma.TransactionClient,
      [review],
      { apply: false },
    );
    await reconcileReviewedAliases(tx as unknown as Prisma.TransactionClient, [review], {
      apply: true,
      expectedPlanHash: String(dry.planHash),
    });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      'UPDATE "hearing_follow" SET "hearing_id" = $2 WHERE "hearing_id" = $1',
      alias.id,
      canonical.id,
    );
    expect(tx.committeeHearing.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: alias.id },
        data: expect.objectContaining({ canonicalHearingId: canonical.id }),
      }),
    );
  });
  it('refuses a stale review and requires reference collisions to abort the transaction', async () => {
    const tx = transaction();
    const dry = await reconcileReviewedAliases(
      tx as unknown as Prisma.TransactionClient,
      [review],
      { apply: false },
    );
    tx.$queryRawUnsafe.mockResolvedValueOnce([{ source: 3n, target: 1n }]);
    await expect(
      reconcileReviewedAliases(tx as unknown as Prisma.TransactionClient, [review], {
        apply: true,
        expectedPlanHash: String(dry.planHash),
      }),
    ).rejects.toThrow('changed since review');
    tx.$executeRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE')) throw new Error('unique violation');
      return 1;
    });
    await expect(
      reconcileReviewedAliases(tx as unknown as Prisma.TransactionClient, [review], {
        apply: true,
        expectedPlanHash: String(dry.planHash),
      }),
    ).rejects.toThrow('unique violation');
    expect(tx.committeeHearing.update).not.toHaveBeenCalled();
  });
  it('exposes immutable saved-history references as a blocker in the dry run', async () => {
    const tx = transaction();
    tx.$queryRaw.mockResolvedValue([
      {
        tableName: 'hearing_source_permission',
        columnName: 'hearing_id',
        immutableGuards: [
          'hearing_permission_identity_immutable:hearing_permission_identity_immutable',
        ],
      },
    ] as never);
    const dry = await reconcileReviewedAliases(
      tx as unknown as Prisma.TransactionClient,
      [review],
      { apply: false },
    );
    expect(dry.readyToApply).toBe(false);
    expect(dry.blockedOperations).toEqual([
      expect.objectContaining({ table: 'hearing_source_permission', references: 2 }),
    ]);
    await expect(
      reconcileReviewedAliases(tx as unknown as Prisma.TransactionClient, [review], {
        apply: true,
        expectedPlanHash: String(dry.planHash),
      }),
    ).rejects.toThrow('blocked by immutable references');
    expect(tx.committeeHearing.update).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });
});

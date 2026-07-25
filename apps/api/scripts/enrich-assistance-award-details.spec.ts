import { describe, expect, jest, test } from '@jest/globals';
import {
  buildEnrichmentUpdate,
  enrichCandidates,
  type AwardDetailRaw,
  type EnrichPrisma,
  type ExistingAssistanceAwardRow,
} from './enrich-assistance-award-details.js';

const noSleep = async (_ms: number) => {};

// Detail fixture captured from a live, keyless call to
// GET /api/v2/awards/ASST_NON_2605CA5MAP_075/ on 2026-07-24 — see the
// script's header comment.
const MEDICAID_DETAIL: AwardDetailRaw = {
  fain: '2605CA5MAP',
  uri: '2605CA5MAP-192598338',
  subaward_count: 0,
  non_federal_funding: 0,
  funding_opportunity: { number: 'NOT APPLICABLE', goals: 'NOT APPLICABLE' } as never,
};

function row(overrides: Partial<ExistingAssistanceAwardRow> = {}): ExistingAssistanceAwardRow {
  return {
    id: 'row-1',
    awardUniqueId: 'ASST_NON_2605CA5MAP_075',
    fain: null,
    uri: null,
    subawardCount: null,
    nonFederalFundingAmount: null,
    fundingOpportunityNumber: null,
    parentRecipientName: null,
    parentRecipientUei: null,
    ...overrides,
  };
}

describe('parent recipient', () => {
  // A real UEI is 12 alphanumerics. A DUNS is 9 digits. USAspending still
  // returns the retired DUNS as `parent_recipient_unique_id` on many records,
  // and the two are easy to conflate because both look like "an id on the
  // recipient object".
  const VALID_UEI = 'ZQGGHJH74DW7';
  const RETIRED_DUNS = '192598338';

  test('fills name and UEI from the verified field names', () => {
    const update = buildEnrichmentUpdate(row(), {
      recipient: { parent_recipient_name: 'LELAND STANFORD JUNIOR UNIVERSITY', parent_recipient_uei: VALID_UEI },
    });
    expect(update.parentRecipientName).toBe('LELAND STANFORD JUNIOR UNIVERSITY');
    expect(update.parentRecipientUei).toBe(VALID_UEI);
  });

  test('never lets the retired DUNS reach the UEI column', () => {
    const update = buildEnrichmentUpdate(row(), {
      recipient: { parent_recipient_name: 'SOME PARENT', parent_recipient_unique_id: RETIRED_DUNS },
    });
    // The name still fills; the UEI column stays honestly empty rather than
    // being populated with an identifier nothing can join on.
    expect(update.parentRecipientName).toBe('SOME PARENT');
    expect(update).not.toHaveProperty('parentRecipientUei');
    expect(Object.values(update)).not.toContain(RETIRED_DUNS);
  });

  test('rejects a DUNS that arrives in the UEI field itself', () => {
    const update = buildEnrichmentUpdate(row(), {
      recipient: { parent_recipient_uei: RETIRED_DUNS },
    });
    expect(update).not.toHaveProperty('parentRecipientUei');
  });

  test('normalizes a lowercase UEI rather than discarding it', () => {
    const update = buildEnrichmentUpdate(row(), {
      recipient: { parent_recipient_uei: VALID_UEI.toLowerCase() },
    });
    expect(update.parentRecipientUei).toBe(VALID_UEI);
  });

  test('is fill-only — an existing parent UEI is never overwritten', () => {
    const update = buildEnrichmentUpdate(row({ parentRecipientUei: 'ALREADYSET1X' }), {
      recipient: { parent_recipient_uei: VALID_UEI },
    });
    expect(update).not.toHaveProperty('parentRecipientUei');
  });

  test('a detail response with no recipient block writes neither field', () => {
    const update = buildEnrichmentUpdate(row(), MEDICAID_DETAIL);
    expect(update).not.toHaveProperty('parentRecipientName');
    expect(update).not.toHaveProperty('parentRecipientUei');
  });
});

describe('buildEnrichmentUpdate', () => {
  test('fills every currently-null field from a verified detail response', () => {
    const update = buildEnrichmentUpdate(row(), MEDICAID_DETAIL);
    expect(update.fain).toBe('2605CA5MAP');
    expect(update.uri).toBe('2605CA5MAP-192598338');
    expect(update.subawardCount).toBe(0);
    expect(update.nonFederalFundingAmount).toBe(0);
    expect(update.fundingOpportunityNumber).toBe('NOT APPLICABLE');
    expect(update.detailEnrichedAt).toBeInstanceOf(Date);
  });

  test('never overwrites an existing non-null value, even with a different detail value', () => {
    const existing = row({ fain: 'ALREADY-SET-FAIN', uri: 'ALREADY-SET-URI' });
    const update = buildEnrichmentUpdate(existing, MEDICAID_DETAIL);
    expect('fain' in update).toBe(false);
    expect('uri' in update).toBe(false);
  });

  test('leaves a field absent from the update entirely when the detail response also lacks it', () => {
    const update = buildEnrichmentUpdate(row(), { fain: '2605CA5MAP' });
    expect('uri' in update).toBe(false);
    expect('subawardCount' in update).toBe(false);
    expect('nonFederalFundingAmount' in update).toBe(false);
    expect('fundingOpportunityNumber' in update).toBe(false);
    expect(update.fain).toBe('2605CA5MAP');
  });

  test('a zero value is a real value, not treated as missing', () => {
    // subaward_count: 0 and non_federal_funding: 0 must both be written —
    // `!= null` (not truthiness) is the correct guard for this exact reason.
    const update = buildEnrichmentUpdate(row(), { subaward_count: 0, non_federal_funding: 0 });
    expect(update.subawardCount).toBe(0);
    expect(update.nonFederalFundingAmount).toBe(0);
  });

  test('always stamps detailEnrichedAt even when the detail response adds nothing new', () => {
    const existing = row({
      fain: 'x', uri: 'x', subawardCount: 0, nonFederalFundingAmount: 0, fundingOpportunityNumber: 'x',
    });
    const update = buildEnrichmentUpdate(existing, MEDICAID_DETAIL);
    expect(Object.keys(update)).toEqual(['detailEnrichedAt']);
  });
});

function makePrismaMock(rows: ExistingAssistanceAwardRow[]) {
  const updateCalls: Array<{ where: { id: string }; data: unknown }> = [];
  return {
    updateCalls,
    federalAssistanceAward: {
      findMany: jest.fn(async () => rows),
      update: jest.fn(async (args: { where: { id: string }; data: unknown }) => {
        updateCalls.push(args);
        return args;
      }),
    },
  };
}

describe('enrichCandidates', () => {
  test('enriches each candidate and counts successes', async () => {
    const prisma = makePrismaMock([row({ id: 'a' }), row({ id: 'b', awardUniqueId: 'ASST_NON_OTHER_069' })]);
    const fetchAwardDetail = jest.fn(async (_id: string) => MEDICAID_DETAIL);

    const counts = await enrichCandidates(prisma as unknown as EnrichPrisma, 10, {
      fetchAwardDetail,
      sleep: noSleep,
    });

    expect(counts).toEqual({ inserted: 0, updated: 2, skipped: 0, errors: 0 });
    expect(prisma.updateCalls).toHaveLength(2);
    expect(fetchAwardDetail).toHaveBeenCalledTimes(2);
  });

  test('a failed detail fetch counts as an error and does not abort the remaining candidates', async () => {
    const prisma = makePrismaMock([row({ id: 'a' }), row({ id: 'b', awardUniqueId: 'ASST_NON_OTHER_069' })]);
    const fetchAwardDetail = jest
      .fn<(id: string) => Promise<AwardDetailRaw>>()
      .mockRejectedValueOnce(new Error('USAspending award detail 500'))
      .mockResolvedValueOnce(MEDICAID_DETAIL);

    const counts = await enrichCandidates(prisma as unknown as EnrichPrisma, 10, {
      fetchAwardDetail,
      sleep: noSleep,
    });

    expect(counts).toEqual({ inserted: 0, updated: 1, skipped: 0, errors: 1 });
    expect(prisma.updateCalls).toHaveLength(1);
  });

  test('passes the row id (not the award unique id) as the update key', async () => {
    const prisma = makePrismaMock([row({ id: 'row-uuid-123' })]);
    const fetchAwardDetail = jest.fn(async (_id: string) => MEDICAID_DETAIL);

    await enrichCandidates(prisma as unknown as EnrichPrisma, 10, { fetchAwardDetail, sleep: noSleep });

    expect(prisma.updateCalls[0]?.where).toEqual({ id: 'row-uuid-123' });
  });

  test('respects the limit passed through to findMany', async () => {
    const prisma = makePrismaMock([]);
    await enrichCandidates(prisma as unknown as EnrichPrisma, 42, {
      fetchAwardDetail: jest.fn(async (_id: string) => MEDICAID_DETAIL),
      sleep: noSleep,
    });
    expect(prisma.federalAssistanceAward.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 42, where: { detailEnrichedAt: null } }),
    );
  });
});

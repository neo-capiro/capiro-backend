import { MeriToolsService } from './meri-tools.service.js';
import { envelopeBillStatusResult, observeBillStatusCall } from './meri-bill-status-envelope.js';

const request = { billId: '119-hr-8800' };
const generatedAt = '2026-09-25T12:00:00.000Z';

function foundPayload(extra: Record<string, unknown> = {}) {
  return {
    tool: 'get_bill_status', generatedAt, billId: request.billId,
    found: true, congress: 119, title: 'NDAA', status: 'rule_failed',
    statusAt: new Date('2026-06-30T00:00:00.000Z'),
    latestAction: { text: 'Rules Committee Resolution Reported', date: new Date('2026-06-30') },
    recentActions: [{ text: 'Rules Committee Resolution Reported', date: new Date('2026-06-30') }],
    floorVotes: [],
    governingRules: [{
      ruleBillId: '119-hres-1398', ruleTitle: 'Rule for H.R. 8800',
      ruleStatus: 'failed', ruleLatestAction: 'Rule failed passage',
      ruleVotes: [{ rollNumber: 232, result: 'Failed', sourceUrl: 'https://clerk.house.gov/votes/232' }],
    }],
    ...extra,
  };
}

describe('get_bill_status result envelope (dormant success observer)', () => {
  it('observes unresolved input as not queried and never treats it as a DB miss', async () => {
    const findUnique = jest.fn();
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    (service as unknown as { prisma: unknown }).prisma = { congressBill: { findUnique } };
    const call = (service as unknown as { getBillStatus: (input: Record<string, unknown>) => Promise<Record<string, unknown>> })
      .getBillStatus.bind(service);
    const input = { billId: 'H.R. 8800' };
    const observe = jest.fn();
    const legacy = await observeBillStatusCall(() => call(input), input, observe);

    expect(findUnique).not.toHaveBeenCalled();
    expect(legacy).toMatchObject({ tool: 'get_bill_status', found: false });
    const envelope = observe.mock.calls[0]![0];
    expect(envelope.legacyPayload).toBe(legacy);
    expect(envelope.outcome).toBe('needs_input');
    expect(envelope.sources).toEqual([expect.objectContaining({
      sourceId: 'congress_bill', availability: 'not_queried', observedAt: null,
      scope: { storage: 'capiro_local_database', resolution: 'unresolved' },
      coverage: { completeness: 'unknown', matchedCount: null }, provenance: [],
    })]);
    expect(envelope.outcome).not.toBe('not_found_within_scope');
  });

  it('limits an exact miss to the canonical local DB key, including resolved designations', async () => {
    const findUnique = jest.fn(async () => null);
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    (service as unknown as { prisma: unknown }).prisma = { congressBill: { findUnique } };
    const call = (service as unknown as { getBillStatus: (input: Record<string, unknown>) => Promise<Record<string, unknown>> })
      .getBillStatus.bind(service);
    const input = { billId: 'H.R. 8800', congress: 119 };
    const legacy = await call(input);
    const envelope = envelopeBillStatusResult(legacy, input);

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: request.billId } }));
    expect(legacy).toMatchObject({ found: false, billId: request.billId });
    expect(envelope.outcome).toBe('not_found_within_scope');
    expect(envelope.legacyPayload).toBe(legacy);
    expect(envelope.sources).toEqual([expect.objectContaining({
      sourceId: 'congress_bill', availability: 'available', observedAt: null,
      scope: { storage: 'capiro_local_database', billId: request.billId, lookup: 'exact_id' },
      coverage: {
        completeness: 'complete', continuation: { hasMore: false },
        returnedCount: 0, matchedCount: 0,
      },
      provenance: [],
    })]);
  });

  it('keeps status, actions, bill votes, rule links, and rule votes distinct', () => {
    const legacy = foundPayload();
    const envelope = envelopeBillStatusResult(legacy, request);

    expect(envelope.outcome).toBe('succeeded');
    expect(envelope.legacyPayload).toBe(legacy);
    expect(envelope.sources.map((source) => source.sourceId)).toEqual([
      'congress_bill', 'congress_bill_action', 'roll_call_vote', 'bill_rule_link', 'roll_call_vote',
    ]);
    expect(envelope.sources[0]).toMatchObject({
      scope: { billId: request.billId, storage: 'capiro_local_database' },
      coverage: { completeness: 'complete', returnedCount: 1, matchedCount: 1 },
      provenance: [{ recordId: request.billId, sourceId: 'congress_bill' }],
    });
    expect(envelope.sources[1]!.coverage).toMatchObject({ completeness: 'complete', returnedCount: 1, matchedCount: 1 });
    expect(envelope.sources[2]).toMatchObject({
      scope: { billId: request.billId, voteRole: 'bill' },
      coverage: { completeness: 'complete', returnedCount: 0, matchedCount: 0 },
    });
    expect(envelope.sources[3]!.coverage).toMatchObject({ completeness: 'complete', returnedCount: 1 });
    expect(envelope.sources[4]).toMatchObject({
      scope: { billId: '119-hres-1398', voteRole: 'governing_rule' },
      coverage: { completeness: 'complete', returnedCount: 1, matchedCount: 1 },
    });
    expect(envelope.sources.every((source) => source.observedAt === null)).toBe(true);
    expect(envelope.sources.slice(1).every((source) => source.provenance.length === 0)).toBe(true);
    expect(envelope.truncation).toEqual({ truncated: false });
  });

  it('treats exact caps as possible truncation without inventing totals or continuation', () => {
    const actions = Array.from({ length: 15 }, (_, i) => ({ text: `Action ${i}` }));
    const votes = Array.from({ length: 15 }, (_, i) => ({ rollNumber: i + 1 }));
    const ruleVotes = Array.from({ length: 3 }, (_, i) => ({ rollNumber: i + 1 }));
    const legacy = foundPayload({
      recentActions: actions, floorVotes: votes,
      governingRules: [{ ruleBillId: '119-hres-1398', ruleStatus: 'failed', ruleVotes }],
    });
    const envelope = envelopeBillStatusResult(legacy, request);

    expect(envelope.outcome).toBe('partial');
    expect(envelope.truncation).toEqual({ truncated: true, reason: 'possible_local_result_cap' });
    for (const source of [envelope.sources[1], envelope.sources[2], envelope.sources[4]]) {
      expect(source!.coverage).toMatchObject({ completeness: 'partial', matchedCount: null });
      expect(source!.coverage).not.toHaveProperty('continuation');
      expect(source!.provenance).toEqual([]);
    }
    expect(envelope.sources[3]!.coverage.completeness).toBe('complete');
  });

  it('does not upgrade mismatched, contradictory, or foreign payloads into absence', () => {
    const inputs = [
      [{ tool: 'get_bill_status', found: false, billId: '119-hr-9999' }, request],
      [{ tool: 'get_bill_status', found: false }, request],
      [{ tool: 'get_bill_status', found: false, billId: request.billId, floorVotes: [] }, request],
      [{ tool: 'foreign_tool', found: false }, { billId: 'H.R. 8800' }],
    ] as const;
    for (const [legacy, input] of inputs) {
      const envelope = envelopeBillStatusResult(legacy, input);
      expect(envelope.outcome).toBe('partial');
      expect(envelope.sources).toEqual([expect.objectContaining({
        availability: 'unknown', scope: { storage: 'capiro_local_database', resolution: 'unverified' },
        coverage: { completeness: 'unknown', matchedCount: null },
      })]);
      expect(envelope.errors).toEqual([{ code: 'bill_status_observation_unverified' }]);
    }
  });

  it('leaves malformed collections and missing status unknown without fabricating row IDs', () => {
    const legacy = foundPayload({
      status: null,
      recentActions: Array.from({ length: 16 }, (_, i) => ({ text: `Action ${i}` })),
      floorVotes: 'not-an-array',
      governingRules: [{ ruleBillId: 'not-a-canonical-id', ruleVotes: [] }],
    });
    const envelope = envelopeBillStatusResult(legacy, request);
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources.slice(1).map((source) => source.coverage.completeness)).toEqual([
      'unknown', 'unknown', 'unknown',
    ]);
    expect(envelope.sources).toHaveLength(4);
    expect(envelope.sources.slice(1).every((source) => source.provenance.length === 0)).toBe(true);
    expect(envelope.errors).toEqual([{ code: 'bill_status_coverage_unverified' }]);
    expect(envelope.truncation).toEqual({ truncated: false });
  });

  it('returns the exact success object, suppresses observer errors, and propagates rejection by identity', async () => {
    const legacy = foundPayload();
    const observe = jest.fn();
    await expect(observeBillStatusCall(async () => legacy, request, observe)).resolves.toBe(legacy);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ legacyPayload: legacy }));

    const observations: unknown[] = [];
    await expect(observeBillStatusCall(async () => legacy, request,
      (envelope) => observations.push(envelope))).resolves.toBe(legacy);
    expect(observations).toHaveLength(1);

    await expect(observeBillStatusCall(async () => legacy, request, () => {
      throw new Error('observer unavailable');
    })).resolves.toBe(legacy);

    const error = new Error('bill lookup failed');
    const rejectedObserver = jest.fn();
    await expect(observeBillStatusCall(async () => { throw error; }, request, rejectedObserver)).rejects.toBe(error);
    expect(rejectedObserver).not.toHaveBeenCalled();
  });

  it('returns the exact bill result without waiting for an async observer', async () => {
    const legacy = foundPayload();
    const pending = new Promise<void>(() => undefined);

    await expect(observeBillStatusCall(async () => legacy, request, () => pending))
      .resolves.toBe(legacy);
    await expect(observeBillStatusCall(async () => legacy, request, () =>
      Promise.reject(new Error('observer rejected')))).resolves.toBe(legacy);
  });
});

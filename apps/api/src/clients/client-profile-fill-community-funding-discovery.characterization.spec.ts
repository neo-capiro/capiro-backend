import {
  clientId,
  communityRow,
  ctx,
  harness,
  installHooks,
  now,
  runId,
} from '../../test/fixtures/client-profile-fill-advocacy-history.js';

installHooks();
const oldAt = '2025-01-01T00:00:00.000Z';
const scanAt = new Date('2026-01-02T00:00:00.000Z');
const prior = {
  startedAt: oldAt,
  historyStart: oldAt,
  examined: 7,
  candidates: 3,
  checkpoint: { createdAt: oldAt, key: 'prior-key' },
};
const row = (id: string, overrides: Record<string, unknown> = {}) =>
  communityRow({ id, createdAt: scanAt, ...overrides });
const fuzzy = (id: string, score = 0.9) =>
  row(id, {
    recipientName: 'Acme Systems',
    recipientNormalized: 'ACME SYSTEMS',
    recipientSimilarity: score,
    state: 'VA',
  });

describe('Community funding discovery — scope and continuation', () => {
  test('exhausted shared budget preserves the prior checkpoint without reading any source', async () => {
    const h = harness();
    expect(
      await h.community({
        currentCount: 200,
        lastCreatedAt: oldAt,
        lastKey: 'old-key',
        priorState: prior,
      }),
    ).toMatchObject({
      count: 0,
      newestCreatedAt: oldAt,
      newestKey: 'old-key',
      backfill: { status: 'in_progress', checkpoint: prior.checkpoint, examined: 7, candidates: 3 },
    });
    expect(h.captures.global).toEqual([]);
    expect(h.captures.models).toEqual([]);
  });

  test('missing client identity completes without canonical source or facility reads', async () => {
    const h = harness({ clientName: null });
    expect(
      await h.community({ lastCreatedAt: oldAt, lastKey: 'old-key', priorState: prior }),
    ).toMatchObject({
      count: 0,
      newestCreatedAt: oldAt,
      newestKey: 'old-key',
      backfill: {
        status: 'complete',
        startedAt: oldAt,
        completedAt: now.toISOString(),
        checkpoint: prior.checkpoint,
      },
    });
    expect(h.captures.global).toEqual([]);
    expect(h.captures.findings).toEqual([]);
  });
});

describe('Community funding discovery — scoped canonical lookup', () => {
  test('confirmed requests use a global uncursored rail while resumed scan uses the saved checkpoint', async () => {
    const h = harness({
      confirmedKeys: { community_funding: ['confirmed'] },
      globalRows: { communityConfirmed: [row('confirmed')] },
    });
    await h.community({
      lastCreatedAt: '2024-01-01T00:00:00.000Z',
      lastKey: 'published-key',
      priorState: prior,
    });
    const confirmed = h.captures.global.find((call) => call.rail === 'communityConfirmed')!;
    expect(confirmed.args).toEqual([['confirmed']]);
    expect(confirmed.transaction).toBeNull();
    expect(confirmed.sql).toContain('WHERE r.id = ANY($1::uuid[])');
    expect(confirmed.sql).toContain('ORDER BY r.created_at ASC, r.id ASC');
    expect(confirmed.sql).toContain('LIMIT 200');
    expect(confirmed.sql).not.toContain('tenant_id');
    const scan = h.captures.global.find((call) => call.rail === 'communityScan')!;
    expect(scan.args.slice(1)).toEqual([oldAt, 'prior-key', 500]);
    expect(scan.sql).toContain('r.created_at = $2::timestamptz AND r.id > $3::uuid');
    expect(scan.sql).toContain('requested_amount_usd::text');
    expect(scan.sql).toContain('final_amount_usd::text');
    expect(h.captures.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'name',
          tenantId: ctx.tenantId,
          args: [{ where: { id: clientId }, select: { id: true, name: true } }],
        }),
        expect.objectContaining({
          operation: 'mapping',
          tenantId: ctx.tenantId,
          args: [
            {
              where: { clientId, source: 'community_funding', confirmed: true },
              select: { externalId: true },
            },
          ],
        }),
        expect.objectContaining({
          operation: 'facilities',
          tenantId: ctx.tenantId,
          args: [{ where: { clientId }, select: { state: true } }],
        }),
      ]),
    );
  });
});

describe('Community funding discovery — scan frontier', () => {
  test('completed history scans from published watermarks and stays complete for a full new batch', async () => {
    const rows = Array.from({ length: 500 }, (_, index) =>
      row(`scan-${index}`, {
        recipientName: 'Other',
        recipientNormalized: 'OTHER',
        recipientSimilarity: 0,
      }),
    );
    const h = harness({ globalRows: { communityScan: rows } });
    const result = await h.community({
      lastCreatedAt: oldAt,
      lastKey: 'published-key',
      priorState: { ...prior, status: 'complete' },
    });
    expect(h.captures.global.find((call) => call.rail === 'communityScan')!.args.slice(1)).toEqual([
      oldAt,
      'published-key',
      500,
    ]);
    expect(result).toMatchObject({
      count: 0,
      newestCreatedAt: scanAt.toISOString(),
      newestKey: 'scan-499',
      backfill: { status: 'complete', examined: 507 },
    });
  });

  test('a capped scan advances its whole-batch checkpoint but retains published watermarks until complete', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => row(`scan-${index}`));
    const h = harness({ globalRows: { communityScan: rows } });
    expect(
      await h.community({
        currentCount: 199,
        lastCreatedAt: oldAt,
        lastKey: 'published-key',
        priorState: prior,
      }),
    ).toMatchObject({
      count: 1,
      newestCreatedAt: oldAt,
      newestKey: 'published-key',
      backfill: {
        status: 'in_progress',
        examined: 507,
        candidates: 4,
        checkpoint: { createdAt: scanAt.toISOString(), key: 'scan-499' },
      },
    });
    expect(h.captures.findings).toHaveLength(1);
  });
});

describe('Community funding discovery — canonical recipient matching', () => {
  test('confirmed mapping overrides recipient name and emits one factual review finding per request', async () => {
    const h = harness({
      confirmedKeys: { community_funding: ['confirmed'] },
      globalRows: {
        communityConfirmed: [
          row('confirmed', {
            recipientName: 'Unrelated Recipient',
            recipientNormalized: 'UNRELATED RECIPIENT',
          }),
        ],
        communityScan: [row('confirmed')],
      },
    });
    const result = await h.community({});
    expect(result).toMatchObject({
      count: 1,
      backfill: { examined: 2, candidates: 1, status: 'complete' },
    });
    expect(h.captures.findings).toHaveLength(1);
    expect(h.captures.findings[0]).toMatchObject({
      runId,
      tenantId: ctx.tenantId,
      clientId,
      kind: 'advocacy_record',
      targetKey: 'advocacy:community_funding:confirmed',
      source: 'advocacy_history',
      factKind: 'fact',
      confidence: 1,
      status: 'pending',
      proposedValue: {
        sourceType: 'community_funding',
        sourceId: 'confirmed',
        evidenceClass: 'PUBLIC_VERIFIED',
        metadata: {
          clientMatch: { method: 'confirmed_client_intel_mapping', matchedRole: 'recipient' },
        },
      },
    });
  });
});

describe('Community funding discovery — exact recipient attribution', () => {
  test('exact recipient emits a recommendation and preserves decimal amount strings and funding disclaimer', async () => {
    const h = harness({
      globalRows: {
        communityScan: [
          row('exact', {
            requestedAmountUsd: '9007199254740993.25',
            finalAmountUsd: '123.45',
            requesterName: 'Senator Other',
          }),
        ],
      },
    });
    expect(await h.community({})).toMatchObject({ count: 1 });
    const finding = h.captures.findings[0]!;
    expect(finding).toMatchObject({
      factKind: 'recommendation',
      confidence: 0.98,
      proposedValue: {
        metadata: {
          requestedAmountUsd: '9007199254740993.25',
          finalAmountUsd: '123.45',
          requesterName: 'Senator Other',
          clientMatch: { method: 'exact_recipient_normalized', matchedRole: 'recipient' },
        },
      },
    });
    expect(finding.proposedValue.summary).toContain('$123.45');
    expect(finding.proposedValue.summary).toContain('does not by itself prove');
  });

  test('a requester name match never supplies recipient identity', async () => {
    const h = harness({
      globalRows: {
        communityScan: [
          row('requester-only', {
            requesterName: 'Acme Research',
            recipientName: 'Other Recipient',
            recipientNormalized: 'OTHER RECIPIENT',
            recipientSimilarity: 0.1,
          }),
        ],
      },
    });
    expect(await h.community({})).toMatchObject({ count: 0, backfill: { examined: 1 } });
    expect(h.captures.findings).toEqual([]);
  });
});

describe('Community funding discovery — geography and ambiguity', () => {
  test('strong fuzzy recipient similarity without independent geography remains unclassified', async () => {
    const h = harness({
      facilityStates: ['MD', 'Virginia'],
      globalRows: { communityScan: [fuzzy('fuzzy')] },
    });
    expect(await h.community({})).toMatchObject({ count: 0, backfill: { examined: 1 } });
    expect(h.captures.findings).toEqual([]);
  });

  test('trimmed uppercase facility geography corroborates a strong fuzzy recipient', async () => {
    const h = harness({
      facilityStates: [' va ', null, 'Virginia'],
      globalRows: { communityScan: [fuzzy('fuzzy')] },
    });
    expect(await h.community({})).toMatchObject({ count: 1 });
    expect(h.captures.findings[0]).toMatchObject({
      confidence: 0.91,
      factKind: 'recommendation',
      proposedValue: {
        metadata: {
          clientMatch: {
            method: 'fuzzy_recipient_with_geography',
            geographyCorroborated: true,
            similarity: 0.9,
          },
        },
      },
    });
  });

  test('a tied best fuzzy score drops all fuzzy candidates while retaining exact recipients', async () => {
    const h = harness({
      facilityStates: ['VA'],
      globalRows: {
        communityScan: [fuzzy('tie-a'), fuzzy('tie-b'), fuzzy('lower', 0.8), row('exact')],
      },
    });
    expect(await h.community({})).toMatchObject({ count: 1, backfill: { examined: 4 } });
    expect(h.captures.findings.map((finding) => finding.proposedValue.sourceId)).toEqual(['exact']);
  });

  test('a unique best fuzzy score permits distinct weaker geography-backed recipients', async () => {
    const h = harness({
      facilityStates: ['VA'],
      globalRows: { communityScan: [fuzzy('best'), fuzzy('lower', 0.8)] },
    });
    expect(await h.community({})).toMatchObject({ count: 2 });
    expect(h.captures.findings.map((finding) => finding.proposedValue.sourceId)).toEqual([
      'best',
      'lower',
    ]);
  });
});

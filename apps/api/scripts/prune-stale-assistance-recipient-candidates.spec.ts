import { describe, expect, jest, test } from '@jest/globals';
import {
  classifyCandidate,
  isPruneVerdict,
  parseArgs,
  pruneStaleCandidates,
  type CandidateRow,
  type PrunePrisma,
} from './prune-stale-assistance-recipient-candidates.js';

function row(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: 'map-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientName: 'Olivet University',
    clientUei: null,
    externalId: 'DUKE-UEI-0001',
    externalName: 'DUKE UNIVERSITY',
    confidence: 0.5,
    confirmed: false,
    ...over,
  };
}

describe('classifyCandidate — reproduces the fixed matcher verdict', () => {
  test('the real 2026-07-27 failure (Olivet -> DUKE UNIVERSITY, $4.2B) is pruned', () => {
    // Both names share the distinctive token "university", so the generic-token
    // guard alone does NOT catch this one — it is pruned because it is not
    // fingerprint-exact, which is the rule the matcher now applies to this
    // source unconditionally.
    expect(classifyCandidate(row())).toBe('prune_name_similarity_only');
  });

  test('SANTA ROSA COUNTY -> COUNTY OF SANTA CLARA is pruned', () => {
    expect(
      classifyCandidate(
        row({ clientName: 'SANTA ROSA COUNTY', externalName: 'COUNTY OF SANTA CLARA' }),
      ),
    ).toBe('prune_name_similarity_only');
  });

  test('a pure generic-token collision is pruned and labelled as such', () => {
    expect(
      classifyCandidate(row({ clientName: 'RTX Corporation', externalName: 'FOX CORPORATION' })),
    ).toBe('prune_no_distinctive_token');
  });

  test('National Wildlife Federation -> NATIONAL FISH AND WILDLIFE FOUNDATION is pruned', () => {
    expect(
      classifyCandidate(
        row({
          clientName: 'National Wildlife Federation',
          externalName: 'NATIONAL FISH AND WILDLIFE FOUNDATION',
        }),
      ),
    ).toBe('prune_name_similarity_only');
  });

  test('a verified UEI match is KEPT — this is the strongest signal the source has', () => {
    expect(
      classifyCandidate(
        row({ clientUei: 'ABC123DEF456', externalId: 'ABC123DEF456', externalName: 'ANYTHING AT ALL' }),
      ),
    ).toBe('keep_uei_match');
  });

  test('UEI comparison is case-insensitive and whitespace-tolerant', () => {
    expect(
      classifyCandidate(row({ clientUei: ' abc123def456 ', externalId: 'ABC123DEF456' })),
    ).toBe('keep_uei_match');
  });

  test('a UEI-shaped externalId that does NOT match the client UEI is not a keep', () => {
    expect(
      classifyCandidate(row({ clientUei: 'ABC123DEF456', externalId: 'ZZZ999YYY888' })),
    ).toBe('prune_name_similarity_only');
  });

  test('an externalId that is not UEI-shaped can never trigger the UEI keep', () => {
    // Guards against a name accidentally equalling a client's UEI field.
    expect(
      classifyCandidate(row({ clientUei: 'DUKE UNIVERSITY', externalId: 'DUKE UNIVERSITY' })),
    ).toBe('prune_name_similarity_only');
  });

  test('a fingerprint-exact name is KEPT even without a UEI', () => {
    expect(
      classifyCandidate(
        row({ clientName: 'RTX Corporation', externalName: 'RTX CORPORATION', clientUei: null }),
      ),
    ).toBe('keep_fingerprint_exact');
  });

  test('fingerprint equality ignores corporate suffixes and punctuation', () => {
    expect(
      classifyCandidate(row({ clientName: 'Acme Widgets, Inc.', externalName: 'ACME WIDGETS LLC' })),
    ).toBe('keep_fingerprint_exact');
  });

  test('two names that both fingerprint to empty are NOT treated as an exact match', () => {
    // "Inc." and "LLC" both normalise to "", and "" === "" must never be read
    // as identity — that would keep a mapping between two entities we know
    // nothing about. It lands on a prune verdict rather than
    // keep_fingerprint_exact; which prune label is incidental (sharesDistinctive
    // Token answers "true" for an empty side by design — "can't judge, don't
    // penalise"), so only the keep/prune decision is pinned here.
    const verdict = classifyCandidate(row({ clientName: 'Inc.', externalName: 'LLC' }));
    expect(verdict).not.toBe('keep_fingerprint_exact');
    expect(isPruneVerdict(verdict)).toBe(true);
  });

  test('a confirmed row is always keep_confirmed, whatever the names say', () => {
    expect(classifyCandidate(row({ confirmed: true }))).toBe('keep_confirmed');
  });
});

describe('parseArgs', () => {
  test('dry run is the default', () => {
    expect(parseArgs(['node', 'script'])).toEqual({ commit: false, tenantId: null });
  });

  test('--commit and --tenant are read in both spellings', () => {
    expect(parseArgs(['node', 'script', '--commit', '--tenant', 't-1'])).toEqual({
      commit: true,
      tenantId: 't-1',
    });
    expect(parseArgs(['node', 'script', '--tenant=t-2'])).toEqual({
      commit: false,
      tenantId: 't-2',
    });
  });
});

function harness(rows: CandidateRow[]) {
  const del = jest.fn(async (_args: { where: { id: string } }) => ({}));
  const queryRaw = jest.fn(async () => rows);
  const executeRawUnsafe = jest.fn(async (_sql: string) => 0);
  const prisma = {
    $transaction: async (fn: (tx: PrunePrisma) => Promise<unknown>) => fn(prisma),
    $executeRawUnsafe: executeRawUnsafe,
    $queryRaw: queryRaw,
    clientIntelMapping: { delete: del },
  } as unknown as PrunePrisma;
  return { prisma, del, queryRaw, executeRawUnsafe };
}

describe('pruneStaleCandidates', () => {
  const MIXED = [
    row({ id: 'stale-1' }),
    row({ id: 'stale-2', clientName: 'RTX Corporation', externalName: 'CSX CORPORATION' }),
    row({ id: 'keep-uei', clientUei: 'ABC123DEF456', externalId: 'ABC123DEF456' }),
    row({ id: 'keep-exact', clientName: 'Acme Widgets', externalName: 'ACME WIDGETS' }),
  ];

  test('a dry run deletes nothing but reports exactly what it would delete', async () => {
    const h = harness(MIXED);

    const result = await pruneStaleCandidates(h.prisma, { tenantId: null, commit: false });

    expect(h.del).not.toHaveBeenCalled();
    expect(result.scanned).toBe(4);
    expect(result.pruned).toBe(2);
    expect(result.kept).toBe(2);
    expect(result.prunedIds).toEqual(['stale-1', 'stale-2']);
    expect(result.byVerdict).toMatchObject({
      keep_uei_match: 1,
      keep_fingerprint_exact: 1,
      prune_name_similarity_only: 1,
      prune_no_distinctive_token: 1,
    });
    // The dry run is an audit artifact: every pruned row is explained.
    expect(result.prunedDetail).toHaveLength(2);
    expect(result.prunedDetail[0]).toContain('DUKE UNIVERSITY');
  });

  test('--commit deletes only the stale ids, one at a time, never a bulk filter', async () => {
    const h = harness(MIXED);

    const result = await pruneStaleCandidates(h.prisma, { tenantId: null, commit: true });

    expect(result.pruned).toBe(2);
    expect(h.del.mock.calls.map(([args]) => args.where.id)).toEqual(['stale-1', 'stale-2']);
    expect(h.del).toHaveBeenCalledTimes(2);
  });

  test('a confirmed row is never deleted, even if it somehow reaches the loop', async () => {
    // The SQL already filters confirmed rows out; this pins the in-loop
    // re-assertion, which is the guard that matters if the query ever drifts.
    const h = harness([row({ id: 'confirmed-1', confirmed: true })]);

    const result = await pruneStaleCandidates(h.prisma, { tenantId: null, commit: true });

    expect(h.del).not.toHaveBeenCalled();
    expect(result.pruned).toBe(0);
    expect(result.kept).toBe(1);
    expect(result.byVerdict.keep_confirmed).toBe(1);
  });

  test('the load query always sets the RLS bypass', async () => {
    const h = harness(MIXED);
    await pruneStaleCandidates(h.prisma, { tenantId: 'tenant-1', commit: false });
    expect(h.executeRawUnsafe).toHaveBeenCalledWith(
      "SELECT set_config('app.bypass_rls', 'on', true)",
    );
  });

  test('a failed delete is counted as an error and does not abort the rest', async () => {
    const h = harness(MIXED);
    h.del.mockImplementationOnce(async () => {
      throw new Error('deadlock detected');
    });

    const result = await pruneStaleCandidates(h.prisma, { tenantId: null, commit: true });

    expect(result.errors).toBe(1);
    expect(result.pruned).toBe(1);
    expect(h.del).toHaveBeenCalledTimes(2);
  });

  test('is idempotent: a second run over the post-prune set deletes nothing', async () => {
    const survivors = MIXED.filter((r) => r.id.startsWith('keep-'));
    const h = harness(survivors);

    const result = await pruneStaleCandidates(h.prisma, { tenantId: null, commit: true });

    expect(h.del).not.toHaveBeenCalled();
    expect(result.pruned).toBe(0);
    expect(result.kept).toBe(2);
  });
});

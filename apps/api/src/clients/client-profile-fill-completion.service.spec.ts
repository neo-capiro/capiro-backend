import {
  buildClientProfileFillCompletionPlan,
  calculateProfileCompletion,
  faraMatchConfidence,
  mergeFillProgress,
  matchAdvocacyOutcomeDeterministically,
  planTestimonyScanBatch,
  sameActivityDay,
  scoreAdvocacyOutcome,
  testimonyMatchConfidence,
  titleOverlapRatio,
} from './client-profile-fill-completion.service.js';

/** Builds a minimal testimony scan-batch row for planTestimonyScanBatch tests. */
function scanRow(
  hearingId: string,
  witnessText: string,
  syncedAt: string,
  similarity: number,
) {
  return {
    hearingId,
    title: `Hearing ${hearingId}`,
    committeeName: 'Armed Services',
    chamber: 'House',
    date: new Date('2026-01-01T00:00:00.000Z'),
    url: null,
    syncedAt: new Date(syncedAt),
    witnessText,
    similarity,
  };
}

describe('Fill with Meri completion workflow', () => {
  test('builds the downstream graph in dependency order', () => {
    const plan = buildClientProfileFillCompletionPlan();
    const byKey = new Map(plan.map((task) => [task.taskKey, task]));

    expect(plan.map((task) => task.taskKey)).toEqual([
      'federal_market',
      'facility_resolution',
      'district_nexus',
      'advocacy_history',
      'lifecycle_outcomes',
      'reconciliation',
      'completion_audit',
    ]);
    expect(byKey.get('district_nexus')?.dependsOn).toEqual(['facility_resolution']);
    expect(byKey.get('lifecycle_outcomes')?.dependsOn).toEqual([
      'advocacy_history',
      'federal_market',
    ]);
    expect(byKey.get('completion_audit')?.dependsOn).toEqual(['reconciliation']);
  });

  test('merges progress across the core and completion ledgers', () => {
    expect(
      mergeFillProgress([
        { status: 'completed' },
        { status: 'completed' },
        { status: 'running' },
        { status: 'queued' },
        { status: 'failed' },
        { status: 'cancelled' },
      ]),
    ).toEqual({
      total: 6,
      queued: 1,
      running: 1,
      completed: 2,
      failed: 1,
      cancelled: 1,
    });
  });

  test('calculates completion only from the declared profile domains', () => {
    const result = calculateProfileCompletion({
      federalIdentity: true,
      website: true,
      overview: true,
      governmentIdentity: true,
      capabilities: true,
      relationships: false,
      facilities: true,
      districtNexus: false,
      federalMarket: true,
      lobbyingHistory: true,
      advocacyHistory: true,
      programElements: true,
      bills: false,
    });

    expect(result.score).toBe(77);
    expect(result.completed).toContain('Advocacy history');
    expect(result.missing).toEqual([
      'Relationships and history',
      'District Nexus',
      'Bill recommendations',
    ]);
  });

  test('scores an exact authoritative source link above a loose textual overlap', () => {
    const advocacy = {
      title: 'FY27 autonomous systems funding request',
      summary: 'Request funding for Army ground robotics.',
      sourceType: 'submission',
      sourceId: 'submission-1',
      metadata: { programElement: '0605053A' },
    };
    const exact = scoreAdvocacyOutcome(advocacy, {
      kind: 'funding_changed',
      sourceType: 'submission',
      sourceId: 'submission-1',
      notes: 'Army ground robotics funding changed.',
      evidence: { programElement: '0605053A' },
    });
    const loose = scoreAdvocacyOutcome(advocacy, {
      kind: 'meeting_held',
      sourceType: 'meeting',
      sourceId: 'meeting-2',
      notes: 'General autonomous systems discussion.',
      evidence: {},
    });

    expect(exact).toBeGreaterThan(loose);
    expect(exact).toBeLessThanOrEqual(0.99);
  });

  test('matches deterministically on exact PE code before any semantic scoring is even needed (§16 priority 1)', () => {
    const matched = matchAdvocacyOutcomeDeterministically(
      { primaryPeCode: '0605053A', primaryBillId: null },
      { peCode: '0605053A', fiscalYear: 2027, stage: 'HAC-D', amountFrom: 12_000_000, amountTo: 30_000_000 },
    );
    expect(matched).toEqual({ matchedOn: 'pe_code', score: 0.95 });
  });

  test('matches deterministically on exact bill ID (§16 priority 2)', () => {
    const matched = matchAdvocacyOutcomeDeterministically(
      { primaryPeCode: null, primaryBillId: '119-hr-1234' },
      { billNumber: '119-hr-1234' },
    );
    expect(matched).toEqual({ matchedOn: 'bill_id', score: 0.95 });
  });

  test('never fabricates a deterministic match — a different PE code, an undefined Matter, or empty evidence all fall through to null', () => {
    expect(
      matchAdvocacyOutcomeDeterministically({ primaryPeCode: '0605053A', primaryBillId: null }, { peCode: '0605055A' }),
    ).toBeNull();
    expect(
      matchAdvocacyOutcomeDeterministically(undefined, { peCode: '0605053A' }),
    ).toBeNull();
    expect(
      matchAdvocacyOutcomeDeterministically({ primaryPeCode: '0605053A', primaryBillId: null }, {}),
    ).toBeNull();
    // A Matter with no PE/bill identifiers of its own can never deterministically match anything.
    expect(
      matchAdvocacyOutcomeDeterministically({ primaryPeCode: null, primaryBillId: null }, { peCode: '0605053A', billNumber: '119-hr-1234' }),
    ).toBeNull();
  });

  test('§27: sameActivityDay is the deterministic gate before any text-similarity check', () => {
    expect(sameActivityDay('2026-03-12T14:00:00.000Z', '2026-03-12T09:00:00.000Z')).toBe(true); // same day, different time
    expect(sameActivityDay('2026-03-12T00:00:00.000Z', '2026-03-13T00:00:00.000Z')).toBe(false); // one day apart
    expect(sameActivityDay(null, '2026-03-12T00:00:00.000Z')).toBe(false); // an undated record never matches anything
    expect(sameActivityDay(undefined, undefined)).toBe(false);
  });

  test('§27: titleOverlapRatio never collapses two dissimilar titles, and is symmetric', () => {
    const ratio = titleOverlapRatio('HASC staff meeting on ground robotics', 'Staff meeting HASC ground robotics funding');
    expect(ratio).toBeGreaterThan(0.5);
    expect(titleOverlapRatio('HASC staff meeting on ground robotics', 'SASC hearing on shipbuilding budget')).toBeLessThan(0.3);
    expect(titleOverlapRatio(null, 'anything')).toBe(0);
    expect(titleOverlapRatio('anything', null)).toBe(0);
  });

  test('faraMatchConfidence: a confirmed client_intel_mapping always yields full confidence regardless of similarity', () => {
    expect(faraMatchConfidence(true, 0)).toBe(1);
    expect(faraMatchConfidence(true, 0.03)).toBe(1);
    expect(faraMatchConfidence(true, 0.99)).toBe(1);
  });

  test('faraMatchConfidence: an unconfirmed match is scaled by similarity but never reaches 1 and never drops below the auto-match floor', () => {
    expect(faraMatchConfidence(false, 0.5)).toBe(0.725);
    expect(faraMatchConfidence(false, 1)).toBe(0.95);
    // Even a similarity below the query's own >= 0.5 gate (defensive floor,
    // in case this helper is ever called before that gate is applied) never
    // produces a confidence below 0.5 — an unconfirmed public-source match
    // is never presented as less certain than the discovery threshold itself.
    expect(faraMatchConfidence(false, 0)).toBe(0.5);
  });

  test('testimonyMatchConfidence: a confirmed client_intel_mapping always yields full confidence regardless of similarity', () => {
    expect(testimonyMatchConfidence(true, 0)).toBe(1);
    expect(testimonyMatchConfidence(true, 0.1)).toBe(1);
    expect(testimonyMatchConfidence(true, 0.99)).toBe(1);
  });

  test('testimonyMatchConfidence: an unconfirmed match is scaled by similarity but never reaches 1 and never drops below the auto-match floor', () => {
    expect(testimonyMatchConfidence(false, 0.55)).toBe(0.77);
    expect(testimonyMatchConfidence(false, 1)).toBe(0.95);
    // Defensive floor mirrors faraMatchConfidence's own defensive floor test:
    // even a similarity below the query's own >= 0.55 gate never produces a
    // confidence below the discovery threshold itself.
    expect(testimonyMatchConfidence(false, 0)).toBe(0.55);
  });

  describe('planTestimonyScanBatch: cursor correctness (skip-safety, zero-match advancement, budget cap)', () => {
    test('pagination: a batch smaller than the page fully examines every row and the cursor lands on the last row', () => {
      const rows = [
        scanRow('h1', 'w1, Org A', '2026-01-01T00:00:00.000Z', 0.9),
        scanRow('h2', 'w2, Org B', '2026-01-02T00:00:00.000Z', 0.1),
        scanRow('h3', 'w3, Org C', '2026-01-03T00:00:00.000Z', 0.8),
      ];
      const plan = planTestimonyScanBatch(rows, new Set(), 0.55, 200);
      expect(plan.toEmit.map((r) => r.hearingId)).toEqual(['h1', 'h3']);
      expect(plan.cursor).toEqual({ syncedAt: '2026-01-03T00:00:00.000Z', key: 'h3::w3, Org C' });
    });

    test('pagination: nothing is skipped across two sequential pages spanning >batch-size rows', () => {
      // Simulate a source with 5 rows total and a page size of 2 (the real
      // batch size is TESTIMONY_SCAN_BATCH_SIZE=500; this test just proves
      // the resumption contract at a small, readable scale).
      const allRows = [
        scanRow('h1', 'w1, Match Org', '2026-01-01T00:00:00.000Z', 0.9),
        scanRow('h2', 'w2, No Match', '2026-01-02T00:00:00.000Z', 0.05),
        scanRow('h3', 'w3, Match Org', '2026-01-03T00:00:00.000Z', 0.85),
        scanRow('h4', 'w4, No Match', '2026-01-04T00:00:00.000Z', 0.02),
        scanRow('h5', 'w5, Match Org', '2026-01-05T00:00:00.000Z', 0.95),
      ];

      // Page 1: rows synced_at > null, first 2 rows.
      const page1 = allRows.slice(0, 2);
      const plan1 = planTestimonyScanBatch(page1, new Set(), 0.55, 200);
      expect(plan1.toEmit.map((r) => r.hearingId)).toEqual(['h1']);
      expect(plan1.cursor).toEqual({ syncedAt: '2026-01-02T00:00:00.000Z', key: 'h2::w2, No Match' });

      // Page 2: rows synced_at > page1's cursor (simulated by slicing the
      // remaining rows — the real SQL WHERE clause does this filtering).
      const page2 = allRows.slice(2, 4);
      const plan2 = planTestimonyScanBatch(page2, new Set(), 0.55, 200);
      expect(plan2.toEmit.map((r) => r.hearingId)).toEqual(['h3']);
      expect(plan2.cursor).toEqual({ syncedAt: '2026-01-04T00:00:00.000Z', key: 'h4::w4, No Match' });

      // Page 3: final row.
      const page3 = allRows.slice(4, 5);
      const plan3 = planTestimonyScanBatch(page3, new Set(), 0.55, 200);
      expect(plan3.toEmit.map((r) => r.hearingId)).toEqual(['h5']);
      expect(plan3.cursor).toEqual({ syncedAt: '2026-01-05T00:00:00.000Z', key: 'h5::w5, Match Org' });

      // Every row across all three pages was examined exactly once — no
      // row appears in more than one page's toEmit, and h1/h3/h5 (the three
      // genuine matches) all surfaced.
      const allEmitted = [...plan1.toEmit, ...plan2.toEmit, ...plan3.toEmit].map((r) => r.hearingId);
      expect(allEmitted).toEqual(['h1', 'h3', 'h5']);
    });

    test('same timestamp: a stable compound-key tie-breaker prevents skipping a row that shares synced_at with the cursor boundary', () => {
      // Three rows share the exact same synced_at. A page boundary falls
      // in the middle of that timestamp group.
      const sameTs = '2026-01-01T00:00:00.000Z';
      const rows = [
        scanRow('h1', 'a-witness, Org', sameTs, 0.9),
        scanRow('h1', 'b-witness, Org', sameTs, 0.9),
      ];
      const plan1 = planTestimonyScanBatch(rows, new Set(), 0.55, 200);
      expect(plan1.cursor).toEqual({ syncedAt: sameTs, key: 'h1::b-witness, Org' });

      // The next page's WHERE clause (synced_at = cursor AND key > cursor.key)
      // would correctly exclude both already-seen rows and include only a
      // THIRD row sharing the same timestamp with a lexicographically later
      // key — simulated here directly, since the tie-breaker logic itself
      // lives in the SQL, not in planTestimonyScanBatch. This test proves
      // the cursor VALUE captured is precise enough (full compound key, not
      // just a timestamp) to make that WHERE clause correct.
      const nextRow = scanRow('h1', 'c-witness, Org', sameTs, 0.9);
      const rowIsPastCursor =
        nextRow.syncedAt.toISOString() > plan1.cursor!.syncedAt ||
        (nextRow.syncedAt.toISOString() === plan1.cursor!.syncedAt &&
          `${nextRow.hearingId}::${nextRow.witnessText}` > plan1.cursor!.key);
      expect(rowIsPastCursor).toBe(true);
      // And the two rows already returned in page 1 are correctly NOT past
      // the cursor (they equal it or precede it) — proving they'd never be
      // re-fetched by the next page's query.
      for (const seen of rows) {
        const key = `${seen.hearingId}::${seen.witnessText}`;
        const isPast =
          seen.syncedAt.toISOString() > plan1.cursor!.syncedAt ||
          (seen.syncedAt.toISOString() === plan1.cursor!.syncedAt && key > plan1.cursor!.key);
        expect(isPast).toBe(false);
      }
    });

    test('zero matches: a batch where every row fails the threshold still advances the cursor to the last row', () => {
      const rows = [
        scanRow('h1', 'w1, Unrelated', '2026-01-01T00:00:00.000Z', 0.02),
        scanRow('h2', 'w2, Unrelated', '2026-01-02T00:00:00.000Z', 0.01),
        scanRow('h3', 'w3, Unrelated', '2026-01-03T00:00:00.000Z', 0.03),
      ];
      const plan = planTestimonyScanBatch(rows, new Set(), 0.55, 200);
      expect(plan.toEmit).toEqual([]);
      // The cursor still lands on the LAST row of the batch — the next Fill
      // run's query starts strictly after this point, never re-scanning
      // these same three rows.
      expect(plan.cursor).toEqual({ syncedAt: '2026-01-03T00:00:00.000Z', key: 'h3::w3, Unrelated' });
    });

    test('confirmed old mapping: a confirmed key is excluded from emission (handled by the separate bypass query) but still advances the cursor', () => {
      const rows = [
        scanRow('h1', 'old-witness, Confirmed Org', '2020-01-01T00:00:00.000Z', 0.02),
      ];
      const confirmedKeys = new Set(['h1::old-witness, Confirmed Org']);
      const plan = planTestimonyScanBatch(rows, confirmedKeys, 0.55, 200);
      // Not emitted from THIS function — the confirmed-mapping bypass query
      // (a separate, cursor-independent query in the real service) is what
      // surfaces it. This proves the scan doesn't double-emit a confirmed
      // row and doesn't stall on a batch containing only confirmed rows.
      expect(plan.toEmit).toEqual([]);
      expect(plan.cursor).toEqual({ syncedAt: '2020-01-01T00:00:00.000Z', key: 'h1::old-witness, Confirmed Org' });
    });

    test('MAX_ADVOCACY_FINDINGS budget cap: the cursor stops at the last row actually examined, never past an unevaluated row', () => {
      const rows = [
        scanRow('h1', 'w1, Match', '2026-01-01T00:00:00.000Z', 0.9),
        scanRow('h2', 'w2, Match', '2026-01-02T00:00:00.000Z', 0.9),
        scanRow('h3', 'w3, Match', '2026-01-03T00:00:00.000Z', 0.9),
        scanRow('h4', 'w4, Match', '2026-01-04T00:00:00.000Z', 0.9),
      ];
      // Budget only allows 2 emissions.
      const plan = planTestimonyScanBatch(rows, new Set(), 0.55, 2);
      expect(plan.toEmit.map((r) => r.hearingId)).toEqual(['h1', 'h2']);
      // Cursor must land on h2 — the last row actually examined — NOT h3 or
      // h4, which were never evaluated because the budget ran out first.
      // Advancing past h3/h4 here would silently drop them forever.
      expect(plan.cursor).toEqual({ syncedAt: '2026-01-02T00:00:00.000Z', key: 'h2::w2, Match' });
    });

    test('zero budget: no rows are examined at all, cursor stays null (caller falls back to the prior cursor)', () => {
      const rows = [scanRow('h1', 'w1, Match', '2026-01-01T00:00:00.000Z', 0.9)];
      const plan = planTestimonyScanBatch(rows, new Set(), 0.55, 0);
      expect(plan.toEmit).toEqual([]);
      expect(plan.cursor).toBeNull();
    });
  });
});

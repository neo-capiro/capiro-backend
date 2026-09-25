/**
 * Focused spec for the Phase 5 pure-domain watch diff
 * (bizdev-watch-diff.ts). These tests pin the contract:
 *
 *   * quiet initial baseline — no alert on the first pass, INCLUDING for a
 *     null/undefined baseline object AND an initialized:false baseline;
 *   * an ESTABLISHED empty baseline (initialized:true, zero records) is NOT
 *     "unbaselined": the next new record alerts as new_record;
 *   * identity ambiguity returns review BEFORE any baseline acceptance —
 *     an ambiguous first scan never becomes a trusted baseline fact;
 *   * stable content fingerprints — same meaning, different key order /
 *     retrieval timestamps → identical fingerprint, no alert;
 *   * harmless fetchedAt / lastSyncedAt / raw noise never alerts;
 *   * a bare source-revision bump with identical content is no_alert;
 *   * new record / material update / correction / backfill classification;
 *   * exact source locator URLs — descriptive text is never a locator, and
 *     an observation without a usable URL skips;
 *   * semantic change fingerprints separate from content fingerprints:
 *     A→B→A→B recurrence alerts each step and is never suppressed;
 *   * deterministic dedupe keys / titles / implications;
 *   * allowlist enforcement (non-material fields cannot produce alerts).
 */

import {
  allowlistedMaterial,
  alertDedupeKey,
  canonicalizeJson,
  diffObservationAgainstBaseline,
  observationFingerprint,
  onlyHarmlessNoise,
  semanticChangeFingerprint,
  sha256Hex,
  stripHarmlessFields,
} from './bizdev-watch-diff';
import {
  bizdevSourceLocator,
  type BizDevSourceObservation,
  type BizDevWatchBaseline,
  type BizDevWatchBaselineRecord,
} from './bizdev-watch.types';

const ESTABLISHED_AT = '2028-09-28T00:00:00.000Z';

function baselineFrom(
  records: Record<string, BizDevWatchBaselineRecord>,
  opts: { initialized?: boolean; establishedAt?: string; effectiveFloorAt?: string } = {},
): BizDevWatchBaseline {
  return {
    initialized: opts.initialized ?? true,
    establishedAt: opts.establishedAt ?? ESTABLISHED_AT,
    effectiveFloorAt: opts.effectiveFloorAt ?? null,
    records,
  };
}

function federalObservation(
  recordId: string,
  material: Record<string, unknown>,
  extra: Partial<BizDevSourceObservation> = {},
): BizDevSourceObservation {
  return {
    sourceFamily: 'federal_award',
    recordId,
    sourceLocator: `https://www.usaspending.gov/award/${recordId}`,
    material: material as BizDevSourceObservation['material'],
    ...extra,
  };
}

describe('bizdev-watch-diff canonicalization', () => {
  it('is insensitive to raw key order at every nesting level', () => {
    const a = { z: { b: 1, a: 2 }, y: [3, { q: 1, p: 2 }] };
    const b = { y: [3, { p: 2, q: 1 }], z: { a: 2, b: 1 } };
    expect(canonicalizeJson(a as never)).toBe(canonicalizeJson(b as never));
  });

  it('treats undefined and null as the same canonical null', () => {
    expect(canonicalizeJson(null)).toBe(canonicalizeJson(undefined as never));
  });

  it('produces lower-case hex sha-256', () => {
    const digest = sha256Hex('abc');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('drops harmless retrieval fields', () => {
    const stripped = stripHarmlessFields({
      amount: 5,
      fetchedAt: '2028-01-01T00:00:00Z',
      lastSyncedAt: '2028-01-02T00:00:00Z',
      providerFetchedAt: '2028-01-03T00:00:00Z',
      raw: { anything: true },
    });
    expect(Object.keys(stripped).sort()).toEqual(['amount']);
  });

  it('onlyHarmlessNoise is true for pure retrieval noise', () => {
    expect(
      onlyHarmlessNoise(
        { amount: 5, fetchedAt: 'a', lastSyncedAt: 'b' },
        { amount: 5, fetchedAt: 'c', lastSyncedAt: 'd' },
      ),
    ).toBe(true);
    expect(onlyHarmlessNoise({ amount: 5 }, { amount: 6 })).toBe(false);
  });

  it('projects material down to the family allowlist', () => {
    const obs = federalObservation('CONT_A', {
      amount: 100,
      fetchedAt: 'noise',
      internalSyncNote: 'not allowlisted',
      contractorName: 'Acme',
    });
    const projected = allowlistedMaterial(obs);
    expect(projected).toEqual({ amount: 100, contractorName: 'Acme' });
  });
});

describe('bizdev-watch-diff fingerprints', () => {
  it('content fingerprint is stable across key order and retrieval noise', () => {
    const a = federalObservation('CONT_A', {
      amount: 100,
      contractorName: 'Acme',
      lastSyncedAt: '2028-01-01',
    });
    const b = federalObservation('CONT_A', {
      lastSyncedAt: '2028-02-02',
      contractorName: 'Acme',
      amount: 100,
    });
    expect(observationFingerprint(a)).toBe(observationFingerprint(b));
  });

  it('content fingerprint moves when a material field changes', () => {
    const a = federalObservation('CONT_A', { amount: 100 });
    const b = federalObservation('CONT_A', { amount: 200 });
    expect(observationFingerprint(a)).not.toBe(observationFingerprint(b));
  });

  it('content fingerprint does NOT move for non-allowlisted fields', () => {
    const a = federalObservation('CONT_A', { amount: 100, mystery: 'x' });
    const b = federalObservation('CONT_A', { amount: 100, mystery: 'y' });
    expect(observationFingerprint(a)).toBe(observationFingerprint(b));
  });

  it('semantic change fingerprint differs from the content fingerprint and varies with revision and sequence', () => {
    const contentA = sha256Hex('content-a');
    const contentB = sha256Hex('content-b');
    const base = semanticChangeFingerprint(
      'federal_award', 'CONT_A', contentA, contentB, 'material_update', null, 1,
    );
    // Different from the content fingerprints themselves.
    expect(base).not.toBe(contentA);
    expect(base).not.toBe(contentB);
    // Change kind matters.
    expect(
      semanticChangeFingerprint('federal_award', 'CONT_A', contentA, contentB, 'correction', null, 1),
    ).not.toBe(base);
    // Source revision matters.
    expect(
      semanticChangeFingerprint('federal_award', 'CONT_A', contentA, contentB, 'material_update', 'rev-2', 1),
    ).not.toBe(base);
    // Prior content matters (A→B differs from C→B).
    expect(
      semanticChangeFingerprint('federal_award', 'CONT_A', sha256Hex('content-c'), contentB, 'material_update', null, 1),
    ).not.toBe(base);
    // The monotonic semantic sequence matters even with identical content
    // pair and null revision (the A→B-after-B→A collision killer).
    expect(
      semanticChangeFingerprint('federal_award', 'CONT_A', contentA, contentB, 'material_update', null, 2),
    ).not.toBe(base);
    expect(
      semanticChangeFingerprint('federal_award', 'CONT_A', contentA, contentB, 'material_update', null, 3),
    ).not.toBe(base);
  });

  it('builds a family+record+fingerprint dedupe key', () => {
    const fp = sha256Hex('x');
    expect(alertDedupeKey('federal_award', 'CONT_A', fp)).toBe(
      `federal_award:CONT_A:${fp}`,
    );
  });
});

describe('bizdevSourceLocator (exact URLs)', () => {
  it('builds deterministic exact URLs for USAspending/SAM/LDA', () => {
    expect(bizdevSourceLocator('federal_award', 'CONT_A')).toBe(
      'https://www.usaspending.gov/award/CONT_A',
    );
    expect(bizdevSourceLocator('sam_opportunity', 'not-123')).toBe(
      'https://sam.gov/opp/not-123/view',
    );
    expect(bizdevSourceLocator('lda_filing', 'abc.xml')).toBe(
      'https://lda.senate.gov/system/lod/abc.xml',
    );
  });

  it('requires Tango/ledger adapters to supply a provider URL', () => {
    expect(bizdevSourceLocator('tango_resource', 'X')).toBe('');
    expect(bizdevSourceLocator('tango_resource', 'X', 'https://provider.example/r/X')).toBe(
      'https://provider.example/r/X',
    );
  });
});

describe('diffObservationAgainstBaseline — baseline establishment', () => {
  it('returns a quiet baseline (no alert) when the baseline object is absent', () => {
    const result = diffObservationAgainstBaseline(
      federalObservation('CONT_A', { amount: 100 }),
      undefined,
    );
    expect(result.outcome).toBe('baseline');
    expect(result.alertDraft).toBeUndefined();
    expect(result.baselineUpdate?.recordId).toBe('CONT_A');
  });

  it('returns a quiet baseline (no alert) when initialized is false, even with records', () => {
    const result = diffObservationAgainstBaseline(
      federalObservation('CONT_A', { amount: 100 }),
      baselineFrom(
        { CONT_OLD: { recordId: 'CONT_OLD', fingerprint: 'x' } },
        { initialized: false },
      ),
    );
    expect(result.outcome).toBe('baseline');
    expect(result.alertDraft).toBeUndefined();
  });

  it('treats an ESTABLISHED EMPTY baseline as baselined: the next record alerts', () => {
    const result = diffObservationAgainstBaseline(
      federalObservation('CONT_NEW', { amount: 500 }, {
        effectiveAt: '2028-10-01T00:00:00.000Z',
      }),
      baselineFrom({}, { initialized: true }),
    );
    expect(result.outcome).toBe('alert');
    expect(result.alertDraft?.changeKind).toBe('new_record');
  });

  it('never lets an ambiguous observation become a trusted baseline fact', () => {
    const ambiguous = federalObservation('CONT_MAYBE', { amount: 100 }, {
      identityConfidence: 0.3,
    });
    // Uninitialized baseline: ambiguity wins over baseline recording.
    expect(diffObservationAgainstBaseline(ambiguous, undefined).outcome).toBe('review');
    expect(diffObservationAgainstBaseline(ambiguous, baselineFrom({})).outcome).toBe('review');
  });

  it('routes invalid identity confidence values to review', () => {
    const observation = federalObservation('CONT_A', { amount: 100 });
    expect(
      diffObservationAgainstBaseline(
        { ...observation, identityConfidence: Number.NaN },
        baselineFrom({}),
      ).outcome,
    ).toBe('review');
    expect(
      diffObservationAgainstBaseline(
        { ...observation, identityConfidence: 1.1 },
        baselineFrom({}),
      ).outcome,
    ).toBe('review');
  });

  it('does not accept an untraceable record into the quiet baseline', () => {
    const result = diffObservationAgainstBaseline(
      {
        sourceFamily: 'tango_resource',
        recordId: 'TANGO_1',
        sourceLocator: '',
        material: { resourceType: 'entity', externalId: 'TANGO_1', name: 'X' },
      },
      null,
    );
    expect(result.outcome).toBe('skip');
    expect(result.baselineUpdate).toBeUndefined();
  });
});

describe('diffObservationAgainstBaseline — noise and revisions', () => {
  it('returns no_alert when only retrieval timestamps changed', () => {
    const before = federalObservation('CONT_A', {
      amount: 100,
      fetchedAt: '2028-01-01',
    });
    const baselined = diffObservationAgainstBaseline(
      before,
      baselineFrom({}),
    ).baselineUpdate!;
    const after = federalObservation('CONT_A', {
      amount: 100,
      fetchedAt: '2028-09-28', // harmless
      lastSyncedAt: '2028-09-29', // harmless
    });
    const result = diffObservationAgainstBaseline(
      after,
      baselineFrom({ CONT_A: baselined }),
    );
    expect(result.outcome).toBe('no_alert');
    expect(result.alertDraft).toBeUndefined();
  });

  it('returns no_alert when only raw key order changed', () => {
    const baselined = diffObservationAgainstBaseline(
      federalObservation('CONT_A', { amount: 100, contractorName: 'Acme' }),
      baselineFrom({}),
    ).baselineUpdate!;
    const result = diffObservationAgainstBaseline(
      federalObservation('CONT_A', { contractorName: 'Acme', amount: 100 }),
      baselineFrom({ CONT_A: baselined }),
    );
    expect(result.outcome).toBe('no_alert');
  });

  it('returns no_alert for a bare source-revision bump with identical content', () => {
    const baselined = diffObservationAgainstBaseline(
      federalObservation('CONT_A', { amount: 100 }),
      baselineFrom({}),
    ).baselineUpdate!;
    const result = diffObservationAgainstBaseline(
      federalObservation('CONT_A', { amount: 100 }, { sourceRevision: 'rev-9' }),
      baselineFrom({ CONT_A: baselined }),
    );
    expect(result.outcome).toBe('no_alert');
  });

  it('skips when no exact source locator URL is available', () => {
    const result = diffObservationAgainstBaseline(
      {
        sourceFamily: 'tango_resource',
        recordId: 'TANGO_1',
        sourceLocator: 'tango resource 1', // descriptive text, not a URL
        material: { resourceType: 'entity', externalId: 'TANGO_1', name: 'X' },
        effectiveAt: '2028-10-01T00:00:00.000Z',
      },
      baselineFrom({}),
    );
    expect(result.outcome).toBe('skip');
    expect(result.alertDraft).toBeUndefined();
  });

  it('accepts an exact URL from the observation itself', () => {
    const result = diffObservationAgainstBaseline(
      {
        sourceFamily: 'tango_resource',
        recordId: 'TANGO_1',
        sourceLocator: 'https://provider.example/r/TANGO_1',
        material: { resourceType: 'entity', externalId: 'TANGO_1', name: 'X' },
        effectiveAt: '2028-10-01T00:00:00.000Z',
      },
      baselineFrom({}),
    );
    expect(result.outcome).toBe('alert');
    expect(result.alertDraft?.sourceLocator).toBe('https://provider.example/r/TANGO_1');
  });

  it('falls back to the material sourceUrl when the observation lacks its own', () => {
    const result = diffObservationAgainstBaseline(
      {
        sourceFamily: 'sam_opportunity',
        recordId: 'not-7',
        sourceLocator: '',
        material: {
          noticeId: 'not-7',
          sourceUrl: 'https://sam.gov/opp/not-7/view?extra=1',
        },
        effectiveAt: '2028-10-01T00:00:00.000Z',
      },
      baselineFrom({}),
    );
    expect(result.alertDraft?.sourceLocator).toBe(
      'https://sam.gov/opp/not-7/view?extra=1',
    );
  });
});

describe('diffObservationAgainstBaseline — classification', () => {
  it('classifies an unknown current record as new_record with an alert', () => {
    const baseline = baselineFrom({
      CONT_OLD: { recordId: 'CONT_OLD', fingerprint: 'deadbeef', effectiveAt: ESTABLISHED_AT },
    });
    const result = diffObservationAgainstBaseline(
      federalObservation('CONT_NEW', { amount: 500 }, {
        effectiveAt: '2028-10-01T00:00:00.000Z',
      }),
      baseline,
    );
    expect(result.outcome).toBe('alert');
    expect(result.alertDraft?.changeKind).toBe('new_record');
    expect(result.alertDraft?.recordId).toBe('CONT_NEW');
    expect(result.alertDraft?.beforeState).toBeNull();
    expect(result.alertDraft?.dedupeKey).toBe(
      `federal_award:CONT_NEW:${result.alertDraft?.fingerprint}`,
    );
    expect(result.alertDraft?.sourceLocator).toBe(
      'https://www.usaspending.gov/award/CONT_NEW',
    );
  });

  it('classifies a late-arriving pre-baseline record as backfill', () => {
    const baseline = baselineFrom({
      CONT_OLD: { recordId: 'CONT_OLD', fingerprint: 'deadbeef' },
    });
    const result = diffObservationAgainstBaseline(
      federalObservation('CONT_OLD2', { amount: 500 }, {
        effectiveAt: '2027-01-01T00:00:00.000Z', // before the floor
      }),
      baseline,
    );
    expect(result.outcome).toBe('alert');
    expect(result.alertDraft?.changeKind).toBe('backfill');
  });

  it('uses conditional language for thematic SAM opportunities', () => {
    const result = diffObservationAgainstBaseline(
      {
        sourceFamily: 'sam_opportunity',
        recordId: 'notice-1',
        sourceLocator: 'https://sam.gov/opp/notice-1/view',
        identityConfidence: 0.7,
        effectiveAt: '2028-10-01T00:00:00.000Z',
        material: { noticeId: 'notice-1', title: 'Agency requirement' },
      },
      baselineFrom({}),
    );
    expect(result.outcome).toBe('alert');
    expect(result.alertDraft?.implication).toMatch(/thematic context only/i);
    expect(result.alertDraft?.implication).toMatch(/does not indicate.*bid or win/i);
  });

  it('uses JSON-safe nulls for fields absent from a new record', () => {
    const result = diffObservationAgainstBaseline(
      federalObservation('CONT_NEW', { amount: 100 }),
      baselineFrom({}),
    );
    expect(result.alertDraft?.changes).toEqual([
      { field: 'amount', before: null, after: 100 },
    ]);
    expect(JSON.stringify(result.alertDraft?.changes)).not.toContain('undefined');
  });

  it('classifies a material change to a known record as material_update', () => {
    const baselined = diffObservationAgainstBaseline(
      federalObservation('CONT_A', { amount: 100, peCode: '0101' }),
      baselineFrom({}),
    ).baselineUpdate!;
    const result = diffObservationAgainstBaseline(
      federalObservation('CONT_A', { amount: 250, peCode: '0101' }),
      baselineFrom({ CONT_A: baselined }),
    );
    expect(result.outcome).toBe('alert');
    expect(result.alertDraft?.changeKind).toBe('material_update');
    expect(result.alertDraft?.changes).toEqual([
      { field: 'amount', before: 100, after: 250 },
    ]);
    expect(result.alertDraft?.materiality).toBe('high');
    expect(result.alertDraft?.beforeState).toEqual({ amount: 100, peCode: '0101' });
    expect(result.alertDraft?.afterState).toEqual({ amount: 250, peCode: '0101' });
  });

  it('classifies a backwards-dated change as correction', () => {
    const baselined = diffObservationAgainstBaseline(
      federalObservation('CONT_A', { amount: 100 }, {
        publishedAt: '2028-09-20T00:00:00.000Z',
        effectiveAt: '2028-09-15T00:00:00.000Z',
      }),
      baselineFrom({}),
    ).baselineUpdate!;
    const result = diffObservationAgainstBaseline(
      federalObservation('CONT_A', { amount: 90 }, {
        // Source rewrote already-published history.
        publishedAt: '2028-09-10T00:00:00.000Z',
        effectiveAt: '2028-09-01T00:00:00.000Z',
      }),
      baselineFrom({ CONT_A: baselined }),
    );
    expect(result.outcome).toBe('alert');
    expect(result.alertDraft?.changeKind).toBe('correction');
  });

  it('never invents before values when the baseline has no snapshot', () => {
    const result = diffObservationAgainstBaseline(
      federalObservation('CONT_A', { amount: 250 }),
      baselineFrom({
        CONT_A: { recordId: 'CONT_A', fingerprint: 'stale-fp' },
      }),
    );
    expect(result.outcome).toBe('alert');
    expect(result.alertDraft?.changes).toEqual([
      { field: 'amount', before: null, after: 250 },
    ]);
  });

  it('returns skip for malformed observations', () => {
    const baseline = baselineFrom({
      CONT_A: { recordId: 'CONT_A', fingerprint: 'deadbeef' },
    });
    expect(
      diffObservationAgainstBaseline(
        { ...federalObservation('', {}) },
        baseline,
      ).outcome,
    ).toBe('skip');
    expect(
      diffObservationAgainstBaseline(
        { ...federalObservation('CONT_A', {}), material: [] as never },
        baseline,
      ).outcome,
    ).toBe('skip');
  });

  it('produces deterministic titles, summaries, and inference implications', () => {
    const baseline = baselineFrom({
      CONT_A: {
        recordId: 'CONT_A',
        fingerprint: 'deadbeef',
        material: { amount: 100 },
      },
    });
    const make = () =>
      diffObservationAgainstBaseline(
        federalObservation('CONT_A', { amount: 300, contractorName: 'Acme' }),
        baseline,
      );
    expect(make().alertDraft).toEqual(make().alertDraft);
    const draft = make().alertDraft!;
    expect(draft.title).toContain('Updated federal award');
    expect(draft.title).toContain('Acme');
    expect(draft.summary).toContain('amount');
    expect(draft.implication).toContain('materially changed');
    expect(draft.sourceLocator).toBe('https://www.usaspending.gov/award/CONT_A');
  });

  it('maps source families to alert categories', () => {
    const baseline = baselineFrom({
      X: { recordId: 'X', fingerprint: 'deadbeef' },
    });
    const result = diffObservationAgainstBaseline(
      {
        sourceFamily: 'lda_filing',
        recordId: 'LDA_1',
        sourceLocator: 'https://lda.senate.gov/system/lod/LDA_1',
        material: { filingUuid: 'LDA_1', clientName: 'Acme' },
        effectiveAt: '2028-10-01T00:00:00.000Z',
      },
      baseline,
    );
    expect(result.alertDraft?.category).toBe('lobbying');
    expect(result.alertDraft?.changeKind).toBe('new_record');
  });

  it('honors an explicit effective floor for backfill classification', () => {
    const baseline = baselineFrom(
      { CONT_OLD: { recordId: 'CONT_OLD', fingerprint: 'deadbeef' } },
      { establishedAt: '2026-01-01T00:00:00.000Z', effectiveFloorAt: '2028-09-01T00:00:00.000Z' },
    );
    const result = diffObservationAgainstBaseline(
      federalObservation('CONT_BACK', { amount: 1 }, {
        effectiveAt: '2028-08-01T00:00:00.000Z',
      }),
      baseline,
    );
    expect(result.alertDraft?.changeKind).toBe('backfill');
  });
});

describe('diffObservationAgainstBaseline — A→B→A→B recurrence', () => {
  function evolve(
    material: Record<string, unknown>,
    extra: Partial<BizDevSourceObservation> = {},
  ) {
    // sourceRevision deliberately absent/null throughout: the sequence must
    // alone guarantee distinct fingerprints across recurrences.
    const obs = federalObservation('CONT_A', material, extra);
    obs.sourceRevision = null;
    return obs;
  }

  /** Uninitialized baseline: the quiet first pass. */
  const QUIET: BizDevWatchBaseline = baselineFrom({}, { initialized: false });

  it('alerts on every legitimate step; three distinct fingerprints for A→B→A→B', () => {
    // Quiet first pass → baseline records content A (sequence 0).
    const stepA = diffObservationAgainstBaseline(
      evolve({ amount: 100 }),
      QUIET,
    );
    expect(stepA.outcome).toBe('baseline');
    expect(stepA.baselineUpdate?.semanticSequence).toBe(0);

    // A → B: material_update alert (sequence 1).
    const stateB = diffObservationAgainstBaseline(
      evolve({ amount: 200 }),
      baselineFrom({ CONT_A: stepA.baselineUpdate! }),
    );
    expect(stateB.outcome).toBe('alert');
    expect(stateB.alertDraft?.changeKind).toBe('material_update');
    expect(stateB.baselineUpdate?.semanticSequence).toBe(1);
    const alertAB1 = stateB.alertDraft!;

    // B → A: content changes BACK; sequence 2 → fresh fingerprint → alert.
    const stateA2 = diffObservationAgainstBaseline(
      evolve({ amount: 100 }),
      baselineFrom({ CONT_A: stateB.baselineUpdate! }),
    );
    expect(stateA2.outcome).toBe('alert');
    expect(stateA2.alertDraft?.changeKind).toBe('material_update');
    expect(stateA2.baselineUpdate?.semanticSequence).toBe(2);
    expect(stateA2.alertDraft?.fingerprint).not.toBe(alertAB1.fingerprint);
    expect(stateA2.alertDraft?.dedupeKey).not.toBe(alertAB1.dedupeKey);

    // A → B again: the SAME content pair as the first A→B with the SAME null
    // sourceRevision — only the sequence (3) distinguishes it. It alerts
    // with a THIRD distinct fingerprint, never suppressed by the unique.
    const stateB2 = diffObservationAgainstBaseline(
      evolve({ amount: 200 }),
      baselineFrom({ CONT_A: stateA2.baselineUpdate! }),
    );
    expect(stateB2.outcome).toBe('alert');
    expect(stateB2.baselineUpdate?.semanticSequence).toBe(3);
    const fingerprints = [
      alertAB1.fingerprint,
      stateA2.alertDraft!.fingerprint,
      stateB2.alertDraft!.fingerprint,
    ];
    expect(new Set(fingerprints).size).toBe(3);
    expect(new Set([
      alertAB1.dedupeKey,
      stateA2.alertDraft!.dedupeKey,
      stateB2.alertDraft!.dedupeKey,
    ]).size).toBe(3);

    // Exact replay of the last transition (before commit): same sequence,
    // same content pair → IDENTICAL fingerprint and dedupe key, so the
    // tenant-delivery unique makes the retry a no-op.
    const replay = diffObservationAgainstBaseline(
      evolve({ amount: 200 }),
      baselineFrom({ CONT_A: stateA2.baselineUpdate! }),
    );
    expect(replay.outcome).toBe('alert');
    expect(replay.alertDraft?.fingerprint).toBe(stateB2.alertDraft?.fingerprint);
    expect(replay.alertDraft?.dedupeKey).toBe(stateB2.alertDraft?.dedupeKey);
  });

  it('no_alert when content is identical to the accepted baseline', () => {
    const stepA = diffObservationAgainstBaseline(
      evolve({ amount: 100 }),
      QUIET,
    );
    expect(stepA.outcome).toBe('baseline');
    // Re-observe the exact same content: no alert, sequence unchanged.
    const again = diffObservationAgainstBaseline(
      evolve({ amount: 100 }),
      baselineFrom({ CONT_A: stepA.baselineUpdate! }),
    );
    expect(again.outcome).toBe('no_alert');
    expect(again.baselineUpdate?.semanticSequence).toBe(0);
  });
});

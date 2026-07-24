import {
  buildToplineCandidates,
  writeToplineCandidates,
  type ArtifactTopline,
  type ToplineDefaults,
} from './topline-candidates.js';

/**
 * Parser topline staging candidates (Release R3, §3.3).
 *
 * The rule this file enforces: a parser may SEE a topline, but it may never assert
 * one. Every candidate lands 'extracted'; anything the parser cannot pin to a known
 * scope, stage, class, and explicit unit is a review warning and no row at all; and
 * a figure a human already reviewed can never be overwritten by a re-run.
 */

const defaults: ToplineDefaults = {
  domain: 'defense',
  fiscalYear: 2027,
  stage: 'house',
  vehicleClass: 'appropriation',
  sourceUrl: 'https://example.invalid/hac-d-report',
  sourceKey: 'armed_services_hacd_fy2027',
  emittedBy: 'parse-defense-approps-reports (HAC-D)',
};

const good: ArtifactTopline = {
  scope: 'defense_appropriations_title',
  amountMillions: 850000,
  units: 'millions',
  sourcePage: 4,
  excerpt: 'Total, Department of Defense — $850,000,000 thousand',
};

describe('buildToplineCandidates', () => {
  it('stages a well-formed topline as extracted, never verified', () => {
    const { candidates, warnings } = buildToplineCandidates([good], defaults);
    expect(warnings).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.verificationStatus).toBe('extracted');
    expect(candidates[0]!.stage).toBe('house');
    expect(candidates[0]!.vehicleClass).toBe('appropriation');
    expect(candidates[0]!.scope).toBe('defense_appropriations_title');
    expect(candidates[0]!.amountMillions).toBe(850000);
  });

  it('retains the verbatim source excerpt and the emitting parser in the note', () => {
    const { candidates } = buildToplineCandidates([good], defaults);
    expect(candidates[0]!.note).toContain('parse-defense-approps-reports (HAC-D)');
    expect(candidates[0]!.note).toContain('awaiting review');
    expect(candidates[0]!.note).toContain('Total, Department of Defense');
  });

  it('warns and commits NOTHING for an ambiguous scope', () => {
    const { candidates, warnings } = buildToplineCandidates(
      [{ ...good, scope: 'defense stuff' }],
      defaults,
    );
    expect(candidates).toEqual([]);
    expect(warnings[0]).toMatch(/ambiguous scope/);
    expect(warnings[0]).toMatch(/no position committed/);
  });

  it('warns and commits NOTHING for a missing scope', () => {
    const { candidates, warnings } = buildToplineCandidates([{ ...good, scope: undefined }], defaults);
    expect(candidates).toEqual([]);
    expect(warnings[0]).toMatch(/ambiguous scope/);
  });

  it('warns and commits NOTHING for ambiguous units (never guesses a scale)', () => {
    for (const units of ['thousands', 'dollars', undefined, '']) {
      const { candidates, warnings } = buildToplineCandidates(
        [{ ...good, units: units as string }],
        defaults,
      );
      expect(candidates).toEqual([]);
      expect(warnings[0]).toMatch(/ambiguous units/);
    }
  });

  it('warns and commits NOTHING for a non-numeric or negative amount', () => {
    expect(
      buildToplineCandidates([{ ...good, amountMillions: undefined }], defaults).candidates,
    ).toEqual([]);
    expect(buildToplineCandidates([{ ...good, amountMillions: -5 }], defaults).candidates).toEqual(
      [],
    );
  });

  it('lets an artifact override the parser stage/class (a CR inside a report)', () => {
    const { candidates } = buildToplineCandidates(
      [{ ...good, stage: 'enacted', vehicleClass: 'interim_funding' }],
      defaults,
    );
    expect(candidates[0]!.stage).toBe('enacted');
    expect(candidates[0]!.vehicleClass).toBe('interim_funding');
  });

  it('rejects an unknown overridden stage or class', () => {
    expect(buildToplineCandidates([{ ...good, stage: 'markup' }], defaults).candidates).toEqual([]);
    expect(
      buildToplineCandidates([{ ...good, vehicleClass: 'omnibus' }], defaults).candidates,
    ).toEqual([]);
  });

  it('keeps two toplines that differ only by scope (different facts)', () => {
    const { candidates, warnings } = buildToplineCandidates(
      [good, { ...good, scope: 'national_defense_total', amountMillions: 1000000 }],
      defaults,
    );
    expect(warnings).toEqual([]);
    expect(candidates.map((c) => c.scope)).toEqual([
      'defense_appropriations_title',
      'national_defense_total',
    ]);
  });

  it('drops a duplicate (stage, class, scope, FY) inside one artifact', () => {
    const { candidates, warnings } = buildToplineCandidates([good, { ...good }], defaults);
    expect(candidates).toHaveLength(1);
    expect(warnings[0]).toMatch(/duplicate/);
  });

  it('is a no-op when the artifact carries no toplines', () => {
    expect(buildToplineCandidates(undefined, defaults)).toEqual({ candidates: [], warnings: [] });
    expect(buildToplineCandidates([], defaults)).toEqual({ candidates: [], warnings: [] });
  });
});

describe('writeToplineCandidates', () => {
  function makeDb(over: Record<string, unknown> = {}) {
    const calls = {
      created: [] as Record<string, unknown>[],
      updated: [] as Record<string, unknown>[],
      packageCreated: 0,
    };
    const db = {
      budgetPackage: {
        findUnique: async () => ({ id: 'pkg-1' }),
        create: async () => {
          calls.packageCreated += 1;
          return { id: 'pkg-new' };
        },
      },
      budgetPackageVehicle: { findFirst: async () => null },
      fundingPosition: {
        findFirst: async () => null,
        create: async (a: { data: Record<string, unknown> }) => {
          calls.created.push(a.data);
          return {};
        },
        update: async (a: { data: Record<string, unknown> }) => {
          calls.updated.push(a.data);
          return {};
        },
      },
      sourceDocument: { findFirst: async () => ({ id: 'doc-1' }) },
      ...over,
    };
    return { db, calls };
  }

  const candidate = () => buildToplineCandidates([good], defaults).candidates;

  it('inserts a new candidate with verification_status extracted', async () => {
    const { db, calls } = makeDb();
    const out = await writeToplineCandidates(db as never, candidate());
    expect(out).toEqual(expect.objectContaining({ inserted: 1, refreshed: 0, skippedReviewed: 0 }));
    expect(calls.created[0]).toEqual(
      expect.objectContaining({
        packageId: 'pkg-1',
        verificationStatus: 'extracted',
        scope: 'defense_appropriations_title',
        amountMillions: 850000,
        sourceDocumentId: 'doc-1',
        sourcePage: 4,
      }),
    );
  });

  it('refreshes an existing extracted row (re-running a parser is idempotent)', async () => {
    const { db, calls } = makeDb({
      fundingPosition: {
        findFirst: async () => ({ id: 'live', verificationStatus: 'extracted' }),
        create: async () => ({}),
        update: async (a: { data: Record<string, unknown> }) => {
          calls.updated.push(a.data);
          return {};
        },
      },
    });
    const out = await writeToplineCandidates(db as never, candidate());
    expect(out.refreshed).toBe(1);
    expect(out.inserted).toBe(0);
  });

  it('NEVER overwrites a reviewed or verified figure', async () => {
    for (const status of ['reviewed', 'verified']) {
      const { db, calls } = makeDb({
        fundingPosition: {
          findFirst: async () => ({ id: 'live', verificationStatus: status }),
          create: async (a: { data: Record<string, unknown> }) => {
            calls.created.push(a.data);
            return {};
          },
          update: async (a: { data: Record<string, unknown> }) => {
            calls.updated.push(a.data);
            return {};
          },
        },
      });
      const out = await writeToplineCandidates(db as never, candidate());
      expect(out.skippedReviewed).toBe(1);
      expect(calls.created).toEqual([]);
      expect(calls.updated).toEqual([]);
      expect(out.warnings[0]).toMatch(new RegExp(`a ${status} figure already holds`));
    }
  });

  it('creates the package on demand so a candidate is never dropped', async () => {
    const { db, calls } = makeDb({
      budgetPackage: {
        findUnique: async () => null,
        create: async () => {
          calls.packageCreated += 1;
          return { id: 'pkg-new' };
        },
      },
    });
    await writeToplineCandidates(db as never, candidate(), { packageName: 'FY27 Defense Budget' });
    expect(calls.packageCreated).toBe(1);
    expect(calls.created[0]!.packageId).toBe('pkg-new');
  });

  it('warns when the named source document is not registered but still writes', async () => {
    const { db, calls } = makeDb({ sourceDocument: { findFirst: async () => null } });
    const out = await writeToplineCandidates(db as never, candidate());
    expect(out.inserted).toBe(1);
    expect(calls.created[0]!.sourceDocumentId).toBeNull();
    // Provenance is never lost: the URL survives even without a registry row.
    expect(calls.created[0]!.sourceUrl).toBe('https://example.invalid/hac-d-report');
    expect(out.warnings.some((w) => /is not registered/.test(w))).toBe(true);
  });

  it('stores a package-level candidate when the named vehicle is unknown', async () => {
    const cands = buildToplineCandidates(
      [{ ...good, vehicleLabel: 'House defense approps' }],
      defaults,
    ).candidates;
    const { db, calls } = makeDb();
    const out = await writeToplineCandidates(db as never, cands);
    expect(calls.created[0]!.vehicleId).toBeNull();
    expect(out.warnings.some((w) => /stored at package level/.test(w))).toBe(true);
  });

  it('attaches to a matching vehicle and inherits its bill id', async () => {
    const cands = buildToplineCandidates(
      [{ ...good, vehicleLabel: 'House defense approps' }],
      defaults,
    ).candidates;
    const { db, calls } = makeDb({
      budgetPackageVehicle: { findFirst: async () => ({ id: 'veh-1', billId: '119-hr-9100' }) },
    });
    await writeToplineCandidates(db as never, cands);
    expect(calls.created[0]!.vehicleId).toBe('veh-1');
    expect(calls.created[0]!.billId).toBe('119-hr-9100');
  });

  it('does nothing at all for an empty candidate list', async () => {
    const { db, calls } = makeDb();
    expect(await writeToplineCandidates(db as never, [])).toEqual({
      inserted: 0,
      refreshed: 0,
      skippedReviewed: 0,
      warnings: [],
    });
    expect(calls.created).toEqual([]);
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  planPackageLoad,
  validateArtifact,
  type ExistingPosition,
  type PackageArtifact,
} from './load-defense-budget-package.js';

/**
 * Release R3, Step 3.2 — the reviewed budget-package loader's PURE planner.
 *
 * These tests are the enforcement of the plan's funding-data prerequisites: no
 * amount reaches the database without a fiscal year, stage, vehicle, scope, source,
 * and an explicit unit; a parser-grade figure is never auto-promoted to verified;
 * and a live verified figure cannot be replaced silently.
 */

const EXAMPLE_PATH = path.join(__dirname, '__fixtures__', 'defense-budget-package.example.json');
const FY2027_PATH = path.join(__dirname, '__data__', 'defense-budget', 'fy2027-package.json');

function loadJson(p: string): PackageArtifact {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as PackageArtifact;
}

/** A minimal valid artifact; individual tests break one field at a time. */
function base(): PackageArtifact {
  return {
    domain: 'defense',
    fiscalYear: 2027,
    name: 'FY27 Defense Budget',
    status: 'open',
    vehicles: [
      {
        key: 'pb',
        track: 'request',
        stage: 'president',
        label: 'Request',
        sourceUrl: 'https://example.invalid/pb',
      },
    ],
    positions: [
      {
        vehicleKey: 'pb',
        fiscalYear: 2027,
        vehicleClass: 'request',
        stage: 'president',
        scope: 'core_dod_discretionary',
        amountMillions: 900000,
        units: 'millions',
        sourceUrl: 'https://example.invalid/pb',
        sourcePage: 1,
      },
    ],
  };
}

describe('validateArtifact — envelope and vehicles', () => {
  it('accepts a well-formed artifact', () => {
    expect(validateArtifact(base())).toEqual([]);
  });

  it('requires domain, fiscalYear, and name', () => {
    const errs = validateArtifact({ vehicles: [], positions: [] });
    expect(errs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('domain is required'),
        expect.stringContaining('fiscalYear must be an integer'),
        expect.stringContaining('name is required'),
      ]),
    );
  });

  it('rejects an unknown track or stage on a vehicle', () => {
    const a = base();
    a.vehicles![0]!.track = 'omnibus';
    a.vehicles![0]!.stage = 'markup';
    const errs = validateArtifact(a);
    expect(errs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('not a BUDGET_VEHICLE_CLASSES value'),
        expect.stringContaining('not a FUNDING_STAGES value'),
      ]),
    );
  });

  it('rejects a vehicle with no traceable public document', () => {
    const a = base();
    delete a.vehicles![0]!.sourceUrl;
    expect(validateArtifact(a)).toEqual([
      expect.stringContaining('must be traceable to a public document'),
    ]);
  });

  it('rejects duplicate vehicle keys', () => {
    const a = base();
    a.vehicles!.push({ ...a.vehicles![0]! });
    expect(validateArtifact(a)).toEqual([expect.stringContaining('is duplicated')]);
  });

  it('rejects an interim period whose coverage ends before it starts', () => {
    const a = base();
    a.interimFundingPeriods = [
      {
        sequence: 1,
        vehicleLabel: 'CR #1',
        startDate: '2026-12-20',
        coverageThrough: '2026-10-01',
      },
    ];
    expect(validateArtifact(a)).toEqual([
      expect.stringContaining('impossible coverage window'),
    ]);
  });

  it('rejects a gap in the interim-period sequence', () => {
    const a = base();
    a.interimFundingPeriods = [
      { sequence: 1, vehicleLabel: 'CR #1' },
      { sequence: 3, vehicleLabel: 'CR #3' },
    ];
    expect(validateArtifact(a)).toEqual([
      expect.stringContaining('must be contiguous from 1'),
    ]);
  });

  it('rejects a negative shutdownDays', () => {
    const a = base();
    a.interimFundingPeriods = [{ sequence: 1, vehicleLabel: 'CR #1', shutdownDays: -3 }];
    expect(validateArtifact(a)).toEqual([
      expect.stringContaining('shutdownDays must be a non-negative integer'),
    ]);
  });
});

describe('planPackageLoad — the five hard rejections (§3.2)', () => {
  const cases: Array<[string, (a: PackageArtifact) => void, RegExp]> = [
    ['stage-less', (a) => delete (a.positions![0] as unknown as Record<string, unknown>).stage, /stage-less/],
    [
      'vehicle-less',
      (a) => {
        a.positions![0]!.vehicleKey = 'nope';
      },
      /vehicle-less/,
    ],
    [
      'scope-less',
      (a) => delete (a.positions![0] as unknown as Record<string, unknown>).scope,
      /scope-less/,
    ],
    [
      'source-less',
      (a) => {
        delete a.positions![0]!.sourceUrl;
        delete a.positions![0]!.sourceKey;
      },
      /source-less/,
    ],
    [
      'unit-ambiguous',
      (a) => {
        a.positions![0]!.units = 'thousands';
      },
      /unit-ambiguous/,
    ],
  ];

  for (const [label, mutate, matcher] of cases) {
    it(`rejects a ${label} position and plans no write for it`, () => {
      const a = base();
      mutate(a);
      const plan = planPackageLoad(a, []);
      expect(plan.errors.some((e) => matcher.test(e))).toBe(true);
      expect(plan.positions).toHaveLength(0);
    });
  }

  it('rejects a missing `units` exactly as it rejects a wrong one (never guesses)', () => {
    const a = base();
    delete (a.positions![0] as unknown as Record<string, unknown>).units;
    const plan = planPackageLoad(a, []);
    expect(plan.errors.some((e) => /unit-ambiguous/.test(e))).toBe(true);
  });

  it('rejects a superseded verificationStatus declared by the artifact', () => {
    const a = base();
    a.positions![0]!.verificationStatus = 'superseded';
    const plan = planPackageLoad(a, []);
    expect(plan.errors.some((e) => /cannot be declared by an artifact/.test(e))).toBe(true);
  });

  it('rejects a duplicate natural key inside one artifact', () => {
    const a = base();
    a.positions!.push({ ...a.positions![0]! });
    const plan = planPackageLoad(a, []);
    expect(plan.errors.some((e) => /duplicate natural key/.test(e))).toBe(true);
    expect(plan.positions).toHaveLength(1);
  });

  it('accepts two positions that differ ONLY by scope (they are different facts)', () => {
    const a = base();
    a.positions!.push({ ...a.positions![0]!, scope: 'national_defense_total' });
    const plan = planPackageLoad(a, []);
    expect(plan.errors).toEqual([]);
    expect(plan.positions.map((p) => p.action)).toEqual(['insert', 'insert']);
  });
});

describe('planPackageLoad — diffing against live rows', () => {
  const live = (over: Partial<ExistingPosition> = {}): ExistingPosition => ({
    id: 'live-1',
    vehicleKey: 'pb',
    fiscalYear: 2027,
    vehicleClass: 'request',
    stage: 'president',
    scope: 'core_dod_discretionary',
    amountMillions: 900000,
    verificationStatus: 'reviewed',
    ...over,
  });

  it('plans an insert when no live row matches', () => {
    const plan = planPackageLoad(base(), []);
    expect(plan.positions).toEqual([
      expect.objectContaining({ action: 'insert', existingId: null }),
    ]);
  });

  it('plans a metadata-only update when the amount is unchanged', () => {
    const plan = planPackageLoad(base(), [live()]);
    expect(plan.positions[0]).toEqual(
      expect.objectContaining({ action: 'update', existingId: 'live-1' }),
    );
    expect(plan.conflicts).toEqual([]);
  });

  it('plans a supersession when the amount changed, keeping the old row', () => {
    const plan = planPackageLoad(base(), [live({ amountMillions: 880000 })]);
    expect(plan.positions[0]).toEqual(
      expect.objectContaining({ action: 'supersede', existingId: 'live-1' }),
    );
    expect(plan.positions[0]!.reason).toMatch(/880000 → 900000/);
    expect(plan.conflicts).toEqual([]);
  });

  it('raises a CONFLICT when the changed row is already verified', () => {
    const plan = planPackageLoad(base(), [
      live({ amountMillions: 880000, verificationStatus: 'verified' }),
    ]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatch(/live VERIFIED row/);
    expect(plan.conflicts[0]).toMatch(/--supersede-verified/);
  });

  it('ignores already-superseded rows when matching (history never blocks a load)', () => {
    const plan = planPackageLoad(base(), [
      live({ id: 'old', amountMillions: 700000, verificationStatus: 'superseded' }),
    ]);
    expect(plan.positions[0]).toEqual(
      expect.objectContaining({ action: 'insert', existingId: null }),
    );
  });

  it('treats a different scope as a different row, not a supersession', () => {
    const plan = planPackageLoad(base(), [live({ scope: 'national_defense_total' })]);
    expect(plan.positions[0]!.action).toBe('insert');
  });

  it('treats a different fiscal year as a different row', () => {
    const plan = planPackageLoad(base(), [live({ fiscalYear: 2026 })]);
    expect(plan.positions[0]!.action).toBe('insert');
  });

  it('keeps authorization and appropriation as separate rows at the same stage', () => {
    const a = base();
    a.vehicles!.push({
      key: 'hac',
      track: 'appropriation',
      stage: 'house',
      label: 'House approps',
      sourceUrl: 'https://example.invalid/hac',
    });
    a.vehicles!.push({
      key: 'ndaa',
      track: 'authorization',
      stage: 'house',
      label: 'House NDAA',
      sourceUrl: 'https://example.invalid/ndaa',
    });
    a.positions!.push({
      ...a.positions![0]!,
      vehicleKey: 'hac',
      vehicleClass: 'appropriation',
      stage: 'house',
      amountMillions: 850000,
    });
    a.positions!.push({
      ...a.positions![0]!,
      vehicleKey: 'ndaa',
      vehicleClass: 'authorization',
      stage: 'house',
      amountMillions: 910000,
    });
    const plan = planPackageLoad(a, []);
    expect(plan.errors).toEqual([]);
    expect(plan.positions).toHaveLength(3);
  });
});

describe('planPackageLoad — warnings never block', () => {
  it('warns (does not reject) when a position has no source page', () => {
    const a = base();
    delete a.positions![0]!.sourcePage;
    const plan = planPackageLoad(a, []);
    expect(plan.errors).toEqual([]);
    expect(plan.warnings.some((w) => /no sourcePage/.test(w))).toBe(true);
    expect(plan.positions[0]!.action).toBe('insert');
  });

  it('warns when a position stage/class disagrees with its vehicle', () => {
    const a = base();
    a.positions![0]!.stage = 'house';
    const plan = planPackageLoad(a, []);
    expect(plan.errors).toEqual([]);
    expect(plan.warnings.some((w) => /differs from vehicle/.test(w))).toBe(true);
  });

  it('warns when a position fiscal year differs from the package year', () => {
    const a = base();
    a.positions![0]!.fiscalYear = 2026;
    const plan = planPackageLoad(a, []);
    expect(plan.warnings.some((w) => /differs from the package fiscalYear/.test(w))).toBe(true);
  });
});

describe('committed artifacts', () => {
  it('the FY2027 artifact is valid and asserts NO unreviewed figures', () => {
    const a = loadJson(FY2027_PATH);
    const plan = planPackageLoad(a, []);
    expect(plan.errors).toEqual([]);
    // Deliberately empty: no FY2027 topline may be invented. Curation is a human
    // step, and this guard fails loudly the moment a figure is added without the
    // required stage/vehicle/scope/source/units metadata.
    expect(a.positions ?? []).toEqual([]);
    expect(a.vehicles ?? []).toEqual([]);
  });

  it('the synthetic example artifact passes every validation rule', () => {
    const a = loadJson(EXAMPLE_PATH);
    const plan = planPackageLoad(a, []);
    expect(plan.errors).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.positions).toHaveLength(5);
    expect(plan.positions.every((p) => p.action === 'insert')).toBe(true);
    expect(plan.interimFundingPeriods).toHaveLength(2);
  });

  it('the example artifact is unmistakably marked synthetic', () => {
    const raw = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8')) as {
      _provenance?: { syntheticFigures?: boolean; note?: string };
    };
    expect(raw._provenance?.syntheticFigures).toBe(true);
    expect(raw._provenance?.note).toMatch(/NOT REAL BUDGET DATA/);
  });
});

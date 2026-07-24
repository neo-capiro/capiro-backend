import { classifyFindings, type VerifyInput } from './verify-defense-budget-packages.js';

/**
 * Release R3, Step 3.7 — the budget-package invariant classifier.
 *
 * The split matters: a HARD finding means a number would be shown that is wrong or
 * unattributable, and the verb must exit non-zero. A SOFT finding is a real-world
 * timing artifact (a vehicle announced before its bill row lands, a figure still
 * awaiting review) and must NOT block a deploy.
 */

function input(over: Partial<VerifyInput> = {}): VerifyInput {
  return {
    packages: [{ id: 'pkg-1', domain: 'defense', fiscalYear: 2027, name: 'FY27 Defense Budget' }],
    vehicles: [
      {
        id: 'veh-1',
        packageId: 'pkg-1',
        track: 'appropriation',
        stage: 'house',
        billId: '119-hr-9100',
        label: 'House defense approps',
      },
    ],
    positions: [
      {
        id: 'pos-1',
        packageId: 'pkg-1',
        vehicleId: 'veh-1',
        billId: '119-hr-9100',
        fiscalYear: 2027,
        vehicleClass: 'appropriation',
        stage: 'house',
        scope: 'defense_appropriations_title',
        amountMillions: 850000,
        sourceUrl: 'https://example.invalid/hac-d',
        sourceDocumentId: null,
        sourcePage: 4,
        verificationStatus: 'reviewed',
      },
    ],
    interimPeriods: [],
    knownBillIds: new Set(['119-hr-9100']),
    ...over,
  };
}

const hard = (f: ReturnType<typeof classifyFindings>) => f.filter((x) => x.severity === 'hard');
const soft = (f: ReturnType<typeof classifyFindings>) => f.filter((x) => x.severity === 'soft');
const codes = (f: ReturnType<typeof classifyFindings>) => f.map((x) => x.code);

describe('classifyFindings — clean data', () => {
  it('reports nothing for fully-sourced, reviewed data', () => {
    expect(classifyFindings(input())).toEqual([]);
  });
});

describe('classifyFindings — HARD failures block a deploy', () => {
  it('duplicate (domain, fiscalYear) package keys', () => {
    const f = classifyFindings(
      input({
        packages: [
          { id: 'a', domain: 'defense', fiscalYear: 2027, name: 'one' },
          { id: 'b', domain: 'defense', fiscalYear: 2027, name: 'two' },
        ],
      }),
    );
    expect(codes(hard(f))).toContain('duplicate_package_key');
  });

  it.each([
    ['fiscalYear', { fiscalYear: null }, 'position_missing_fiscal_year'],
    ['stage', { stage: null }, 'position_missing_stage'],
    ['vehicleClass', { vehicleClass: null }, 'position_missing_vehicle_class'],
    ['scope', { scope: null }, 'position_missing_scope'],
  ])('a position missing %s', (_label, patch, code) => {
    const base = input();
    const f = classifyFindings({
      ...base,
      positions: [{ ...base.positions[0]!, ...(patch as Record<string, unknown>) }],
    });
    expect(codes(hard(f))).toContain(code);
  });

  it('a position with no source URL and no source document', () => {
    const base = input();
    const f = classifyFindings({
      ...base,
      positions: [{ ...base.positions[0]!, sourceUrl: null, sourceDocumentId: null }],
    });
    expect(codes(hard(f))).toContain('position_missing_source');
  });

  it('accepts a position sourced ONLY by a registered document', () => {
    const base = input();
    const f = classifyFindings({
      ...base,
      positions: [{ ...base.positions[0]!, sourceUrl: null, sourceDocumentId: 'doc-1' }],
    });
    expect(hard(f)).toEqual([]);
  });

  it('an amount that is obviously not in millions (units error)', () => {
    const base = input();
    // 850 billion entered in DOLLARS instead of millions.
    const f = classifyFindings({
      ...base,
      positions: [{ ...base.positions[0]!, amountMillions: 850_000_000_000 }],
    });
    expect(codes(hard(f))).toContain('position_invalid_units');
  });

  it('a negative amount', () => {
    const base = input();
    const f = classifyFindings({
      ...base,
      positions: [{ ...base.positions[0]!, amountMillions: -1 }],
    });
    expect(codes(hard(f))).toContain('position_invalid_units');
  });

  it('two live rows on one natural key with different amounts', () => {
    const base = input();
    const f = classifyFindings({
      ...base,
      positions: [
        base.positions[0]!,
        { ...base.positions[0]!, id: 'pos-2', amountMillions: 860000 },
      ],
    });
    expect(codes(hard(f))).toContain('conflicting_live_positions');
  });

  it('two live VERIFIED rows on one natural key even at the same amount', () => {
    const base = input();
    const f = classifyFindings({
      ...base,
      positions: [
        { ...base.positions[0]!, verificationStatus: 'verified' },
        { ...base.positions[0]!, id: 'pos-2', verificationStatus: 'verified' },
      ],
    });
    expect(codes(hard(f))).toContain('conflicting_live_positions');
  });

  it('does NOT flag a superseded row alongside its live replacement', () => {
    const base = input();
    const f = classifyFindings({
      ...base,
      positions: [
        base.positions[0]!,
        { ...base.positions[0]!, id: 'old', amountMillions: 830000, verificationStatus: 'superseded' },
      ],
    });
    expect(codes(hard(f))).not.toContain('conflicting_live_positions');
  });

  it('an orphan vehicle whose package is missing', () => {
    const base = input();
    const f = classifyFindings({
      ...base,
      vehicles: [{ ...base.vehicles[0]!, packageId: 'ghost' }],
    });
    expect(codes(hard(f))).toContain('orphan_vehicle');
  });

  it('a position pointing at a missing vehicle', () => {
    const base = input();
    const f = classifyFindings({
      ...base,
      positions: [{ ...base.positions[0]!, vehicleId: 'ghost' }],
    });
    expect(codes(hard(f))).toContain('orphan_position_vehicle');
  });

  it('an interim-period sequence gap', () => {
    const f = classifyFindings(
      input({
        interimPeriods: [
          { id: 'i1', domain: 'defense', fiscalYear: 2027, sequence: 1, startDate: null, coverageThrough: null },
          { id: 'i3', domain: 'defense', fiscalYear: 2027, sequence: 3, startDate: null, coverageThrough: null },
        ],
      }),
    );
    expect(codes(hard(f))).toContain('interim_sequence_gap');
  });

  it('impossible coverage dates', () => {
    const f = classifyFindings(
      input({
        interimPeriods: [
          {
            id: 'i1',
            domain: 'defense',
            fiscalYear: 2027,
            sequence: 1,
            startDate: new Date('2026-12-20T00:00:00Z'),
            coverageThrough: new Date('2026-10-01T00:00:00Z'),
          },
        ],
      }),
    );
    expect(codes(hard(f))).toContain('impossible_coverage_dates');
  });

  it('an unknown vehicle track or stage', () => {
    const base = input();
    const f = classifyFindings({
      ...base,
      vehicles: [{ ...base.vehicles[0]!, track: 'omnibus', stage: 'markup' }],
    });
    expect(codes(hard(f))).toEqual(
      expect.arrayContaining(['vehicle_unknown_track', 'vehicle_unknown_stage']),
    );
  });
});

describe('classifyFindings — SOFT findings never block', () => {
  it('an orphan bill id is soft (a vehicle can precede its bill row)', () => {
    const f = classifyFindings(input({ knownBillIds: new Set() }));
    expect(hard(f)).toEqual([]);
    expect(codes(soft(f))).toContain('orphan_bill_id');
  });

  it('a missing page citation is soft', () => {
    const base = input();
    const f = classifyFindings({
      ...base,
      positions: [{ ...base.positions[0]!, sourcePage: null }],
    });
    expect(hard(f)).toEqual([]);
    expect(codes(soft(f))).toContain('position_missing_page');
  });

  it('a still-extracted parser figure is soft, and visibly awaiting review', () => {
    const base = input();
    const f = classifyFindings({
      ...base,
      positions: [{ ...base.positions[0]!, verificationStatus: 'extracted' }],
    });
    expect(hard(f)).toEqual([]);
    expect(codes(soft(f))).toContain('position_awaiting_review');
  });
});

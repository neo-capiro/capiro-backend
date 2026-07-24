import {
  BudgetPackagesService,
  buildStatusMatrix,
  diffAgainstRequest,
  type VehicleView,
} from './budget-packages.service.js';

/**
 * Budget Package read APIs (Release R3, §3.4) — the two guardrails that make this
 * data safe to display, plus the matrix shape.
 *
 * The delta rule is the important one: a figure may only be subtracted from another
 * figure with the SAME fiscal year and the SAME funding scope. Core DoD
 * discretionary, Function 050, national-defense total, and the defense
 * appropriations title measure different things; subtracting across them produces a
 * number that looks authoritative and is meaningless.
 */

function vehicle(over: Partial<VehicleView> = {}): VehicleView {
  return {
    id: 'v1',
    track: 'authorization',
    trackLabel: 'Authorization (NDAA)',
    stage: 'house',
    stageLabel: 'House',
    billId: '119-hr-9000',
    reportNumber: null,
    publicLaw: null,
    chamber: 'house',
    label: 'House NDAA',
    status: 'passed',
    statusAt: null,
    sourceUrl: null,
    sourceDocumentId: null,
    positions: [],
    ...over,
  };
}

describe('diffAgainstRequest — same-FY, same-scope only (§3.2 hard rule)', () => {
  const req = { fiscalYear: 2027, scope: 'core_dod_discretionary', amountMillions: 900000 };

  it('computes a delta and percentage for the same FY and scope', () => {
    expect(
      diffAgainstRequest(req, {
        fiscalYear: 2027,
        scope: 'core_dod_discretionary',
        amountMillions: 910000,
      }),
    ).toEqual({ deltaMillions: 10000, pct: 1.11 });
  });

  it('returns a negative delta for a cut', () => {
    expect(
      diffAgainstRequest(req, {
        fiscalYear: 2027,
        scope: 'core_dod_discretionary',
        amountMillions: 880000,
      }).deltaMillions,
    ).toBe(-20000);
  });

  it('refuses to compare ACROSS funding scopes', () => {
    expect(
      diffAgainstRequest(req, {
        fiscalYear: 2027,
        scope: 'national_defense_total',
        amountMillions: 1000000,
      }),
    ).toEqual({ deltaMillions: null, pct: null });
  });

  it('refuses to compare across the defense-appropriations title', () => {
    expect(
      diffAgainstRequest(req, {
        fiscalYear: 2027,
        scope: 'defense_appropriations_title',
        amountMillions: 850000,
      }).deltaMillions,
    ).toBeNull();
  });

  it('refuses to compare ACROSS fiscal years', () => {
    expect(
      diffAgainstRequest(req, {
        fiscalYear: 2026,
        scope: 'core_dod_discretionary',
        amountMillions: 880000,
      }),
    ).toEqual({ deltaMillions: null, pct: null });
  });

  it('returns nulls when there is no request baseline (request-only-year inverse)', () => {
    expect(
      diffAgainstRequest(null, {
        fiscalYear: 2027,
        scope: 'core_dod_discretionary',
        amountMillions: 910000,
      }),
    ).toEqual({ deltaMillions: null, pct: null });
  });

  it('reports a zero delta as 0, not as "no data"', () => {
    expect(
      diffAgainstRequest(req, {
        fiscalYear: 2027,
        scope: 'core_dod_discretionary',
        amountMillions: 900000,
      }),
    ).toEqual({ deltaMillions: 0, pct: 0 });
  });

  it('suppresses the percentage (not the delta) when the baseline is zero', () => {
    expect(
      diffAgainstRequest(
        { fiscalYear: 2027, scope: 'supplemental', amountMillions: 0 },
        { fiscalYear: 2027, scope: 'supplemental', amountMillions: 5000 },
      ),
    ).toEqual({ deltaMillions: 5000, pct: null });
  });
});

describe('buildStatusMatrix — track x stage grid (§3.4)', () => {
  it('returns the four named tracks across the five stages', () => {
    const { rows } = buildStatusMatrix([]);
    expect(rows.map((r) => r.track)).toEqual([
      'request',
      'authorization',
      'appropriation',
      'interim_funding',
    ]);
    for (const r of rows) {
      expect(r.cells.map((c) => c.stage)).toEqual([
        'president',
        'house',
        'senate',
        'conference',
        'enacted',
      ]);
    }
  });

  it('keeps empty cells present so the UI can say "no vehicle yet" (never $0)', () => {
    const { rows } = buildStatusMatrix([vehicle()]);
    const approps = rows.find((r) => r.track === 'appropriation')!;
    expect(approps.cells.every((c) => c.vehicles.length === 0)).toBe(true);
    const auth = rows.find((r) => r.track === 'authorization')!;
    expect(auth.cells.find((c) => c.stage === 'house')!.vehicles).toHaveLength(1);
  });

  it('holds MULTIPLE vehicles in one cell (a chamber can move more than one bill)', () => {
    const { rows } = buildStatusMatrix([
      vehicle({ id: 'v1', label: 'House NDAA' }),
      vehicle({ id: 'v2', label: 'House NDAA (second vehicle)' }),
    ]);
    const cell = rows
      .find((r) => r.track === 'authorization')!
      .cells.find((c) => c.stage === 'house')!;
    expect(cell.vehicles.map((v) => v.id)).toEqual(['v1', 'v2']);
  });

  it('appends supplemental / reconciliation rows only when such a vehicle exists', () => {
    expect(buildStatusMatrix([]).rows.map((r) => r.track)).not.toContain('supplemental');
    const { rows } = buildStatusMatrix([
      vehicle({ track: 'supplemental', stage: 'enacted', label: 'Supplemental' }),
    ]);
    expect(rows.map((r) => r.track)).toContain('supplemental');
    expect(rows.map((r) => r.track)).not.toContain('reconciliation');
  });

  it('surfaces a vehicle with an unknown track instead of dropping it', () => {
    const odd = vehicle({ id: 'weird', track: 'omnibus_special' });
    const { rows, unmatchedVehicles } = buildStatusMatrix([odd]);
    expect(rows.flatMap((r) => r.cells).flatMap((c) => c.vehicles)).toHaveLength(0);
    expect(unmatchedVehicles.map((v) => v.id)).toEqual(['weird']);
  });

  it('carries the shared human labels so the UI never re-derives them', () => {
    const { rows } = buildStatusMatrix([]);
    expect(rows.find((r) => r.track === 'interim_funding')!.trackLabel).toBe(
      'Interim funding (CR)',
    );
    expect(rows[0]!.cells[0]!.stageLabel).toBe("President's request");
  });
});

describe('BudgetPackagesService — reads', () => {
  const pkgRow = {
    id: 'pkg-1',
    domain: 'defense',
    fiscalYear: 2027,
    name: 'FY27 Defense Budget',
    status: 'open',
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    _count: { vehicles: 2 },
    positions: [{ scope: 'core_dod_discretionary' }, { scope: 'national_defense_total' }],
  };

  function makePrisma(over: Record<string, unknown> = {}) {
    return {
      budgetPackage: {
        findMany: async () => [pkgRow],
        findUnique: async () => pkgRow,
      },
      budgetPackageVehicle: { findMany: async () => [] },
      fundingPosition: { findMany: async () => [] },
      budgetInterimFundingPeriod: { findMany: async () => [] },
      billBudgetLineLink: { findMany: async () => [] },
      programElementYear: { findMany: async () => [] },
      programElement: { findMany: async () => [] },
      ...over,
    };
  }

  it('lists packages with vehicle/position counts and the live scope set', async () => {
    const svc = new BudgetPackagesService(makePrisma() as never);
    const out = await svc.list();
    expect(out).toEqual([
      expect.objectContaining({
        id: 'pkg-1',
        fiscalYear: 2027,
        vehicleCount: 2,
        positionCount: 2,
        scopes: ['core_dod_discretionary', 'national_defense_total'],
      }),
    ]);
  });

  it('404s an unknown package id', async () => {
    const svc = new BudgetPackagesService(
      makePrisma({ budgetPackage: { findMany: async () => [], findUnique: async () => null } }) as never,
    );
    await expect(svc.get('nope')).rejects.toThrow(/BUDGET_PACKAGE_NOT_FOUND/);
  });

  it('excludes superseded positions from the live read', async () => {
    let captured: Record<string, unknown> | null = null;
    const svc = new BudgetPackagesService(
      makePrisma({
        budgetPackageVehicle: {
          findMany: async (a: Record<string, unknown>) => {
            captured = a;
            return [];
          },
        },
      }) as never,
    );
    await svc.get('pkg-1');
    const include = (captured as unknown as { include: { positions: { where: unknown } } }).include;
    expect(include.positions.where).toEqual({ verificationStatus: { not: 'superseded' } });
  });

  it('returns superseded figures ONLY through history (audit trail preserved)', async () => {
    const svc = new BudgetPackagesService(
      makePrisma({
        fundingPosition: {
          findMany: async () => [
            {
              id: 'old',
              vehicleId: 'v1',
              billId: '119-hr-9000',
              fiscalYear: 2027,
              vehicleClass: 'authorization',
              stage: 'house',
              scope: 'core_dod_discretionary',
              amountMillions: '880000.00',
              effectiveDate: null,
              sourceUrl: null,
              sourcePage: null,
              sourceDocumentId: null,
              note: null,
              verificationStatus: 'superseded',
            },
          ],
        },
      }) as never,
    );
    const out = await svc.history('pkg-1');
    expect(out.supersededPositions).toHaveLength(1);
    expect(out.supersededPositions[0]!.amountMillions).toBe(880000);
    expect(out.supersededPositions[0]!.verificationStatus).toBe('superseded');
  });

  it('byBill returns [] for a bill that is not a budget vehicle (not a 404)', async () => {
    const svc = new BudgetPackagesService(makePrisma() as never);
    await expect(svc.byBill('119-hr-1')).resolves.toEqual([]);
  });

  it('program-element impacts are empty when the package has no linked bills', async () => {
    const svc = new BudgetPackagesService(makePrisma() as never);
    const out = await svc.programElementImpacts('pkg-1');
    expect(out.impacts).toEqual([]);
  });

  it('program-element impacts keep appropriations marks separate from authorization', async () => {
    const svc = new BudgetPackagesService(
      makePrisma({
        budgetPackageVehicle: { findMany: async () => [{ billId: '119-hr-9100' }] },
        billBudgetLineLink: {
          findMany: async () => [
            {
              peCode: '0603270A',
              linkType: 'explicit_pe_code',
              status: 'accepted',
              confidence: 1,
              billId: '119-hr-9100',
            },
          ],
        },
        programElementYear: {
          findMany: async () => [
            {
              peCode: '0603270A',
              fy: 2027,
              request: '100.00',
              // Authorization marks exist but must NOT become the funding number.
              hascMark: '150.00',
              sascMark: '140.00',
              hacDMark: '120.00',
              sacDMark: '110.00',
              enacted: null,
            },
          ],
        },
        programElement: { findMany: async () => [{ peCode: '0603270A', title: 'A program' }] },
      }) as never,
    );
    const out = await svc.programElementImpacts('pkg-1');
    expect(out.impacts).toHaveLength(1);
    const row = out.impacts[0]!;
    // House/Senate read the APPROPRIATIONS marks (hacD/sacD), never hasc/sasc.
    expect(row.houseMillions).toBe(120);
    expect(row.senateMillions).toBe(110);
    // Delta uses the furthest available appropriations stage (senate here), same FY.
    expect(row.deltaVsRequestMillions).toBe(10);
    expect(row.pct).toBe(10);
    expect(row.matchBasis).toBe('explicit_pe_code');
  });

  // ── R4 §4.4: cross-year CR / lapse history ────────────────────────────────
  describe('interimFundingHistory', () => {
    const periods = [
      {
        id: 'i1',
        domain: 'defense',
        fiscalYear: 2026,
        sequence: 1,
        vehicleLabel: 'CR #1',
        startDate: new Date('2025-10-01T00:00:00Z'),
        coverageThrough: new Date('2025-12-19T00:00:00Z'),
        billId: '119-hr-5371',
        publicLaw: 'P.L. 119-001',
        shutdownDays: 0,
        notes: null,
        sourceUrl: 'https://example.invalid/cr1',
      },
      {
        id: 'i2',
        domain: 'defense',
        fiscalYear: 2026,
        sequence: 2,
        vehicleLabel: 'CR #2',
        startDate: new Date('2025-12-22T00:00:00Z'),
        coverageThrough: new Date('2026-01-30T00:00:00Z'),
        billId: null,
        publicLaw: null,
        shutdownDays: 2,
        notes: 'A two-day lapse preceded this window.',
        sourceUrl: null,
      },
    ];

    function historyPrisma(over: Record<string, unknown> = {}) {
      return makePrisma({
        budgetInterimFundingPeriod: { findMany: async () => periods },
        budgetPackage: {
          findUnique: async () => pkgRow,
          findMany: async () => [
            {
              ...pkgRow,
              id: 'pkg-2026',
              fiscalYear: 2026,
              name: 'FY26 Defense Budget',
              status: 'enacted',
              vehicles: [
                {
                  id: 'veh-enacted',
                  label: 'Consolidated Appropriations Act, 2026',
                  billId: '119-hr-6000',
                  publicLaw: 'P.L. 119-086',
                },
              ],
              positions: [
                {
                  id: 'p-enacted',
                  vehicleId: 'veh-enacted',
                  billId: '119-hr-6000',
                  fiscalYear: 2026,
                  vehicleClass: 'appropriation',
                  stage: 'enacted',
                  scope: 'defense_appropriations_title',
                  amountMillions: '830000.00',
                  effectiveDate: null,
                  sourceUrl: null,
                  sourcePage: null,
                  sourceDocumentId: null,
                  note: null,
                  verificationStatus: 'verified',
                },
              ],
            },
          ],
        },
        ...over,
      });
    }

    it('groups CR windows by fiscal year, newest first, in sequence order', async () => {
      const svc = new BudgetPackagesService(historyPrisma() as never);
      const out = await svc.interimFundingHistory('defense');
      expect(out).toHaveLength(1);
      expect(out[0]!.fiscalYear).toBe(2026);
      expect(out[0]!.periods.map((p) => p.sequence)).toEqual([1, 2]);
      expect(out[0]!.crCount).toBe(2);
    });

    it('SUMS recorded lapse days and never estimates one', async () => {
      const svc = new BudgetPackagesService(historyPrisma() as never);
      const out = await svc.interimFundingHistory('defense');
      expect(out[0]!.lapseDays).toBe(2);
    });

    it('treats a null shutdownDays as contributing nothing (not as zero-verified)', async () => {
      const svc = new BudgetPackagesService(
        historyPrisma({
          budgetInterimFundingPeriod: {
            findMany: async () => [{ ...periods[0]!, shutdownDays: null }],
          },
        }) as never,
      );
      const out = await svc.interimFundingHistory('defense');
      expect(out[0]!.lapseDays).toBe(0);
      expect(out[0]!.periods[0]!.shutdownDays).toBeNull();
    });

    it('surfaces the enacted vehicle and its public law', async () => {
      const svc = new BudgetPackagesService(historyPrisma() as never);
      const out = await svc.interimFundingHistory('defense');
      expect(out[0]!.enactedVehicle).toEqual({
        label: 'Consolidated Appropriations Act, 2026',
        billId: '119-hr-6000',
        publicLaw: 'P.L. 119-086',
      });
    });

    it('returns the enacted amount WITH its scope, never a bare number', async () => {
      const svc = new BudgetPackagesService(historyPrisma() as never);
      const out = await svc.interimFundingHistory('defense');
      expect(out[0]!.enactedPositions).toHaveLength(1);
      expect(out[0]!.enactedPositions[0]).toEqual(
        expect.objectContaining({
          amountMillions: 830000,
          scope: 'defense_appropriations_title',
          stage: 'enacted',
          vehicleClass: 'appropriation',
          verificationStatus: 'verified',
        }),
      );
    });

    it('preserves each period ISO date and its source url', async () => {
      const svc = new BudgetPackagesService(historyPrisma() as never);
      const out = await svc.interimFundingHistory('defense');
      expect(out[0]!.periods[0]!.coverageThrough).toBe('2025-12-19T00:00:00.000Z');
      expect(out[0]!.periods[0]!.sourceUrl).toBe('https://example.invalid/cr1');
    });

    it('includes a fiscal year that has CRs but no package row yet', async () => {
      const svc = new BudgetPackagesService(
        historyPrisma({
          budgetPackage: { findUnique: async () => pkgRow, findMany: async () => [] },
        }) as never,
      );
      const out = await svc.interimFundingHistory('defense');
      expect(out).toHaveLength(1);
      expect(out[0]!.packageId).toBeNull();
      expect(out[0]!.enactedVehicle).toBeNull();
      expect(out[0]!.crCount).toBe(2);
    });

    it('includes a fiscal year with an enacted package but no CR at all', async () => {
      const svc = new BudgetPackagesService(
        historyPrisma({ budgetInterimFundingPeriod: { findMany: async () => [] } }) as never,
      );
      const out = await svc.interimFundingHistory('defense');
      expect(out).toHaveLength(1);
      expect(out[0]!.crCount).toBe(0);
      expect(out[0]!.lapseDays).toBe(0);
      expect(out[0]!.enactedVehicle).not.toBeNull();
    });

    it('returns [] when the domain has no funding history recorded', async () => {
      const svc = new BudgetPackagesService(
        historyPrisma({
          budgetInterimFundingPeriod: { findMany: async () => [] },
          budgetPackage: { findUnique: async () => pkgRow, findMany: async () => [] },
        }) as never,
      );
      await expect(svc.interimFundingHistory('defense')).resolves.toEqual([]);
    });
  });

  it('leaves a PE delta null when the PE has no request for that fiscal year', async () => {
    const svc = new BudgetPackagesService(
      makePrisma({
        budgetPackageVehicle: { findMany: async () => [{ billId: '119-hr-9100' }] },
        billBudgetLineLink: {
          findMany: async () => [
            {
              peCode: '0603270A',
              linkType: 'title_match',
              status: 'candidate',
              confidence: 0.5,
              billId: '119-hr-9100',
            },
          ],
        },
        programElementYear: {
          findMany: async () => [
            { peCode: '0603270A', fy: 2027, request: null, hacDMark: '120.00' },
          ],
        },
        programElement: { findMany: async () => [] },
      }) as never,
    );
    const out = await svc.programElementImpacts('pkg-1');
    expect(out.impacts[0]!.requestMillions).toBeNull();
    expect(out.impacts[0]!.deltaVsRequestMillions).toBeNull();
    expect(out.impacts[0]!.reviewStatus).toBe('candidate');
  });
});

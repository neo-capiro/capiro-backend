import { BillDossierService } from '../src/bill-dossier/bill-dossier.service.js';
import type {
  SourceBillIdentity,
  SourceBillPeImpact,
  SourceFundingPosition,
} from '../src/sourcedata/source-data.repository.js';

/**
 * Bill 360 funding integration (Release R3, §3.6).
 *
 * The contract under test is the honesty contract:
 *  - with the flag off, NO funding query runs and the block says so;
 *  - with the flag on but no linked data, arrays are empty and no $0 appears;
 *  - a delta is computed ONLY within one fiscal year and one funding scope;
 *  - authorization and appropriation both appear and are never merged;
 *  - a fuzzy PE link is labelled inferred, a verbatim PE code explicit.
 */

const BILL = '119-hr-9100';
const PACKAGE = { packageId: 'pkg-1', domain: 'defense', fiscalYear: 2027, name: 'FY27 Defense Budget', status: 'open' };

const identity: SourceBillIdentity = {
  id: BILL,
  congress: 119,
  billType: 'hr',
  billNumber: '9100',
  title: 'Department of Defense Appropriations Act, 2027',
  originChamber: 'House',
  sponsorName: 'Rep. Example',
  introducedDate: new Date('2026-05-01T00:00:00Z'),
  status: 'passed_chamber',
  statusAt: new Date('2026-07-10T00:00:00Z'),
  latestActionText: 'Passed the House.',
  latestActionDate: new Date('2026-07-10T00:00:00Z'),
  policyArea: 'Armed Forces and National Security',
  url: 'https://congress.gov/bill/119/hr/9100',
  lastSyncedAt: new Date('2026-07-11T00:00:00Z'),
  updateDate: new Date('2026-07-10T12:00:00Z'),
  updateDateIncludingText: new Date('2026-07-10T12:00:00Z'),
};

function position(over: Partial<SourceFundingPosition> = {}): SourceFundingPosition {
  return {
    id: 'p-house-approps',
    packageId: 'pkg-1',
    packageName: 'FY27 Defense Budget',
    domain: 'defense',
    vehicleId: 'veh-house',
    vehicleLabel: 'House defense appropriations',
    vehicleTrack: 'appropriation',
    fiscalYear: 2027,
    vehicleClass: 'appropriation',
    stage: 'house',
    scope: 'defense_appropriations_title',
    amountMillions: '850000.00',
    effectiveDate: new Date('2026-07-10T00:00:00Z'),
    sourceUrl: 'https://example.invalid/hac-d',
    sourcePage: 4,
    note: null,
    verificationStatus: 'reviewed',
    ...over,
  };
}

function peImpact(over: Partial<SourceBillPeImpact> = {}): SourceBillPeImpact {
  return {
    peCode: '0603270A',
    title: 'Electronic Warfare Technology',
    fiscalYear: 2027,
    requestMillions: '100.00',
    houseMillions: '120.00',
    senateMillions: '110.00',
    enactedMillions: null,
    matchBasis: 'explicit_pe_code',
    reviewStatus: 'accepted',
    confidence: 1,
    ...over,
  };
}

/** SourceDataRepository fake; funding reads are overridable per test. */
function makeSource(over: Record<string, unknown> = {}) {
  const calls = { funding: 0, pe: 0, related: 0, provisions: 0, parent: 0 };
  return {
    calls,
    src: {
      getBillDossierIdentity: async (id: string) => (id === BILL ? identity : null),
      getBillActions: async () => [],
      getBillVotes: async () => [],
      getGoverningRules: async () => [],
      getBillCommittees: async () => [],
      getBillFiscalNotes: async () => [],
      getBillSourceFreshness: async () => null,
      getUpcomingHearingsForBills: async () => [],
      getBillMemberVoteSummary: async () => [],
      getClientProfile: async () => ({ name: 'Acme Defense', sectorTag: 'DEFENSE' }),
      getBillFundingPositions: async () => {
        calls.funding += 1;
        return [position()];
      },
      getBillProgramElementImpacts: async () => {
        calls.pe += 1;
        return [peImpact()];
      },
      getRelatedBudgetVehicles: async () => {
        calls.related += 1;
        return [
          {
            vehicleId: 'veh-senate',
            billId: '119-s-9100',
            label: 'Senate defense appropriations',
            track: 'appropriation',
            stage: 'senate',
            reportNumber: null,
            publicLaw: null,
            status: 'reported',
          },
        ];
      },
      getBillFundingProvisions: async () => {
        calls.provisions += 1;
        return [];
      },
      getParentBudgetPackage: async () => {
        calls.parent += 1;
        return PACKAGE;
      },
      ...over,
    },
  };
}

function svcWith(over: Record<string, unknown> = {}) {
  const { src, calls } = makeSource(over);
  return { svc: new BillDossierService({} as never, src as never, {} as never), calls };
}

describe('funding OFF — the flag gates the query itself', () => {
  it('issues no funding read and returns the grounded not-enabled state', async () => {
    const { svc, calls } = svcWith();
    const d = await svc.getGlobalDossier(BILL);
    expect(calls.funding).toBe(0);
    expect(calls.pe).toBe(0);
    expect(calls.parent).toBe(0);
    expect(d.funding.available).toBe(false);
    expect(d.funding.status).toMatch(/not yet enabled/i);
    expect(d.funding.positions).toEqual([]);
    expect(d.funding.programElementImpacts).toEqual([]);
    expect(d.relatedVehicles).toEqual([]);
  });

  it('leaves the funding KPI cells as em-dashes, never $0', async () => {
    const { svc } = svcWith();
    const d = await svc.getGlobalDossier(BILL);
    expect(d.kpis.find((k) => k.label === 'Funding position')!.value).toBe('—');
    expect(d.kpis.find((k) => k.label === 'Δ from request')!.value).toBe('—');
    expect(JSON.stringify(d.kpis)).not.toContain('$0');
  });
});

describe('funding ON but nothing linked — honest empty state', () => {
  it('returns empty arrays with a data-availability status, not $0', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [],
      getBillProgramElementImpacts: async () => [],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.available).toBe(false);
    expect(d.funding.status).toMatch(/No reviewed funding positions/i);
    expect(d.funding.positions).toEqual([]);
    expect(d.funding.reqCompare).toBeNull();
    // No fabricated amount anywhere: the block carries no numeric figure at all.
    // (The status COPY legitimately mentions "$0" — it is the promise not to show one.)
    expect(d.funding.positions.some((p) => p.amountMillions === 0)).toBe(false);
    expect(d.funding.programElementImpacts).toEqual([]);
    // The parent package label still resolves, so the UI can point at the cycle.
    expect(d.funding.parentPackageLabel).toBe('FY27 Defense Budget');
  });

  it('still returns related vehicles so the reader can see the cycle', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [],
      getBillProgramElementImpacts: async () => [],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.relatedVehicles).toEqual([
      expect.objectContaining({ billId: '119-s-9100', role: 'appropriation · senate' }),
    ]);
  });
});

describe('funding ON with data', () => {
  it('populates positions, PE impacts, provisions, vehicles, and the package label', async () => {
    const { svc } = svcWith();
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.available).toBe(true);
    expect(d.funding.status).toBeNull();
    expect(d.funding.positions).toHaveLength(1);
    expect(d.funding.programElementImpacts).toHaveLength(1);
    expect(d.funding.parentPackageLabel).toBe('FY27 Defense Budget');
    expect(d.relatedVehicles).toHaveLength(1);
  });

  it('every position carries FY-independent labels: scope, stage, class, source, verification', async () => {
    const { svc } = svcWith();
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.positions[0]).toEqual(
      expect.objectContaining({
        scope: 'defense_appropriations_title',
        stage: 'house',
        vehicleClass: 'appropriation',
        amountMillions: 850000,
        verification: 'reviewed',
        source: 'House defense appropriations',
        sourceUrl: 'https://example.invalid/hac-d',
      }),
    );
  });

  it('computes the request delta ONLY within the same FY and scope', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [
        position(),
        position({
          id: 'p-request',
          stage: 'president',
          vehicleClass: 'request',
          vehicleLabel: 'FY2027 request',
          amountMillions: '840000.00',
        }),
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.reqCompare).toEqual(
      expect.objectContaining({
        scope: 'defense_appropriations_title',
        amountMillions: 840000,
        deltaMillions: 10000,
        comparable: true,
      }),
    );
    expect(d.kpis.find((k) => k.label === 'Δ from request')!.value).toBe('+$10.0B');
    expect(d.kpis.find((k) => k.label === 'Δ from request')!.sub).toBe('same scope only');
  });

  it('does NOT compute a delta against a request on a different scope', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [
        position(),
        position({
          id: 'p-request-other-scope',
          stage: 'president',
          vehicleClass: 'request',
          scope: 'national_defense_total',
          amountMillions: '1000000.00',
        }),
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.reqCompare).toBeNull();
    expect(d.kpis.find((k) => k.label === 'Δ from request')!.value).toBe('—');
    // …and the guardrail explains why the two figures are not subtracted.
    expect(d.funding.guardrail).toMatch(/same fiscal year and the same scope/i);
  });

  it('does NOT compute a delta against a request from a different fiscal year', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [
        position(),
        position({
          id: 'p-request-prior-fy',
          stage: 'president',
          vehicleClass: 'request',
          fiscalYear: 2026,
          amountMillions: '820000.00',
        }),
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.reqCompare).toBeNull();
  });

  it('shows no guardrail when every figure is on one scope', async () => {
    const { svc } = svcWith();
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.guardrail).toBeNull();
  });

  it('keeps authorization and appropriation as SEPARATE rows, never merged', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [
        position(),
        position({
          id: 'p-auth',
          vehicleClass: 'authorization',
          vehicleLabel: 'House NDAA',
          amountMillions: '910000.00',
          scope: 'defense_appropriations_title',
        }),
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.positions).toHaveLength(2);
    expect(d.funding.positions.map((p) => p.vehicleClass).sort()).toEqual([
      'appropriation',
      'authorization',
    ]);
    // The primary (KPI) figure is the APPROPRIATION — the money, not the ceiling.
    const primary = d.funding.positions.find((p) => p.primary)!;
    expect(primary.vehicleClass).toBe('appropriation');
  });

  it('picks the furthest-progressed stage as the primary figure', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [
        position(),
        position({ id: 'p-enacted', stage: 'enacted', amountMillions: '845000.00' }),
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.positions.find((p) => p.primary)!.stage).toBe('enacted');
    expect(d.kpis.find((k) => k.label === 'Funding position')!.value).toBe('$845.0B');
  });

  it('surfaces a like-for-like Senate comparison on the same scope with no delta claimed', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [
        position(),
        position({
          id: 'p-senate',
          stage: 'senate',
          vehicleLabel: 'Senate defense appropriations',
          amountMillions: '855000.00',
        }),
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    // Primary is the furthest stage (senate); the comparison row is the other chamber.
    expect(d.funding.senateCompare === null || d.funding.senateCompare.comparable).toBe(true);
    expect(d.funding.positions).toHaveLength(2);
  });

  it('carries the source PAGE on every position (§4.1)', async () => {
    const { svc } = svcWith();
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.positions[0]!.sourcePage).toBe(4);
  });

  it('builds the House/Senate/conference like-for-like set in stage order (§4.1)', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [
        position(),
        position({ id: 'p-senate', stage: 'senate', vehicleLabel: 'Senate approps', amountMillions: '855000.00' }),
        position({ id: 'p-conf', stage: 'conference', vehicleLabel: 'Conference', amountMillions: '852000.00' }),
        position({
          id: 'p-request',
          stage: 'president',
          vehicleClass: 'request',
          vehicleLabel: 'FY2027 request',
          amountMillions: '840000.00',
        }),
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    // Primary is the furthest stage (conference); the set is every OTHER same-scope,
    // same-FY figure, ordered president → house → senate.
    expect(d.funding.positions.find((p) => p.primary)!.stage).toBe('conference');
    expect(d.funding.comparisons.map((c) => c.label)).toEqual([
      'FY2027 request',
      'House defense appropriations',
      'Senate approps',
    ]);
    // Deltas are against the primary, same scope, same fiscal year.
    expect(d.funding.comparisons.map((c) => c.deltaMillions)).toEqual([-12000, -2000, 3000]);
    expect(d.funding.comparisons.every((c) => c.comparable)).toBe(true);
  });

  it('EXCLUDES a different-scope figure from the like-for-like set', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [
        position(),
        position({
          id: 'p-other-scope',
          stage: 'senate',
          scope: 'national_defense_total',
          amountMillions: '1000000.00',
        }),
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.comparisons).toEqual([]);
    // The figure is still returned — just never compared.
    expect(d.funding.positions).toHaveLength(2);
    expect(d.funding.guardrail).toMatch(/same fiscal year and the same scope/i);
  });

  it('EXCLUDES a different-fiscal-year figure from the like-for-like set', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [
        position(),
        position({ id: 'p-prior-fy', stage: 'senate', fiscalYear: 2026, amountMillions: '820000.00' }),
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.comparisons).toEqual([]);
  });

  it('returns an empty like-for-like set for a lone position', async () => {
    const { svc } = svcWith();
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.comparisons).toEqual([]);
  });

  it('labels a verbatim PE-code link explicit and a fuzzy one inferred', async () => {
    const { svc } = svcWith({
      getBillProgramElementImpacts: async () => [
        peImpact(),
        peImpact({
          peCode: '0604270A',
          matchBasis: 'title_match',
          reviewStatus: 'candidate',
          confidence: 0.55,
        }),
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    const [explicit, inferred] = d.funding.programElementImpacts;
    expect(explicit!.basis).toBe('explicit');
    expect(inferred!.basis).toBe('inferred');
    expect(inferred!.source).toMatch(/candidate/);
  });

  it('computes a PE delta vs request from the furthest appropriations stage', async () => {
    const { svc } = svcWith();
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    const pe = d.funding.programElementImpacts[0]!;
    expect(pe.requestMillions).toBe(100);
    expect(pe.houseMillions).toBe(120);
    expect(pe.senateMillions).toBe(110);
    expect(pe.deltaVsRequestMillions).toBe(10); // senate (110) − request (100)
    expect(pe.pct).toBe(10);
  });

  it('leaves a PE delta null when the PE has no request that year', async () => {
    const { svc } = svcWith({
      getBillProgramElementImpacts: async () => [peImpact({ requestMillions: null })],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.programElementImpacts[0]!.deltaVsRequestMillions).toBeNull();
    expect(d.funding.programElementImpacts[0]!.pct).toBeNull();
  });

  it('marks report provisions as official and cites committee, FY, and page', async () => {
    const { svc } = svcWith({
      getBillFundingProvisions: async () => [
        {
          provisionId: 'prov-1',
          committee: 'HAC-D',
          fy: 2027,
          heading: 'Electronic warfare increase',
          text: 'The Committee recommends an increase of $20,000,000.',
          pageStart: 88,
          pageEnd: 88,
          actionType: 'adds',
          peCode: '0603270A',
          matchBasis: 'pe_code',
          confidence: 1,
          reviewStatus: 'accepted',
        },
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.provisions[0]).toEqual(
      expect.objectContaining({
        origin: 'official',
        title: 'Electronic warfare increase',
        sec: 'PE 0603270A',
        source: 'HAC-D · FY2027 · p.88',
      }),
    );
  });
});

describe('state bills never claim funding', () => {
  it('returns the state unsupported message even with funding enabled', async () => {
    const stateSrc = {
      getStateBillById: async () => ({
        id: 'tx-2025-hb1234',
        state: 'TX',
        sessionKey: '2025',
        identifier: 'HB 1234',
        title: 'A Texas measure',
        status: 'in_committee',
        statusAt: new Date('2026-04-10T00:00:00Z'),
        latestActionText: 'Referred.',
        latestActionDate: new Date('2026-04-10T00:00:00Z'),
        textDate: null,
        sponsorName: null,
        sponsorParty: null,
        sponsorCount: 1,
        stateUrl: null,
        url: null,
        subjects: [],
      }),
      getStateBillActionsByIds: async () => [],
      getStateVotesForBills: async () => [],
      getMovedCompanions: async () => [],
    };
    const svc = new BillDossierService({} as never, {} as never, stateSrc as never);
    const d = await svc.getGlobalDossier('tx-2025-hb1234', { funding: true });
    expect(d.funding.available).toBe(false);
    expect(d.funding.status).toMatch(/state funding data is not available/i);
    expect(d.funding.positions).toEqual([]);
  });
});

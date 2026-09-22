import { BillDossierService } from '../src/bill-dossier/bill-dossier.service.js';
import type { BillDossierResponse, BillKpiId } from '../src/bill-dossier/bill-dossier.types.js';
import type {
  SourceBillIdentity,
  SourceBillPeImpact,
  SourceFundingPosition,
} from '../src/sourcedata/source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';

/** LW-QA-021: cells are addressed by SEMANTIC id, never by index or by label. */
function kpi(d: BillDossierResponse, id: BillKpiId) {
  const cell = d.kpis.find((k) => k.id === id);
  if (!cell) throw new Error(`no KPI cell with id ${id}`);
  return cell;
}

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
const PACKAGE = {
  packageId: 'pkg-1',
  domain: 'defense',
  fiscalYear: 2027,
  name: 'FY27 Defense Budget',
  status: 'open',
  vehicleId: 'veh-house',
  vehicleLabel: 'House defense appropriations',
  vehicleTrack: 'appropriation',
  vehicleStage: 'house',
  vehicleStatus: 'passed',
  vehicleChamber: 'house',
  sourceDocumentTitle: 'House Defense Appropriations Report, FY2027',
  sourceDocumentKey: 'hac_d_fy2027_house',
  sourceDocumentSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  sourceDocumentUrl: 'https://example.invalid/hac-d',
  sourceDocumentCurrent: true,
};

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
    vehicleStatus: 'passed',
    fiscalYear: 2027,
    vehicleClass: 'appropriation',
    stage: 'house',
    scope: 'defense_appropriations_title',
    amountMillions: '850000.00',
    effectiveDate: new Date('2026-07-10T00:00:00Z'),
    sourceUrl: 'https://example.invalid/hac-d',
    sourcePage: 4,
    sourceDocumentTitle: 'House Defense Appropriations Report, FY2027',
    sourceDocumentKey: 'hac_d_fy2027_house',
    sourceDocumentSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    sourceDocumentCurrent: true,
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
    vehicleTrack: 'appropriation',
    vehicleStage: 'house',
    requestMillions: '100.00',
    houseMillions: '120.00',
    senateMillions: '110.00',
    conferenceMillions: null,
    enactedMillions: null,
    requestSourceDocumentKey: 'pb_fy2027',
    requestSourceDocumentSha256:
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    houseSourceDocumentKey: 'hac_d_fy2027_house',
    houseSourceDocumentSha256:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    senateSourceDocumentKey: 'sac_d_fy2027_senate',
    senateSourceDocumentSha256:
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
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

/** Client route: no tracking rows, no alerts, no matches — only the funding path
 *  is under test, so every tenant-scoped read returns empty. */
const emptyClientPrisma = {
  withTenant: async <T>(_tenantId: string, fn: (tx: unknown) => Promise<T> | T) =>
    fn({
      trackedBill: { findFirst: async () => null },
      intelAlert: { findMany: async () => [] },
      billMatch: { findFirst: async () => null },
    }),
};

function clientSvcWith(over: Record<string, unknown> = {}) {
  const { src, calls } = makeSource(over);
  return {
    svc: new BillDossierService(emptyClientPrisma as never, src as never, {} as never),
    calls,
  };
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

  it('leaves the funding KPI cells unavailable WITH A REASON, never $0', async () => {
    const { svc } = svcWith();
    const d = await svc.getGlobalDossier(BILL);
    // LW-QA-021: an absent figure is `null` + a grounded reason — never $0, and
    // never a bare em-dash the reader has to interpret as "blank".
    expect(kpi(d, 'funding_position').value).toBeNull();
    expect(kpi(d, 'funding_position').unavailableReason).toMatch(/not yet enabled/i);
    expect(kpi(d, 'delta_from_request').value).toBeNull();
    expect(kpi(d, 'delta_from_request').unavailableReason).toMatch(/not yet enabled/i);
    // No fabricated amount in any VALUE. (The reason COPY legitimately contains
    // "$0" — it is the promise not to show one, so it is excluded here.)
    expect(JSON.stringify(d.kpis.map((k) => k.value))).not.toContain('$0');
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
    expect(kpi(d, 'delta_from_request').value).toBe('+$10.0B');
    expect(kpi(d, 'delta_from_request').sub).toBe('same scope only');
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
    expect(kpi(d, 'delta_from_request').value).toBeNull();
    // …and the guardrail explains why the two figures are not subtracted — the
    // KPI cell carries that same explanation rather than a bare em-dash.
    expect(d.funding.guardrail).toMatch(/same fiscal year and the same scope/i);
    expect(kpi(d, 'delta_from_request').unavailableReason).toBe(d.funding.guardrail);
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

  it('picks the reviewed amount on the exact selected vehicle stage', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [
        position(),
        position({ id: 'p-enacted', stage: 'enacted', amountMillions: '845000.00' }),
      ],
      getParentBudgetPackage: async () => ({ ...PACKAGE, vehicleStage: 'enacted' }),
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.positions.find((p) => p.primary)!.stage).toBe('enacted');
    expect(kpi(d, 'funding_position').value).toBe('$845.0B');
  });

  it('does not promote a later-stage or older-FY row from a different bill vehicle', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [
        position(),
        position({
          id: 'p-other-vehicle',
          vehicleId: 'veh-other',
          stage: 'enacted',
          amountMillions: '999999.00',
        }),
        position({
          id: 'p-prior-fy',
          fiscalYear: 2026,
          stage: 'enacted',
          amountMillions: '777777.00',
        }),
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.positions.find((p) => p.primary)).toEqual(
      expect.objectContaining({ amountMillions: 850000, stage: 'house', fiscalYear: 2027 }),
    );
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
      getParentBudgetPackage: async () => ({ ...PACKAGE, vehicleStage: 'conference' }),
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

  it('computes a House-version PE delta without leaking later Senate values', async () => {
    const { svc } = svcWith();
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    const pe = d.funding.programElementImpacts[0]!;
    expect(pe.requestMillions).toBe(100);
    expect(pe.houseMillions).toBe(120);
    expect(pe.senateMillions).toBeNull();
    expect(pe.deltaVsRequestMillions).toBe(20); // House (120) − request (100)
    expect(pe.pct).toBe(20);
    expect(pe.source).toMatch(/request source pb_fy2027@aaaaaaaaaaaa/);
    expect(pe.source).toMatch(/house source hac_d_fy2027_house@0123456789ab/);
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
          billLinkStatus: 'accepted',
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

  it('treats linked House authorization tables as pending analysis, not unavailable', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [],
      getBillProgramElementImpacts: async () => [
        peImpact({
          vehicleTrack: 'authorization',
          houseMillions: '125.00',
          senateMillions: null,
          conferenceMillions: null,
          enactedMillions: null,
        }),
      ],
      getParentBudgetPackage: async () => ({
        ...PACKAGE,
        vehicleId: 'veh-ndaa-house',
        vehicleLabel: 'House-passed FY2027 NDAA',
        vehicleTrack: 'authorization',
        vehicleStage: 'house',
        sourceDocumentTitle: 'House-passed H.R. 8800 funding tables',
        sourceDocumentKey: 'hr8800_house_passed_fy2027',
      }),
    });

    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.available).toBe(true);
    expect(d.funding.tablesAvailable).toBe(true);
    expect(d.funding.analysisStatus).toBe('analysis_pending');
    expect(d.funding.status).toBe('Funding tables are available; amounts await verification.');
    expect(d.funding.vehicle).toEqual(
      expect.objectContaining({
        track: 'authorization',
        stage: 'house',
        fiscalYear: 2027,
        amountTreatment: 'proposed_authorization',
        sourceDocumentKey: 'hr8800_house_passed_fy2027',
      }),
    );
    expect(kpi(d, 'funding_position')).toEqual(
      expect.objectContaining({
        label: 'House authorization',
        value: null,
        unavailableLabel: 'Analysis pending',
        unavailableReason: 'Funding tables are available; amounts await verification.',
      }),
    );
    expect(kpi(d, 'delta_from_request')).toEqual(
      expect.objectContaining({
        label: 'Change vs. FY2027 request',
        value: null,
        unavailableLabel: 'Comparison pending',
      }),
    );
  });

  it('never promotes an extracted amount to the primary position', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [
        position({ verificationStatus: 'extracted', amountMillions: '999999.00' }),
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.positions).toEqual([
      expect.objectContaining({ amountMillions: 999999, verification: 'extracted', primary: false }),
    ]);
    expect(d.funding.analysisStatus).toBe('analysis_pending');
    expect(kpi(d, 'funding_position').value).toBeNull();
    expect(kpi(d, 'funding_position').unavailableLabel).toBe('Analysis pending');
  });

  it('fails closed when accepted provisions change amounts but are not numerically reconciled', async () => {
    const { svc } = svcWith({
      getBillFundingProvisions: async () => [
        {
          provisionId: 'prov-override',
          committee: 'HAC-D',
          fy: 2027,
          heading: 'Program increase',
          text: 'The Committee recommends an increase for the program.',
          pageStart: 88,
          pageEnd: 88,
          actionType: 'adds',
          peCode: '0603270A',
          matchBasis: 'pe_code',
          confidence: 1,
          reviewStatus: 'accepted',
          billLinkStatus: 'accepted',
        },
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.overrideReconciliation).toBe('verification_required');
    expect(d.funding.positions.every((item) => !item.primary)).toBe(true);
    expect(d.funding.reqCompare).toBeNull();
    expect(d.funding.comparisons).toEqual([]);
    expect(d.funding.guardrail).toMatch(/not been numerically reconciled/i);
    expect(d.funding.provisions[0]).toEqual(
      expect.objectContaining({ actionType: 'adds', reconciliationRequired: true }),
    );
  });

  it('allows a verified, explicitly attested override reconciliation to become primary', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [
        position({
          verificationStatus: 'verified',
          note: 'Analyst checked section overrides. [overrides-reconciled]',
        }),
      ],
      getBillFundingProvisions: async () => [
        {
          provisionId: 'prov-reconciled',
          committee: 'HAC-D',
          fy: 2027,
          heading: 'Program increase',
          text: 'The Committee recommends an increase for the program.',
          pageStart: 88,
          pageEnd: 88,
          actionType: 'adds',
          peCode: '0603270A',
          matchBasis: 'pe_code',
          confidence: 1,
          reviewStatus: 'accepted',
          billLinkStatus: 'accepted',
        },
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.overrideReconciliation).toBe('reconciled');
    expect(d.funding.positions.find((item) => item.primary)).toEqual(
      expect.objectContaining({ verification: 'verified', amountMillions: 850000 }),
    );
    expect(d.funding.guardrail).toBeNull();
  });

  it('does not let a candidate bill-to-PE link suppress a verified amount', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [position({ verificationStatus: 'verified' })],
      getBillFundingProvisions: async () => [
        {
          provisionId: 'prov-candidate-edge',
          committee: 'HAC-D',
          fy: 2027,
          heading: 'Possible program increase',
          text: 'The Committee recommends an increase for the program.',
          pageStart: 89,
          pageEnd: 89,
          actionType: 'adds',
          peCode: '0603270A',
          matchBasis: 'pe_code',
          confidence: 0.5,
          reviewStatus: 'accepted',
          billLinkStatus: 'candidate',
        },
      ],
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.overrideReconciliation).toBe('not_required');
    expect(d.funding.positions.find((item) => item.primary)).toBeTruthy();
    expect(d.funding.provisions[0]).toEqual(
      expect.objectContaining({ billLinkStatus: 'candidate', reconciliationRequired: false }),
    );
  });

  it('exposes exact amount source/version metadata and the funding treatment', async () => {
    const { svc } = svcWith();
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.positions[0]).toEqual(
      expect.objectContaining({
        fiscalYear: 2027,
        vehicleTrack: 'appropriation',
        amountTreatment: 'appropriated_funding',
        sourceDocumentTitle: 'House Defense Appropriations Report, FY2027',
        sourceDocumentKey: 'hac_d_fy2027_house',
        sourceDocumentVersion:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        sourceDocumentCurrent: true,
      }),
    );
  });

  it('uses the authorization conference rung and labels every chamber amount explicitly', async () => {
    const { svc } = svcWith({
      getBillFundingPositions: async () => [],
      getBillProgramElementImpacts: async () => [
        peImpact({
          vehicleTrack: 'authorization',
          vehicleStage: 'conference',
          houseMillions: '120.00',
          senateMillions: '110.00',
          conferenceMillions: '130.00',
          // A malformed legacy value cannot become the final authorization amount.
          enactedMillions: '999.00',
        }),
      ],
      getParentBudgetPackage: async () => ({
        ...PACKAGE,
        vehicleTrack: 'authorization',
        vehicleStage: 'conference',
      }),
    });
    const d = await svc.getGlobalDossier(BILL, { funding: true });
    expect(d.funding.programElementImpacts[0]).toEqual(
      expect.objectContaining({
        vehicleTrack: 'authorization',
        houseLabel: 'House authorization (HASC)',
        senateLabel: 'Senate authorization (SASC)',
        conferenceLabel: 'NDAA conference authorization',
        conferenceMillions: 130,
        enactedMillions: null,
        deltaVsRequestMillions: 30,
      }),
    );
  });
});

describe('funding source SQL — track and version safety', () => {
  it('selects the authorization and appropriation ladders independently', async () => {
    let sql = '';
    const repo = new SourceDataRepository({
      $queryRawUnsafe: async (query: string) => {
        sql = query;
        return [];
      },
    } as never);
    await repo.getBillProgramElementImpacts(BILL);
    expect(sql).toContain("WHEN 'authorization' THEN 'hascMark'");
    expect(sql).toContain("WHEN 'authorization' THEN 'sascMark'");
    expect(sql).toContain("WHEN 'authorization' THEN 'ndaaConference'");
    expect(sql).toContain("WHEN 'appropriation' THEN 'hacDMark'");
    expect(sql).toContain("WHEN 'appropriation' THEN 'sacDMark'");
    expect(sql).toContain("WHEN 'appropriation' THEN 'conference'");
    expect(sql).toContain("cv.track = 'appropriation'");
    expect(sql).toContain("cv.stage = 'enacted'");
    expect(sql).toContain("cv.stage IN ('house', 'senate', 'conference', 'enacted')");
    expect(sql).toContain("cv.stage IN ('senate', 'conference', 'enacted')");
    expect(sql).toContain("cv.stage IN ('conference', 'enacted')");
  });

  it('reads PE amounts from exact versioned source observations, not the global winner row', async () => {
    let sql = '';
    const repo = new SourceDataRepository({
      $queryRawUnsafe: async (query: string) => {
        sql = query;
        return [];
      },
    } as never);
    await repo.getBillProgramElementImpacts(BILL);
    expect(sql).toContain('program_element_year_source_value');
    expect(sql).toContain('v.source_document_id = hv.source_document_id');
    expect(sql).toContain('v.source_document_id IN (cv.source_document_id, rv.source_document_id)');
    expect(sql).not.toContain('LEFT JOIN program_element_year y');
    expect(sql).toContain('AS "houseSourceDocumentSha256"');
  });

  it('loads the selected bill vehicle plus same-package request rows for FY comparisons', async () => {
    let sql = '';
    const repo = new SourceDataRepository({
      $queryRawUnsafe: async (query: string) => {
        sql = query;
        return [];
      },
    } as never);
    await repo.getBillFundingPositions(BILL);
    expect(sql).toContain('fp.package_id = cv.package_id');
    expect(sql).toContain('fp.fiscal_year = cv.fiscal_year');
    expect(sql).toContain("fp.vehicle_class = 'request'");
    expect(sql).toContain('fp.vehicle_id = cv.id');
  });

  it('joins funding positions and the bill vehicle to immutable source-document versions', async () => {
    const statements: string[] = [];
    const repo = new SourceDataRepository({
      $queryRawUnsafe: async (query: string) => {
        statements.push(query);
        return [];
      },
    } as never);
    await repo.getBillFundingPositions(BILL);
    await repo.getParentBudgetPackage(BILL);
    expect(statements[0]).toContain('COALESCE(fp.source_document_id, v.source_document_id)');
    expect(statements[0]).toContain('AS "sourceDocumentSha256"');
    expect(statements[1]).toContain('LEFT JOIN source_document sd ON sd.id = v.source_document_id');
    expect(statements[1]).toContain('AS "sourceDocumentCurrent"');
  });

  it('limits override provisions to the bill vehicle FY, track, stage, and source document', async () => {
    let sql = '';
    const repo = new SourceDataRepository({
      $queryRawUnsafe: async (query: string) => {
        sql = query;
        return [];
      },
    } as never);
    await repo.getBillFundingProvisions(BILL);
    expect(sql).toContain('p.fy = cv.fiscal_year');
    expect(sql).toContain("cv.stage = 'house' AND p.committee = 'HASC'");
    expect(sql).toContain("cv.stage = 'house' AND p.committee = 'HAC-D'");
    expect(sql).toContain('p.source_document_id = cv.source_document_id');
    expect(sql).toContain("bll.status <> 'rejected'");
    expect(sql).toContain('bll.status        AS "billLinkStatus"');
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

/**
 * LW-QA-021 item 5: the client-scoped route rebuilt the KPI strip WITHOUT the
 * funding block, so a bill with a real reviewed position showed its amount in
 * global scope and "not available" in client scope. Both routes must agree.
 */
describe('LW-QA-021 — funding KPIs match across global and client scope', () => {
  const TENANT = '00000000-0000-0000-0000-0000000000aa';
  const CLIENT = '11111111-1111-1111-1111-111111111111';

  it('shows the same funding position and delta on the client route', async () => {
    const { svc } = clientSvcWith({
      getBillFundingPositions: async () => [
        position(),
        position({
          id: 'p-request',
          stage: 'president',
          vehicleClass: 'request',
          amountMillions: '830000.00',
        }),
      ],
    });
    const global = await svc.getGlobalDossier(BILL, { funding: true });
    const scoped = await svc.getClientDossier(TENANT, CLIENT, BILL, { funding: true });

    expect(kpi(global, 'funding_position').value).toBe(kpi(scoped, 'funding_position').value);
    expect(kpi(global, 'delta_from_request').value).toBe(kpi(scoped, 'delta_from_request').value);
    // …and they are REAL figures, so the assertion cannot pass on two nulls.
    expect(kpi(scoped, 'funding_position').value).toBeTruthy();
    expect(kpi(scoped, 'delta_from_request').value).toBeTruthy();
    expect(kpi(scoped, 'funding_position').unavailableReason).toBeNull();
  });

  it('keeps the client route honest when funding really is unavailable', async () => {
    const { svc } = clientSvcWith();
    const scoped = await svc.getClientDossier(TENANT, CLIENT, BILL);
    expect(kpi(scoped, 'funding_position').value).toBeNull();
    expect(kpi(scoped, 'funding_position').unavailableReason).toMatch(/not yet enabled/i);
  });
});

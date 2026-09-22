import { describe, expect, jest, test } from '@jest/globals';
import type { CensusGeocodeResult } from '../external/census-geocoder/census-geocoder.client.js';
import type { SamEntityRecord, SamLookupResult } from './vendor-reference-sam.client.js';
import { periodLabel, stateFromOneLine, VendorReferenceService } from './vendor-reference.service.js';
import {
  LITIGATION_FINDING,
  LITIGATION_ITEM,
  LITIGATION_SOURCE,
  type VendorReferenceDossier,
  type VendorReferenceRow,
} from './vendor-reference.types.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const UEI = 'KM99JJBNQ9M5';
const CLIENT_ID = '2c6f2a8e-6e0e-4c4c-9d4a-0f4d8f1a2b3c';

const SAM_LMT: SamEntityRecord = {
  uei: UEI,
  cageCode: '3V1F7',
  legalBusinessName: 'LOCKHEED MARTIN CORPORATION',
  dbaName: null,
  registrationStatus: 'Active',
  registrationDate: '2024-01-15',
  registrationExpirationDate: '2027-01-15',
  lastUpdateDate: '2026-06-01',
  physicalAddress: { line1: '6801 ROCKLEDGE DR', line2: null, city: 'BETHESDA', state: 'MD', zip: '20817', country: 'USA' },
  congressionalDistrict: '08',
  entityStructure: 'Corporate Entity (Not Tax Exempt)',
  stateOfIncorporation: 'MD',
  primaryNaics: '336411',
  naicsCodes: ['336411', '541330'],
  pscCodes: ['1510'],
};

const HOUSE = { bioguideId: 'D000001', fullName: 'Jane Doe', party: 'Democratic', state: 'Maryland', district: 8, chamber: 'house' };
const SEN1 = { bioguideId: 'S000001', fullName: 'Sen A', party: 'Democratic', state: 'Maryland', district: null, chamber: 'senate' };
const SEN2 = { bioguideId: 'S000002', fullName: 'Sen B', party: 'Republican', state: 'Maryland', district: null, chamber: 'senate' };

const CONTRACT = {
  awardUniqueId: 'CONT_AWD_1',
  piid: 'FA8611-26-C-0001',
  awardingAgency: 'Department of Defense',
  awardingSubTier: 'Department of the Air Force',
  contractorName: 'LOCKHEED MARTIN CORPORATION',
  recipientUei: UEI,
  amount: '1234567.89',
  description: 'F-35 SUSTAINMENT',
  actionDate: new Date('2026-03-01T00:00:00Z'),
  baseAwardSignedDate: new Date('2026-02-15T00:00:00Z'),
  latestActionDate: new Date('2026-03-01T00:00:00Z'),
  lastSyncedAt: new Date('2026-09-10T00:00:00Z'),
};
const GRANT = {
  awardUniqueId: 'ASST_NON_1',
  fain: 'FAIN-1',
  awardTypeLabel: 'Cooperative Agreement',
  awardingAgency: 'Department of Energy',
  awardingSubTier: null,
  recipientName: 'LOCKHEED MARTIN CORPORATION',
  recipientUei: UEI,
  assistanceListingTitle: 'Fusion Energy Sciences',
  description: 'RESEARCH',
  totalObligatedAmount: '500000',
  startDate: new Date('2025-10-01T00:00:00Z'),
  endDate: new Date('2027-09-30T00:00:00Z'),
  lastSyncedAt: new Date('2026-09-10T00:00:00Z'),
};
const AWARDEE_SNAPSHOT = {
  externalId: 'veh-1#awd-1',
  providerFetchedAt: new Date('2026-09-01T00:00:00Z'),
  normalizedJsonb: { awardeeId: 'awd-1', piid: 'GS-00F-0001', title: 'OASIS+ IDV', awardDate: '2025-01-15', idvObligations: 25000000, recipientUei: UEI, recipientName: 'LOCKHEED MARTIN CORPORATION' },
};
const VEHICLE_SNAPSHOT = {
  externalId: 'veh-1',
  normalizedJsonb: { vehicleId: 'veh-1', programAcronym: 'OASIS+', solicitationTitle: 'One Acquisition Solution', vehicleType: 'IDIQ', agencyId: 'GSA', lastDateToOrder: '2034-12-31' },
};
const FILING_EXACT = {
  filingUuid: 'f-1',
  filingType: 'Q2',
  filingYear: 2026,
  filingPeriod: 'second_quarter',
  income: '90000',
  registrantName: 'Capitol Counsel LLC',
  clientName: 'LOCKHEED MARTIN CORPORATION',
  issueCodes: ['DEF', 'BUD'],
  lastSyncedAt: new Date('2026-09-10T00:00:00Z'),
};
const FILING_PARTIAL = {
  ...FILING_EXACT,
  filingUuid: 'f-2',
  clientName: 'LOCKHEED MARTIN AERONAUTICS COMPANY',
  registrantName: 'Some Other Firm',
};
const SEAT_CHAIR = {
  bioguideId: 'D000001',
  systemCode: 'hsas00',
  title: 'Chair',
  rank: 1,
  committee: { name: 'House Committee on Armed Services', chamber: 'house', parentSystemCode: null, isCurrent: true },
};
const SEAT_STALE = {
  bioguideId: 'S000001',
  systemCode: 'ssxx00',
  title: null,
  rank: 3,
  committee: { name: 'Defunct Committee', chamber: 'senate', parentSystemCode: null, isCurrent: false },
};

// ── Fakes ───────────────────────────────────────────────────────────────────

interface PrismaOpts {
  awards?: unknown[];
  assistance?: unknown[];
  awardeeSnapshots?: unknown[];
  vehicleSnapshots?: unknown[];
  filings?: unknown[];
  seats?: unknown[];
  client?: { id: string; name: string; uei: string | null } | null;
  throwOn?: string[];
}

function fakePrisma(opts: PrismaOpts = {}) {
  const calls: Record<string, unknown[]> = {};
  const hit = (name: string, args: unknown) => {
    (calls[name] ??= []).push(args);
    if (opts.throwOn?.includes(name)) throw new Error(`${name} exploded`);
  };
  return {
    calls,
    federalAward: { findMany: jest.fn(async (args: unknown) => (hit('federalAward.findMany', args), opts.awards ?? [])) },
    federalAssistanceAward: {
      findMany: jest.fn(async (args: unknown) => (hit('federalAssistanceAward.findMany', args), opts.assistance ?? [])),
    },
    tangoResourceSnapshot: {
      findMany: jest.fn(async (args: { where: { resourceType: string } }) => {
        hit('tangoResourceSnapshot.findMany', args);
        return args.where.resourceType === 'vehicle_awardee' ? (opts.awardeeSnapshots ?? []) : (opts.vehicleSnapshots ?? []);
      }),
    },
    ldaFiling: { findMany: jest.fn(async (args: unknown) => (hit('ldaFiling.findMany', args), opts.filings ?? [])) },
    congressCommitteeMembership: {
      findMany: jest.fn(async (args: unknown) => (hit('congressCommitteeMembership.findMany', args), opts.seats ?? [])),
    },
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
      hit('withTenant', null);
      return fn({ client: { findUnique: async () => (opts.client === undefined ? null : opts.client) } });
    }),
  };
}

function fakeSam(opts: { byUei?: SamLookupResult; byCage?: SamLookupResult; byName?: SamLookupResult; throws?: boolean } = {}) {
  const impl = (res: SamLookupResult | undefined) =>
    jest.fn(async (): Promise<SamLookupResult> => {
      if (opts.throws) throw new Error('sam client crashed');
      return res ?? { ok: true, entities: [] };
    });
  return { lookupByUei: impl(opts.byUei), lookupByCage: impl(opts.byCage), lookupByName: impl(opts.byName) };
}

function fakeResolver(opts: { throws?: boolean } = {}) {
  return {
    representativesForFacility: jest.fn(async (f: { state: string; congressionalDistrict: string | null }) => {
      if (opts.throws) throw new Error('resolver down');
      return {
        unresolved: false as const,
        federal: { house: f.congressionalDistrict ? HOUSE : null, senate: [SEN1, SEN2] },
        state: { lower: null, upper: null },
      };
    }),
  };
}

function makeService(prisma = fakePrisma(), sam = fakeSam(), resolver = fakeResolver()) {
  const service = new VendorReferenceService(prisma as never, sam as never, resolver as never);
  return { service, prisma, sam, resolver };
}

function rows(d: VendorReferenceDossier, section: VendorReferenceRow['section']): VendorReferenceRow[] {
  return d.rows.filter((r) => r.section === section);
}
function row(d: VendorReferenceDossier, section: VendorReferenceRow['section'], item: string): VendorReferenceRow {
  const r = rows(d, section).find((x) => x.item === item);
  if (!r) throw new Error(`missing row ${section}/${item}`);
  return r;
}

function expectLitigationInvariant(d: VendorReferenceDossier) {
  const lit = rows(d, 'litigation_adverse_history');
  expect(lit).toHaveLength(1);
  expect(lit[0]).toEqual({
    section: 'litigation_adverse_history',
    item: LITIGATION_ITEM,
    finding: LITIGATION_FINDING,
    source: LITIGATION_SOURCE,
    verification: 'not_sourced',
  });
}

function expectReadOnly(prisma: ReturnType<typeof fakePrisma>) {
  for (const key of Object.keys(prisma.calls)) {
    expect(key).toMatch(/findMany|findUnique|withTenant/);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('VendorReferenceService.pull — UEI-anchored happy path', () => {
  const prisma = fakePrisma({
    awards: [CONTRACT],
    assistance: [GRANT],
    awardeeSnapshots: [AWARDEE_SNAPSHOT],
    vehicleSnapshots: [VEHICLE_SNAPSHOT],
    filings: [FILING_EXACT, FILING_PARTIAL],
    seats: [SEAT_CHAIR, SEAT_STALE],
    client: { id: CLIENT_ID, name: 'Lockheed Martin Corporation', uei: UEI },
  });
  const sam = fakeSam({ byUei: { ok: true, entities: [SAM_LMT] } });
  const { service } = makeService(prisma, sam);
  let d: VendorReferenceDossier;

  test('produces a dossier with no warnings and touches no write path', async () => {
    d = await service.pull('tenant-1', { name: 'Lockheed Martin Corporation', uei: UEI, clientId: CLIENT_ID });
    expect(d.warnings).toEqual([]);
    expect(d.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expectReadOnly(prisma);
  });

  test('identity: exact UEI, SAM-verified, explanation names the basis', () => {
    expect(d.identity).toEqual(
      expect.objectContaining({ basis: 'uei_input', uei: UEI, samVerified: true, ambiguous: false, matchedName: 'LOCKHEED MARTIN CORPORATION' }),
    );
    expect(d.identity.explanation).toContain(UEI);
  });

  test('SAM-sourced identity + credential rows are confirmed', () => {
    expect(row(d, 'company_identity', 'Legal name and DBA')).toEqual(
      expect.objectContaining({ finding: 'LOCKHEED MARTIN CORPORATION', source: 'SAM.gov entity', verification: 'confirmed' }),
    );
    expect(row(d, 'company_identity', 'Headquarters').verification).toBe('confirmed');
    expect(row(d, 'federal_market_credentials', 'UEI')).toEqual(expect.objectContaining({ finding: UEI, verification: 'confirmed' }));
    expect(row(d, 'federal_market_credentials', 'CAGE').finding).toBe('3V1F7');
    expect(row(d, 'federal_market_credentials', 'SAM registration status and expiry').finding).toContain('expires 2027-01-15');
    expect(row(d, 'federal_market_credentials', 'NAICS / PSC').finding).toContain('336411 (primary)');
  });

  test('manual-only rows stay not_sourced even when SAM has hints', () => {
    expect(row(d, 'company_identity', 'Ownership and parent').verification).toBe('not_sourced');
    expect(row(d, 'federal_market_credentials', 'ITAR / export-control posture').verification).toBe('not_sourced');
  });

  test('relationship to the client is confirmed on a UEI match', () => {
    expect(row(d, 'company_identity', 'Relationship to the client')).toEqual(
      expect.objectContaining({ verification: 'confirmed', finding: expect.stringContaining('Same legal entity') }),
    );
    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
  });

  test('awards joined on recipient_uei only — names are NOT queried', () => {
    const awardArgs = prisma.calls['federalAward.findMany']![0] as { where: Record<string, unknown> };
    expect(awardArgs.where).toEqual({ recipientUei: UEI });
    const assistArgs = prisma.calls['federalAssistanceAward.findMany']![0] as { where: Record<string, unknown> };
    expect(assistArgs.where).toEqual({ recipientUei: UEI });
    const contracting = rows(d, 'federal_contracting_history');
    expect(contracting).toHaveLength(3);
    expect(contracting.every((r) => r.verification === 'confirmed')).toBe(true);
    expect(contracting.map((r) => r.source)).toEqual([
      'USAspending (contracts) / Capiro ingestion',
      'USAspending (assistance) / Capiro ingestion',
      'MakeGov/Tango vehicle awardees',
    ]);
    expect(contracting[0]!.detail).toEqual(
      expect.objectContaining({ agency: 'Department of Defense / Department of the Air Force', type: 'Contract', value: 1234567.89, awardDate: '2026-03-01', matchBasis: 'exact_uei' }),
    );
    expect(contracting[1]!.detail).toEqual(expect.objectContaining({ type: 'Cooperative Agreement', periodOfPerformance: '2025-10-01 – 2027-09-30' }));
    expect(contracting[2]!).toEqual(
      expect.objectContaining({ item: 'OASIS+ (IDV GS-00F-0001)', detail: expect.objectContaining({ type: 'IDIQ', agency: 'GSA', value: 25000000, periodOfPerformance: 'orders through 2034-12-31' }) }),
    );
  });

  test('vehicle awardees are looked up by UEI inside the normalized JSON', () => {
    const tangoArgs = prisma.calls['tangoResourceSnapshot.findMany']![0] as { where: Record<string, unknown> };
    expect(tangoArgs.where).toEqual(
      expect.objectContaining({ resourceType: 'vehicle_awardee', active: true, normalizedJsonb: { path: ['recipientUei'], equals: UEI } }),
    );
  });

  test('LDA: exact legal-name filing is confirmed; partial-name filings are excluded when an exact one exists', () => {
    const lda = rows(d, 'federal_lobbying_representation');
    expect(lda).toHaveLength(1);
    expect(lda[0]).toEqual(
      expect.objectContaining({
        item: 'Capitol Counsel LLC',
        verification: 'confirmed',
        detail: expect.objectContaining({ clientOfRecord: 'LOCKHEED MARTIN CORPORATION', period: 'Q2 2026', income: 90000, issueCodes: ['DEF', 'BUD'], matchBasis: 'exact_legal_name' }),
      }),
    );
  });

  test('delegation from the SAM physical address: House + both senators, committee seats joined, stale committees dropped', () => {
    const del = rows(d, 'congressional_delegation');
    expect(del.map((r) => r.detail!.member)).toEqual(['Jane Doe (D)', 'Sen A (D)', 'Sen B (R)']);
    expect(del[0]!.detail).toEqual(
      expect.objectContaining({ chamber: 'House', stateDistrict: 'MD-08', committee: 'House Committee on Armed Services', role: 'Chair', districtBasis: 'sam_physical_address' }),
    );
    expect(del[1]!.detail).toEqual(expect.objectContaining({ chamber: 'Senate', stateDistrict: 'MD (statewide)', committee: null, role: 'Member' }));
    expect(del.every((r) => r.verification === 'confirmed')).toBe(true);
    expect(row(d, 'company_identity', 'Facility relevant to this request (address, congressional district)').finding).toContain('MD-08');
  });

  test('litigation row invariant', () => expectLitigationInvariant(d));

  test('handling notes explain identity, delegation basis and the litigation rule', () => {
    expect(d.handlingNotes[0]).toMatch(/^Identity: /);
    expect(d.handlingNotes.join('\n')).toContain('SAM.gov registered physical address');
    expect(d.handlingNotes.join('\n')).toContain('Litigation and adverse history is never sourced');
  });
});

describe('VendorReferenceService.pull — name-only (SAM ambiguous)', () => {
  const other: SamEntityRecord = { ...SAM_LMT, uei: 'BBBBBBBBBBBB', physicalAddress: { ...SAM_LMT.physicalAddress!, state: 'TX' } };
  const prisma = fakePrisma({ awards: [{ ...CONTRACT, recipientUei: null }], filings: [FILING_PARTIAL] });
  const sam = fakeSam({ byName: { ok: true, entities: [SAM_LMT, other] } });
  const { service } = makeService(prisma, sam);
  let d: VendorReferenceDossier;

  test('identity is name_only with the candidates listed', async () => {
    d = await service.pull('tenant-1', { name: 'Lockheed Martin Corporation' });
    expect(d.identity).toEqual(expect.objectContaining({ basis: 'name_only', uei: null, samVerified: false, ambiguous: true }));
    expect(d.identity.candidates.map((c) => c.uei).sort()).toEqual(['BBBBBBBBBBBB', UEI]);
  });

  test('SAM rows are not_sourced / unverified, never confirmed', () => {
    expect(row(d, 'company_identity', 'Legal name and DBA').verification).toBe('unverified');
    expect(row(d, 'federal_market_credentials', 'UEI').verification).toBe('not_sourced');
    expect(row(d, 'federal_market_credentials', 'SAM registration status and expiry').verification).toBe('not_sourced');
  });

  test('awards are joined by EXACT name and marked unverified; vehicles are not searched', () => {
    const awardArgs = prisma.calls['federalAward.findMany']![0] as { where: { OR: unknown[] } };
    expect(awardArgs.where.OR).toEqual([{ contractorName: { equals: 'Lockheed Martin Corporation', mode: 'insensitive' } }]);
    expect(prisma.calls['tangoResourceSnapshot.findMany']).toBeUndefined();
    const contracting = rows(d, 'federal_contracting_history');
    expect(contracting).toHaveLength(1);
    expect(contracting[0]).toEqual(expect.objectContaining({ verification: 'unverified', detail: expect.objectContaining({ matchBasis: 'exact_name' }) }));
  });

  test('LDA partial-name filings surface only as unverified leads', () => {
    const lda = rows(d, 'federal_lobbying_representation');
    expect(lda).toHaveLength(1);
    expect(lda[0]).toEqual(expect.objectContaining({ verification: 'unverified', detail: expect.objectContaining({ matchBasis: 'name_contains' }) }));
    expect(d.handlingNotes.join('\n')).toContain('partial-name matches');
  });

  test('no facility placement → delegation not_sourced; nothing is confirmed anywhere', () => {
    expect(rows(d, 'congressional_delegation')).toHaveLength(1);
    expect(rows(d, 'congressional_delegation')[0]!.verification).toBe('not_sourced');
    expect(d.rows.some((r) => r.verification === 'confirmed')).toBe(false);
    expectLitigationInvariant(d);
  });
});

describe('VendorReferenceService.pull — single exact SAM name match anchors a UEI', () => {
  test('basis sam_exact_name; state narrows; awards then key on the SAM UEI', async () => {
    const other: SamEntityRecord = { ...SAM_LMT, uei: 'BBBBBBBBBBBB', physicalAddress: { ...SAM_LMT.physicalAddress!, state: 'TX' } };
    const prisma = fakePrisma({ awards: [CONTRACT] });
    const sam = fakeSam({ byName: { ok: true, entities: [SAM_LMT, other, { ...SAM_LMT, legalBusinessName: 'LOCKHEED MARTIN SPACE' }] } });
    const { service } = makeService(prisma, sam);
    const d = await service.pull('tenant-1', { name: 'Lockheed Martin Corp.', state: 'MD' });
    expect(d.identity).toEqual(expect.objectContaining({ basis: 'sam_exact_name', uei: UEI, samVerified: true, ambiguous: false }));
    expect((prisma.calls['federalAward.findMany']![0] as { where: unknown }).where).toEqual({ recipientUei: UEI });
    expect(row(d, 'federal_market_credentials', 'UEI').verification).toBe('confirmed');
    expect(rows(d, 'federal_contracting_history')[0]!.verification).toBe('confirmed');
    expectLitigationInvariant(d);
  });

  test('CAGE input resolves through SAM to a UEI', async () => {
    const sam = fakeSam({ byCage: { ok: true, entities: [SAM_LMT] } });
    const { service } = makeService(fakePrisma(), sam);
    const d = await service.pull('tenant-1', { name: 'Lockheed Martin', cage: '3V1F7' });
    expect(d.identity).toEqual(expect.objectContaining({ basis: 'cage_input', uei: UEI }));
    expect(sam.lookupByName).not.toHaveBeenCalled();
  });
});

describe('VendorReferenceService.pull — provider failures are fail-soft', () => {
  test('SAM throws, LDA + directory reads throw → warnings, not_sourced rows, no exception', async () => {
    const prisma = fakePrisma({ awards: [CONTRACT], throwOn: ['ldaFiling.findMany'] });
    const sam = fakeSam({ throws: true });
    const resolver = fakeResolver({ throws: true });
    const { service } = makeService(prisma, sam, resolver);
    const d = await service.pull('tenant-1', { name: 'Lockheed Martin Corporation', uei: UEI, state: 'TX', district: '12' });

    expect(d.warnings.length).toBeGreaterThanOrEqual(3);
    expect(d.warnings.join('\n')).toMatch(/SAM\.gov entity lookup .* failed: sam client crashed/);
    expect(d.warnings.join('\n')).toContain('Federal lobbying representation unavailable: ldaFiling.findMany exploded');
    expect(d.warnings.join('\n')).toContain('Congressional delegation unavailable: resolver down');

    // The UEI still anchors the award join; the SAM-sourced rows degrade honestly.
    expect(d.identity).toEqual(expect.objectContaining({ basis: 'uei_input', uei: UEI, samVerified: false }));
    expect(row(d, 'federal_market_credentials', 'UEI')).toEqual(expect.objectContaining({ verification: 'unverified', source: 'Client (caller-supplied)' }));
    expect(row(d, 'company_identity', 'Headquarters').verification).toBe('not_sourced');
    expect(rows(d, 'federal_contracting_history')[0]!.verification).toBe('confirmed');
    expect(rows(d, 'federal_lobbying_representation')).toEqual([expect.objectContaining({ verification: 'not_sourced', source: 'Senate LDA' })]);
    expect(rows(d, 'congressional_delegation')).toEqual([expect.objectContaining({ verification: 'not_sourced', source: 'Capiro directory' })]);
    expectLitigationInvariant(d);
  });

  test('SAM ok:false (no key) is reported as a warning and the pull still completes', async () => {
    const sam = fakeSam({ byName: { ok: false, reason: 'no_api_key', message: 'SAM_GOV_API_KEY is not configured' } });
    const { service } = makeService(fakePrisma(), sam);
    const d = await service.pull('tenant-1', { name: 'Acme Aerospace' });
    expect(d.warnings).toEqual([expect.stringContaining('SAM_GOV_API_KEY is not configured')]);
    expect(d.identity.basis).toBe('name_only');
    expect(rows(d, 'federal_contracting_history')[0]!.verification).toBe('unverified');
    expectLitigationInvariant(d);
  });

  test('clientId that does not exist in the tenant → relationship not_sourced, no throw', async () => {
    const { service } = makeService(fakePrisma({ client: null }), fakeSam({ byUei: { ok: true, entities: [SAM_LMT] } }));
    const d = await service.pull('tenant-1', { name: 'Lockheed Martin Corporation', uei: UEI, clientId: CLIENT_ID });
    expect(row(d, 'company_identity', 'Relationship to the client')).toEqual(expect.objectContaining({ verification: 'not_sourced', finding: 'Client record unavailable' }));
  });
});

describe('VendorReferenceService.pull — facility placement precedence', () => {
  test('caller-supplied state + district → members resolved but unverified', async () => {
    const prisma = fakePrisma({ seats: [SEAT_CHAIR] });
    const { service, resolver } = makeService(prisma, fakeSam({ byUei: { ok: true, entities: [SAM_LMT] } }));
    const d = await service.pull('tenant-1', { name: 'Lockheed Martin Corporation', uei: UEI, state: 'tx', district: '12' });
    expect(resolver.representativesForFacility).toHaveBeenCalledWith(expect.objectContaining({ state: 'TX', congressionalDistrict: '12' }));
    const del = rows(d, 'congressional_delegation');
    expect(del).toHaveLength(3);
    expect(del.every((r) => r.verification === 'unverified')).toBe(true);
    expect(del[0]!.detail).toEqual(expect.objectContaining({ stateDistrict: 'TX-12', districtBasis: 'caller_supplied' }));
    expect(row(d, 'company_identity', 'Facility relevant to this request (address, congressional district)')).toEqual(
      expect.objectContaining({ finding: 'TX-12', source: 'Client (caller-supplied)', verification: 'unverified' }),
    );
  });

  test('at-large spelled AL becomes the 00 facility sentinel', async () => {
    const { service, resolver } = makeService(fakePrisma(), fakeSam({ byUei: { ok: true, entities: [SAM_LMT] } }));
    await service.pull('tenant-1', { name: 'Lockheed Martin Corporation', uei: UEI, state: 'WY', district: 'AL' });
    expect(resolver.representativesForFacility).toHaveBeenCalledWith(expect.objectContaining({ state: 'WY', congressionalDistrict: '00' }));
  });

  test('facilityAddress is geocoded (Census) and outranks the SAM address; members confirmed on a match', async () => {
    const { service, resolver } = makeService(fakePrisma(), fakeSam({ byUei: { ok: true, entities: [SAM_LMT] } }));
    const geo: CensusGeocodeResult = {
      status: 'matched',
      latitude: 32.7,
      longitude: -97.4,
      congressionalDistrict: '12',
      congressionalDistrictCongress: 119,
      stateHouseDistrict: null,
      stateSenateDistrict: null,
      matchedAddress: '1 LOCKHEED BLVD, FORT WORTH, TX, 76108',
    };
    const spy = jest
      .spyOn(service as unknown as { geocodeOneLine: (a: string) => Promise<CensusGeocodeResult> }, 'geocodeOneLine')
      .mockResolvedValue(geo);
    const d = await service.pull('tenant-1', { name: 'Lockheed Martin Corporation', uei: UEI, facilityAddress: '1 Lockheed Blvd, Fort Worth, TX 76108' });
    expect(spy).toHaveBeenCalledWith('1 Lockheed Blvd, Fort Worth, TX 76108');
    expect(resolver.representativesForFacility).toHaveBeenCalledWith(expect.objectContaining({ state: 'TX', congressionalDistrict: '12' }));
    const del = rows(d, 'congressional_delegation');
    expect(del[0]!.detail).toEqual(expect.objectContaining({ stateDistrict: 'TX-12', districtBasis: 'census_geocode' }));
    expect(del.every((r) => r.verification === 'confirmed')).toBe(true);
    expect(d.warnings).toEqual([]);
  });

  test('geocoder miss falls back to the SAM address with a warning', async () => {
    const { service } = makeService(fakePrisma(), fakeSam({ byUei: { ok: true, entities: [SAM_LMT] } }));
    jest
      .spyOn(service as unknown as { geocodeOneLine: (a: string) => Promise<CensusGeocodeResult> }, 'geocodeOneLine')
      .mockResolvedValue({ status: 'no_match', latitude: null, longitude: null, congressionalDistrict: null, congressionalDistrictCongress: null, stateHouseDistrict: null, stateSenateDistrict: null, matchedAddress: null });
    const d = await service.pull('tenant-1', { name: 'Lockheed Martin Corporation', uei: UEI, facilityAddress: 'nowhere' });
    expect(d.warnings).toEqual([expect.stringContaining('could not place "nowhere" (no_match)')]);
    expect(rows(d, 'congressional_delegation')[0]!.detail).toEqual(expect.objectContaining({ districtBasis: 'sam_physical_address' }));
  });
});

describe('VendorReferenceService.pull — award-date rollout', () => {
  const rolloutTenant = '00000000-0000-4000-8000-000000000001';
  test('off mode retains the exact legacy contract detail', async () => {
    const { service } = makeService(
      fakePrisma({ awards: [CONTRACT] }),
      fakeSam({ byUei: { ok: true, entities: [SAM_LMT] } }),
    );
    const dossier = await service.pull('tenant-1', { name: 'Lockheed', uei: UEI });
    expect(rows(dossier, 'federal_contracting_history')[0]!.detail).toEqual({
      agency: 'Department of Defense / Department of the Air Force',
      type: 'Contract',
      value: 1234567.89,
      awardDate: '2026-03-01',
      periodOfPerformance: null,
      matchBasis: 'exact_uei',
      recordId: 'CONT_AWD_1',
    });
  });

  test('enforce mode uses and labels the authoritative base signed date', async () => {
    const keys = ['MERI_EVIDENCE_ACCURACY_MODE', 'MERI_EVIDENCE_ACCURACY_TENANTS', 'MERI_EVIDENCE_ACCURACY_SURFACES'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      MERI_EVIDENCE_ACCURACY_MODE: 'enforce',
      MERI_EVIDENCE_ACCURACY_TENANTS: rolloutTenant,
      MERI_EVIDENCE_ACCURACY_SURFACES: 'strategy',
    });
    try {
      const { service } = makeService(
        fakePrisma({ awards: [CONTRACT] }),
        fakeSam({ byUei: { ok: true, entities: [SAM_LMT] } }),
      );
      const dossier = await service.pull(rolloutTenant, { name: 'Lockheed', uei: UEI });
      expect(rows(dossier, 'federal_contracting_history')[0]!.detail).toEqual(
        expect.objectContaining({
          awardDate: '2026-02-15',
          awardDateSemantics: 'base_award_signed',
        }),
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('pure helpers', () => {
  test('periodLabel understands the LDA spellings', () => {
    expect(periodLabel(2026, 'second_quarter', 'Q2')).toBe('Q2 2026');
    expect(periodLabel(2026, 'Q3', 'Q3')).toBe('Q3 2026');
    expect(periodLabel(2026, '4th Quarter - Report', 'Q4')).toBe('Q4 2026');
    expect(periodLabel(2025, null, 'Q1A')).toBe('Q1 2025');
    expect(periodLabel(2025, null, 'RR')).toBe('Registration 2025');
    expect(periodLabel(2025, 'mid-year', 'MM')).toBe('mid-year 2025');
  });
  test('stateFromOneLine pulls the state before the ZIP', () => {
    expect(stateFromOneLine('1 LOCKHEED BLVD, FORT WORTH, TX, 76108')).toBe('TX');
    expect(stateFromOneLine('1 Lockheed Blvd, Fort Worth, TX 76108-1234, USA')).toBe('TX');
    expect(stateFromOneLine('no state here')).toBeNull();
    expect(stateFromOneLine(null)).toBeNull();
  });
});

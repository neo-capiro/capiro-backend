/**
 * District Nexus Release 4 — REAL commit-entrypoint reachability proof for the
 * change ledger (DB-gated).
 *
 * This is NOT a re-run of the pure detector unit tests: it drives the actual
 * production commit paths and proves district_nexus_change rows are written by
 * them:
 *
 *  1. CPF/CDS: CommunityFundingUpsertService.upsertMany() — the canonical
 *     ingest transaction — wired through createDistrictNexusChangeSink().
 *     Proves new-request detection, correction detection, idempotent
 *     republishing (nothing), duplicate suppression on re-run, sentinel
 *     rejection (district 98 → null), and Senate statewide honesty (null
 *     district + null vintage).
 *  2. GSA: GsaRealPropertyIngestService.ingest() — the canonical GSA commit
 *     path used by sync-gsa-frpp.ts. Proves additions land with their chunk,
 *     identical re-publication emits nothing, corrected re-publication (new
 *     document SHA) emits exactly one material-change row, removal of a prior
 *     row emits exactly one removal row, and dry runs write zero facts and
 *     zero ledger rows.
 *
 * DB-gated: `process.env.DATABASE_URL ? describe : describe.skip`, matching the
 * existing convention (community-funding.cross-source-dedup.spec.ts).
 */
import { PrismaClient } from '@prisma/client';
import { CommunityFundingUpsertService } from '../../government-data/community-funding/community-funding.upsert.service.js';
import { upsertSourceDocument } from '../../program-element/source-document/source-document-registry.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { FundingCandidate } from '../../government-data/community-funding/community-funding.types.js';
import { createDistrictNexusChangeSink } from './priority-intelligence-cpf-cds-bridge.js';
import { DistrictNexusChangeWriter } from './priority-intelligence-changes.js';
import { GsaRealPropertyIngestService } from './priority-intelligence-gsa-ingest.service.js';
import type { FrppIngestTestRow } from './priority-intelligence-gsa-ingest.testing.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

function cpfCdsCandidate(overrides: Partial<FundingCandidate>): FundingCandidate {
  return {
    chamber: 'house',
    requestType: 'cpf',
    fiscalYear: 2026,
    requesterName: 'Test Requester Unique',
    requesterState: 'NY',
    requesterDistrict: '05',
    recipientName: 'Test Recipient Org',
    recipientAddress: null,
    city: null,
    state: null,
    zip: null,
    projectTitle: 'Test Project Unique',
    projectDescription: null,
    requestedAmountUsd: '100000.00',
    finalAmountUsd: null,
    amountStageRaw: 'amount_requested',
    appropriationsAccountRaw: null,
    subcommittee: null,
    sourcePage: 1,
    sourceRow: 1,
    ...overrides,
  };
}

describeDb('R4 change ledger is reached through REAL commit entrypoints (Postgres)', () => {
  jest.setTimeout(180_000);
  const prisma = new PrismaClient();
  const writer = new DistrictNexusChangeWriter(prisma as unknown as PrismaService);
  const upsert = new CommunityFundingUpsertService(prisma as unknown as PrismaService);

  const ledgerCount = (where: Record<string, unknown>) =>
    prisma.districtNexusChange.count({ where: where as never });

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.$executeRawUnsafe(
      'TRUNCATE district_nexus_change, gsa_real_property, gsa_real_property_source_run, ' +
        'community_funding_request_source, community_funding_request, source_document RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE district_nexus_change, gsa_real_property, gsa_real_property_source_run, ' +
        'community_funding_request_source, community_funding_request, source_document RESTART IDENTITY CASCADE',
    );
    await prisma.$disconnect();
  });

  describe('CPF/CDS — canonical upsertMany() ingest transaction', () => {
    let documentId: string;

    beforeAll(async () => {
      const doc = await upsertSourceDocument(prisma as never, {
        sourceKey: 'r4_change_ledger_cpf_cds_rehearsal',
        sha256: 'c'.repeat(64),
        fiscalYear: 2026,
        budgetCycle: 'cpf_request',
        component: null,
        documentType: 'cpf_consolidated_xlsx',
        title: 'R4 change-ledger rehearsal document',
        sourceUrl: 'https://example.test/r4-rehearsal',
        byteSize: 1,
        pageCount: null,
        downloadedAt: new Date(),
        extractionMethod: 'structured_import',
      });
      documentId = doc.document.id;
    });

    it('a genuinely NEW canonical request emits exactly one cpf_cds_request_new ledger row', async () => {
      const sink = createDistrictNexusChangeSink(writer);
      const outcome = await upsert.upsertMany([cpfCdsCandidate({})], documentId, new Date(), sink);
      expect(outcome.upserted).toBe(1);

      const rows = await prisma.districtNexusChange.findMany({
        where: { changeKind: 'cpf_cds_request_new' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe('cpf');
      expect(rows[0]!.stateCode).toBe('NY');
      expect(rows[0]!.districtCode).toBe('05');
      // House district rows never claim a boundary vintage the source did not publish.
      expect(rows[0]!.geographyVintage).toBe('source_unknown');
      expect((rows[0]!.newValue as Record<string, unknown>).amountStageRaw).toBe(
        'amount_requested',
      );
      // Requested ≠ final: amount semantics stay honest in provenance.
      expect(rows[0]!.provenance).toMatchObject({ amountSemantics: 'requested_not_awarded' });
    });

    it('identical republishing of the same document emits NOTHING', async () => {
      const sink = createDistrictNexusChangeSink(writer);
      const before = await ledgerCount({ changeKind: 'cpf_cds_request_new' });
      const outcome = await upsert.upsertMany(
        [cpfCdsCandidate({ sourceRow: 1 })],
        documentId,
        new Date(),
        sink,
      );
      expect(outcome.upserted).toBe(0);
      expect(outcome.changed).toBe(0);
      const after = await ledgerCount({ changeKind: 'cpf_cds_request_new' });
      expect(after).toBe(before);
    });

    it('a real amount correction (stage escalation) emits exactly one cpf_cds_amount_stage_correction row, idempotent on re-run', async () => {
      // Canonical precedence: a same-ranked stage never overwrites the recorded
      // amount (first-seen wins within a rank); a REAL correction escalates the
      // amount stage (amount_requested rank 0 → house_amount rank 1) and the
      // amount moves together with it. Emitting is conditional on the merge
      // actually writing — which is exactly the "value really changed" gate.
      const sink = createDistrictNexusChangeSink(writer);
      const outcome = await upsert.upsertMany(
        [cpfCdsCandidate({ requestedAmountUsd: '150000.00', amountStageRaw: 'house_amount' })],
        documentId,
        new Date(),
        sink,
      );
      expect(outcome.changed).toBe(1);

      const rows = await prisma.districtNexusChange.findMany({
        where: { changeKind: 'cpf_cds_amount_stage_correction' },
      });
      expect(rows).toHaveLength(1);
      expect((rows[0]!.oldValue as Record<string, unknown>).requestedAmountUsd).toBe('100000'); // persisted Decimal toString
      expect((rows[0]!.newValue as Record<string, unknown>).requestedAmountUsd).toBe('150000.00');
      expect(rows[0]!.oldState).toBe('amount_requested');

      // Re-running the SAME corrected batch emits nothing more (merge is a
      // no-op at the escalated rank AND the dedupe key would suppress it).
      await upsert.upsertMany(
        [cpfCdsCandidate({ requestedAmountUsd: '150000.00', amountStageRaw: 'house_amount' })],
        documentId,
        new Date(),
        sink,
      );
      expect(await ledgerCount({ changeKind: 'cpf_cds_amount_stage_correction' })).toBe(1);
    });

    it('sentinel district 98 can never land in the ledger; Senate rows stay statewide with null vintage', async () => {
      const sink = createDistrictNexusChangeSink(writer);
      await upsert.upsertMany(
        [
          cpfCdsCandidate({
            requesterName: 'Sentinel District Requester',
            projectTitle: 'Sentinel District Project',
            requesterDistrict: '98',
          }),
          cpfCdsCandidate({
            chamber: 'senate',
            requestType: 'cds',
            requesterName: 'Statewide Senate Requester',
            projectTitle: 'Statewide Senate Project',
            requesterState: 'NY',
            requesterDistrict: null,
            amountStageRaw: 'senate_recommendation',
          }),
        ],
        documentId,
        new Date(),
        sink,
      );

      const sentinel = await prisma.districtNexusChange.findFirst({
        where: { newValue: { path: ['requesterName'], equals: 'Sentinel District Requester' } },
      });
      expect(sentinel).not.toBeNull();
      // 90/98/ZZ-class sentinel codes are NOT districts — normalized to null.
      expect(sentinel!.districtCode).toBeNull();
      expect(sentinel!.geographyVintage).toBeNull();

      const senate = await prisma.districtNexusChange.findFirst({
        where: { newValue: { path: ['requesterName'], equals: 'Statewide Senate Requester' } },
      });
      expect(senate).not.toBeNull();
      expect(senate!.source).toBe('cds');
      expect(senate!.districtCode).toBeNull();
      expect(senate!.geographyVintage).toBeNull();
      expect(senate!.boundaryCongress).toBeNull();
    });
  });

  describe('GSA — canonical GsaRealPropertyIngestService.ingest() commit path', () => {
    const ingest = new GsaRealPropertyIngestService(prisma as unknown as PrismaService, writer);

    const row = (overrides: Partial<FrppIngestTestRow>): FrppIngestTestRow => ({
      rpUid: 'RP-R4-TEST-0001',
      reportingAgency: 'Test Agency',
      reportingAgencyCode: null,
      usingAgency: null,
      bureau: null,
      installationName: null,
      installationId: null,
      grain: 'detailed_asset',
      isDefense: false,
      usOrForeign: 'U.S.',
      countryName: null,
      stateCode: 'NY',
      stateName: null,
      countyName: null,
      cityName: null,
      zipCode: null,
      streetAddress: null,
      latitude: null,
      longitude: null,
      geographyBasis: 'source_state_only',
      legalInterest: 'Owned',
      realPropertyType: null,
      realPropertyUse: 'Office',
      utilization: null,
      assetStatus: 'Active',
      assetStatusCode: null,
      historicalStatus: null,
      squareFeet: 10000,
      squareFeetUom: null,
      congressionalDistrict: '05',
      boundaryCongress: null,
      congressSession: null,
      leaseExpirationDate: null,
      leaseStartDate: null,
      annualRentUsd: null,
      federalEmployeesCount: null,
      federalContractorsCount: null,
      ...overrides,
    });

    const ingestOpts = (sha: string, rows: FrppIngestTestRow[], dryRun: boolean) => ({
      sourceDataset: 'frpp_public_detailed' as const,
      fiscalYear: 2024,
      sourceDocumentSha256: sha,
      sourceUrl: 'https://example.test/frpp-rehearsal',
      dryRun,
      rows,
      warnings: [] as string[],
      metadata: {},
    });

    it('a dry run writes ZERO fact rows and ZERO ledger rows', async () => {
      const result = await ingest.ingest(
        ingestOpts('d0'.repeat(32), [row({}), row({ rpUid: 'RP-R4-TEST-0002' })], true),
      );
      expect(result.dryRun).toBe(true);
      expect(result.rowsWritten).toBe(0);
      expect(result.changes).toBeNull();
      expect(await prisma.gsaRealProperty.count()).toBe(0);
      expect(await ledgerCount({ source: 'gsa' })).toBe(0);
    });

    it('a committed run writes gsa_property_added rows — one per new rp_uid', async () => {
      const result = await ingest.ingest(
        ingestOpts(
          'd1'.repeat(32),
          [row({}), row({ rpUid: 'RP-R4-TEST-0002' }), row({ rpUid: 'RP-R4-TEST-0003' })],
          false,
        ),
      );
      expect(result.rowsWritten).toBe(3);
      expect(result.changes).not.toBeNull();
      expect(result.changes!.written).toBe(3); // three additions, one per new rp_uid
      expect(result.changes!.duplicates).toBe(0);
      expect(await ledgerCount({ changeKind: 'gsa_property_added' })).toBe(3);

      // This is the FIRST-EVER commit against this (just-truncated) table —
      // an empty prior snapshot — so every addition here is baseline
      // population of the whole fiscal year, not a discrete later change.
      // Real production shape: FY2024's actual initial load wrote 291,757
      // rows exactly like this, all in one run.
      const baselineRows = await prisma.districtNexusChange.findMany({
        where: { changeKind: 'gsa_property_added' },
      });
      expect(baselineRows).toHaveLength(3);
      for (const r of baselineRows) expect(r.observationKind).toBe('baseline');
    });

    it('identical re-publication emits nothing new (idempotent)', async () => {
      const result = await ingest.ingest(
        ingestOpts(
          'd1'.repeat(32),
          [row({}), row({ rpUid: 'RP-R4-TEST-0002' }), row({ rpUid: 'RP-R4-TEST-0003' })],
          false,
        ),
      );
      expect(result.rowsWritten).toBe(0);
      expect(result.rowsSkippedDuplicate).toBe(3);
      expect(result.changes!.written).toBe(0);
      expect(result.changes!.duplicates).toBe(0);
      expect(await ledgerCount({ source: 'gsa' })).toBe(3);
    });

    it('a corrected re-publication (new document SHA) emits exactly one material change and one removal', async () => {
      // RP-0001 sqft 10000 → 20000 (material change); RP-0002 unchanged
      // (same values, new doc SHA → new fact row but NO change row);
      // RP-0003 existed before and is now absent (removal); RP-0004 is new.
      const result = await ingest.ingest(
        ingestOpts(
          'd2'.repeat(32),
          [
            row({ squareFeet: 20000 }),
            row({ rpUid: 'RP-R4-TEST-0002' }),
            row({ rpUid: 'RP-R4-TEST-0004' }),
          ],
          false,
        ),
      );
      expect(result.rowsWritten).toBe(3); // RP-0001 v2 (new doc SHA → new hash) + RP-0002 + RP-0004
      // RP-0004 addition (in-chunk) + RP-0001 material change + RP-0003 removal;
      // RP-0002 unchanged → nothing; post-loop pass excludes additions (already counted).
      expect(result.changes!.written).toBe(3);

      const material = await prisma.districtNexusChange.findMany({
        where: { changeKind: 'gsa_property_material_change' },
      });
      expect(material).toHaveLength(1);
      expect(material[0]!.sourceRecordId).toBe('RP-R4-TEST-0001');
      expect((material[0]!.oldValue as Record<string, unknown>).squareFeet).toBe('10000');
      expect((material[0]!.newValue as Record<string, unknown>).squareFeet).toBe('20000');
      expect(material[0]!.geographyVintage).toBe('source_unknown');

      const removed = await prisma.districtNexusChange.findMany({
        where: { changeKind: 'gsa_property_removed' },
      });
      expect(removed).toHaveLength(1);
      expect(removed[0]!.sourceRecordId).toBe('RP-R4-TEST-0003');
      expect(removed[0]!.newState).toBe('absent');
      // Removals/corrections require a prior row — never baseline.
      expect(material[0]!.observationKind).toBe('change');
      expect(removed[0]!.observationKind).toBe('change');

      expect(await ledgerCount({ changeKind: 'gsa_property_added' })).toBe(4); // 3 from run1 + RP-0004
      // RP-0004 is a genuinely SUBSEQUENT addition (the prior snapshot from
      // this fiscal year is non-empty by now) — a real later change, not a
      // repeat of the baseline classification from the first commit.
      const rp0004 = await prisma.districtNexusChange.findFirst({
        where: { changeKind: 'gsa_property_added', sourceRecordId: 'RP-R4-TEST-0004' },
      });
      expect(rp0004!.observationKind).toBe('change');
    });
  });
});

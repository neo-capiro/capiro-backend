/** Reproducible Package 5 database qualification. Run only against a disposable DB. */
import { PrismaClient } from '@prisma/client';
import { AcquisitionContinuityReadService } from '../src/program-element/acquisition-continuity/acquisition-continuity-read.service.js';
import { AcquisitionContinuityStore } from '../src/program-element/acquisition-continuity/acquisition-continuity.store.js';
import { projectPortfolioAcquisition } from '../src/program-element/acquisition-continuity/acquisition-projection.js';
import { ProgramContinuityService } from '../src/program-element/programs/program-continuity.service.js';
import {
  assertPackage5QualificationTarget,
  Package5QualificationSafetyError,
} from './package5-qualification-safety.js';

const PROGRAM_A = '50000000-0000-4000-8000-000000000001';
const PROGRAM_B = '50000000-0000-4000-8000-000000000002';
const CROSSWALK_OLD = '50000000-0000-4000-8000-000000000101';
const CROSSWALK_NEW = '50000000-0000-4000-8000-000000000102';
const CROSSWALK_SPLIT_A = '50000000-0000-4000-8000-000000000103';
const CROSSWALK_SPLIT_B = '50000000-0000-4000-8000-000000000104';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PACKAGE5_QUALIFICATION_FAILED: ${message}`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/qualify-package5-program-acquisition.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }

  assertPackage5QualificationTarget({
    databaseUrl: process.env.DATABASE_URL,
    environmentOptIn: process.env.PACKAGE5_QUALIFICATION_ALLOW_WRITES,
    args: process.argv.slice(2),
  });
  const prisma = new PrismaClient();

  try {
    await prisma.$connect();
    await prisma.program.upsert({
      where: { id: PROGRAM_A },
      create: { id: PROGRAM_A, canonicalName: 'P5 Qualification Program Alpha', status: 'active' },
      update: {},
    });
    await prisma.program.upsert({
      where: { id: PROGRAM_B },
      create: { id: PROGRAM_B, canonicalName: 'P5 Qualification Program Bravo', status: 'active' },
      update: {},
    });
    const reviewedAt = new Date('2026-09-24T12:00:00.000Z');
    await prisma.programIdentityCrosswalk.createMany({
      skipDuplicates: true,
      data: [
        {
          id: CROSSWALK_OLD,
          programId: PROGRAM_A,
          identityKind: 'pe', sourceSystem: 'qualification_jbook', sourceIdentifier: 'PE-OLD',
          relationshipKind: 'same_as', validFromFy: 2024, validToFy: 2025,
          recordedAt: new Date('2026-09-01T00:00:00.000Z'), source: 'qualification_fixture',
          evidence: { kind: 'official_exhibit', quote: 'PE-OLD becomes PE-NEW in FY2026' },
          confidence: 1, reviewStatus: 'accepted', reviewedAt,
        },
        {
          id: CROSSWALK_NEW,
          programId: PROGRAM_A,
          identityKind: 'pe', sourceSystem: 'qualification_jbook', sourceIdentifier: 'PE-NEW',
          relationshipKind: 'successor', validFromFy: 2026,
          recordedAt: new Date('2026-09-01T00:00:01.000Z'), source: 'qualification_fixture',
          evidence: { kind: 'official_exhibit', quote: 'PE-NEW is the FY2026 successor' },
          confidence: 1, reviewStatus: 'accepted', reviewedAt,
        },
        {
          id: CROSSWALK_SPLIT_A,
          programId: PROGRAM_A,
          identityKind: 'source_program', sourceSystem: 'qualification_jbook', sourceIdentifier: 'PROGRAM-SPLIT',
          relationshipKind: 'split_from', validFromFy: 2027,
          recordedAt: new Date('2026-09-01T00:00:02.000Z'), source: 'qualification_fixture',
          evidence: { kind: 'official_exhibit', quote: 'one source program split into Alpha and Bravo' },
          confidence: 1, reviewStatus: 'accepted', reviewedAt,
        },
        {
          id: CROSSWALK_SPLIT_B,
          programId: PROGRAM_B,
          identityKind: 'source_program', sourceSystem: 'qualification_jbook', sourceIdentifier: 'PROGRAM-SPLIT',
          relationshipKind: 'split_from', validFromFy: 2027,
          recordedAt: new Date('2026-09-01T00:00:03.000Z'), source: 'qualification_fixture',
          evidence: { kind: 'official_exhibit', quote: 'one source program split into Alpha and Bravo' },
          confidence: 1, reviewStatus: 'accepted', reviewedAt,
        },
      ],
    });

    const continuity = new ProgramContinuityService(prisma as never);
    const oldPath = await continuity.list({
      asOfFy: 2025, knownAt: '2026-09-24T23:00:00.000Z', sourceIdentifier: 'PE-OLD',
    });
    const oldAfterRename = await continuity.list({
      asOfFy: 2026, knownAt: '2026-09-24T23:00:00.000Z', sourceIdentifier: 'PE-OLD',
    });
    const newPath = await continuity.list({
      asOfFy: 2026, knownAt: '2026-09-24T23:00:00.000Z', sourceIdentifier: 'PE-NEW',
    });
    const split = await continuity.list({
      asOfFy: 2027, knownAt: '2026-09-24T23:00:00.000Z', sourceIdentifier: 'PROGRAM-SPLIT',
    });
    assert(oldPath.data.length === 1, 'renumbered PE old path missing in FY2025');
    assert(oldAfterRename.data.length === 0, 'renumbered PE old path leaked into FY2026');
    assert(newPath.data.length === 1, 'renumbered PE successor missing in FY2026');
    assert(split.data.length === 2, 'split program did not retain both successor paths');

    const store = new AcquisitionContinuityStore(prisma as never);
    const vehicle = await store.appendRecord({
      source: 'qualification_fpds', sourceRecordId: 'VEHICLE-1', vehicleId: 'VEHICLE-1', recordKind: 'vehicle',
      title: 'Qualification IDIQ', sourceVersion: 'v1', sourceObservedAt: '2026-09-24T12:00:00Z',
      raw: { fixture: 'parent vehicle plus orders' },
    });
    const order1 = await store.appendRecord({
      source: 'qualification_fpds', sourceRecordId: 'ORDER-1', orderId: 'ORDER-1', recordKind: 'order',
      parentIdentityKey: vehicle.identityKey, parentAwardId: 'VEHICLE-1', piid: 'ORDER-1',
      title: 'Qualification Order 1', sourceVersion: 'v1', sourceObservedAt: '2026-09-24T12:00:00Z',
    });
    const order2 = await store.appendRecord({
      source: 'qualification_fpds', sourceRecordId: 'ORDER-2', orderId: 'ORDER-2', recordKind: 'order',
      parentIdentityKey: vehicle.identityKey, parentAwardId: 'VEHICLE-1', piid: 'ORDER-2',
      title: 'Qualification Order 2', sourceVersion: 'v1', sourceObservedAt: '2026-09-24T12:00:00Z',
    });
    const award = await store.appendRecord({
      source: 'usaspending', sourceRecordId: 'CONT_AWD_P5_QUAL', generatedAwardId: 'CONT_AWD_P5_QUAL',
      recordKind: 'award', title: 'Qualification Award', sourceVersion: 'v1',
      sourceObservedAt: '2026-09-24T12:00:00Z', raw: { fixture: 'award dedupe' },
    });
    for (const [programId, sourceRecordId] of [[PROGRAM_A, 'path-alpha'], [PROGRAM_B, 'path-bravo']] as const) {
      await store.appendRelationship({
        subjectKind: 'program', subjectKey: programId, acquisitionIdentityKey: award.identityKey!,
        relationshipClass: 'reviewed_association', sourceSystem: 'qualification', sourceRecordId,
        validFromFy: 2026, reviewStatus: 'accepted', reviewedAt: reviewedAt.toISOString(),
        sourceVersion: 'v1', sourceObservedAt: '2026-09-24T12:00:00Z',
        evidence: [{ kind: 'reviewed_award_association', sourceNativeId: 'CONT_AWD_P5_QUAL' }],
        confidence: 1, coverageState: 'partial',
      });
    }
    await store.appendRelationship({
      subjectKind: 'program', subjectKey: PROGRAM_A, acquisitionIdentityKey: order1.identityKey!,
      relationshipClass: 'reviewed_association', sourceSystem: 'qualification_fpds', sourceRecordId: 'ORDER-1',
      validFromFy: 2026, reviewStatus: 'accepted', reviewedAt: reviewedAt.toISOString(),
      sourceVersion: 'v1', sourceObservedAt: '2026-09-24T12:00:00Z',
      evidence: [{ kind: 'parent_order_chain', sourceNativeId: 'ORDER-1' }], confidence: 1, coverageState: 'complete',
    });
    await store.appendRelationship({
      subjectKind: 'program', subjectKey: PROGRAM_A, acquisitionIdentityKey: order2.identityKey!,
      relationshipClass: 'reviewed_association', sourceSystem: 'qualification_fpds', sourceRecordId: 'ORDER-2',
      validFromFy: 2026, reviewStatus: 'accepted', reviewedAt: reviewedAt.toISOString(),
      sourceVersion: 'v1', sourceObservedAt: '2026-09-24T12:00:00Z',
      evidence: [{ kind: 'parent_order_chain', sourceNativeId: 'ORDER-2' }], confidence: 1, coverageState: 'complete',
    });
    await store.appendRelationship({
      subjectKind: 'program', subjectKey: PROGRAM_A, acquisitionIdentityKey: award.identityKey!,
      relationshipClass: 'unresolved', sourceSystem: 'usaspending', sourceRecordId: 'unsupported-allocation',
      validFromFy: 2026, reviewStatus: 'unresolved', sourceVersion: 'v1',
      sourceObservedAt: '2026-09-24T12:00:00Z', evidence: [], confidence: 0,
      unresolvedReason: 'No source-stated award-to-program allocation exists.', coverageState: 'unsupported',
    });
    await store.upsertCoverageGap({
      subjectKind: 'program', subjectKey: PROGRAM_A, sourceSystem: 'usaspending',
      relationshipKind: 'award_to_program_financial_allocation', reason: 'allocation_not_supported',
      detail: 'Association is useful, but it is not a financial allocation.', coverageState: 'unsupported',
      sourceAsOf: '2026-09-24T12:00:00Z', observedAt: '2026-09-24T12:00:00Z',
    });

    const tx1 = await store.appendTransaction({
      source: 'usaspending', sourceTransactionId: 'TX-P5-1', awardIdentityKey: award.identityKey!,
      actionDate: '2026-09-01', signedObligationDelta: '1000.00', sourceObservedAt: '2026-09-24T12:00:00Z',
    });
    const tx2 = await store.appendTransaction({
      source: 'usaspending', sourceTransactionId: 'TX-P5-2', awardIdentityKey: award.identityKey!,
      actionDate: '2026-09-02', signedObligationDelta: '-250.00', sourceObservedAt: '2026-09-24T12:00:00Z',
    });
    const portfolio = projectPortfolioAcquisition({
      awardPaths: [
        { awardIdentityKey: award.identityKey!, pathIdentityKey: `program:${PROGRAM_A}` },
        { awardIdentityKey: award.identityKey!, pathIdentityKey: `program:${PROGRAM_B}` },
      ],
      transactions: [
        { identityKey: tx1.identityKey!, awardIdentityKey: award.identityKey!, signedDeltaUsd: '1000.00', revision: 1 },
        { identityKey: tx2.identityKey!, awardIdentityKey: award.identityKey!, signedDeltaUsd: '-250.00', revision: 1 },
      ],
      accountTotals: [{ identityKey: 'TAS-FIXTURE', amountUsd: '9999.00', sourceAsOf: '2026-09-24' }],
    });
    assert(portfolio.awardCount === 1, 'one award was double-counted across two program paths');
    assert(portfolio.signedTransactionDeltaUsd === '750', 'negative obligation was not preserved');
    assert(!('combinedTotalUsd' in portfolio), 'account totals were combined with award transactions');

    const readService = new AcquisitionContinuityReadService(store);
    const acquisitionRead = await readService.read({
      programId: PROGRAM_A, asOfFy: 2027, knownAt: '2099-01-01T00:00:00Z', status: 'all', limit: 20,
    });
    assert(acquisitionRead.accepted.length >= 3, 'vehicle/order/award relationships were not readable');
    assert(acquisitionRead.unresolved.length === 1, 'unsupported allocation was not visible as unresolved');
    assert(acquisitionRead.unresolved[0]!.authoritativeAmountUsd === null, 'unsupported allocation exposed dollars');
    assert(acquisitionRead.coverage.state === 'unsupported', 'unsupported allocation coverage was hidden');
    const orderRows = acquisitionRead.accepted.filter((row) => row.to.entityType === 'order');
    assert(orderRows.length === 2 && orderRows.every((row) => row.parent?.id === vehicle.identityKey), 'parent vehicle/order paths were not preserved');

    let immutable = false;
    try {
      await prisma.$executeRawUnsafe(`UPDATE program_identity_crosswalk SET confidence = 0.1 WHERE id = '${CROSSWALK_OLD}'`);
    } catch {
      immutable = true;
    }
    assert(immutable, 'crosswalk history was mutable');

    const output = {
      ok: true,
      package: 5,
      fixtures: {
        renumberedPe: true,
        splitProgram: split.data.length,
        negativeObligation: portfolio.signedTransactionDeltaUsd,
        parentVehicleOrders: orderRows.length,
        unsupportedAllocation: acquisitionRead.coverage.state,
        awardDeduplication: portfolio.awardCount,
      },
      counts: {
        crosswalks: await prisma.programIdentityCrosswalk.count({ where: { source: 'qualification_fixture' } }),
        records: await prisma.acquisitionRecordRevision.count({ where: { sourceSystem: { in: ['qualification_fpds', 'usaspending'] } } }),
        transactions: await prisma.acquisitionAwardTransactionRevision.count({ where: { awardIdentityKey: award.identityKey! } }),
        relationships: await prisma.programAcquisitionRelationship.count({ where: { subjectKey: { in: [PROGRAM_A, PROGRAM_B] } } }),
        openCoverageGaps: await prisma.acquisitionCoverageGap.count({ where: { subjectKey: PROGRAM_A, resolvedAt: null } }),
      },
      boundaries: {
        accountTotalsCombinedWithTransactions: false,
        unsupportedJoinPublishesDollars: false,
        immutableHistory: immutable,
      },
    };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
void main().catch((error) => {
  if (error instanceof Package5QualificationSafetyError) {
    console.error(error.message);
  } else {
    // Prisma/driver errors can echo connection metadata; keep the fixture runner
    // from ever printing DATABASE_URL, user names, hosts, or passwords.
    console.error('Package 5 qualification failed. Database connection details are withheld.');
  }
  process.exit(1);
});
}

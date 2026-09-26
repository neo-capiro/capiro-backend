/** Reproducible Package 6 qualification. Run only against the named disposable DB. */
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { FundingExecutionStore, type FundingSourceEventInput } from '../src/funding-execution/funding-execution.store.js';
import { FundingExecutionReadService } from '../src/program-element/funding-execution/funding-execution-read.service.js';
import { runFundingExecutionCertificationWorker } from './funding-execution-certification-worker.js';
import {
  assertPackage6QualificationTarget,
  Package6QualificationSafetyError,
} from './package6-qualification-safety.js';

const DOC = '60000000-0000-4000-8000-000000000001';
const PROPOSED_MEASURE = '60000000-0000-4000-8000-000000000101';
const ENACTED_MEASURE = '60000000-0000-4000-8000-000000000102';
const TRANSFER_MEASURE = '60000000-0000-4000-8000-000000000103';
const RESCISSION_MEASURE = '60000000-0000-4000-8000-000000000104';
const PROPOSED_PROVISION = '60000000-0000-4000-8000-000000000201';
const ENACTED_PROVISION = '60000000-0000-4000-8000-000000000202';
const TRANSFER_PROVISION = '60000000-0000-4000-8000-000000000203';
const RESCISSION_PROVISION = '60000000-0000-4000-8000-000000000204';
const PROPOSED_ALLOCATION = '60000000-0000-4000-8000-000000000301';
const SNAPSHOT_ALLOCATION = '60000000-0000-4000-8000-000000000302';
const NEGATIVE_OBLIGATION = '60000000-0000-4000-8000-000000000303';
const TRANSFER_OUT = '60000000-0000-4000-8000-000000000304';
const TRANSFER_IN = '60000000-0000-4000-8000-000000000305';
const RESCISSION_ALLOCATION = '60000000-0000-4000-8000-000000000306';
const ACCOUNT_SNAPSHOT = '60000000-0000-4000-8000-000000000307';
const LEGACY_ALLOCATION = '60000000-0000-4000-8000-000000000308';
const PE_A = '0606001Q';
const PE_B = '0606002Q';
const EVIDENCE = 'e'.repeat(64);
const OBSERVED_AT = '2026-09-24T12:00:00.000Z';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PACKAGE6_QUALIFICATION_FAILED: ${message}`);
}

function amountEquals(value: string | null, expected: string): boolean {
  const cents = (input: string): bigint | null => {
    const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(input);
    if (!match) return null;
    const parsed = BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0') || '0');
    return match[1] ? -parsed : parsed;
  };
  return value !== null && cents(value) === cents(expected);
}

function sourceEvent(input: Omit<FundingSourceEventInput, 'sourceDocumentId' | 'sourceSystem' | 'sourceObservedAt'>): FundingSourceEventInput {
  return {
    ...input,
    sourceDocumentId: DOC,
    sourceSystem: 'package6_qualification',
    sourceObservedAt: OBSERVED_AT,
    sourceUrl: 'https://example.invalid/package6-qualification',
    sourceVersion: 'qualification-v1',
    raw: { quote: `Package 6 qualification evidence for ${input.sourceRecordId}` },
  };
}

async function main(): Promise<void> {
  assertPackage6QualificationTarget({
    databaseUrl: process.env.DATABASE_URL,
    environmentOptIn: process.env.PACKAGE6_QUALIFICATION_ALLOW_WRITES,
    args: process.argv.slice(2),
  });

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    await prisma.sourceDocument.upsert({
      where: { id: DOC },
      create: {
        id: DOC,
        sourceKey: 'package6_funding_execution_qualification',
        fiscalYear: 2027,
        budgetCycle: 'execution',
        component: 'DW',
        documentType: 'other',
        title: 'Package 6 funding and execution qualification evidence',
        sourceUrl: 'https://example.invalid/package6-qualification',
        sha256: EVIDENCE,
        extractionMethod: 'manual',
        extractionToolVersion: 'package6-qualification-v1',
        metadata: { qualification: true },
      },
      update: {},
    });

    const measures = [
      { id: PROPOSED_MEASURE, measureType: 'supplemental', status: 'introduced', title: 'Proposed qualification supplemental' },
      { id: ENACTED_MEASURE, measureType: 'supplemental', status: 'enacted', title: 'Enacted qualification execution measure' },
      { id: TRANSFER_MEASURE, measureType: 'transfer', status: 'enacted', title: 'Approved qualification transfer' },
      { id: RESCISSION_MEASURE, measureType: 'rescission', status: 'enacted', title: 'Enacted qualification rescission' },
    ] as const;
    for (const measure of measures) {
      await prisma.federalFundingMeasure.upsert({
        where: { id: measure.id },
        create: {
          ...measure,
          authorityType: 'discretionary',
          fiscalYear: 2027,
          availabilityStart: new Date('2026-10-01T00:00:00.000Z'),
          availabilityEnd: new Date('2027-09-30T00:00:00.000Z'),
          sourceDocumentId: DOC,
          sourcePage: 1,
          dedupKey: hash(`package6:measure:${measure.id}`),
          metadata: { qualification: true },
        },
        update: {},
      });
    }

    const provisions = [
      { id: PROPOSED_PROVISION, measureId: PROPOSED_MEASURE, statedAmountUsd: '150000000.00', purposeText: 'Proposed supplemental authority' },
      { id: ENACTED_PROVISION, measureId: ENACTED_MEASURE, statedAmountUsd: '100000000.00', purposeText: 'Enacted execution reporting' },
      { id: TRANSFER_PROVISION, measureId: TRANSFER_MEASURE, statedAmountUsd: '12000000.00', purposeText: 'Approved paired transfer' },
      { id: RESCISSION_PROVISION, measureId: RESCISSION_MEASURE, statedAmountUsd: '-7000000.00', purposeText: 'Enacted rescission' },
    ] as const;
    for (const provision of provisions) {
      await prisma.federalFundingProvision.upsert({
        where: { id: provision.id },
        create: {
          ...provision,
          agency: 'Department of Defense',
          component: 'DW',
          appropriationTitle: 'Research, Development, Test and Evaluation',
          tas: '097-0400',
          sourceDocumentId: DOC,
          sourcePage: 1,
          evidenceSha256: EVIDENCE,
          dedupKey: hash(`package6:provision:${provision.id}`),
          metadata: { qualification: true },
        },
        update: {},
      });
    }

    const proposedEvents = [sourceEvent({
      sourceEventKey: 'package6:proposed:snapshot', sourceRecordId: 'PROPOSED-SNAPSHOT', eventType: 'supplemental_position',
      measureId: PROPOSED_MEASURE, amountBasis: 'snapshot', asOfDate: '2027-09-30', sourceAmountUsd: '150000000.00',
    })];
    const enactedEvents = [
      sourceEvent({
        sourceEventKey: 'package6:enacted:snapshot', sourceRecordId: 'ENACTED-SNAPSHOT', eventType: 'execution_snapshot',
        measureId: ENACTED_MEASURE, amountBasis: 'snapshot', executionMetric: 'obligations', asOfDate: '2027-09-30',
        sourceAmountUsd: '100000000.00',
      }),
      sourceEvent({
        sourceEventKey: 'package6:enacted:negative-obligation', sourceRecordId: 'NEGATIVE-OBLIGATION', eventType: 'obligation_transaction',
        measureId: ENACTED_MEASURE, amountBasis: 'transaction_delta', executionMetric: 'obligations', asOfDate: '2027-09-24',
        signedObligationDelta: '-5000000.00',
      }),
      sourceEvent({
        sourceEventKey: 'package6:enacted:account-snapshot', sourceRecordId: 'ACCOUNT-SNAPSHOT', eventType: 'execution_snapshot',
        measureId: ENACTED_MEASURE, amountBasis: 'snapshot', executionMetric: 'obligations', asOfDate: '2027-09-30',
        sourceAmountUsd: '200000000.00',
      }),
    ];
    const transferEvents = [
      sourceEvent({
        sourceEventKey: 'package6:transfer:out', sourceRecordId: 'TRANSFER-OUT', eventType: 'transfer_leg',
        measureId: TRANSFER_MEASURE, amountBasis: 'transaction_delta', asOfDate: '2027-09-20', sourceAmountUsd: '-12000000.00',
        transferPairKey: 'package6-transfer-pair', transferSide: 'out',
      }),
      sourceEvent({
        sourceEventKey: 'package6:transfer:in', sourceRecordId: 'TRANSFER-IN', eventType: 'transfer_leg',
        measureId: TRANSFER_MEASURE, amountBasis: 'transaction_delta', asOfDate: '2027-09-20', sourceAmountUsd: '12000000.00',
        transferPairKey: 'package6-transfer-pair', transferSide: 'in',
      }),
    ];
    const rescissionEvents = [sourceEvent({
      sourceEventKey: 'package6:rescission', sourceRecordId: 'RESCISSION', eventType: 'rescission',
      measureId: RESCISSION_MEASURE, amountBasis: 'transaction_delta', asOfDate: '2027-09-21', sourceAmountUsd: '-7000000.00',
    })];

    const store = new FundingExecutionStore(prisma as never);
    const proposedIds = await store.appendSourceEvents(proposedEvents);
    const enactedIds = await store.appendSourceEvents(enactedEvents);
    const transferIds = await store.appendSourceEvents(transferEvents);
    const rescissionIds = await store.appendSourceEvents(rescissionEvents);

    const allocationCreate = (input: {
      id: string; provisionId: string; sourceEventId?: string; targetType: string; targetNativeKey: string;
      amount: string | null; stage: string; basis?: string; asOfDate?: string; executionMetric?: string | null;
      transferPairKey?: string; transferSide?: string; obligationReference?: string;
    }) => ({
      id: input.id,
      provisionId: input.provisionId,
      targetType: input.targetType,
      targetNativeKey: input.targetNativeKey,
      allocationStage: input.stage,
      mappingMaturity: input.targetType === 'appropriation_account' ? 'account_level' : 'exact_identifier',
      reviewState: input.sourceEventId ? 'verified' : 'candidate',
      authoritativeAmountUsd: input.amount,
      inferredRelevance: false,
      confidence: input.sourceEventId ? '1' : null,
      baseRequestStatus: 'unknown',
      potentialDoubleCount: false,
      fundingPosture: 'one_time',
      evidenceSourceDocumentId: DOC,
      evidencePage: 1,
      evidenceSha256: EVIDENCE,
      obligationReference: input.obligationReference,
      executionReference: input.sourceEventId ? `qualification:${input.id}` : null,
      sourceEventId: input.sourceEventId,
      amountBasis: input.basis,
      asOfDate: input.asOfDate ? new Date(`${input.asOfDate}T00:00:00.000Z`) : undefined,
      executionMetric: input.executionMetric,
      transferPairKey: input.transferPairKey,
      transferSide: input.transferSide,
      dedupKey: hash(`package6:allocation:${input.id}`),
      metadata: { qualification: true },
    });

    const ordinaryAllocations = [
      allocationCreate({ id: PROPOSED_ALLOCATION, provisionId: PROPOSED_PROVISION, sourceEventId: proposedIds[0]!.id, targetType: 'program_element', targetNativeKey: PE_A, amount: '150000000.00', stage: 'statutory', basis: 'snapshot', asOfDate: '2027-09-30' }),
      allocationCreate({ id: SNAPSHOT_ALLOCATION, provisionId: ENACTED_PROVISION, sourceEventId: enactedIds[0]!.id, targetType: 'program_element', targetNativeKey: PE_A, amount: '100000000.00', stage: 'dod_spend_plan', basis: 'snapshot', asOfDate: '2027-09-30', executionMetric: 'obligations' }),
      allocationCreate({ id: NEGATIVE_OBLIGATION, provisionId: ENACTED_PROVISION, sourceEventId: enactedIds[1]!.id, targetType: 'program_element', targetNativeKey: PE_A, amount: '-5000000.00', stage: 'obligated', basis: 'transaction_delta', asOfDate: '2027-09-24', executionMetric: 'obligations', obligationReference: 'qualification-negative-obligation' }),
      allocationCreate({ id: ACCOUNT_SNAPSHOT, provisionId: ENACTED_PROVISION, sourceEventId: enactedIds[2]!.id, targetType: 'appropriation_account', targetNativeKey: '097-0400', amount: '200000000.00', stage: 'dod_spend_plan', basis: 'snapshot', asOfDate: '2027-09-30', executionMetric: 'obligations' }),
      allocationCreate({ id: RESCISSION_ALLOCATION, provisionId: RESCISSION_PROVISION, sourceEventId: rescissionIds[0]!.id, targetType: 'program_element', targetNativeKey: PE_A, amount: '-7000000.00', stage: 'statutory', basis: 'transaction_delta', asOfDate: '2027-09-21' }),
    ];
    for (const data of ordinaryAllocations) {
      await prisma.federalFundingAllocation.upsert({ where: { id: data.id }, create: data, update: {} });
    }

    const transferAllocations = [
      allocationCreate({ id: TRANSFER_OUT, provisionId: TRANSFER_PROVISION, sourceEventId: transferIds[0]!.id, targetType: 'program_element', targetNativeKey: PE_A, amount: '-12000000.00', stage: 'reprogramming', basis: 'transaction_delta', asOfDate: '2027-09-20', transferPairKey: 'package6-transfer-pair', transferSide: 'out' }),
      allocationCreate({ id: TRANSFER_IN, provisionId: TRANSFER_PROVISION, sourceEventId: transferIds[1]!.id, targetType: 'program_element', targetNativeKey: PE_B, amount: '12000000.00', stage: 'reprogramming', basis: 'transaction_delta', asOfDate: '2027-09-20', transferPairKey: 'package6-transfer-pair', transferSide: 'in' }),
    ];
    await prisma.$transaction(async (tx) => {
      for (const data of transferAllocations) {
        await tx.federalFundingAllocation.upsert({ where: { id: data.id }, create: data, update: {} });
      }
    });

    await prisma.federalFundingAllocation.upsert({
      where: { id: LEGACY_ALLOCATION },
      create: {
        id: LEGACY_ALLOCATION,
        provisionId: ENACTED_PROVISION,
        targetType: 'federal_program',
        targetNativeKey: 'LEGACY-P6-COMPAT',
        allocationStage: 'service_budget_exhibit',
        mappingMaturity: 'exact_identifier',
        reviewState: 'candidate',
        authoritativeAmountUsd: null,
        evidenceSourceDocumentId: DOC,
        evidenceSha256: EVIDENCE,
        dedupKey: hash(`package6:allocation:${LEGACY_ALLOCATION}`),
        metadata: { qualification: true, legacyCompatibility: true },
      },
      update: {},
    });

    const certifications = [
      await store.certifyAndPublish({ certificationKey: 'package6:proposed', revision: 1, measureId: PROPOSED_MEASURE, sourceEvents: proposedEvents, allocationIds: [PROPOSED_ALLOCATION], residuals: [], scope: { fiscalYear: 2027, disposition: 'proposed' }, certifiedBy: 'package6-qualification' }),
      await store.certifyAndPublish({ certificationKey: 'package6:enacted', revision: 1, measureId: ENACTED_MEASURE, sourceEvents: enactedEvents, allocationIds: [SNAPSHOT_ALLOCATION, NEGATIVE_OBLIGATION, ACCOUNT_SNAPSHOT], residuals: [{ scopeKey: 'package6:pe-a:fy2027', scope: { subjectType: 'pe', subjectId: PE_A, fiscalYear: 2027, metric: 'obligations', stage: 'execution', period: 'FY2027' }, basis: 'snapshot', residualAmountUsd: '15000000.00', reason: 'unallocated qualification residual', coverageState: 'partial', freshness: { sourceAsOf: '2027-09-30' }, evidenceSourceDocumentId: DOC, evidenceSha256: EVIDENCE }], scope: { fiscalYear: 2027, disposition: 'enacted' }, certifiedBy: 'package6-qualification' }),
      await store.certifyAndPublish({ certificationKey: 'package6:transfer', revision: 1, measureId: TRANSFER_MEASURE, sourceEvents: transferEvents, allocationIds: [TRANSFER_OUT, TRANSFER_IN], residuals: [], scope: { fiscalYear: 2027, transferPairKey: 'package6-transfer-pair' }, certifiedBy: 'package6-qualification' }),
      await store.certifyAndPublish({ certificationKey: 'package6:rescission', revision: 1, measureId: RESCISSION_MEASURE, sourceEvents: rescissionEvents, allocationIds: [RESCISSION_ALLOCATION], residuals: [], scope: { fiscalYear: 2027, measureType: 'rescission' }, certifiedBy: 'package6-qualification' }),
    ];
    const replay = await store.certifyAndPublish({ certificationKey: 'package6:transfer', revision: 1, measureId: TRANSFER_MEASURE, sourceEvents: transferEvents, allocationIds: [TRANSFER_OUT, TRANSFER_IN], residuals: [], scope: { fiscalYear: 2027, transferPairKey: 'package6-transfer-pair' }, certifiedBy: 'package6-qualification' });
    assert(!replay.inserted, 'identical certification replay was not idempotent');

    const reads = new FundingExecutionReadService(store);
    await prisma.federalFundingMeasure.update({ where: { id: ENACTED_MEASURE }, data: { status: 'introduced' } });
    const read = await reads.read({ peCode: PE_A, asOfFy: 2027, knownAt: '2099-01-01T00:00:00.000Z', limit: 50 });
    assert(
      read.proposed.cumulativeSnapshots.some((row) => amountEquals(row.amountUsd, '150000000.00')),
      `proposed position was not isolated (proposed snapshots: ${read.proposed.cumulativeSnapshots.map((row) => `${row.factId}=${row.amountUsd}`).join(', ') || 'none'}; enacted snapshots: ${read.enacted.cumulativeSnapshots.map((row) => `${row.factId}=${row.amountUsd}`).join(', ') || 'none'}; proposed deltas: ${read.proposed.transactionDeltas.length}; allocations: ${read.allocations.length}; residuals: ${read.residuals.length})`,
    );
    assert(read.enacted.cumulativeSnapshots.some((row) => amountEquals(row.amountUsd, '100000000.00')), 'enacted cumulative snapshot missing');
    assert(read.enacted.cumulativeSnapshots.some((row) => row.availabilityStart === '2026-10-01' && row.availabilityEnd === '2027-09-30'), 'availability period was not preserved in financial reads');
    assert(read.enacted.transactionDeltas.some((row) => row.factId === NEGATIVE_OBLIGATION && amountEquals(row.amountUsd, '-5000000.00')), 'negative obligation was not preserved');
    assert(read.enacted.transactionDeltas.some((row) => row.factId === RESCISSION_ALLOCATION && amountEquals(row.amountUsd, '-7000000.00')), 'rescission was not preserved as a negative authority delta');
    assert(read.enacted.totals.cumulativeSnapshotUsd === '100000000.00', 'cumulative snapshot total was mixed with deltas');
    assert(read.enacted.totals.transactionDeltaUsd === '-12000000.00', 'transaction deltas were not accumulated separately');
    assert(read.transferPairs.some((pair) => pair.transferGroupId === 'package6-transfer-pair' && pair.state === 'paired' && amountEquals(pair.outflow?.amountUsd ?? null, '-12000000.00') && amountEquals(pair.inflow?.amountUsd ?? null, '12000000.00')), 'transfer source/destination pair was not readable atomically');
    assert(read.residuals.some((row) => row.factId === 'residual:package6:pe-a:fy2027' && amountEquals(row.amountUsd, '15000000.00')), 'explicit unallocated residual was hidden');
    assert(read.residuals.some((row) => row.factId === 'residual:package6:pe-a:fy2027' && row.authorityState === 'enacted'), 'residual authority state followed mutable measure status instead of certification status');
    assert(read.coverage.state === 'partial', 'residual did not make attribution coverage partial');

    await prisma.federalFundingMeasure.update({ where: { id: ENACTED_MEASURE }, data: { status: 'enacted' } });
    const dryRun = await runFundingExecutionCertificationWorker(store, { commit: false, limit: 50, env: { FUNDING_EXECUTION_PUBLICATION_ENABLED: 'true' } });
    assert(dryRun.mode === 'DRY_RUN' && dryRun.publishable >= 1 && dryRun.published === 0 && !dryRun.checkpointAdvanced, 'worker dry-run gate or eligible account-level path failed');

    const legacy = await prisma.federalFundingAllocation.findUniqueOrThrow({ where: { id: LEGACY_ALLOCATION }, select: { amountBasis: true, sourceEventId: true } });
    assert(legacy.amountBasis === 'legacy_unspecified' && legacy.sourceEventId === null, 'legacy allocation compatibility failed');
    let legacyRejected = false;
    try {
      await store.certifyAndPublish({ certificationKey: 'package6:unsafe-legacy', revision: 1, measureId: ENACTED_MEASURE, sourceEvents: [], allocationIds: [LEGACY_ALLOCATION], residuals: [], scope: {} });
    } catch {
      legacyRejected = true;
    }
    assert(legacyRejected, 'legacy allocation entered certified publication without P6 source semantics');

    let positiveRescissionRejectedAtDatabase = false;
    try {
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO federal_funding_source_event (
          id, source_event_key, source_system, source_record_id, event_type, measure_id,
          source_document_id, source_observed_at, amount_basis, as_of_date, source_amount_usd,
          content_sha256, raw_jsonb
        ) VALUES (
          '60000000-0000-4000-8000-000000000401'::uuid,
          'package6:invalid-positive-rescission', 'package6_qualification', 'INVALID-POSITIVE-RESCISSION',
          'alternative_funding_rescission', ${RESCISSION_MEASURE}::uuid, ${DOC}::uuid,
          ${new Date(OBSERVED_AT)}, 'transaction_delta', '2027-09-21'::date, 1.00,
          ${hash('package6:invalid-positive-rescission')}, '{}'::jsonb
        )
      `);
    } catch {
      positiveRescissionRejectedAtDatabase = true;
    }
    assert(positiveRescissionRejectedAtDatabase, 'database accepted a positive rescission source event');

    let immutable = false;
    try {
      await prisma.$executeRawUnsafe(`UPDATE federal_funding_source_event SET event_type = 'mutated' WHERE id = '${enactedIds[0]!.id}'`);
    } catch {
      immutable = true;
    }
    assert(immutable, 'source-event history was mutable');

    console.log(JSON.stringify({
      ok: true,
      package: 6,
      fixtures: {
        proposedEnactedSeparated: true,
        transferPair: 'balanced',
        cumulativeSnapshotUsd: read.enacted.totals.cumulativeSnapshotUsd,
        transactionDeltaUsd: read.enacted.totals.transactionDeltaUsd,
        negativeObligationUsd: '-5000000.00',
        rescissionUsd: '-7000000.00',
        unallocatedResidualUsd: '15000000.00',
        legacyCompatibility: true,
        availabilityPeriodPreserved: true,
        certifiedStatusSnapshotPreserved: true,
      },
      counts: {
        sourceEvents: await prisma.federalFundingSourceEvent.count({ where: { sourceSystem: 'package6_qualification' } }),
        certifications: certifications.length,
        publications: await prisma.federalFundingPublication.count({ where: { certification: { certificationKey: { startsWith: 'package6:' } } } }),
        residuals: await prisma.federalFundingReconciliationResidual.count({ where: { certification: { certificationKey: { startsWith: 'package6:' } } } }),
      },
      worker: dryRun,
      boundaries: {
        canonicalAnnualPromotionAllowed: false,
        workerCommitEnabled: false,
        accountTotalsCombinedWithTransactions: false,
        immutableHistory: immutable,
        positiveRescissionRejectedAtDatabase,
      },
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  if (error instanceof Package6QualificationSafetyError) console.error(error.message);
  else {
    const detail = error instanceof Error
      ? error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[DATABASE_URL_WITHHELD]')
      : 'Unknown qualification error';
    console.error(`Package 6 qualification failed: ${detail}`);
  }
  process.exit(1);
});

/**
 * Real Phase 10B-3 cross-layer proof. The starting line is a corpus already
 * durably ready for reconciliation: the outbox call-site itself remains a
 * worker unit-test concern. From `PrismaReadinessCorpusLoaderV1` onward every
 * production materialization adapter/class is real; only one shared Prisma
 * SQL boundary is table-routed in memory, while artifact bytes are real
 * temporary files.
 *
 * The former producer/readiness boundary mismatch is fixed by separating the
 * governed `cycleId` from the content-addressed `bundleId`; both families now
 * traverse the real Phase 7 eligibility and deterministic planning boundary.
 *
 * Phase 10B-4 restart extension narrows its starting point to the parser
 * handoff's composed extraction bytes: HTTP discovery/archive and the parser
 * engine itself are intentionally excluded because their real bridge behavior
 * is covered by observation-ingestion-bridge.spec.ts. Here those exact composed
 * bytes cross the new immutable S3 store boundary, all local state is discarded,
 * and a brand-new reader instance reloads them before the real readiness chain.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DefenseBudgetExtractionArtifactV1 } from './contracts/extraction-artifact-v1.js';
import type { BudgetCycleManifestV1 } from './contracts/budget-cycle-manifest-v1.js';
import {
  buildRdteCycleArtifacts,
  buildRdteCycleArtifactsFromPersistedArtifacts,
  finalizeRdteCycle,
} from './rdte/cycle/rdte-cycle-pipeline-v1.js';
import { rdteCycleVerificationRefV1Schema } from './rdte/rdte-cycle-bundle-v1.js';
import {
  reconstructR2aProjectFundingValuesFromArtifact,
  reconstructR2PeTotalCellsFromArtifact,
} from './rdte/cycle/rdte-artifact-reconciliation-input-v1.js';
import { goldenCloseoutDocuments } from './rdte/cycle/rdte-golden-closeout-v1.js';
import type { CycleFamilyReadinessIdentityV1 } from './promotion/readiness/cycle-family-readiness-v1.js';
import { PrismaReadinessCorpusLoaderV1 } from './promotion/readiness/prisma-readiness-corpus-loader-v1.js';
import { PrismaFamilyReconciliationCertificationV1 } from './promotion/readiness/prisma-family-reconciliation-certification-v1.js';
import { MaterializingFamilyReconciliationCertificationV1 } from './promotion/readiness/materializing-family-reconciliation-certification-v1.js';
import { PrismaCycleManifestRegistryV1 } from './promotion/readiness/prisma-cycle-manifest-registry-v1.js';
import { PrismaMaterializationArtifactSourceV1 } from './promotion/readiness/prisma-materialization-artifact-source-v1.js';
import { PrismaProjectionPlanRepositoryV1 } from './projection-plan/projection-plan-repository-prisma-v1.js';
import { evaluateAndAdvanceCycleFamilyReadinessV1 } from './promotion/readiness/cycle-family-readiness-orchestrator-v1.js';
import { PrismaPromotionEligibilityReadRepositoryV1 } from './promotion/promotion-eligibility-read-repository-prisma-v1.js';
import { PrismaPromotionAuditSinkV1 } from './promotion/promotion-eligibility-service-v1.js';
import { PrismaPromotionPlanInputLoaderV1 } from './promotion/readiness/prisma-promotion-plan-input-loader-v1.js';
import { PrismaPromotionPlanPersistenceV1 } from './promotion/readiness/prisma-promotion-plan-persistence-v1.js';
import { S3ExtractionArtifactStore } from './parser-router/extraction-artifact-store.js';
import type { ParserArtifactObjectStoreV1 } from './parser-router/parser-artifact-store.js';
import type { S3ByteReaderPortV1 } from './promotion/readiness/prisma-materialization-artifact-source-v1.js';

const SHA = (character: string) => character.repeat(64);
const CYCLE = 'cycle-fy2027-authorization';

type Row = Record<string, any>;

class SharedReadinessPrisma {
  readonly queries: Array<{ query: string; values: unknown[] }> = [];
  readonly manifests: Row[] = [];
  readonly projectionPlans: Row[] = [];
  readonly eligibilityDocuments = new Map<string, unknown>();
  readonly promotionPlans = new Map<string, { planId: string; planHash: string }>();
  candidates: Row[] = [];
  verificationRuns: Row[] = [];
  expectedSourceFamily = 'pb_o1';
  sourceDocumentId = 'source-corpus';
  sourceSha256 = SHA('a');
  readonly defenseBudgetPromotionAudit = { create: async () => ({}) };

  async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
    this.queries.push({ query, values });
    if (query.includes('FROM "defense_budget_cycle_manifest_registry"')) return this.manifests as T;
    if (query.includes('FROM "defense_budget_cycle"')) return [{ id: CYCLE }] as T;
    if (query.includes('FROM "defense_budget_expected_source"')) {
      return [
        {
          id: 'expected-1',
          sourceFamily: this.expectedSourceFamily,
          expectedState: 'published',
          optional: false,
        },
      ] as T;
    }
    if (query.includes('FROM "defense_budget_source_observation"')) {
      return [
        {
          expectedSourceId: 'expected-1',
          observationState: 'ingested',
          sourceDocumentId: this.sourceDocumentId,
          contentSha256: this.sourceSha256,
          lastSeenAt: new Date('2027-06-01T00:00:00Z'),
        },
      ] as T;
    }
    if (query.includes('FROM "source_document"'))
      return [{ id: this.sourceDocumentId, sha256: this.sourceSha256 }] as T;
    if (query.includes('FROM "document_parse_job"'))
      return [{ inputSha256: this.sourceSha256, status: 'succeeded' }] as T;
    if (query.includes('FROM "budget_extraction_candidate_v1"')) {
      if (query.includes('DISTINCT ON')) {
        const requested = new Set(values.slice(1).map(String));
        return this.candidates.filter((row) => requested.has(String(row.manifestDocumentKey))) as T;
      }
      if (query.includes('source_document_id')) {
        return this.candidates.filter((row) => row.sourceDocumentId === values[0]) as T;
      }
      return this.candidates as T;
    }
    if (query.includes('FROM "budget_verification_run_v1"')) {
      const id = String(values[0]);
      const rows = this.verificationRuns.filter((row) => row.id === id || row.candidateId === id);
      if (query.includes('result_snapshot_jsonb'))
        return rows.map((row) => ({ resultSnapshot: row.resultSnapshot })) as T;
      if (query.includes('AS "runId"')) return rows.map((row) => ({ runId: row.id })) as T;
      return rows as T;
    }
    if (query.includes('FROM "defense_budget_projection_plan"')) return this.projectionPlans as T;
    if (query.includes('FROM "defense_budget_promotion_eligibility"')) {
      const document = this.eligibilityDocuments.get(String(values[0]));
      return (document == null ? [] : [{ document }]) as T;
    }
    if (query.includes('FROM "defense_budget_promotion_plan"')) {
      const row = this.promotionPlans.get(String(values[0]));
      if (row == null) return [] as T;
      return (query.includes('AS "planId"') ? [row] : [{ planHash: row.planHash }]) as T;
    }
    if (
      query.includes('FROM "defense_budget_active_snapshot"') ||
      query.includes('FROM "defense_budget_manual_override"') ||
      query.includes('FROM "phase6_cycle_certification"')
    )
      return [] as T;
    throw new Error(`unexpected query in shared readiness fake: ${query}`);
  }

  async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
    this.queries.push({ query, values });
    if (query.includes('INSERT INTO "defense_budget_cycle_manifest_registry"')) {
      this.manifests.push({
        cycleId: values[0],
        manifestContentSha256: values[1],
        fiscalYear: values[2],
        manifestDocument: JSON.parse(String(values[3])),
      });
      return 1;
    }
    if (query.includes('INSERT INTO "defense_budget_projection_plan"')) {
      this.projectionPlans.push({
        projectionPlanId: values[0],
        recordSchemaVersion: values[1],
        schemaVersion: values[2],
        family: values[3],
        cycleId: values[4],
        fiscalYear: values[5],
        contentSha256: values[6],
        producerVersion: values[7],
        certificationId: values[8],
        certificationSha256: values[9],
        artifactSetSha256: values[10],
        status: values[11],
        conflictCount: values[12],
        unsupportedCount: values[13],
        planDocument: JSON.parse(String(values[14])),
        planLocator: null,
      });
      return 1;
    }
    if (query.includes('INSERT INTO "defense_budget_promotion_eligibility"')) {
      this.eligibilityDocuments.set(String(values[1]), JSON.parse(String(values[9])));
      return 1;
    }
    if (query.includes('INSERT INTO "defense_budget_promotion_plan"')) {
      this.promotionPlans.set(String(values[0]), {
        planId: String(values[0]),
        planHash: String(values[1]),
      });
      return 1;
    }
    throw new Error(`unexpected execute in shared readiness fake: ${query}`);
  }
}

class FakeDurableS3 implements ParserArtifactObjectStoreV1 {
  readonly objects = new Map<string, { bytes: Uint8Array; versionId: string }>();
  private key(bucket: string, key: string) { return `${bucket}/${key}`; }
  async headObject(input: { bucket: string; key: string }) {
    const found = this.objects.get(this.key(input.bucket, input.key));
    return found ? { versionId: found.versionId } : null;
  }
  async getObject(input: { bucket: string; key: string; versionId?: string }) {
    return this.objects.get(this.key(input.bucket, input.key)) ?? null;
  }
  async putObject(input: { bucket: string; key: string; bytes: Uint8Array; contentType: string; ifNoneMatch?: '*' }) {
    const key = this.key(input.bucket, input.key);
    if (input.ifNoneMatch && this.objects.has(key)) throw Object.assign(new Error('precondition failed'), { name: 'PreconditionFailed' });
    const value = { bytes: Uint8Array.from(input.bytes), versionId: `version-${this.objects.size + 1}` };
    this.objects.set(key, value);
    return { versionId: value.versionId };
  }
}

async function persistComposedArtifact(
  store: S3ExtractionArtifactStore,
  artifact: DefenseBudgetExtractionArtifactV1,
): Promise<{ locator: string; sha256: string }> {
  // RDT&E's production persisted-artifact builder defines the byte identity
  // as pretty JSON plus a trailing newline; write those exact real bytes.
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const persisted = await store.putImmutable({ bytes });
  return { locator: persisted.locator, sha256: persisted.byteSha256 };
}

function restartedS3Reader(objects: FakeDurableS3): S3ByteReaderPortV1 {
  // A new store instance models Task B after Task A's container/local disk died.
  const restarted = new S3ExtractionArtifactStore('phase10-artifacts', 'phase10/parser-artifacts', objects);
  return { async readObject(locator: string) {
    const url = new URL(locator);
    const object = await objects.getObject({ bucket: url.hostname, key: url.pathname.slice(1), versionId: url.searchParams.get('versionId') ?? undefined });
    if (!object) throw new Error(`materialization artifact object missing: ${locator}`);
    return Buffer.from(object.bytes);
  }};
}

function omArtifact(key: string, exhibit: string): DefenseBudgetExtractionArtifactV1 {
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: `artifact-${key}`,
    contentSha256: SHA('b'),
    source: {
      manifestDocumentKey: key,
      sourcePdfSha256: SHA('a'),
      sourceLocator: 'fixture://o1.pdf',
      fiscalYear: 2027,
      family: 'om',
      exhibit,
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb_fy2027',
      documentType: 'om_exhibit',
    },
    parserRuns: [],
    evidence: [],
    sourceFacts: [],
    assertions: [
      {
        assertionId: `om-line-${key}`,
        assertionKind: 'om_line',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        identity: { lineKind: 'OM_SAG', code: 'SAG1', account: 'O&M, ARMY', component: 'ARMY' },
        title: 'Operations and Maintenance Support',
      },
      {
        assertionId: `om-funding-${key}`,
        assertionKind: 'funding',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        identity: { lineKind: 'OM_SAG', code: 'SAG1', account: 'O&M, ARMY', component: 'ARMY' },
        fiscalYear: 2027,
        field: 'request',
        money: { originalValue: '30', originalUnit: 'millions', valueMillions: '30' },
      },
    ],
    warnings: [],
    omissions: [],
    summary: {
      sourceFactCount: 0,
      requiredSourceFactCount: 0,
      coveredRequiredSourceFactCount: 0,
      omittedRequiredSourceFactCount: 0,
      uncoveredRequiredSourceFactCount: 0,
      assertionCount: 2,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: {},
      countsByOmissionReason: {},
      completenessStatus: 'complete',
    },
  } as unknown as DefenseBudgetExtractionArtifactV1;
}

function omManifest(): BudgetCycleManifestV1 {
  return {
    schemaVersion: 'defense_budget_cycle_manifest_v1',
    cycleId: CYCLE,
    fiscalYear: 2027,
    domain: 'defense',
    documents: [
      {
        documentKey: 'o1',
        required: true,
        title: 'O-1',
        sourceLocator: 'fixture://o1.pdf',
        family: 'om',
        exhibit: 'O-1',
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb_fy2027',
        documentType: 'om_exhibit',
        parserPolicy: 'native_structured',
        requiredDataCategories: ['identity', 'funding'],
        requiredFundingFields: ['request'],
        expectedLineKinds: ['OM_SAG'],
        allowEmpty: false,
      },
      {
        documentKey: 'op5',
        required: true,
        title: 'OP-5',
        sourceLocator: 'fixture://op5.pdf',
        family: 'om',
        exhibit: 'OP-5',
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb_fy2027',
        documentType: 'om_exhibit',
        parserPolicy: 'native_structured',
        requiredDataCategories: ['identity', 'funding'],
        requiredFundingFields: ['request'],
        expectedLineKinds: ['OM_SAG'],
        allowEmpty: false,
      },
    ],
    metadata: { omRequiredIdentityKeys: ['OM_SAG:ARMY:O&M, ARMY:SAG1'] },
  } as unknown as BudgetCycleManifestV1;
}

function realMaterializationChain(prisma: SharedReadinessPrisma, s3Reader?: S3ByteReaderPortV1) {
  return {
    corpusLoader: new PrismaReadinessCorpusLoaderV1(prisma),
    reconciliationCertification: new MaterializingFamilyReconciliationCertificationV1(
      new PrismaFamilyReconciliationCertificationV1(prisma),
      new PrismaCycleManifestRegistryV1(prisma),
      new PrismaMaterializationArtifactSourceV1(prisma, s3Reader),
      new PrismaProjectionPlanRepositoryV1(prisma),
      'real-integration@1',
    ),
    eligibilityRepository: new PrismaPromotionEligibilityReadRepositoryV1(prisma),
    eligibilityAudit: new PrismaPromotionAuditSinkV1(prisma.defenseBudgetPromotionAudit),
    planInputs: new PrismaPromotionPlanInputLoaderV1(prisma, 'defense_budget', 'test'),
    planPersistence: new PrismaPromotionPlanPersistenceV1(prisma),
    now: () => new Date('2027-06-03T00:00:00Z'),
  };
}

function seedCandidate(
  prisma: SharedReadinessPrisma,
  input: {
    key: string;
    artifact: DefenseBudgetExtractionArtifactV1;
    locator: string;
    byteSha256: string;
    manifestSha256: string;
    family: 'rdte' | 'om';
  },
) {
  const candidateId = `candidate-${input.key}`;
  const runId = `run-${input.key}`;
  prisma.candidates.push({
    manifestDocumentKey: input.key,
    extractionArtifactId: input.artifact.artifactId,
    extractionArtifactSha256: input.byteSha256,
    extractionArtifactLocator: input.locator,
    sourceDocumentId:
      input.artifact.source.sourceDocumentId ??
      (input.key === 'o1' ? prisma.sourceDocumentId : `source-${input.key}`),
    sourceSha256: input.artifact.source.sourcePdfSha256,
    candidateId,
    id: candidateId,
    manifestContentSha256: input.manifestSha256,
    policySha256: SHA('c'),
    currentRunId: runId,
    runDecision: 'PASS',
    runStatus: 'VERIFICATION_PASSED',
    candidateStatus: 'VERIFICATION_PASSED',
    status: 'VERIFICATION_PASSED',
    terminalVerificationRunId: runId,
    family: input.family,
    extractionMethod: 'deterministic_pdfplumber',
    artifactSha256: input.byteSha256,
    verificationPolicySha256: SHA('c'),
    manifestSha256: input.manifestSha256,
    reviewDecisionId: null,
    reviewerActorId: null,
    acceptedAssertionIds: input.artifact.assertions.map((value) => value.assertionId),
    sourceProfileSha256: null,
    sourceProfileHashCount: 0,
  });
  prisma.verificationRuns.push({
    id: runId,
    candidateId,
    decision: 'PASS',
    status: 'VERIFICATION_PASSED',
    completedAt: '2027-06-02T00:00:00Z',
    resultSnapshot: {
      acceptedAssertionIds: input.artifact.assertions.map((value) => value.assertionId),
      rejectedAssertionIds: [],
    },
  });
}

describe('real ingestion readiness integration', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-ingestion-readiness-'));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('RDT&E reaches awaiting_authorization through the real persisted projection plan', async () => {
    const prisma = new SharedReadinessPrisma();
    const remote = new FakeDurableS3();
    const writer = new S3ExtractionArtifactStore('phase10-artifacts', 'phase10/parser-artifacts', remote);
    prisma.expectedSourceFamily = 'pb_r1';
    const identity: CycleFamilyReadinessIdentityV1 = {
      fiscalYear: 2027,
      authorityTrack: 'authorization',
      familyGroup: 'rdte',
    };
    const manifest: BudgetCycleManifestV1 = {
      schemaVersion: 'defense_budget_cycle_manifest_v1',
      cycleId: CYCLE,
      fiscalYear: 2027,
      domain: 'defense',
      documents: goldenCloseoutDocuments().map((value) => value.document),
      metadata: { rdteRequiredIdentityKeys: [] },
    } as unknown as BudgetCycleManifestV1;
    const registry = new PrismaCycleManifestRegistryV1(prisma);
    const registered = await registry.register(CYCLE, manifest);
    const built = buildRdteCycleArtifacts({
      fiscalYear: 2027,
      manifestContentSha256: registered.manifestContentSha256,
      manifestDocuments: manifest.documents,
      documents: goldenCloseoutDocuments(),
    });
    for (const item of built.artifacts) {
      const artifact = {
        ...item.artifact,
        assertions: item.artifact.assertions.map((assertion) =>
          assertion.assertionKind === 'funding'
            ? {
                ...assertion,
                metadata: {
                  ...(assertion.metadata ?? {}),
                  fiscalYear: assertion.fiscalYear ?? 2027,
                },
                fiscalYear: assertion.fiscalYear ?? 2027,
              }
            : assertion.assertionKind === 'document_fact' && assertion.fieldName.startsWith('r2_')
              ? {
                  ...assertion,
                  value: {
                    ...(assertion.value as Record<string, unknown>),
                    fiscalYear: (assertion.value as Record<string, unknown>).fiscalYear ?? 2027,
                  },
                }
              : assertion,
        ),
      } as DefenseBudgetExtractionArtifactV1;
      const file = await persistComposedArtifact(writer, artifact);
      seedCandidate(prisma, {
        key: item.documentKey,
        artifact,
        locator: file.locator,
        byteSha256: file.sha256,
        manifestSha256: registered.manifestContentSha256,
        family: 'rdte',
      });
    }
    prisma.sourceDocumentId = prisma.candidates[0]!.sourceDocumentId;
    prisma.sourceSha256 = prisma.candidates[0]!.sourceSha256;
    const restartedEmptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase10b4-restarted-task-'));
    expect(fs.readdirSync(restartedEmptyDir)).toEqual([]);
    const s3Reader = restartedS3Reader(remote);
    const artifactSource = new PrismaMaterializationArtifactSourceV1(prisma, s3Reader);
    const refs = await artifactSource.loadCandidateRefs({
      cycleId: CYCLE,
      manifestDocumentKeys: manifest.documents.map((value) => value.documentKey),
    });
    const persistedDocuments = [] as Array<{
      document: (typeof manifest.documents)[number];
      artifact: DefenseBudgetExtractionArtifactV1;
    }>;
    const verifications = [] as Array<ReturnType<typeof rdteCycleVerificationRefV1Schema.parse>>;
    for (const document of manifest.documents) {
      const ref = refs.get(document.documentKey)!;
      const artifact = await artifactSource.loadVerifiedArtifact(ref);
      persistedDocuments.push({ document, artifact });
      verifications.push(
        rdteCycleVerificationRefV1Schema.parse({
          manifestDocumentKey: ref.manifestDocumentKey,
          manifestContentSha256: ref.manifestContentSha256,
          artifactId: artifact.artifactId,
          artifactContentSha256: artifact.contentSha256,
          artifactByteSha256: ref.extractionArtifactSha256,
          candidateId: ref.candidateId,
          verificationRunId: ref.verificationRunId,
          policySha256: ref.policySha256,
          sourceDocumentId: ref.sourceDocumentId,
          sourcePdfSha256: ref.sourceSha256,
          phase2Decision: ref.decision,
          status: ref.status,
          acceptedAssertionIds: ref.acceptedAssertionIds,
          rejectedAssertionIds: ref.rejectedAssertionIds ?? [],
          verificationCandidateId: ref.candidateId,
          decision: ref.status,
          decisionId: ref.verificationRunId,
        }),
      );
    }
    const diagnostic = finalizeRdteCycle({
      governedCycleId: CYCLE,
      cycleIdIdentity: {
        family: 'rdte',
        fiscalYear: manifest.fiscalYear,
        manifestContentSha256: registered.manifestContentSha256,
      },
      build: buildRdteCycleArtifactsFromPersistedArtifacts({
        fiscalYear: 2027,
        manifestContentSha256: registered.manifestContentSha256,
        manifestDocuments: manifest.documents,
        documents: persistedDocuments,
      }),
      verifications,
    });
    if (diagnostic.certification !== 'CERTIFIED_RDTE_READY_FOR_PROJECTION')
      throw new Error(
        `RDT&E findings: ${JSON.stringify(diagnostic.bundle.blockingFindings)} totals=${JSON.stringify(persistedDocuments.flatMap((value) => reconstructR2PeTotalCellsFromArtifact(value.artifact)))} values=${JSON.stringify(persistedDocuments.flatMap((value) => reconstructR2aProjectFundingValuesFromArtifact(value.artifact)))}`,
      );
    fs.rmSync(restartedEmptyDir, { recursive: true, force: true });
    const chain = realMaterializationChain(prisma, s3Reader);
    const result = await evaluateAndAdvanceCycleFamilyReadinessV1(identity, chain, {
      mode: 'new_cycle',
      environment: 'test',
    });
    expect(result.outcome).toBe('awaiting_authorization');
    expect(prisma.projectionPlans[0]?.cycleId).toBe(CYCLE);
    expect(prisma.projectionPlans[0]?.family).toBe('rdte');
  });

  it('O&M reaches awaiting_authorization through the real persisted projection plan', async () => {
    const prisma = new SharedReadinessPrisma();
    const remote = new FakeDurableS3();
    const writer = new S3ExtractionArtifactStore('phase10-artifacts', 'phase10/parser-artifacts', remote);
    const identity: CycleFamilyReadinessIdentityV1 = {
      fiscalYear: 2027,
      authorityTrack: 'authorization',
      familyGroup: 'om',
    };
    const registry = new PrismaCycleManifestRegistryV1(prisma);
    const registered = await registry.register(CYCLE, omManifest());
    for (const [key, exhibit] of [
      ['o1', 'O-1'],
      ['op5', 'OP-5'],
    ] as const) {
      const artifact = omArtifact(key, exhibit);
      const file = await persistComposedArtifact(writer, artifact);
      seedCandidate(prisma, {
        key,
        artifact,
        locator: file.locator,
        byteSha256: file.sha256,
        manifestSha256: registered.manifestContentSha256,
        family: 'om',
      });
    }
    const restartedEmptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase10b4-restarted-task-'));
    expect(fs.readdirSync(restartedEmptyDir)).toEqual([]);
    const chain = realMaterializationChain(prisma, restartedS3Reader(remote));
    fs.rmSync(restartedEmptyDir, { recursive: true, force: true });
    const result = await evaluateAndAdvanceCycleFamilyReadinessV1(identity, chain, {
      mode: 'new_cycle',
      environment: 'test',
    });
    expect(result.outcome).toBe('awaiting_authorization');
    expect(prisma.projectionPlans[0]?.cycleId).toBe(CYCLE);
    expect(prisma.projectionPlans[0]?.family).toBe('om');
  });
});

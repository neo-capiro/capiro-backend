/**
 * Real PostgreSQL Package E ownership/recovery proof. Run only against an
 * explicitly disposable `ingestion_manifest_test_*` database (or schema) after
 * migrations.
 */
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { sealIngestionManifestV1, type IngestionManifestV1 } from './ingestion-manifest-contract-v1.js';
import {
  createIngestionManifestRepositoryV1,
  IngestionManifestLeaseLostErrorV1,
} from './ingestion-manifest-repository-v1.js';
import { createIngestionOutboxDrainRepositoryPrismaV1 } from '../ingestion-outbox-drain-repository-prisma-v1.js';
import { RunIngestionManifestV1 } from './run-ingestion-manifest-v1.js';
import { PrismaBudgetVerificationRepositoryV1 } from '../verification/persistence/prisma-budget-verification.repository.js';
import { computeCandidateId, computeRunId } from '../verification/persistence/verification-persistence-mappers.js';
import type {
  CandidateIdentityV1,
  PersistCompletedVerificationInputV1,
} from '../verification/persistence/verification-repository.js';

const integration = process.env.INGESTION_MANIFEST_INTEGRATION === '1' ? describe : describe.skip;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const fixedNow = '2026-09-20T12:00:00.000Z';

integration('Package E manifest controller: real PostgreSQL', () => {
  jest.setTimeout(30_000);

  let prisma: PrismaClient;
  let fixtureCycleId: string;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    const databaseName = url.pathname.replace(/^\//, '');
    const schemaName = url.searchParams.get('schema') ?? '';
    if (!/^ingestion_manifest_test_[a-z0-9_]+$/.test(databaseName)
      && !/^ingestion_manifest_test_[a-z0-9_]+$/.test(schemaName)) {
      throw new Error('integration requires an explicitly disposable ingestion_manifest_test_* DATABASE_URL database or schema');
    }
    prisma = new PrismaClient();
    await prisma.$connect();
    await prisma.$queryRawUnsafe('SELECT "id" FROM "defense_budget_ingestion_manifest_v1" LIMIT 0');
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE
         "defense_budget_ingestion_manifest_item_v1",
         "defense_budget_ingestion_manifest_v1",
         "defense_budget_ingestion_outbox",
         "defense_budget_source_observation",
         "defense_budget_expected_source",
         "source_document",
         "defense_budget_cycle"
       CASCADE`,
    );
    fixtureCycleId = randomUUID();
    await insert('defense_budget_cycle', {
      id: fixtureCycleId, fiscal_year: 2027, authority_track: 'request', status: 'active',
      template_version: 'fixture-v1', bootstrap_origin: 'operator', dedup_key: sha(fixtureCycleId),
    });
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  async function insert(table: string, data: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(data).map(key => `"${key}"`).join(',');
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`,
      JSON.stringify(data),
    );
  }

  interface FixtureMember {
    memberId: string;
    cycleId: string;
    sourceDocumentId: string;
    observationId: string;
    outboxRowId: string;
    sourceSha256: string;
    byteSize: number;
    officialLocator: string;
    archiveKey: string;
    archiveVersionId: string;
    outboxState: 'pending' | 'failed';
    outboxAttempts: number;
    updatedAt: string;
  }

  async function fixtureMember(
    label: string,
    createdAt = fixedNow,
    outboxState: 'pending' | 'failed' = 'pending',
    outboxAttempts = 0,
  ): Promise<FixtureMember> {
    const cycleId = fixtureCycleId;
    const sourceDocumentId = randomUUID();
    const expectedSourceId = randomUUID();
    const observationId = randomUUID();
    const outboxRowId = randomUUID();
    const memberId = randomUUID();
    const bytes = Buffer.from(`%PDF-1.7\nPackage E disposable fixture ${label}`);
    const sourceSha256 = sha(bytes);
    const officialLocator = `https://example.invalid/package-e/${sourceDocumentId}.pdf`;
    const archiveKey = `package-e/${sourceSha256}.pdf`;
    const archiveVersionId = `version-${sourceDocumentId}`;
    await insert('source_document', {
      id: sourceDocumentId, source_key: `package-e:${sourceDocumentId}`, fiscal_year: 2027,
      budget_cycle: 'pb', component: 'ARMY', document_type: 'r2', title: `Package E ${label}`,
      source_url: officialLocator, sha256: sourceSha256, byte_size: bytes.length,
      extraction_method: 'deterministic_pdf', archive_bucket: 'package-e-disposable-archive',
      archive_s3_key: archiveKey, archive_version_id: archiveVersionId, archived_at: fixedNow,
    });
    await insert('defense_budget_expected_source', {
      id: expectedSourceId, cycle_id: cycleId, fiscal_year: 2027, authority_track: 'request',
      stage: 'president_budget_request', source_family: 'pb_r2', component: 'ARMY', adapter_id: 'package-e-fixture',
      label: `Package E ${label}`, template_version: 'fixture-v1', expected_from: fixedNow,
      expected_to: fixedNow, expected_state: 'published', dedup_key: sha(expectedSourceId),
    });
    await insert('defense_budget_source_observation', {
      id: observationId, expected_source_id: expectedSourceId, cycle_id: cycleId,
      adapter_id: 'package-e-fixture', discovered_url: officialLocator, content_sha256: sourceSha256,
      byte_size: bytes.length, observation_state: 'ingested', revision_kind: 'first_discovery',
      classified_fiscal_year: 2027, classified_authority_track: 'request',
      classified_stage: 'president_budget_request', classified_source_family: 'pb_r2',
      classification_confidence: 1, source_document_id: sourceDocumentId, dedup_key: sha(observationId),
    });
    await insert('defense_budget_ingestion_outbox', {
      id: outboxRowId, observation_id: observationId, observation_state: 'ingested', cycle_id: cycleId,
      job_kind: 'governed_source_ingestion', state: outboxState, attempts: outboxAttempts, available_at: createdAt,
      dedup_key: sha(outboxRowId), created_at: createdAt, updated_at: createdAt,
    });
    const rows = await prisma.$queryRawUnsafe<{ updated_at: Date }[]>(
      'SELECT "updated_at" FROM "defense_budget_ingestion_outbox" WHERE "id"=$1::uuid', outboxRowId,
    );
    return {
      memberId, cycleId, sourceDocumentId, observationId, outboxRowId, sourceSha256,
      byteSize: bytes.length, officialLocator, archiveKey, archiveVersionId,
      outboxState, outboxAttempts,
      updatedAt: rows[0]!.updated_at.toISOString(),
    };
  }

  function manifest(
    members: FixtureMember[],
    operationId = randomUUID(),
    timeoutSeconds = 120,
  ): IngestionManifestV1 {
    return sealIngestionManifestV1({
      schemaVersion: 'defense_budget_ingestion_manifest_v1', operationId,
      owner: 'package-e-integration', environment: 'capiro-dev',
      runtime: {
        releaseRevision: '1'.repeat(40), apiImageDigest: digest('1'), drainImageDigest: digest('2'),
        runtimeConfigReference: 'evidence/package-e/runtime-config.json', runtimeConfigSha256: '3'.repeat(64),
        taskDefinitionArn: 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-defense-budget-ingestion-drain:26',
        taskDefinitionRevision: 26, containerName: 'ingestion-drain',
        command: ['run-defense-budget-ingestion-manifest-v1'],
      },
      members: members.map((member, index) => ({
        memberId: member.memberId, ordinal: index + 1, documentKey: `fixture-${member.sourceDocumentId}`,
        component: 'ARMY', agency: 'Department of the Army', fiscalYear: 2027,
        authorityTrack: 'request', lifecycleStage: 'president_budget_request', sourceFamily: 'pb_r2',
        exhibit: 'R-2', volume: `fixture-${index + 1}`,
        source: { officialLocator: member.officialLocator, sourceVersion: member.archiveVersionId, sha256: member.sourceSha256, byteSize: member.byteSize },
        archive: { bucket: 'package-e-disposable-archive', objectKey: member.archiveKey, versionId: member.archiveVersionId, sha256: member.sourceSha256, byteSize: member.byteSize },
        lifecycle: {
          cycleId: member.cycleId, sourceDocumentId: member.sourceDocumentId, observationId: member.observationId,
          outboxRowId: member.outboxRowId, jobKind: 'governed_source_ingestion',
          expectedObservationState: 'ingested', expectedOutboxState: member.outboxState,
          expectedOutboxAttempts: member.outboxAttempts,
          expectedOutboxUpdatedAt: member.updatedAt, expectedCandidateCount: 0,
          expectedActiveApprovalCount: 0, expectedCorrectionCount: 0, intendedOperation: 'drain_existing_outbox',
        },
        qualification: {
          status: 'qualified', formatProfile: 'package-e-disposable-r2',
          evidenceReference: `evidence/package-e/${member.sourceDocumentId}.json`,
          evidenceSha256: sha(`qualification:${member.sourceDocumentId}`), qualifiedDrainImageDigest: digest('2'),
        },
        timeoutSeconds, retry: { classification: 'transient_only', maxAttempts: 3, initialBackoffSeconds: 1 },
        protection: {
          baselineEvidenceReference: `evidence/package-e/${member.sourceDocumentId}-baseline.json`,
          expectedApprovalWrites: 0, expectedCorrectionWrites: 0, expectedCanonicalWrites: 0,
        },
      })),
      exclusions: [{
        exclusionId: randomUUID(), documentKey: `excluded-af-${operationId}`, component: 'AF',
        agency: 'Department of the Air Force', officialLocator: 'https://www.af.mil/package-e-excluded.pdf',
        sourceVersion: 'FY2027-RDTE-Volume-I', sourceSha256: sha(`excluded:${operationId}`), byteSize: 9504933,
        reasonCode: 'qualification_failed', reason: 'Isolated duplicate evidenceId failure; production remains excluded.',
        evidenceReference: 'evidence/package-e/air-force-qualification-failure.json', permittedEffects: 'none',
      }],
      limits: {
        maxDocuments: 5, activeWorkers: 1, maxAttemptsPerDocument: 3,
        maxElapsedSeconds: 3600, defaultDocumentTimeoutSeconds: timeoutSeconds,
        resourceShape: { cpuUnits: 4096, memoryMiB: 8192, ephemeralStorageGiB: 20, cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
        costCeiling: { currency: 'USD', maximumAmount: '25.00', enforcement: 'operator_and_elapsed_limits' },
      },
      readiness: { policy: 'deferred', expectedOutcome: 'not_performed' },
      permittedEffects: {
        database: {
          manifestLedgerWrites: true, outboxLeaseAndDispositionWrites: true, documentParseJobWrites: true,
          verificationEvidenceWrites: true, sourceRegistrationWrites: false, lifecycleObservationWrites: false,
          readinessWrites: false, approvalWrites: false, correctionWrites: false, canonicalWrites: false,
          outOfManifestEnqueueWrites: false,
        },
        storage: {
          pinnedArchiveReads: true, extractionArtifactWrites: true, rawArchiveWrites: false,
          objectDeletes: false, durablePresignedUrlWrites: false,
        },
      },
    });
  }

  function verification(identity: CandidateIdentityV1, decision: 'PASS' | 'REVIEW' = 'REVIEW'): PersistCompletedVerificationInputV1 {
    const checks = [{
      checkId: `check-${identity.extractionArtifactId}`, code: decision === 'PASS' ? 'fixture_pass' : 'fixture_review',
      ruleVersion: 'v1', outcome: decision === 'PASS' ? 'PASS' as const : 'FAIL' as const,
      required: true, blocking: decision !== 'PASS', riskPoints: decision === 'PASS' ? 0 : 50,
      message: 'Disposable persistence fixture', assertionIds: [], evidenceIds: ['fixture-evidence'], referenceArtifactIds: [],
    }];
    const discrepancies = decision === 'PASS' ? [] : [{
      discrepancyId: `discrepancy-${identity.extractionArtifactId}`, code: 'fixture_review', severity: 'review' as const,
      description: 'Disposable persistence fixture', assertionIds: [], evidenceIds: ['fixture-evidence'], referenceArtifactIds: [],
    }];
    const result = {
      ...identity, verifierVersion: 'defense_budget_verifier_v1' as const,
      policyVersion: 'defense_budget_verification_policy_v1' as const,
      candidateId: computeCandidateId(identity), verificationRunId: computeRunId(identity, '0'),
      sourcePdfSha256: identity.sourceSha256, decision,
      status: decision === 'PASS' ? 'VERIFICATION_PASSED' as const : 'NEEDS_REVIEW' as const,
      route: decision === 'PASS' ? 'none' as const : 'human_review' as const, riskScore: decision === 'PASS' ? 0 : 50,
      checks, discrepancies, acceptedAssertionIds: [], rejectedAssertionIds: [], referenceArtifactIds: [],
      startedAt: fixedNow, completedAt: fixedNow,
    };
    return {
      candidateIdentity: identity, result,
      proofBundle: {
        manifest: { locator: '/fixture-manifest.json', contentSha256: identity.manifestContentSha256, cycleId: identity.cycleId, fiscalYear: 2027, documentKey: identity.manifestDocumentKey },
        extractionArtifact: { locator: identity.extractionArtifactLocator, artifactId: identity.extractionArtifactId, contentSha256: identity.extractionArtifactSha256, byteSha256: sha('fixture-artifact-bytes'), schemaVersion: 'defense_budget_extraction_v1' },
        sourceDocument: { id: identity.sourceDocumentId, sourceKey: `package-e:${identity.sourceDocumentId}`, sourceSha256: identity.sourceSha256 },
        archive: { status: 'verified' }, parserRuns: [], resolvedReferenceArtifacts: [],
      },
      proofFindings: [], proofSnapshots: [{ proofKind: 'archive', status: 'verified', sourceDocumentId: identity.sourceDocumentId, evidenceJson: { fixture: true } }],
      checks, discrepancies, startedAt: fixedNow, completedAt: fixedNow,
    };
  }

  function identity(member: FixtureMember, suffix: string): CandidateIdentityV1 {
    return {
      cycleId: member.cycleId, sourceDocumentId: member.sourceDocumentId, sourceSha256: member.sourceSha256,
      manifestContentSha256: sha(`parser-manifest:${member.sourceDocumentId}:${suffix}`),
      manifestDocumentKey: member.sourceDocumentId, extractionArtifactId: `artifact-${suffix}`,
      extractionArtifactSha256: sha(`artifact:${suffix}`), extractionArtifactLocator: `s3://package-e-artifacts/${suffix}.json`,
      verifierVersion: 'defense_budget_verifier_v1', policyVersion: 'defense_budget_verification_policy_v1',
      policySha256: sha('policy-v1'),
    };
  }

  it('claims only manifest members even when an older unrelated pending row sorts first', async () => {
    const unrelated = await fixtureMember(`unlisted-${randomUUID()}`, '2026-09-19T00:00:00.000Z');
    const selected = await fixtureMember(`selected-${randomUUID()}`, fixedNow);
    const repo = createIngestionManifestRepositoryV1(prisma, { leaseMs: 5_000 });
    const plan = manifest([selected]);
    expect((await repo.register(plan)).outcome).toBe('registered');
    const claim = await repo.claimNext({ operationId: plan.operationId, leaseToken: randomUUID(), taskJobId: 'task:exact-selection' });
    expect(claim.item?.outboxRowId).toBe(selected.outboxRowId);
    const untouched = await prisma.defenseBudgetIngestionOutbox.findUniqueOrThrow({ where: { id: unrelated.outboxRowId } });
    expect(untouched).toMatchObject({ state: 'pending', attempts: 0, leasedBy: null, leasedUntil: null });
  });

  it('refuses an exact pending row while its existing backoff is not due', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const member = await fixtureMember(`future-${randomUUID()}`, future);
    const result = await createIngestionManifestRepositoryV1(prisma).register(manifest([member]));
    expect(result).toMatchObject({
      outcome: 'ineligible',
      issues: [{ memberId: member.memberId, code: 'OUTBOX_NOT_DUE' }],
    });
  });

  it('allows one owner for two simultaneous controllers and blocks an overlapping manifest', async () => {
    const member = await fixtureMember(`race-${randomUUID()}`);
    const plan = manifest([member]);
    const repo1 = createIngestionManifestRepositoryV1(prisma, { leaseMs: 5_000 });
    const repo2 = createIngestionManifestRepositoryV1(prisma, { leaseMs: 5_000 });
    expect((await repo1.register(plan)).outcome).toBe('registered');
    const [first, second] = await Promise.all([
      repo1.claimNext({ operationId: plan.operationId, leaseToken: randomUUID(), taskJobId: 'task:race-1' }),
      repo2.claimNext({ operationId: plan.operationId, leaseToken: randomUUID(), taskJobId: 'task:race-2' }),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(['busy', 'claimed']);
    const overlap = manifest([{ ...member, memberId: randomUUID() }], randomUUID());
    const conflict = await repo2.register(overlap);
    expect(conflict.outcome).toBe('conflict');
    expect(conflict.issues[0]?.code).toBe('ACTIVE_RESERVATION_CONFLICT');
  });

  it('renews both leases and refuses a second controller after the original lease window', async () => {
    const member = await fixtureMember(`heartbeat-${randomUUID()}`);
    const plan = manifest([member]);
    const repo = createIngestionManifestRepositoryV1(prisma, { leaseMs: 600 });
    await repo.register(plan);
    const context = { operationId: plan.operationId, itemId: member.memberId, leaseToken: randomUUID() };
    expect((await repo.claimNext({ operationId: plan.operationId, leaseToken: context.leaseToken, taskJobId: 'task:heartbeat' })).outcome).toBe('claimed');
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(await repo.heartbeat(context)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 350));
    expect((await repo.claimNext({ operationId: plan.operationId, leaseToken: randomUUID(), taskJobId: 'task:competitor' })).outcome).toBe('busy');
  });

  it('rolls back an item heartbeat and refuses failure disposition after outbox ownership is lost', async () => {
    const member = await fixtureMember(`split-lease-${randomUUID()}`);
    const plan = manifest([member]);
    const repo = createIngestionManifestRepositoryV1(prisma, { leaseMs: 5_000 });
    await repo.register(plan);
    const leaseToken = randomUUID();
    await repo.claimNext({
      operationId: plan.operationId, leaseToken, taskJobId: 'task:split-lease',
    });
    const before = (await repo.read(plan.operationId))!.items[0]!.leasedUntil;
    await prisma.defenseBudgetIngestionOutbox.update({
      where: { id: member.outboxRowId },
      data: { leasedBy: randomUUID() },
    });

    await expect(repo.heartbeat({
      operationId: plan.operationId, itemId: member.memberId, leaseToken,
    })).rejects.toBeInstanceOf(IngestionManifestLeaseLostErrorV1);
    expect((await repo.read(plan.operationId))!.items[0]!.leasedUntil).toBe(before);
    expect(await repo.recordTransientFailure({
      operationId: plan.operationId, itemId: member.memberId, leaseToken,
      errorClass: 'TRANSIENT_FIXTURE', detail: 'must not commit without outbox ownership', backoffMs: 0,
    })).toBe('lease_lost');
    expect((await repo.read(plan.operationId))!.items[0]!.status).toBe('running');
  });

  it('controller heartbeats retain ownership while a bridge call exceeds the initial lease', async () => {
    const member = await fixtureMember(`controller-heartbeat-${randomUUID()}`);
    const plan = manifest([member]);
    const repo = createIngestionManifestRepositoryV1(prisma, { leaseMs: 500 });
    const controller = new RunIngestionManifestV1({
      repository: repo,
      heartbeatMs: 100,
      bridge: {
        bridge: async observationId => {
          await new Promise(resolve => setTimeout(resolve, 1_200));
          return {
            status: 'blocked', observationId, sourceDocumentId: member.sourceDocumentId,
            reason: 'deterministic disposable rejection after a deliberately long bridge call',
            sourceDocumentBound: true, parserHandoffInvoked: false, parserHandoffError: null,
            verifierDecision: null, parserVerificationSucceeded: false,
            durableEvidencePersisted: false, ingestionSucceeded: false,
          };
        },
      },
    });
    const running = controller.run(plan, { taskJobId: 'task:slow-controller' });
    await new Promise(resolve => setTimeout(resolve, 800));
    const competitor = await repo.claimNext({
      operationId: plan.operationId, leaseToken: randomUUID(), taskJobId: 'task:slow-competitor',
    });
    expect(competitor.outcome).toBe('busy');
    const result = await running;
    expect(result).toMatchObject({ outcome: 'completed', summary: { quarantined: 1, uncertain: 0 } });
  });

  it('refuses verification persistence after the document deadline', async () => {
    const member = await fixtureMember(`deadline-${randomUUID()}`);
    const plan = manifest([member], randomUUID(), 1);
    const repo = createIngestionManifestRepositoryV1(prisma, { leaseMs: 5_000 });
    await repo.register(plan);
    const context = { operationId: plan.operationId, itemId: member.memberId, leaseToken: randomUUID() };
    await repo.claimNext({
      operationId: plan.operationId, leaseToken: context.leaseToken, taskJobId: 'task:deadline',
    });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const candidateIdentity = identity(member, 'after-deadline');

    await expect(new PrismaBudgetVerificationRepositoryV1(
      prisma, repo.persistenceFence(context),
    ).persistCompletedVerification(verification(candidateIdentity))).rejects.toBeInstanceOf(
      IngestionManifestLeaseLostErrorV1,
    );
    expect(await prisma.budgetExtractionCandidateV1.findUnique({
      where: { id: computeCandidateId(candidateIdentity) },
    })).toBeNull();
    expect(await repo.heartbeat(context)).toBe(false);
  });

  it('adopts a candidate committed before controller acknowledgement and fences the stale owner', async () => {
    const member = await fixtureMember(`checkpoint-${randomUUID()}`);
    const plan = manifest([member]);
    const repo = createIngestionManifestRepositoryV1(prisma, { leaseMs: 5_000 });
    await repo.register(plan);
    const oldContext = { operationId: plan.operationId, itemId: member.memberId, leaseToken: randomUUID() };
    await repo.claimNext({ operationId: plan.operationId, leaseToken: oldContext.leaseToken, taskJobId: 'task:old' });
    const exactIdentity = identity(member, randomUUID());
    const saved = await new PrismaBudgetVerificationRepositoryV1(
      prisma, repo.persistenceFence(oldContext),
    ).persistCompletedVerification(verification(exactIdentity));
    await prisma.$executeRawUnsafe(
      `UPDATE "defense_budget_ingestion_manifest_item_v1"
       SET "leased_until"=clock_timestamp()-INTERVAL '1 second'
       WHERE "id"=$1::uuid`,
      member.memberId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "defense_budget_ingestion_outbox"
       SET "leased_until"=clock_timestamp()-INTERVAL '1 second'
       WHERE "id"=$1::uuid`,
      member.outboxRowId,
    );
    const newToken = randomUUID();
    const adopted = await repo.claimNext({ operationId: plan.operationId, leaseToken: newToken, taskJobId: 'task:recovery' });
    expect(adopted.outcome).toBe('evidence_ready');
    expect(adopted.item).toMatchObject({ candidateId: saved.candidate.id, verificationRunId: saved.run.id, attempts: 1 });
    expect(await repo.checkpointTerminal(oldContext, {
      candidateId: saved.candidate.id, verificationRunId: saved.run.id, verifierDecision: 'REVIEW',
      artifactId: exactIdentity.extractionArtifactId, artifactContentSha256: exactIdentity.extractionArtifactSha256,
      artifactLocator: exactIdentity.extractionArtifactLocator, finalState: 'TERMINAL_REVIEW',
    })).toBe(false);
    const secondIdentity = identity(member, randomUUID());
    await expect(new PrismaBudgetVerificationRepositoryV1(
      prisma, repo.persistenceFence(oldContext),
    ).persistCompletedVerification(verification(secondIdentity))).rejects.toBeInstanceOf(IngestionManifestLeaseLostErrorV1);
    expect(await prisma.budgetExtractionCandidateV1.findUnique({ where: { id: computeCandidateId(secondIdentity) } })).toBeNull();
    expect(await repo.finalizeEvidence({ operationId: plan.operationId, itemId: member.memberId, leaseToken: newToken })).toBe(true);
    const outbox = await prisma.defenseBudgetIngestionOutbox.findUniqueOrThrow({ where: { id: member.outboxRowId } });
    expect(outbox.state).toBe('dead_letter');
    expect(outbox.metadata).toMatchObject({ readinessPhase: 'not_requested_manifest_ingestion_only', readinessInvoked: false });
    expect((await prisma.budgetExtractionCandidateV1.count({ where: { sourceDocumentId: member.sourceDocumentId } }))).toBe(1);
    expect((await repo.claimNext({ operationId: plan.operationId, leaseToken: randomUUID(), taskJobId: 'task:terminal-resume' })).outcome).toBe('complete');
  });

  it('turns an expired uncheckpointed task into durable uncertainty until exact reconciliation', async () => {
    const member = await fixtureMember(`uncertain-${randomUUID()}`, fixedNow, 'failed', 1);
    const plan = manifest([member]);
    const repo = createIngestionManifestRepositoryV1(prisma, { leaseMs: 100 });
    await repo.register(plan);
    await repo.claimNext({ operationId: plan.operationId, leaseToken: randomUUID(), taskJobId: 'task:ambiguous' });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect((await repo.claimNext({ operationId: plan.operationId, leaseToken: randomUUID(), taskJobId: 'task:new' })).outcome).toBe('uncertain');
    expect((await repo.read(plan.operationId))?.items[0]).toMatchObject({ status: 'uncertain', taskJobId: 'task:ambiguous' });
    expect(await repo.reconcileUncertain({
      operationId: plan.operationId, itemId: member.memberId, expectedTaskJobId: 'wrong-task',
      actor: 'operator', reason: 'ECS task is stopped',
    })).toBe('ineligible');
    expect(await repo.reconcileUncertain({
      operationId: plan.operationId, itemId: member.memberId, expectedTaskJobId: 'task:ambiguous',
      actor: 'operator', reason: 'ECS DescribeTasks proves this exact task is STOPPED',
    })).toBe('retry_wait');
    expect(await prisma.defenseBudgetIngestionOutbox.findUniqueOrThrow({
      where: { id: member.outboxRowId },
    })).toMatchObject({ state: 'failed', attempts: 1 });
    expect((await repo.claimNext({
      operationId: plan.operationId, leaseToken: randomUUID(), taskJobId: 'task:reconciled-retry',
    })).outcome).toBe('claimed');
  });

  it('preserves an initially failed outbox state across a bounded transient retry', async () => {
    const member = await fixtureMember(`failed-retry-${randomUUID()}`, fixedNow, 'failed', 1);
    const plan = manifest([member]);
    const repo = createIngestionManifestRepositoryV1(prisma, { leaseMs: 5_000 });
    await repo.register(plan);
    const firstToken = randomUUID();
    const first = await repo.claimNext({
      operationId: plan.operationId, leaseToken: firstToken, taskJobId: 'task:failed-first',
    });
    expect(first).toMatchObject({ outcome: 'claimed', item: { attempts: 2 } });
    expect(await repo.recordTransientFailure({
      operationId: plan.operationId, itemId: member.memberId, leaseToken: firstToken,
      errorClass: 'TRANSIENT_FIXTURE', detail: 'retryable disposable failure', backoffMs: 0,
    })).toBe('retry_wait');
    expect(await prisma.defenseBudgetIngestionOutbox.findUniqueOrThrow({
      where: { id: member.outboxRowId },
    })).toMatchObject({ state: 'failed', attempts: 2 });
    expect((await repo.claimNext({
      operationId: plan.operationId, leaseToken: randomUUID(), taskJobId: 'task:failed-second',
    })).outcome).toBe('claimed');
  });

  it('stop-new-work retains and renews the in-flight owner but refuses another member', async () => {
    const first = await fixtureMember(`stop-first-${randomUUID()}`);
    const second = await fixtureMember(`stop-second-${randomUUID()}`);
    const plan = manifest([first, second]);
    const repo = createIngestionManifestRepositoryV1(prisma, { leaseMs: 5_000 });
    await repo.register(plan);
    const context = { operationId: plan.operationId, itemId: first.memberId, leaseToken: randomUUID() };
    expect((await repo.claimNext({ operationId: plan.operationId, leaseToken: context.leaseToken, taskJobId: 'task:stop' })).item?.id).toBe(first.memberId);
    const stopped = await repo.requestStop(plan.operationId);
    expect(stopped?.status).toBe('stop_requested');
    expect(await repo.heartbeat(context)).toBe(true);
    expect((await repo.claimNext({ operationId: plan.operationId, leaseToken: randomUUID(), taskJobId: 'task:new-work' })).outcome).toBe('stopped');
    expect((await prisma.defenseBudgetIngestionOutbox.findUniqueOrThrow({ where: { id: second.outboxRowId } })).state).toBe('pending');
  });

  it('refuses a member when candidates, an approval, and a correction appear after planning and preserves unrelated audit state', async () => {
    const member = await fixtureMember(`stale-${randomUUID()}`);
    const plan = manifest([member]);
    const repo = createIngestionManifestRepositoryV1(prisma, { leaseMs: 5_000 });
    await repo.register(plan);
    const exactIdentity = identity(member, randomUUID());
    const saved = await new PrismaBudgetVerificationRepositoryV1(prisma).persistCompletedVerification(verification(exactIdentity));
    await prisma.budgetScopedFactReviewV1.create({ data: {
      candidateId: saved.candidate.id, runId: saved.run.id,
      sourceDocumentId: member.sourceDocumentId, sourceSha256: member.sourceSha256,
      extractionArtifactId: exactIdentity.extractionArtifactId,
      extractionArtifactSha256: exactIdentity.extractionArtifactSha256,
      manifestContentSha256: exactIdentity.manifestContentSha256,
      policyId: 'package-e-integration', policyVersion: 'v1', policySha256: sha('package-e-review-policy'),
      scopeKind: 'rdte_r2_pe_total_request_fy', scopeKey: `package-e:${member.sourceDocumentId}:2027:request`,
      scope: { peCode: '0601102A', fiscalYear: 2027, fundingField: 'request', component: 'ARMY' },
      assertionIds: [], evidenceIds: [], projection: {}, independence: {}, limitations: [],
      decision: 'approve', reviewerId: 'package-e-integration', rationale: 'Disposable stale-approval guard proof',
      decisionHash: sha(`package-e-review:${saved.candidate.id}`), status: 'active',
    } });
    const replacementIdentity = identity(member, randomUUID());
    const replacement = await new PrismaBudgetVerificationRepositoryV1(prisma)
      .persistCompletedVerification(verification(replacementIdentity));
    await prisma.budgetCandidateCorrectionV1.create({ data: {
      oldCandidateId: saved.candidate.id, newCandidateId: replacement.candidate.id,
      oldCandidateStatusAtCorrection: 'NEEDS_REVIEW',
      oldCandidateSourceDocumentId: member.sourceDocumentId, oldCandidateSourceSha256: member.sourceSha256,
      newCandidateSourceDocumentId: member.sourceDocumentId, newCandidateSourceSha256: member.sourceSha256,
      supersededScopedFactReviewIds: [], actor: 'package-e-integration', reason: 'Disposable stale-correction guard proof',
    } });
    const approvalCountBefore = await prisma.budgetScopedFactReviewV1.count();
    const promotionAuditBefore = await prisma.$queryRawUnsafe<{ count: bigint }[]>('SELECT count(*)::bigint AS count FROM "defense_budget_promotion_audit"');
    const claimed = await repo.claimNext({ operationId: plan.operationId, leaseToken: randomUUID(), taskJobId: 'task:stale' });
    expect(claimed.outcome).toBe('uncertain');
    expect(claimed.item?.lastErrorClass).toBe('STALE_MANIFEST_MEMBER');
    expect(claimed.item?.lastErrorMessage).toContain('CANDIDATE_APPEARED');
    expect(claimed.item?.lastErrorMessage).toContain('APPROVAL_COUNT_CHANGED');
    expect(claimed.item?.lastErrorMessage).toContain('CORRECTION_COUNT_CHANGED');
    expect(await prisma.budgetScopedFactReviewV1.count()).toBe(approvalCountBefore);
    expect((await prisma.$queryRawUnsafe<{ count: bigint }[]>('SELECT count(*)::bigint AS count FROM "defense_budget_promotion_audit"'))[0]!.count).toBe(promotionAuditBefore[0]!.count);
    expect((await prisma.defenseBudgetIngestionOutbox.findUniqueOrThrow({ where: { id: member.outboxRowId } })).state).toBe('pending');
  });

  it('refuses a planned member when its source hash or outbox state changes', async () => {
    const member = await fixtureMember(`identity-stale-${randomUUID()}`);
    const plan = manifest([member]);
    await prisma.sourceDocument.update({
      where: { id: member.sourceDocumentId },
      data: { sha256: sha('changed-after-planning') },
    });
    await prisma.defenseBudgetIngestionOutbox.update({
      where: { id: member.outboxRowId },
      data: { state: 'failed' },
    });
    const result = await createIngestionManifestRepositoryV1(prisma).register(plan);
    expect(result.outcome).toBe('ineligible');
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'OUTBOX_STATE_CHANGED', 'SOURCE_HASH_CHANGED',
    ]));
    expect(await prisma.defenseBudgetIngestionManifestV1.findUnique({ where: { id: plan.operationId } })).toBeNull();
  });

  it('legacy count and exact-row claim SQL skip a manifest-reserved row', async () => {
    const reserved = await fixtureMember(`reserved-${randomUUID()}`, '2026-09-18T00:00:00.000Z');
    const free = await fixtureMember(`free-${randomUUID()}`, '2026-09-19T00:00:00.000Z');
    const plan = manifest([reserved]);
    await createIngestionManifestRepositoryV1(prisma).register(plan);
    const legacy = createIngestionOutboxDrainRepositoryPrismaV1(prisma, { leaseMs: 5_000 });
    const batch = await legacy.claimBatch({ leaseOwner: 'legacy-worker', limit: 1, now: new Date('2026-09-21T00:00:00.000Z') });
    expect(batch[0]?.id).toBe(free.outboxRowId);
    expect(await legacy.claimRowById({ rowId: reserved.outboxRowId, leaseOwner: 'legacy-exact', now: new Date('2026-09-21T00:00:00.000Z') })).toBeNull();
    expect((await prisma.defenseBudgetIngestionOutbox.findUniqueOrThrow({ where: { id: reserved.outboxRowId } })).state).toBe('pending');
  });
});

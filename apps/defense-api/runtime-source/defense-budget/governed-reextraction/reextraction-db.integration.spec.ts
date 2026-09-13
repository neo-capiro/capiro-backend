/**
 * Actual Prisma/PostgreSQL integration suite. Run only against a DISPOSABLE,
 * migrated database schema named reextract_test_*; no database doubles.
 * Fixtures exercise persistence/fencing, not OCR or semantic extraction quality.
 * These sequential cases do not prove multi-backend lock scheduling.
 */
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  checkpointReextractionVerificationV1, createReextractionRepositoryV1,
  ReextractionLeaseLostErrorV1, reextractionRequestHashV1, type ReextractionRequestV1, type ReextractionLeaseContextV1,
} from './reextraction-repository-v1.js';
import { resolveReextractionTargetV1 } from './reextraction-target-v1.js';
import { ReviewCandidateReextractionV1 } from './reextract-review-candidate-v1.js';
import { PrismaBudgetVerificationRepositoryV1 } from '../verification/persistence/prisma-budget-verification.repository.js';
import { computeCandidateId, computeRunId } from '../verification/persistence/verification-persistence-mappers.js';
import type { CandidateIdentityV1, PersistCompletedVerificationInputV1 } from '../verification/persistence/verification-repository.js';

const integration = process.env.REEXTRACTION_INTEGRATION === '1' ? describe : describe.skip;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const now = '2026-09-13T00:00:00.000Z';

integration('governed re-extraction: real PostgreSQL persistence', () => {
  let prisma: PrismaClient;
  let repository: ReturnType<typeof createReextractionRepositoryV1>;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!/^reextract_test_[a-z0-9_]+$/.test(url.searchParams.get('schema') ?? '')) {
      throw new Error('Integration tests require an explicitly disposable reextract_test_* DATABASE_URL schema');
    }
    prisma = new PrismaClient();
    await prisma.$connect();
    await prisma.$queryRawUnsafe('SELECT "id" FROM "budget_reextraction_operation_v1" LIMIT 0');
    repository = createReextractionRepositoryV1(prisma);
    // Catch intentional SQL rejection inside a PostgreSQL subtransaction; the
    // returned SQLSTATE/message must be the actual guard, not a transport error.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION reextract_test_capture_rejection(statement text)
      RETURNS TABLE(message text, errorcode text) LANGUAGE plpgsql AS $$
      BEGIN
        EXECUTE statement;
        RETURN NEXT;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS message=MESSAGE_TEXT, errorcode=RETURNED_SQLSTATE;
        RETURN NEXT;
      END $$`);
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  // Populate actual table types while allowing omitted columns to use DB defaults.
  async function expectSqlGuard(statement: string, expected: string, errorcode = 'P0001') {
    const rows = await prisma.$queryRawUnsafe<{ message: string | null; errorcode: string | null }[]>(
      'SELECT * FROM reextract_test_capture_rejection($1)', statement,
    );
    expect(rows[0]?.errorcode).toBe(errorcode);
    expect(rows[0]?.message).toContain(expected);
  }

  async function insert(table: string, data: Record<string, unknown>) {
    const columns = Object.keys(data).map(k => `"${k}"`).join(',');
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`,
      JSON.stringify(data),
    );
  }

  function verification(identity: CandidateIdentityV1, decision: 'REVIEW' | 'REJECT' = 'REVIEW'): PersistCompletedVerificationInputV1 {
    const checks = [{ checkId: 'fixture-check', code: 'fixture_review_required', ruleVersion: 'v1',
      outcome: 'FAIL' as const, required: true, blocking: true, riskPoints: 100,
      message: 'Synthetic persistence fixture; does not establish extraction accuracy.',
      assertionIds: [], evidenceIds: ['fixture-evidence'], referenceArtifactIds: [] }];
    const discrepancies = [{ discrepancyId: 'fixture-discrepancy', code: 'fixture_discrepancy',
      severity: 'blocking' as const, description: 'Synthetic persistence fixture.',
      assertionIds: [], evidenceIds: ['fixture-evidence'], referenceArtifactIds: [] }];
    return {
      candidateIdentity: identity,
      result: {
        ...identity, verifierVersion: 'defense_budget_verifier_v1', policyVersion: 'defense_budget_verification_policy_v1', candidateId: computeCandidateId(identity), verificationRunId: computeRunId(identity, '0'),
        sourcePdfSha256: identity.sourceSha256,
        decision, status: decision === 'REJECT' ? 'REJECTED' : 'NEEDS_REVIEW',
        route: decision === 'REJECT' ? 'none' : 'human_review', riskScore: 100,
        checks, discrepancies, acceptedAssertionIds: [], rejectedAssertionIds: [], referenceArtifactIds: [],
        startedAt: now, completedAt: now,
      },
      proofBundle: {
        manifest: { locator: '/fixture-manifest.json', contentSha256: identity.manifestContentSha256,
          cycleId: identity.cycleId, fiscalYear: 2026, documentKey: identity.manifestDocumentKey },
        extractionArtifact: { locator: identity.extractionArtifactLocator, artifactId: identity.extractionArtifactId,
          contentSha256: identity.extractionArtifactSha256, byteSha256: sha('artifact-bytes'), schemaVersion: 'defense_budget_extraction_v1' },
        sourceDocument: { id: identity.sourceDocumentId, sourceKey: 'fixture', sourceSha256: identity.sourceSha256 },
        archive: { status: 'verified' }, parserRuns: [], resolvedReferenceArtifacts: [],
      },
      proofFindings: [], proofSnapshots: [{ proofKind: 'archive', status: 'verified',
        sourceDocumentId: identity.sourceDocumentId, evidenceJson: { fixture: true } }],
      checks, discrepancies, startedAt: now, completedAt: now,
    };
  }

  async function fixture() {
    const existingCycle = await prisma.defenseBudgetCycle.findFirst({ where: { fiscalYear: 2026, authorityTrack: 'request' } });
    const cycleId = existingCycle?.id ?? randomUUID(), sourceDocumentId = randomUUID(), observationId = randomUUID(), expectedId = randomUUID();
    const bytes = Buffer.from(`%PDF-1.4\nfixture ${sourceDocumentId}`);
    const sourceSha256 = sha(bytes.toString());
    if (!existingCycle) await insert('defense_budget_cycle', { id: cycleId, fiscal_year: 2026, authority_track: 'request',
      template_version: 'v1', bootstrap_origin: 'operator', dedup_key: sha(cycleId) });
    await insert('source_document', { id: sourceDocumentId, source_key: `fixture:${sourceDocumentId}`, fiscal_year: 2026,
      budget_cycle: 'pb', component: 'ARMY', document_type: 'r2', title: 'Synthetic persistence fixture',
      source_url: `https://example.invalid/${sourceDocumentId}.pdf`, sha256: sourceSha256, byte_size: bytes.length,
      extraction_method: 'deterministic', archive_bucket: 'fixture-bucket', archive_s3_key: `fixture/${sourceSha256}.pdf`,
      archive_version_id: 'fixture-version' });
    await insert('defense_budget_expected_source', { id: expectedId, cycle_id: cycleId, fiscal_year: 2026,
      authority_track: 'request', stage: 'president_budget_request', source_family: 'pb_r2', component: 'ARMY', adapter_id: 'fixture',
      label: 'fixture', template_version: 'v1', expected_from: now, expected_to: now, dedup_key: sha(expectedId) });
    await insert('defense_budget_source_observation', { id: observationId, expected_source_id: expectedId, cycle_id: cycleId,
      adapter_id: 'fixture', discovered_url: `https://example.invalid/${sourceDocumentId}.pdf`, content_sha256: sourceSha256,
      observation_state: 'ingested', revision_kind: 'first_discovery', classified_fiscal_year: 2026,
      classified_source_family: 'pb_r2', source_document_id: sourceDocumentId, dedup_key: sha(observationId) });
    const identity: CandidateIdentityV1 = { cycleId, sourceDocumentId, sourceSha256,
      manifestContentSha256: sha(`manifest:${sourceDocumentId}`), manifestDocumentKey: 'fixture-source',
      extractionArtifactId: `old:${sourceDocumentId}`, extractionArtifactSha256: sha(`old:${sourceDocumentId}`),
      extractionArtifactLocator: `s3://fixture/old/${sourceDocumentId}`,
      verifierVersion: 'defense_budget_verifier_v1', policyVersion: 'defense_budget_verification_policy_v1', policySha256: sha('policy') };
    const input = verification(identity);
    const saved = await new PrismaBudgetVerificationRepositoryV1(prisma).persistCompletedVerification(input);
    const outboxRowId = randomUUID();
    await insert('defense_budget_ingestion_outbox', { id: outboxRowId, observation_id: observationId,
      observation_state: 'ingested', cycle_id: cycleId, job_kind: 'governed_source_ingestion', state: 'dead_letter', attempts: 3,
      last_error: 'REVIEW retained for governed recovery', dedup_key: sha(outboxRowId),
      metadata_jsonb: { governedDisposition: 'review_required', verifierDecision: 'REVIEW', sourceDocumentId,
        fixtureSentinel: ['do', 'not', 'change'] } });
    const request: ReextractionRequestV1 = { operationId: randomUUID(), outboxRowId, oldCandidateId: saved.candidate.id,
      expectedOldVerificationRunId: saved.run.id, expectedSourceSha256: sourceSha256,
      expectedOldExtractionArtifactSha256: identity.extractionArtifactSha256,
      actor: 'integration-fixture', reason: 'Verify guarded persistence', releaseRevision: 'a'.repeat(40) };
    const snapshot = await resolveReextractionTargetV1(prisma, request);
    const context = { operationId: request.operationId, leaseToken: randomUUID() };
    return { request, snapshot, context, identity, input, bytes };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function claim(f: Fixture) {
    const saved = await repository.claim({ request: f.request, snapshot: f.snapshot, leaseToken: f.context.leaseToken });
    expect(saved.outcome).toBe('claimed');
    return saved.operation!;
  }
  function fenced(context: ReextractionLeaseContextV1) {
    return new PrismaBudgetVerificationRepositoryV1(prisma, (tx, identity, candidateId, runId) =>
      checkpointReextractionVerificationV1(tx, context, identity, candidateId, runId));
  }
  function fresh(f: Fixture, changes: Partial<CandidateIdentityV1> = {}) {
    return { ...f.identity, extractionArtifactId: `new:${randomUUID()}`,
      extractionArtifactSha256: sha(randomUUID()), extractionArtifactLocator: 's3://fixture/new', ...changes };
  }
  function terminal(identity: CandidateIdentityV1, decision: 'REVIEW' | 'REJECT' = 'REVIEW') {
    return { candidateId: computeCandidateId(identity), verificationRunId: computeRunId(identity, '0'),
      artifactId: identity.extractionArtifactId, artifactContentSha256: identity.extractionArtifactSha256,
      artifactByteSha256: sha('artifact-bytes'), artifactLocator: identity.extractionArtifactLocator,
      verifierDecision: decision, finalState: decision === 'REJECT' ? 'TERMINAL_REJECTED' : 'TERMINAL_REVIEW' };
  }
  async function originalRows(f: Fixture) {
    return prisma.$queryRawUnsafe(
      `SELECT to_jsonb(c) AS candidate, to_jsonb(o) AS outbox FROM "budget_extraction_candidate_v1" c,
       "defense_budget_ingestion_outbox" o WHERE c."id"=$1::uuid AND o."id"=$2::uuid`,
      f.request.oldCandidateId, f.request.outboxRowId,
    );
  }
  async function expectAbsent(identity: CandidateIdentityV1) {
    const id = computeCandidateId(identity), runId = computeRunId(identity, '0');
    expect(await prisma.budgetExtractionCandidateV1.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.budgetVerificationRunV1.findUnique({ where: { id: runId } })).toBeNull();
    expect(await prisma.budgetVerificationProofV1.count({ where: { runId } })).toBe(0);
    expect(await prisma.budgetVerificationCheckV1.count({ where: { runId } })).toBe(0);
    expect(await prisma.budgetVerificationDiscrepancyV1.count({ where: { runId } })).toBe(0);
  }
  function readCompletedService() {
    const unexpected = async (): Promise<never> => { throw new Error('Completed readback must not execute dependencies'); };
    return new ReviewCandidateReextractionV1({ repository, resolveTarget: unexpected,
      archive: { readMaterializedBytes: unexpected }, parse: unexpected,
      persistenceFence: () => unexpected, runtimeConfigSha256: sha('fixture-runtime'), parserArtifactRoot: '/tmp/fixture-parser-root' });
  }

  it('claims the exact same-cycle source and preserves every original candidate/outbox field', async () => {
    const f = await fixture(), before = await originalRows(f);
    const op = await claim(f);
    expect(op).toMatchObject({ cycleId: f.identity.cycleId, sourceDocumentId: f.identity.sourceDocumentId,
      oldCandidateId: f.request.oldCandidateId, status: 'running', attempts: 1, verificationCorrelations: [] });
    expect(await originalRows(f)).toEqual(before);
  });

  it('returns busy for a live claim and conflict for changed request/runtime, preserving failed history', async () => {
    const f = await fixture();
    await claim(f);
    expect((await repository.claim({ request: f.request, snapshot: f.snapshot, leaseToken: randomUUID() })).outcome).toBe('busy');
    expect((await repository.claim({ request: { ...f.request, reason: 'changed' }, snapshot: f.snapshot, leaseToken: randomUUID() })).outcome).toBe('conflict');
    expect((await repository.claim({ request: f.request, snapshot: { ...f.snapshot, sourcePath: '/changed.pdf' }, leaseToken: randomUUID() })).outcome).toBe('conflict');
    expect((await repository.claim({ request: { ...f.request, operationId: randomUUID() }, snapshot: f.snapshot, leaseToken: randomUUID() })).outcome).toBe('busy');
    expect(await repository.fail(f.context, 'transient')).toBe(true);
    expect((await repository.claim({ request: { ...f.request, operationId: randomUUID() }, snapshot: f.snapshot, leaseToken: randomUUID() })).outcome).toBe('claimed');
    expect((await repository.read(f.request.operationId))!.status).toBe('failed');
  });

  it('allows only one running operation across distinct historical candidates for one source, including expired leases', async () => {
    const f = await fixture();
    await claim(f);
    const secondIdentity = fresh(f);
    const secondCandidate = await new PrismaBudgetVerificationRepositoryV1(prisma).persistCompletedVerification(verification(secondIdentity));
    const request = { ...f.request, operationId: randomUUID(), oldCandidateId: secondCandidate.candidate.id,
      expectedOldVerificationRunId: secondCandidate.run.id, expectedOldExtractionArtifactSha256: secondIdentity.extractionArtifactSha256 };
    const snapshot = await resolveReextractionTargetV1(prisma, request);
    expect((await repository.claim({ request, snapshot, leaseToken: randomUUID() })).outcome).toBe('busy');
    const patch = JSON.stringify({ id: request.operationId, old_candidate_id: request.oldCandidateId,
      old_verification_run_id: request.expectedOldVerificationRunId, request_jsonb: request,
      request_hash: reextractionRequestHashV1(request, snapshot), snapshot_jsonb: snapshot, lease_token: randomUUID() }).replaceAll("'", "''");
    await expectSqlGuard(`INSERT INTO "budget_reextraction_operation_v1"
      SELECT r.* FROM "budget_reextraction_operation_v1" op
      CROSS JOIN LATERAL jsonb_populate_record(NULL::"budget_reextraction_operation_v1", to_jsonb(op) || '${patch}'::jsonb) r
      WHERE op."id"='${f.request.operationId}'::uuid`, 'duplicate key', '23505');
    await prisma.$executeRawUnsafe('UPDATE "budget_reextraction_operation_v1" SET "leased_until"=clock_timestamp()-interval \'1 second\' WHERE "id"=$1::uuid', f.request.operationId);
    expect((await repository.claim({ request, snapshot, leaseToken: randomUUID() })).outcome).toBe('busy');
    expect((await repository.abandonExpired(f.request.operationId, 'operator', 'retire expired attempt', { commit: true })).outcome).toBe('abandoned');
    expect((await repository.claim({ request, snapshot, leaseToken: randomUUID() })).outcome).toBe('claimed');
  });

  it.each(['cycle', 'source', 'artifact', 'run'] as const)('refuses initial claim with mismatched %s binding', async kind => {
    const f = await fixture();
    const request = { ...f.request }, snapshot = { ...f.snapshot };
    if (kind === 'cycle') snapshot.cycleId = randomUUID();
    if (kind === 'source') snapshot.sourceDocumentId = randomUUID();
    if (kind === 'artifact') request.expectedOldExtractionArtifactSha256 = sha('wrong');
    if (kind === 'run') request.expectedOldVerificationRunId = randomUUID();
    expect((await repository.claim({ request, snapshot, leaseToken: f.context.leaseToken })).outcome).toBe('ineligible');
    expect(await repository.read(request.operationId)).toBeNull();
  });

  it('rolls back an inserted operation when post-lock eligibility detects a changed archive snapshot', async () => {
    const f = await fixture();
    await expect(repository.claim({ request: f.request, snapshot: { ...f.snapshot, archiveS3Key: 'different' },
      leaseToken: f.context.leaseToken })).rejects.toBeInstanceOf(ReextractionLeaseLostErrorV1);
    expect(await repository.read(f.request.operationId)).toBeNull();
  });

  it('an expired owner cannot heartbeat, fail, block, complete, or persist; reclaim replaces its token', async () => {
    const f = await fixture();
    await claim(f);
    await prisma.$executeRawUnsafe('UPDATE "budget_reextraction_operation_v1" SET "leased_until"=clock_timestamp()-interval \'1 second\' WHERE "id"=$1::uuid', f.request.operationId);
    expect(await repository.heartbeat(f.context)).toBe(false);
    expect(await repository.fail(f.context, 'stale')).toBe(false);
    expect(await repository.block(f.context, 'stale')).toBe(false);
    expect(await repository.complete(f.context, terminal(f.identity))).toBe(false);
    const staleIdentity = fresh(f);
    await expect(fenced(f.context).persistCompletedVerification(verification(staleIdentity))).rejects.toBeInstanceOf(ReextractionLeaseLostErrorV1);
    await expectAbsent(staleIdentity);
    const newContext = { ...f.context, leaseToken: randomUUID() };
    const reclaimed = await repository.claim({ request: f.request, snapshot: f.snapshot, leaseToken: newContext.leaseToken });
    expect(reclaimed.operation).toMatchObject({ leaseToken: newContext.leaseToken, attempts: 2, status: 'running' });
    expect(await repository.heartbeat(f.context)).toBe(false);
    expect(await repository.heartbeat(newContext)).toBe(true);
    const identity = fresh(f);
    await fenced(newContext).persistCompletedVerification(verification(identity));
    expect(await repository.complete(newContext, terminal(identity))).toBe(true);
  });

  it('stale-token checkpoint rolls back real candidate, run, proofs, checks and discrepancies in their transaction', async () => {
    const f = await fixture(), before = await originalRows(f);
    await claim(f);
    const identity = fresh(f);
    await expect(fenced({ ...f.context, leaseToken: randomUUID() }).persistCompletedVerification(verification(identity)))
      .rejects.toBeInstanceOf(ReextractionLeaseLostErrorV1);
    await expectAbsent(identity);
    expect((await repository.read(f.request.operationId))!.verificationCorrelations).toEqual([]);
    expect(await originalRows(f)).toEqual(before);
  });

  it.each(['cycleId', 'sourceDocumentId', 'sourceSha256'] as const)('rolls back fresh verification with mismatched %s', async field => {
    const f = await fixture();
    await claim(f);
    const identity = fresh(f, { [field]: field === 'sourceSha256' ? sha('wrong-source') : randomUUID() });
    await expect(fenced(f.context).persistCompletedVerification(verification(identity))).rejects.toBeInstanceOf(ReextractionLeaseLostErrorV1);
    await expectAbsent(identity);
  });

  it('exact replay appends one correlation and fences both lookup and persist cache paths', async () => {
    const f = await fixture(), before = await originalRows(f);
    await claim(f);
    const saved = await fenced(f.context).findTerminalRunByIdentity(f.identity);
    expect(saved?.candidate.id).toBe(f.request.oldCandidateId);
    expect(saved?.run.id).toBe(f.request.expectedOldVerificationRunId);
    await fenced(f.context).persistCompletedVerification(f.input);
    expect((await repository.read(f.request.operationId))!.verificationCorrelations).toHaveLength(1);
    const stale = fenced({ ...f.context, leaseToken: randomUUID() });
    await expect(stale.findTerminalRunByIdentity(f.identity)).rejects.toBeInstanceOf(ReextractionLeaseLostErrorV1);
    await expect(stale.persistCompletedVerification(f.input)).rejects.toBeInstanceOf(ReextractionLeaseLostErrorV1);
    expect(await originalRows(f)).toEqual(before);
  });

  it('completion requires the exact checkpointed artifact and persisted verifier decision', async () => {
    const f = await fixture();
    await claim(f);
    const identity = fresh(f);
    await new PrismaBudgetVerificationRepositoryV1(prisma).persistCompletedVerification(verification(identity));
    expect(await repository.complete(f.context, terminal(identity))).toBe(false);
    await fenced(f.context).findTerminalRunByIdentity(identity);
    expect(await repository.complete(f.context, { ...terminal(identity), artifactContentSha256: sha('wrong') })).toBe(false);
    expect(await repository.complete(f.context, terminal(identity, 'REJECT'))).toBe(false);
    expect(await repository.complete(f.context, terminal(identity))).toBe(true);
  });

  it.each(['no-change', 'REJECT'] as const)('durably records %s, returns it on replay, and leaves the original review/outbox untouched', async kind => {
    const f = await fixture(), before = await originalRows(f);
    await claim(f);
    const identity = kind === 'no-change' ? f.identity : fresh(f);
    const decision = kind === 'REJECT' ? 'REJECT' : 'REVIEW';
    await fenced(f.context).persistCompletedVerification(verification(identity, decision));
    expect(await repository.complete(f.context, terminal(identity, decision))).toBe(true);
    const result = await readCompletedService().run(f.request, { commit: true });
    expect(result).toMatchObject({ outcome: 'completed', extractionChanged: kind !== 'no-change',
      persistedForReview: decision === 'REVIEW', publication: 'not_performed',
      operation: { candidateId: computeCandidateId(identity), verificationRunId: computeRunId(identity, '0'),
        terminal: { verifierDecision: decision } } });
    expect(result.nextAction).toMatch(kind === 'REJECT' ? /No correction or approval is eligible/ : /unchanged/);
    expect((await repository.claim({ request: f.request, snapshot: f.snapshot, leaseToken: randomUUID() })).outcome).toBe('completed');
    expect(await originalRows(f)).toEqual(before);
    expect(await prisma.budgetCandidateCorrectionV1.count({ where: { oldCandidateId: f.request.oldCandidateId } })).toBe(0);
    expect(await prisma.budgetReviewDecisionV1.count({ where: { candidateId: f.request.oldCandidateId } })).toBe(0);
  });

  it('rechecks a review accepted during extraction before checkpointing any new verification', async () => {
    const f = await fixture();
    await claim(f);
    await new PrismaBudgetVerificationRepositoryV1(prisma).persistReviewDecision({ candidateId: f.request.oldCandidateId,
      verificationRunId: f.request.expectedOldVerificationRunId, reviewerId: 'fixture-reviewer', decision: 'accept',
      notes: 'Concurrent review fixture', evidenceIds: [], expectedSourceSha256: f.identity.sourceSha256,
      expectedExtractionArtifactSha256: f.identity.extractionArtifactSha256, expectedManifestContentSha256: f.identity.manifestContentSha256 });
    const identity = fresh(f);
    await expect(fenced(f.context).persistCompletedVerification(verification(identity))).rejects.toBeInstanceOf(ReextractionLeaseLostErrorV1);
    await expectAbsent(identity);
  });

  it('operator abandonment previews without mutation, refuses a live lease, and closes an expired operation after target drift', async () => {
    const f = await fixture();
    await claim(f);
    expect((await repository.abandonExpired(f.request.operationId, 'operator', 'release stale claim')).outcome).toBe('ineligible');
    expect((await repository.abandonExpired(f.request.operationId, 'operator', 'release stale claim', { commit: true })).outcome).toBe('ineligible');
    await fenced(f.context).persistCompletedVerification(f.input);
    await prisma.$executeRawUnsafe('UPDATE "budget_reextraction_operation_v1" SET "leased_until"=clock_timestamp()-interval \'1 second\' WHERE "id"=$1::uuid', f.request.operationId);
    await prisma.sourceDocument.update({ where: { id: f.identity.sourceDocumentId }, data: { title: 'Changed source metadata' } });
    const before = await repository.read(f.request.operationId);
    expect((await repository.abandonExpired(f.request.operationId, 'operator', 'release stale claim')).outcome).toBe('preview');
    expect(await repository.read(f.request.operationId)).toEqual(before);
    const closed = await repository.abandonExpired(f.request.operationId, 'operator', 'release stale claim', { commit: true });
    expect(closed).toMatchObject({ outcome: 'abandoned', operation: { status: 'blocked', leaseToken: null, leasedUntil: null,
      closure: { actor: 'operator', reason: 'release stale claim' } } });
    expect(closed.operation!.verificationCorrelations).toEqual(before!.verificationCorrelations);
    expect(await repository.heartbeat(f.context)).toBe(false);
    const staleIdentity = fresh(f);
    await expect(fenced(f.context).persistCompletedVerification(verification(staleIdentity))).rejects.toBeInstanceOf(ReextractionLeaseLostErrorV1);
    await expectAbsent(staleIdentity);
    const request = { ...f.request, operationId: randomUUID() };
    const snapshot = await resolveReextractionTargetV1(prisma, request);
    expect((await repository.claim({ request, snapshot, leaseToken: randomUUID() })).outcome).toBe('claimed');
    expect((await repository.read(f.request.operationId))!.status).toBe('blocked');
  });

  it('operator abandonment closes a failed operation and preserves its durable failure history', async () => {
    const f = await fixture();
    await claim(f);
    expect(await repository.fail(f.context, 'fixture failure')).toBe(true);
    expect((await repository.abandonExpired(f.request.operationId, 'operator', 'retire failed attempt')).outcome).toBe('preview');
    const closed = await repository.abandonExpired(f.request.operationId, 'operator', 'retire failed attempt', { commit: true });
    expect(closed).toMatchObject({ outcome: 'abandoned', operation: { status: 'blocked', attempts: 1,
      closure: { actor: 'operator', reason: 'retire failed attempt' } } });
    expect(closed.operation!.request).toEqual(f.request);
    expect((await repository.abandonExpired(f.request.operationId, 'operator', 'again', { commit: true })).outcome).toBe('ineligible');
  });

  it('migration guards reject immutable request edits, deletion, live token replacement, invalid attempts and incomplete correlations', async () => {
    const f = await fixture();
    await claim(f);
    const rejectedUpdates: [string, string][] = [
      ['"request_jsonb"=jsonb_set("request_jsonb",\'{reason}\',\'"changed"\')', 'immutable'],
      ['"snapshot_jsonb"=jsonb_set("snapshot_jsonb",\'{sourcePath}\',\'"/changed.pdf"\')', 'immutable'],
      [`"lease_token"='${randomUUID()}'::uuid,"attempts"="attempts"+1`, 'live'],
      ['"attempts"="attempts"+1', 'attempt'],
      ['"verification_correlations_jsonb"=\'[{"candidateId":"missing"}]\'::jsonb', 'incomplete'],
    ];
    for (const [assignment, expected] of rejectedUpdates) {
      await expectSqlGuard(`UPDATE "budget_reextraction_operation_v1" SET ${assignment} WHERE "id"='${f.request.operationId}'::uuid`, expected);
    }
    await expectSqlGuard(`DELETE FROM "budget_reextraction_operation_v1" WHERE "id"='${f.request.operationId}'::uuid`, 'cannot be deleted');
    expect((await repository.read(f.request.operationId))!.attempts).toBe(1);
  });

  it('migration enforces append-only correlations and immutable completed operations', async () => {
    const f = await fixture();
    await claim(f);
    await fenced(f.context).persistCompletedVerification(f.input);
    await expectSqlGuard(`UPDATE "budget_reextraction_operation_v1" SET "verification_correlations_jsonb"='[]'::jsonb WHERE "id"='${f.request.operationId}'::uuid`, 'append');
    expect(await repository.complete(f.context, terminal(f.identity))).toBe(true);
    await expectSqlGuard(`UPDATE "budget_reextraction_operation_v1" SET "last_error"='rewrite' WHERE "id"='${f.request.operationId}'::uuid`, 'immutable');
  });
});

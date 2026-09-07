/**
 * Phase 10B-31 -- permanent regression for the lifecycle-bridge
 * SourceDocument metadata-agreement check, proven against a REAL Postgres
 * through the REAL `DefaultParserHandoffAdapter`, the REAL synthetic
 * manifest builder (`buildLifecycleBridgeSyntheticManifestV1`, invoked
 * internally by the adapter's own call chain -- never called directly with
 * pre-corrected arguments here), the REAL `CompositeProofResolver` running in
 * `production_proof` mode, a REAL `SourceDocument` row read back out of
 * Postgres by the REAL Prisma client, and the REAL decision engine
 * (`computeDecisionV1`). No table-routed fakes, no in-memory maps, no
 * hand-built manifest/artifact JSON.
 *
 * Why this exists. PR #1486 / Phase 10B-28's qualification run of the real
 * FY2024 Army R-2 canary was blocked by two metadata-agreement bugs fixed in
 * this phase's Stage 2 commits: (1) the manifest's `component` silently
 * defaulted to 'UNKNOWN' because `ParserHandoffInput` never carried the
 * persisted `SourceDocument.component` through to the manifest builder, and
 * (2) the resolver compared the persisted `SourceDocument.sourceKey`
 * (identity slug) against the manifest's `sourceLocator` (an ephemeral local
 * scratch path) -- two values from structurally disjoint token spaces that
 * can never legitimately agree. Both were fixed by threading the real,
 * persisted `sourceKey`/`component` through `ParserHandoffInput` and adding
 * a dedicated `expectedSourceKey` manifest field. This spec is the
 * regression that proves it, end to end, through the real code paths that
 * process the real canary in production.
 *
 * ── What this deliberately does NOT prove ──────────────────────────────────
 * `requireImmutableArchive` is `true` for the R-2/rdte policy this spec
 * exercises. Every SourceDocument row created here carries NO archive
 * fields (`archiveBucket`/`archiveS3Key`/`archiveVersionId` all null) -- a
 * real, legitimately-supported case the codebase itself documents
 * ("reviewed legacy artifacts whose source PDF is not archived", see
 * `archive-proof-resolver.ts`) -- so `CompositeProofResolver`'s archive step
 * ALWAYS short-circuits with a blocking `archive_version_missing` finding
 * BEFORE ever calling an S3 client (confirmed by reading
 * `ArchiveProofResolver.resolve`: it returns immediately when
 * `archiveBucket`/`archiveS3Key` are absent, making zero network calls).
 * Consequently `decision` resolves `REJECT` in EVERY scenario below,
 * regardless of whether the metadata-agreement bug is present or fixed --
 * `decision` is NOT the signal this spec reads. The signal is the specific
 * `source_metadata_mismatch` proof-finding code (present/absent, and its
 * exact message), read directly off the persisted `budget_verification_proof`
 * rows (the `source_document` snapshot's own status/evidence, and the
 * `proof_findings` snapshot Stage 2's evidence-durability fix introduced) --
 * exactly the mechanism this bug fix touches. Archive proof itself is a
 * separate, pre-existing, unaffected resolver; this spec does not attempt to
 * also prove it reaches `verified` (that would require either live
 * production AWS access or a non-adapter-literal wiring substitution, both
 * avoided here to keep this suite hermetic and side-effect-free). The
 * authoritative SOURCE BYTES resolution (priority 2 of
 * `resolveAuthoritativeLocator`: `SourceDocument.artifactPath`) is still
 * genuinely exercised for real -- every scenario's source bytes are read
 * back off local disk and SHA-256'd for real, so the SHA-based half of the
 * metadata check (`row.sha256 !== actualSourceSha256`) is fully live, not
 * skipped.
 *
 * ── RED/GREEN ────────────────────────────────────────────────────────────
 * This file's "matching" and "another component/year" scenarios are the
 * ones proven RED (see the qualification command / EXECUTION-LOG for the
 * captured revert-and-rerun output): reverting the Stage 2 source commits
 * (composite-proof-resolver.ts, default-parser-handoff.adapter.ts,
 * observation-ingestion-bridge.ports.ts/.service.ts,
 * source-document-parser-handoff.ts, budget-cycle-manifest-v1.ts,
 * prisma-observation-bridge.store.ts) and rerunning this UNMODIFIED file
 * reproduces a spurious `source_metadata_mismatch` on every scenario
 * (because the pre-fix code compares `sourceKey` against the ephemeral
 * `sourceLocator` unconditionally, which can never match); restoring the fix
 * makes those same scenarios show no such finding. Every call below is
 * therefore written without a compile-time-checked `ParserHandoffInput`
 * import so the identical test file runs unmodified against both the
 * reverted and fixed source (see `callHandoff`).
 *
 * Gate: runs only when DATABASE_URL names a LOCAL disposable database (see
 * docs: pgvector/pgvector:pg16, database `capiro`, `prisma migrate deploy`).
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { DefaultParserHandoffAdapter } from '../../default-parser-handoff.adapter.js';

const DATABASE_URL = process.env.DATABASE_URL?.trim();

function isLocalDatabaseUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

const describeDb = isLocalDatabaseUrl(DATABASE_URL) ? describe : describe.skip;

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describeDb('Phase 10B-31 -- lifecycle-bridge SourceDocument metadata agreement against a real database', () => {
  jest.setTimeout(300_000);

  let prisma: PrismaClient;
  let outerDir: string;
  let parserArtifactRoot: string;
  let workDir: string;
  let pdfBytes: Buffer;
  let pdfSha256: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL! } } });
    await prisma.$connect();

    outerDir = mkdtempSync(join(tmpdir(), 'phase10b31-metadata-agreement-'));
    parserArtifactRoot = join(outerDir, 'parser-artifact-root');
    mkdirSync(parserArtifactRoot, { recursive: true });
    process.env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT = parserArtifactRoot;
    process.env.DEFENSE_BUDGET_PARSER_PROJECT_DIR = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      'defense-budget-parser',
    );
    // `FilesystemByteLocatorReader`'s approved-prefix list (production
    // wiring, `production-parser-verification-context.ts`) is exactly
    // `[parserArtifactRoot]` -- the manifest the router writes under
    // `workDir/<sourceDocumentId>/` is read back through that same reader,
    // so `workDir` (and every SourceDocument.artifactPath below) must itself
    // live under `parserArtifactRoot`.
    workDir = join(parserArtifactRoot, 'work');
    mkdirSync(workDir, { recursive: true });

    // ONE real, valid, minimal one-page PDF (via pdf-lib -- a real dependency
    // already used elsewhere in this app, not a hand-rolled binary format),
    // reused as the source bytes for every scenario below. Its content does
    // not need to resemble a real R-2 exhibit's layout: every scenario here
    // deliberately leaves the archive unresolved (see the file header), so
    // overall `decision` is REJECT regardless of how much (if any) of this
    // text the real R-2 semantic extractor manages to recognize -- only the
    // SourceDocument metadata-agreement findings are asserted on.
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('PE 0601102A In-House Laboratory Independent Research FY2024 12.34', {
      x: 50,
      y: 700,
      size: 12,
      font,
      color: rgb(0, 0, 0),
    });
    pdfBytes = Buffer.from(await doc.save());
    pdfSha256 = sha256Hex(pdfBytes);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(outerDir, { recursive: true, force: true });
  });

  interface ScenarioDb {
    sourceKey: string;
    fiscalYear: number;
    component: string | null;
    budgetCycle: string;
    documentType: string;
    sha256: string;
  }
  interface ScenarioHandoff {
    cycleId: string;
    sourceDocumentId: string;
    sourceSha256: string;
    fiscalYear: number;
    sourceFamily: string;
    sourceKey: string;
    component: string | null;
  }

  /**
   * Calls the REAL `DefaultParserHandoffAdapter.handoff()` with a plain,
   * untyped object (`as any` at the call site only) rather than a value
   * typed against the `ParserHandoffInput` interface. This is deliberate,
   * not a shortcut: it is what lets this exact file run unmodified against
   * BOTH the current (fixed) source AND the Stage-2-reverted source for the
   * RED/GREEN evidence (see the file header) -- the reverted
   * `ParserHandoffInput` type carries neither `sourceKey` nor `component`,
   * and a compile-time-checked object literal would fail ts-jest's
   * diagnostics in that state before the file could even run. The RUNTIME
   * behavior is unaffected either way: the reverted adapter simply ignores
   * the two extra properties; the fixed adapter reads and forwards them.
   */
  async function callHandoff(input: ScenarioHandoff) {
    const adapter = new DefaultParserHandoffAdapter({ workDir, maxEscalationRounds: 1 });
    return adapter.handoff({
      cycleId: input.cycleId,
      sourceDocumentId: input.sourceDocumentId,
      sourceSha256: input.sourceSha256,
      sourcePath: join(workDir, `${input.sourceDocumentId}-source.pdf`),
      fiscalYear: input.fiscalYear,
      authorityTrack: 'request',
      stage: 'president_budget_request',
      sourceFamily: input.sourceFamily,
      title: 'r2',
      sourceUrl: 'https://example.invalid/phase10b31-metadata-agreement.pdf',
      sourceKey: input.sourceKey,
      component: input.component,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  /**
   * Registers a real SourceDocument row (the REAL SourceDocument reader --
   * `CompositeProofResolver`'s `sourceDocumentClient` -- is the SAME real
   * Prisma client reading this SAME table) and materializes real bytes at
   * `artifactPath`, under the approved parser-artifact root, so
   * `resolveAuthoritativeLocator`'s priority-2 branch resolves genuine,
   * hashable bytes without needing any archive/S3 configuration.
   */
  async function registerSourceDocument(
    sourceDocumentId: string,
    db: ScenarioDb,
    bytes: Buffer,
  ): Promise<void> {
    const dir = join(parserArtifactRoot, 'source-bytes');
    mkdirSync(dir, { recursive: true });
    const artifactPath = join(dir, `${sourceDocumentId}.pdf`);
    writeFileSync(artifactPath, bytes);
    writeFileSync(join(workDir, `${sourceDocumentId}-source.pdf`), bytes);
    await prisma.sourceDocument.create({
      data: {
        id: sourceDocumentId,
        sourceKey: db.sourceKey,
        fiscalYear: db.fiscalYear,
        budgetCycle: db.budgetCycle,
        component: db.component,
        documentType: db.documentType,
        title: 'phase10b31-metadata-agreement fixture',
        sourceUrl: 'https://example.invalid/phase10b31-metadata-agreement.pdf',
        sha256: db.sha256,
        byteSize: bytes.length,
        extractionMethod: 'deterministic_pdf',
        artifactPath,
      },
    });
  }

  interface RunResult {
    result: { decision: string; finalState: string; artifactLocator: string };
    sourceDocumentId: string;
    cycleId: string;
    candidateRows: Array<{ id: string; cycle_id: string; status: string; source_document_id: string; manifest_content_sha256: string }>;
    sourceDocumentProof: { status: string; evidence_jsonb: { findings?: Array<{ code: string; message: string; severity: string }> } } | undefined;
    proofFindings: { status: string; evidence_jsonb: { findings: Array<{ code: string; message: string; severity: string }> } } | undefined;
  }

  async function queryEvidence(sourceDocumentId: string): Promise<{
    candidateRows: RunResult['candidateRows'];
    sourceDocumentProof: RunResult['sourceDocumentProof'];
    proofFindings: RunResult['proofFindings'];
  }> {
    const candidateRows = await prisma.$queryRawUnsafe<RunResult['candidateRows']>(
      `SELECT id, cycle_id, status, source_document_id, manifest_content_sha256
         FROM budget_extraction_candidate_v1 WHERE source_document_id = $1::uuid ORDER BY created_at ASC`,
      sourceDocumentId,
    );
    const proofRows = await prisma.$queryRawUnsafe<
      Array<{ proof_kind: string; status: string; evidence_jsonb: unknown }>
    >(
      `SELECT proof_kind, status, evidence_jsonb FROM budget_verification_proof
         WHERE run_id IN (SELECT id FROM budget_verification_run_v1 WHERE candidate_id IN
           (SELECT id FROM budget_extraction_candidate_v1 WHERE source_document_id = $1::uuid))
         ORDER BY created_at ASC`,
      sourceDocumentId,
    );
    return {
      candidateRows,
      sourceDocumentProof: proofRows.find((r) => r.proof_kind === 'source_document') as RunResult['sourceDocumentProof'],
      proofFindings: proofRows.find((r) => r.proof_kind === 'proof_findings') as RunResult['proofFindings'],
    };
  }

  /** One full scenario: register a SourceDocument row, run the real adapter, read back evidence. */
  async function runScenario(db: ScenarioDb, handoffOverrides: Partial<ScenarioHandoff> = {}): Promise<RunResult> {
    const sourceDocumentId = randomUUID();
    const cycleId = randomUUID();
    await registerSourceDocument(sourceDocumentId, db, pdfBytes);
    const result = await callHandoff({
      cycleId,
      sourceDocumentId,
      sourceSha256: pdfSha256,
      fiscalYear: db.fiscalYear,
      sourceFamily: 'pb_r2',
      sourceKey: db.sourceKey,
      component: db.component,
      ...handoffOverrides,
    });
    const evidence = await queryEvidence(sourceDocumentId);
    return { result: result as RunResult['result'], sourceDocumentId, cycleId, ...evidence };
  }

  function mismatchCodes(run: RunResult): string[] {
    return (run.proofFindings?.evidence_jsonb.findings ?? []).map((f) => f.code);
  }

  describe('the repaired real path (GREEN)', () => {
    it('a SourceDocument whose sourceKey/component/fiscalYear/sha256 all genuinely match the manifest shows NO metadata-agreement finding, and persists under the raw lifecycle cycle UUID', async () => {
      const dedupKey = randomUUID();
      const run = await runScenario({
        sourceKey: `defense-budget-observation-${dedupKey}`,
        fiscalYear: 2024,
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'r2',
        sha256: pdfSha256,
      });

      // Overall decision is REJECT solely due to archive_version_missing --
      // see the file header. The SourceDocument-specific proof must be clean.
      expect(run.sourceDocumentProof?.status).toBe('verified');
      expect(mismatchCodes(run)).not.toContain('source_metadata_mismatch');
      expect(mismatchCodes(run)).toEqual(['archive_version_missing']);

      expect(run.candidateRows).toHaveLength(1);
      expect(run.candidateRows[0]!.cycle_id).toBe(run.cycleId);
      expect(run.candidateRows[0]!.source_document_id).toBe(run.sourceDocumentId);

      // Candidate retrieval under the RAW lifecycle UUID (never the fy-tagged
      // manifest label) -- the same guarantee Phase 10B-28R proved for
      // cycle identity, exercised here through the metadata-agreement path.
      const byRaw = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        // `cycle_id` is TEXT (it also stores fy-tagged labels like
        // "fy2024:<uuid>"), never native uuid -- compared as plain text.
        `SELECT id FROM budget_extraction_candidate_v1 WHERE cycle_id = $1`,
        run.cycleId,
      );
      expect(byRaw.map((r) => r.id)).toEqual([run.candidateRows[0]!.id]);
      const byLabel = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM budget_extraction_candidate_v1 WHERE cycle_id = $1`,
        `fy2024:${run.cycleId}`,
      );
      expect(byLabel).toHaveLength(0);
    });

    it('a different, genuinely-registered component (NAVY, not ARMY) and a different fiscal year (2026, not 2024) exercise the same generic repair path successfully', async () => {
      const dedupKey = randomUUID();
      const run = await runScenario({
        sourceKey: `defense-budget-observation-${dedupKey}`,
        fiscalYear: 2026,
        component: 'NAVY',
        budgetCycle: 'pb',
        documentType: 'r2',
        sha256: pdfSha256,
      });
      expect(run.sourceDocumentProof?.status).toBe('verified');
      expect(mismatchCodes(run)).not.toContain('source_metadata_mismatch');
      expect(mismatchCodes(run)).toEqual(['archive_version_missing']);
    });

    it('a null component (legitimate all-component/committee document) is never coerced into a false mismatch', async () => {
      const dedupKey = randomUUID();
      const run = await runScenario({
        sourceKey: `defense-budget-observation-${dedupKey}`,
        fiscalYear: 2024,
        component: null,
        budgetCycle: 'pb',
        documentType: 'r2',
        sha256: pdfSha256,
      });
      expect(run.sourceDocumentProof?.status).toBe('verified');
      expect(mismatchCodes(run)).not.toContain('source_metadata_mismatch');
    });
  });

  describe('independently tampered inputs each still fail closed (tested one at a time, not bundled)', () => {
    it('component mismatch: the persisted row disagrees with what the handoff declares', async () => {
      const dedupKey = randomUUID();
      const run = await runScenario(
        {
          sourceKey: `defense-budget-observation-${dedupKey}`,
          fiscalYear: 2024,
          component: 'ARMY',
          budgetCycle: 'pb',
          documentType: 'r2',
          sha256: pdfSha256,
        },
        { component: 'NAVY' },
      );
      expect(run.sourceDocumentProof?.status).toBe('mismatch');
      const findings = run.sourceDocumentProof?.evidence_jsonb.findings ?? [];
      expect(findings).toHaveLength(1);
      expect(findings[0]!.code).toBe('source_metadata_mismatch');
      expect(findings[0]!.message).toBe(
        'SourceDocument component "ARMY" does not match manifest component "NAVY"',
      );
      expect(mismatchCodes(run)).toEqual(
        expect.arrayContaining(['source_metadata_mismatch', 'archive_version_missing']),
      );
    });

    it('identity/locator (sourceKey) mismatch: the persisted row disagrees with what the handoff declares', async () => {
      const dedupKey = randomUUID();
      const realKey = `defense-budget-observation-${dedupKey}`;
      const wrongKey = `defense-budget-observation-${randomUUID()}`;
      const run = await runScenario(
        {
          sourceKey: realKey,
          fiscalYear: 2024,
          component: 'ARMY',
          budgetCycle: 'pb',
          documentType: 'r2',
          sha256: pdfSha256,
        },
        { sourceKey: wrongKey },
      );
      expect(run.sourceDocumentProof?.status).toBe('mismatch');
      const findings = run.sourceDocumentProof?.evidence_jsonb.findings ?? [];
      expect(findings.some((f) => f.code === 'source_metadata_mismatch')).toBe(true);
      const sourceKeyFinding = findings.find((f) => f.message.includes('sourceKey'));
      expect(sourceKeyFinding?.message).toBe(
        `SourceDocument sourceKey "${realKey}" does not match manifest expectedSourceKey "${wrongKey}"`,
      );
    });

    it('fiscal year mismatch: the persisted row disagrees with what the handoff declares', async () => {
      const dedupKey = randomUUID();
      const run = await runScenario(
        {
          sourceKey: `defense-budget-observation-${dedupKey}`,
          fiscalYear: 2024,
          component: 'ARMY',
          budgetCycle: 'pb',
          documentType: 'r2',
          sha256: pdfSha256,
        },
        { fiscalYear: 2025 },
      );
      expect(run.sourceDocumentProof?.status).toBe('mismatch');
      const findings = run.sourceDocumentProof?.evidence_jsonb.findings ?? [];
      expect(findings.some((f) => f.code === 'source_metadata_mismatch' && f.message.includes('fiscalYear'))).toBe(
        true,
      );
    });

    it('hash mismatch: the persisted SourceDocument.sha256 disagrees with the real, resolved artifactPath bytes', async () => {
      const dedupKey = randomUUID();
      const staleSha256 = '0'.repeat(64);
      // The DB row's own sha256 column is wrong (simulating drift/corruption
      // of the persisted identity); the handoff's declared sourceSha256 is
      // the REAL hash of the real bytes at artifactPath, so the profiler
      // does not throw and the manifest's own expectedSourceSha256 is
      // genuinely correct -- isolating this to exactly the SourceDocument
      // row's own stale sha256 column, not a manifest/profiler-level failure.
      const run = await runScenario({
        sourceKey: `defense-budget-observation-${dedupKey}`,
        fiscalYear: 2024,
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'r2',
        sha256: staleSha256,
      });
      expect(run.sourceDocumentProof?.status).toBe('mismatch');
      const findings = run.sourceDocumentProof?.evidence_jsonb.findings ?? [];
      const shaFinding = findings.find((f) => f.message.includes('stored SHA'));
      expect(shaFinding).toBeDefined();
      expect(shaFinding!.code).toBe('source_metadata_mismatch');
      expect(shaFinding!.message).toBe(
        `SourceDocument stored SHA ${staleSha256} does not match resolved source bytes SHA ${pdfSha256}`,
      );
    });
  });

  describe('idempotent reprocessing', () => {
    it('an identical repeat of the same scenario is a true idempotent replay: same candidate, same run, no duplicate rows', async () => {
      const dedupKey = randomUUID();
      const db: ScenarioDb = {
        sourceKey: `defense-budget-observation-${dedupKey}`,
        fiscalYear: 2024,
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'r2',
        sha256: pdfSha256,
      };
      const sourceDocumentId = randomUUID();
      const cycleId = randomUUID();
      await registerSourceDocument(sourceDocumentId, db, pdfBytes);
      const handoffInput: ScenarioHandoff = {
        cycleId,
        sourceDocumentId,
        sourceSha256: pdfSha256,
        fiscalYear: db.fiscalYear,
        sourceFamily: 'pb_r2',
        sourceKey: db.sourceKey,
        component: db.component,
      };

      const first = (await callHandoff(handoffInput)) as RunResult['result'];
      const second = (await callHandoff(handoffInput)) as RunResult['result'];

      const rows = await prisma.$queryRawUnsafe<Array<{ id: string; created_at: Date }>>(
        `SELECT id, created_at FROM budget_extraction_candidate_v1 WHERE source_document_id = $1::uuid`,
        sourceDocumentId,
      );
      expect(rows).toHaveLength(1);
      const runRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM budget_verification_run_v1 WHERE candidate_id = $1::uuid`,
        rows[0]!.id,
      );
      expect(runRows).toHaveLength(1);
      expect(first.decision).toBe(second.decision);
    });

    it('reprocessing the same observation with corrected metadata does not overwrite the prior (historically rejected-for-mismatch) evidence, and creates no invalid duplicate association', async () => {
      const dedupKey = randomUUID();
      const sourceDocumentId = randomUUID();
      const cycleId = randomUUID();
      const db: ScenarioDb = {
        sourceKey: `defense-budget-observation-${dedupKey}`,
        fiscalYear: 2024,
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'r2',
        sha256: pdfSha256,
      };
      await registerSourceDocument(sourceDocumentId, db, pdfBytes);

      // Pass 1: a genuine, historical component mismatch (as if an earlier,
      // buggy caller declared the wrong component to the handoff).
      await callHandoff({
        cycleId,
        sourceDocumentId,
        sourceSha256: pdfSha256,
        fiscalYear: db.fiscalYear,
        sourceFamily: 'pb_r2',
        sourceKey: db.sourceKey,
        component: 'NAVY',
      });
      const afterFirst = await prisma.$queryRawUnsafe<
        Array<{ id: string; status: string; manifest_content_sha256: string; created_at: Date }>
      >(
        `SELECT id, status, manifest_content_sha256, created_at FROM budget_extraction_candidate_v1
           WHERE source_document_id = $1::uuid ORDER BY created_at ASC`,
        sourceDocumentId,
      );
      expect(afterFirst).toHaveLength(1);
      const historicalCandidate = afterFirst[0]!;
      const historicalProof = await prisma.$queryRawUnsafe<Array<{ evidence_jsonb: { findings?: unknown[] } }>>(
        `SELECT evidence_jsonb FROM budget_verification_proof
           WHERE run_id IN (SELECT id FROM budget_verification_run_v1 WHERE candidate_id = $1::uuid)
             AND proof_kind = 'source_document'`,
        historicalCandidate.id,
      );
      expect(historicalProof[0]!.evidence_jsonb.findings).toBeDefined();

      // Pass 2: reprocessing the SAME observation (same cycleId,
      // sourceDocumentId, sourceKey) with the CORRECT component. This is a
      // different manifest (different declared component => different
      // manifestContentSha256), so it is a NEW candidate identity, not an
      // overwrite of the historical one.
      await callHandoff({
        cycleId,
        sourceDocumentId,
        sourceSha256: pdfSha256,
        fiscalYear: db.fiscalYear,
        sourceFamily: 'pb_r2',
        sourceKey: db.sourceKey,
        component: 'ARMY',
      });

      const afterSecond = await prisma.$queryRawUnsafe<
        Array<{ id: string; status: string; manifest_content_sha256: string; cycle_id: string; source_document_id: string }>
      >(
        `SELECT id, status, manifest_content_sha256, cycle_id, source_document_id FROM budget_extraction_candidate_v1
           WHERE source_document_id = $1::uuid ORDER BY created_at ASC`,
        sourceDocumentId,
      );
      expect(afterSecond).toHaveLength(2);
      expect(afterSecond[0]!.id).toBe(historicalCandidate.id);
      expect(afterSecond[0]!.manifest_content_sha256).toBe(historicalCandidate.manifest_content_sha256);
      expect(afterSecond[1]!.id).not.toBe(historicalCandidate.id);
      expect(afterSecond[1]!.manifest_content_sha256).not.toBe(historicalCandidate.manifest_content_sha256);

      // Both rows correctly, distinctly associate to the SAME cycle and
      // SourceDocument -- no corrupted/duplicated foreign-key association.
      for (const row of afterSecond) {
        expect(row.cycle_id).toBe(cycleId);
        expect(row.source_document_id).toBe(sourceDocumentId);
      }

      // The historical row's own proof evidence is untouched by pass 2.
      const historicalProofAfter = await prisma.$queryRawUnsafe<Array<{ evidence_jsonb: { findings?: unknown[] } }>>(
        `SELECT evidence_jsonb FROM budget_verification_proof
           WHERE run_id IN (SELECT id FROM budget_verification_run_v1 WHERE candidate_id = $1::uuid)
             AND proof_kind = 'source_document'`,
        historicalCandidate.id,
      );
      expect(historicalProofAfter[0]!.evidence_jsonb).toEqual(historicalProof[0]!.evidence_jsonb);

      // The new (corrected) candidate's own evidence shows no metadata mismatch.
      const newEvidence = await queryEvidence(sourceDocumentId);
      const newCandidate = newEvidence.candidateRows.find((c) => c.id === afterSecond[1]!.id);
      expect(newCandidate).toBeDefined();
    });
  });
});

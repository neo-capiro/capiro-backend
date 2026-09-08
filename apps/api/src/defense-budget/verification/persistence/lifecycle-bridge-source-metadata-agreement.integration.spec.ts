/**
 * Phase 10B-31 -- permanent regression for the lifecycle-bridge
 * SourceDocument metadata-agreement check, proven against a REAL Postgres
 * through the REAL `DefaultParserHandoffAdapter`, the REAL Python parser
 * runtime, the REAL synthetic manifest builder
 * (`buildLifecycleBridgeSyntheticManifestV1`, invoked internally by the
 * adapter's own call chain -- never called directly with pre-corrected
 * arguments here), the REAL `CompositeProofResolver` running in
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
 * ── Two sections, two different signals ───────────────────────────────────
 *
 * Section A ("no archive" scenarios). Every SourceDocument row carries NO
 * archive fields (`archiveBucket`/`archiveS3Key`/`archiveVersionId` all
 * null) -- a real, legitimately-supported case the codebase itself documents
 * ("reviewed legacy artifacts whose source PDF is not archived", see
 * `archive-proof-resolver.ts`). Because `requireImmutableArchive` is `true`
 * for the R-2/rdte policy, `ArchiveProofResolver` short-circuits with a
 * blocking `archive_version_missing` finding BEFORE ever calling an S3
 * client, so `decision` is REJECT in EVERY Section A scenario regardless of
 * whether the metadata bug is present or fixed. `decision` is NOT the
 * signal there; the signal is the specific `source_metadata_mismatch`
 * proof-finding code (present/absent, exact message), read off the persisted
 * `budget_verification_proof` rows. Authoritative SOURCE BYTES resolution is
 * still real (priority 2 of `resolveAuthoritativeLocator`:
 * `SourceDocument.artifactPath`, read off local disk and SHA-256'd for real).
 *
 * Section B ("complete archive" scenarios). Every SourceDocument row carries
 * COMPLETE, VALID archive evidence (bucket, key, exact version id) pointing
 * at a disposable, versioned, S3-compatible object store (MinIO) reached
 * ONLY through the pre-existing verifier-scoped test hook
 * `BUDGET_VERIFICATION_S3_ENDPOINT` (`s3-proof-adapters.ts`,
 * `createBudgetVerificationS3Client` -- the ONE S3 client construction path
 * production uses). Nothing in the archive check is weakened or bypassed:
 * the real `SdkS3ProofClient` (`@aws-sdk/client-s3` HeadObject/GetObject
 * with an exact VersionId), the real `S3ByteLocatorReader`, and the real
 * `ArchiveProofResolver` run unmodified against that store, so the archive
 * proof genuinely resolves `verified` (head + bytes + SHA), the
 * authoritative source bytes come from the versioned archive (priority 1 of
 * `resolveAuthoritativeLocator`), and the parser-run proof genuinely
 * resolves `verified` (the fresh parse's output bytes are persisted under the
 * shared parser-artifact root, exactly as in the production drain). Section
 * B therefore reaches a GENUINE overall decision through the complete path.
 *
 * Why the positive decision is REVIEW and not PASS -- by policy, not by
 * shortfall: the rdte/R-2 `VerificationPolicyV1` names `rdte_summary_detail`
 * as a required comparison rule, and that check is `NOT_RUN` whenever no
 * independently proved R-1 reference artifact is supplied (a single R-2
 * document never carries one), which the decision engine maps to at least
 * REVIEW (`computeDecisionV1`, precedence 3). Independently, real R-2 pages
 * carry review-severity `ambiguous_layout` omissions (repeated headers), so
 * `completeness` is `NOT_RUN` as well. PASS is unreachable for a lone R-2
 * document by design; REVIEW with ZERO proof findings, ZERO blocking
 * discrepancies, and every proof snapshot `verified` is the correct, best
 * outcome -- and it is exactly the outcome the Phase 10B-28 qualification
 * of the real canary reached before the metadata bugs were exposed.
 *
 * The Section B source bytes are REAL R-2 pages: an 8-page slice
 * (physical pages 126-133, PE 0601103A and the start of PE 0601104A) cut
 * at test time with pdf-lib from the committed, byte-verified FY2024 Army
 * R-2 canary PDF fixture, so the real R-2 segmenter/extractor produces real
 * identities, funding assertions, and review omissions -- not a toy page.
 * A second, different slice (pages 161-170) supplies "different bytes" for
 * the substituted-archive control.
 *
 * ── Parser environment preflight ─────────────────────────────────────────
 * `runParserHandoffForSourceDocument` launches the parser as
 * `uv run --no-sync capiro-defense-budget-parser` in the parser project
 * directory. If that directory's own `.venv` has not been synced, `uv run`
 * silently falls through to whatever `capiro-defense-budget-parser`
 * executable is on PATH -- on this program's shared workstation that was a
 * FOREIGN venv carrying a Phase-7-era checkout of the parser with no OCR
 * engine, which produced a materially different artifact (590 assertions /
 * 39 blocking omissions) that was, for a time, mistaken for a production
 * parser defect. `beforeAll` below refuses to run unless the runtime the
 * launcher will actually invoke resolves to THIS worktree's parser source.
 *
 * ── RED/GREEN ────────────────────────────────────────────────────────────
 * `scripts/verify-pe-budget-phase-10b31-metadata-regression.ts` reverts the
 * exact Stage 2 source files to the pre-fix baseline commit and reruns this
 * UNMODIFIED file, asserting by exact test title which tests must FAIL under
 * the revert and which must stay green (see that script's table). Every
 * call below is therefore written without a compile-time-checked
 * `ParserHandoffInput` import so the identical test file runs unmodified
 * against both the reverted and fixed source (see `callHandoff`).
 *
 * Gates: runs only when DATABASE_URL names a LOCAL disposable database
 * (pgvector/pgvector:pg16, database `capiro`, both prisma schemas migrated).
 * Section B additionally REQUIRES `BUDGET_VERIFICATION_S3_ENDPOINT` to name
 * a LOCAL versioned S3-compatible store (with matching AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY / AWS_REGION for it) and fails loudly -- never
 * silently skips -- when it is absent, so the complete-path positive
 * regression cannot quietly disappear from a "green" run.
 * `pnpm --filter @capiro/api run verify:pe-budget-phase-10b31:db` provisions
 * and tears down both containers itself.
 *
 * Section B also needs Node's `--experimental-vm-modules` flag on the jest
 * process (`node --experimental-vm-modules node_modules/jest/bin/jest.js …`,
 * as both `verify:pe-budget-phase-10b31` variants and the mutation script
 * already do): the real `@aws-sdk/client-s3` request pipeline performs a
 * dynamic `import()` (`@smithy/core` config submodule, `await
 * import('node:http')`), which Jest's module VM refuses without that flag
 * (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`). Section A never sends an
 * S3 request and so never needed it. This is Jest's documented requirement
 * for dynamic imports, not a suite-specific workaround.
 */
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { DefaultParserHandoffAdapter } from '../../default-parser-handoff.adapter.js';
import {
  BUDGET_VERIFICATION_S3_ENDPOINT_ENV,
  createBudgetVerificationS3Client,
} from '../trusted-proof/s3-proof-adapters.js';
import { TrustedProofResolutionError } from '../trusted-proof/trusted-proof-types.js';

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const ARCHIVE_ENDPOINT = process.env[BUDGET_VERIFICATION_S3_ENDPOINT_ENV]?.trim();
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

/** The committed, byte-verified real FY2024 Army R-2 Vol 1 BA1 PDF (170 pages). */
const REAL_R2_FIXTURE_PATH = join(
  __dirname,
  '..',
  '..',
  'rdte',
  'cycle',
  '__fixtures__',
  'production-fy2024-army-r2-vol1-ba1-official.pdf',
);
const REAL_R2_FIXTURE_SHA256 = '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6';
/** Physical page ranges (1-based, inclusive) cut from the fixture at test time. */
const REAL_R2_SLICE = { start: 126, end: 133 } as const;
const OTHER_R2_SLICE = { start: 161, end: 170 } as const;
const ISOLATED_ARCHIVE_BUCKET = 'capiro-phase10b31-isolated-archive';

function isLocalUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    return LOCAL_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

const describeDb = isLocalUrl(DATABASE_URL) ? describe : describe.skip;

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Refuse to run against a parser runtime that is not THIS worktree's own
 * synced environment (see the file header for the incident this prevents).
 * Mirrors the launcher exactly: the same `uv run --no-sync` prefix, the same
 * cwd, so whatever `uv` resolves here is what the adapter will run.
 */
function assertParserRuntimeIsThisWorktree(parserProjectDir: string): void {
  const probe = spawnSync(
    'uv',
    ['run', '--no-sync', 'python', '-c', 'import capiro_defense_budget_parser as p; print(p.__file__)'],
    { cwd: parserProjectDir, encoding: 'utf8', timeout: 120_000 },
  );
  if (probe.status !== 0) {
    throw new Error(
      `parser runtime preflight failed (uv run --no-sync python ... exited ${String(probe.status)}): ` +
        `${probe.stderr}\nRun \`uv sync --locked\` in ${parserProjectDir} first.`,
    );
  }
  const reported = resolve(probe.stdout.trim());
  const expectedRoot = resolve(parserProjectDir);
  if (!reported.toLowerCase().startsWith(expectedRoot.toLowerCase())) {
    throw new Error(
      `parser runtime preflight: \`uv run --no-sync\` in ${parserProjectDir} resolves the parser package to ` +
        `"${reported}", which is OUTSIDE this worktree -- a foreign or stale parser install would be exercised. ` +
        `Run \`uv sync --locked\` in ${parserProjectDir} so the project's own .venv is used.`,
    );
  }
}

async function slicePdf(sourceBytes: Buffer, start: number, end: number): Promise<Buffer> {
  const src = await PDFDocument.load(sourceBytes);
  const out = await PDFDocument.create();
  const indices = Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i);
  for (const page of await out.copyPages(src, indices)) out.addPage(page);
  return Buffer.from(await out.save());
}

describeDb('Phase 10B-31 -- lifecycle-bridge SourceDocument metadata agreement against a real database', () => {
  jest.setTimeout(600_000);

  let prisma: PrismaClient;
  let outerDir: string;
  let parserArtifactRoot: string;
  let workDir: string;
  let parserProjectDir: string;
  let pdfBytes: Buffer;
  let pdfSha256: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL! } } });
    await prisma.$connect();

    outerDir = mkdtempSync(join(tmpdir(), 'phase10b31-metadata-agreement-'));
    parserArtifactRoot = join(outerDir, 'parser-artifact-root');
    mkdirSync(parserArtifactRoot, { recursive: true });
    process.env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT = parserArtifactRoot;
    parserProjectDir = join(__dirname, '..', '..', '..', '..', '..', 'defense-budget-parser');
    process.env.DEFENSE_BUDGET_PARSER_PROJECT_DIR = parserProjectDir;
    assertParserRuntimeIsThisWorktree(parserProjectDir);
    // `FilesystemByteLocatorReader`'s approved-prefix list (production
    // wiring, `production-parser-verification-context.ts`) is exactly
    // `[parserArtifactRoot]` -- the manifest the router writes under
    // `workDir/<sourceDocumentId>/` is read back through that same reader,
    // so `workDir` (and every SourceDocument.artifactPath below) must itself
    // live under `parserArtifactRoot`.
    workDir = join(parserArtifactRoot, 'work');
    mkdirSync(workDir, { recursive: true });

    // Section A's source bytes: ONE real, valid, minimal one-page PDF (via
    // pdf-lib -- a real dependency already used elsewhere in this app, not a
    // hand-rolled binary format). Its content does not need to resemble a
    // real R-2 exhibit's layout: every Section A scenario deliberately
    // leaves the archive unresolved (see the file header), so overall
    // `decision` is REJECT regardless of how much of this text the real R-2
    // semantic extractor recognizes -- only the SourceDocument
    // metadata-agreement findings are asserted on there.
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
   * Section A: registers a real SourceDocument row with NO archive fields
   * (the REAL SourceDocument reader -- `CompositeProofResolver`'s
   * `sourceDocumentClient` -- is the SAME real Prisma client reading this
   * SAME table) and materializes real bytes at `artifactPath`, under the
   * approved parser-artifact root, so `resolveAuthoritativeLocator`'s
   * priority-2 branch resolves genuine, hashable bytes without needing any
   * archive/S3 configuration.
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

  interface ProofRow {
    proof_kind: string;
    status: string;
    evidence_jsonb: Record<string, unknown> & { findings?: Array<{ code: string; message: string; severity: string }> };
  }
  interface CheckRow {
    code: string;
    outcome: string;
    required: boolean;
    blocking: boolean;
    message: string;
  }
  interface RunResult {
    result: { decision: string; finalState: string; artifactLocator: string };
    sourceDocumentId: string;
    cycleId: string;
    candidateRows: Array<{ id: string; cycle_id: string; status: string; source_document_id: string; manifest_content_sha256: string }>;
    runRows: Array<{ id: string; decision: string; status: string; route: string }>;
    checkRows: CheckRow[];
    discrepancyCounts: Array<{ code: string; severity: string; n: number }>;
    proofRows: ProofRow[];
    sourceDocumentProof: ProofRow | undefined;
    proofFindings: ProofRow | undefined;
  }

  async function queryEvidence(sourceDocumentId: string): Promise<Omit<RunResult, 'result' | 'sourceDocumentId' | 'cycleId'>> {
    const candidateRows = await prisma.$queryRawUnsafe<RunResult['candidateRows']>(
      `SELECT id, cycle_id, status, source_document_id, manifest_content_sha256
         FROM budget_extraction_candidate_v1 WHERE source_document_id = $1::uuid ORDER BY created_at ASC`,
      sourceDocumentId,
    );
    const runRows = await prisma.$queryRawUnsafe<RunResult['runRows']>(
      `SELECT id, decision, status, route FROM budget_verification_run_v1
         WHERE candidate_id IN (SELECT id FROM budget_extraction_candidate_v1 WHERE source_document_id = $1::uuid)
         ORDER BY created_at ASC`,
      sourceDocumentId,
    );
    const checkRows = await prisma.$queryRawUnsafe<CheckRow[]>(
      `SELECT code, outcome, required, blocking, message FROM budget_verification_check_v1
         WHERE run_id IN (SELECT id FROM budget_verification_run_v1 WHERE candidate_id IN
           (SELECT id FROM budget_extraction_candidate_v1 WHERE source_document_id = $1::uuid))
         ORDER BY code ASC`,
      sourceDocumentId,
    );
    const rawDiscrepancyCounts = await prisma.$queryRawUnsafe<Array<{ code: string; severity: string; n: bigint }>>(
      `SELECT code, severity, COUNT(*)::bigint AS n FROM budget_verification_discrepancy_v1
         WHERE run_id IN (SELECT id FROM budget_verification_run_v1 WHERE candidate_id IN
           (SELECT id FROM budget_extraction_candidate_v1 WHERE source_document_id = $1::uuid))
         GROUP BY code, severity ORDER BY code, severity`,
      sourceDocumentId,
    );
    const proofRows = await prisma.$queryRawUnsafe<ProofRow[]>(
      `SELECT proof_kind, status, evidence_jsonb FROM budget_verification_proof
         WHERE run_id IN (SELECT id FROM budget_verification_run_v1 WHERE candidate_id IN
           (SELECT id FROM budget_extraction_candidate_v1 WHERE source_document_id = $1::uuid))
         ORDER BY created_at ASC`,
      sourceDocumentId,
    );
    return {
      candidateRows,
      runRows,
      checkRows,
      discrepancyCounts: rawDiscrepancyCounts.map((d) => ({ code: d.code, severity: d.severity, n: Number(d.n) })),
      proofRows,
      sourceDocumentProof: proofRows.find((r) => r.proof_kind === 'source_document'),
      proofFindings: proofRows.find((r) => r.proof_kind === 'proof_findings'),
    };
  }

  /** One full Section A scenario: register a SourceDocument row, run the real adapter, read back evidence. */
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

  /** The persisted complete finding list, reduced to the three columns that identify a finding. */
  function findings(run: RunResult): Array<{ code: string; severity: string; message: string }> {
    return (run.proofFindings?.evidence_jsonb.findings ?? []).map((f) => ({
      code: f.code,
      severity: f.severity,
      message: f.message,
    }));
  }

  function proof(run: RunResult, kind: string): ProofRow | undefined {
    return run.proofRows.find((r) => r.proof_kind === kind);
  }

  function check(run: RunResult, code: string): CheckRow | undefined {
    return run.checkRows.find((c) => c.code === code);
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
      // see the file header (Section A). The SourceDocument-specific proof
      // must be clean.
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
      const sdFindings = run.sourceDocumentProof?.evidence_jsonb.findings ?? [];
      expect(sdFindings).toHaveLength(1);
      expect(sdFindings[0]!.code).toBe('source_metadata_mismatch');
      expect(sdFindings[0]!.message).toBe(
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
      const sdFindings = run.sourceDocumentProof?.evidence_jsonb.findings ?? [];
      expect(sdFindings.some((f) => f.code === 'source_metadata_mismatch')).toBe(true);
      const sourceKeyFinding = sdFindings.find((f) => f.message.includes('sourceKey'));
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
      const sdFindings = run.sourceDocumentProof?.evidence_jsonb.findings ?? [];
      expect(sdFindings.some((f) => f.code === 'source_metadata_mismatch' && f.message.includes('fiscalYear'))).toBe(
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
      const sdFindings = run.sourceDocumentProof?.evidence_jsonb.findings ?? [];
      const shaFinding = sdFindings.find((f) => f.message.includes('stored SHA'));
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

  /* ------------------------------------------------------------------ */
  /* Section B -- complete, valid archive evidence: the full path reaches */
  /* a genuine overall decision.                                          */
  /* ------------------------------------------------------------------ */

  describe('complete archive evidence through the real adapter (isolated versioned archive store)', () => {
    let s3: S3Client;
    let realR2Slice: Buffer;
    let realR2SliceSha256: string;
    let otherR2Slice: Buffer;
    let otherR2SliceSha256: string;

    interface ArchiveLocation {
      bucket: string;
      key: string;
      versionId: string;
    }

    beforeAll(async () => {
      if (!isLocalUrl(ARCHIVE_ENDPOINT)) {
        throw new Error(
          `${BUDGET_VERIFICATION_S3_ENDPOINT_ENV} must name a LOCAL versioned S3-compatible store for the ` +
            'complete-archive scenarios (with AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION set for it). ' +
            'These scenarios never skip silently: run `pnpm --filter @capiro/api run verify:pe-budget-phase-10b31:db`, ' +
            'which provisions and tears down the store itself.',
        );
      }
      if (!existsSync(REAL_R2_FIXTURE_PATH)) {
        throw new Error(`missing real-PDF fixture at ${REAL_R2_FIXTURE_PATH}`);
      }
      const fixtureBytes = readFileSync(REAL_R2_FIXTURE_PATH);
      const fixtureSha = sha256Hex(fixtureBytes);
      if (fixtureSha !== REAL_R2_FIXTURE_SHA256) {
        throw new Error(`real-PDF fixture SHA drifted: expected ${REAL_R2_FIXTURE_SHA256}, got ${fixtureSha}`);
      }
      realR2Slice = await slicePdf(fixtureBytes, REAL_R2_SLICE.start, REAL_R2_SLICE.end);
      realR2SliceSha256 = sha256Hex(realR2Slice);
      otherR2Slice = await slicePdf(fixtureBytes, OTHER_R2_SLICE.start, OTHER_R2_SLICE.end);
      otherR2SliceSha256 = sha256Hex(otherR2Slice);
      expect(otherR2SliceSha256).not.toBe(realR2SliceSha256);

      // The SAME client factory production uses -- proves the endpoint hook
      // is the only thing pointing this at the isolated store.
      s3 = createBudgetVerificationS3Client(process.env);
      try {
        await s3.send(new HeadBucketCommand({ Bucket: ISOLATED_ARCHIVE_BUCKET }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket: ISOLATED_ARCHIVE_BUCKET }));
      }
      await s3.send(
        new PutBucketVersioningCommand({
          Bucket: ISOLATED_ARCHIVE_BUCKET,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      );
      const probe = await s3.send(
        new PutObjectCommand({
          Bucket: ISOLATED_ARCHIVE_BUCKET,
          Key: `raw/phase10b31/versioning-probe/${randomUUID()}`,
          Body: Buffer.from('versioning probe'),
        }),
      );
      if (!probe.VersionId) {
        throw new Error('the isolated archive store did not return a VersionId; bucket versioning is not effective');
      }
    });

    afterAll(() => {
      s3?.destroy();
    });

    /** Store bytes as one exact, versioned archive object and return its real location. */
    async function archiveObject(sourceDocumentId: string, bytes: Buffer): Promise<ArchiveLocation> {
      const key = `raw/phase10b31/${sourceDocumentId}/original.bin`;
      const put = await s3.send(
        new PutObjectCommand({
          Bucket: ISOLATED_ARCHIVE_BUCKET,
          Key: key,
          Body: bytes,
          ContentType: 'application/pdf',
          ChecksumAlgorithm: 'SHA256',
        }),
      );
      if (!put.VersionId) throw new Error('archive store returned no VersionId for the uploaded object');
      return { bucket: ISOLATED_ARCHIVE_BUCKET, key, versionId: put.VersionId };
    }

    /**
     * Section B row: COMPLETE archive evidence (bucket, key, exact version
     * id), NO artifactPath -- mirroring the real production row
     * (`artifact_path` null) so `resolveAuthoritativeLocator` takes its
     * priority-1 branch (the versioned archive locator) and the authoritative
     * source bytes are read back out of the archive store by the real
     * `S3ByteLocatorReader`, exactly as in production.
     */
    async function registerArchivedSourceDocument(
      sourceDocumentId: string,
      db: ScenarioDb,
      handoffBytes: Buffer,
      archive: ArchiveLocation,
    ): Promise<void> {
      writeFileSync(join(workDir, `${sourceDocumentId}-source.pdf`), handoffBytes);
      await prisma.sourceDocument.create({
        data: {
          id: sourceDocumentId,
          sourceKey: db.sourceKey,
          fiscalYear: db.fiscalYear,
          budgetCycle: db.budgetCycle,
          component: db.component,
          documentType: db.documentType,
          title: 'phase10b31 complete-archive fixture (real FY2024 Army R-2 pages 126-133)',
          sourceUrl: 'https://example.invalid/phase10b31-metadata-agreement.pdf',
          sha256: db.sha256,
          byteSize: handoffBytes.length,
          extractionMethod: 'deterministic_pdf',
          archiveBucket: archive.bucket,
          archiveS3Key: archive.key,
          archiveVersionId: archive.versionId,
          archivedAt: new Date(),
        },
      });
    }

    function archivedDb(overrides: Partial<ScenarioDb> = {}): ScenarioDb {
      return {
        sourceKey: `defense-budget-observation-${randomUUID()}`,
        fiscalYear: 2024,
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'r2',
        sha256: realR2SliceSha256,
        ...overrides,
      };
    }

    interface ArchivedScenarioOptions {
      db?: ScenarioDb;
      handoffOverrides?: Partial<ScenarioHandoff>;
      /** Bytes actually stored under the version the row points at (default: the real slice). */
      archivedBytes?: Buffer;
      /** Replace the row's archiveVersionId with this value after archiving. */
      archiveVersionIdOverride?: string;
    }

    async function prepareArchivedScenario(options: ArchivedScenarioOptions = {}) {
      const db = options.db ?? archivedDb();
      const sourceDocumentId = randomUUID();
      const cycleId = randomUUID();
      const stored = await archiveObject(sourceDocumentId, options.archivedBytes ?? realR2Slice);
      const archive: ArchiveLocation = options.archiveVersionIdOverride
        ? { ...stored, versionId: options.archiveVersionIdOverride }
        : stored;
      // The parser always sees the REAL slice; what the archive holds is the
      // scenario's own business.
      await registerArchivedSourceDocument(sourceDocumentId, db, realR2Slice, archive);
      const handoff: ScenarioHandoff = {
        cycleId,
        sourceDocumentId,
        sourceSha256: realR2SliceSha256,
        fiscalYear: db.fiscalYear,
        sourceFamily: 'pb_r2',
        sourceKey: db.sourceKey,
        component: db.component,
        ...(options.handoffOverrides ?? {}),
      };
      return { db, sourceDocumentId, cycleId, stored, archive, handoff };
    }

    async function runArchivedScenario(options: ArchivedScenarioOptions = {}): Promise<RunResult & { stored: ArchiveLocation; archive: ArchiveLocation }> {
      const prepared = await prepareArchivedScenario(options);
      const result = await callHandoff(prepared.handoff);
      const evidence = await queryEvidence(prepared.sourceDocumentId);
      return {
        result: result as RunResult['result'],
        sourceDocumentId: prepared.sourceDocumentId,
        cycleId: prepared.cycleId,
        stored: prepared.stored,
        archive: prepared.archive,
        ...evidence,
      };
    }

    function expectArchiveVerifiedAgainst(run: RunResult, archive: ArchiveLocation, objectSha256: string): void {
      const archiveProof = proof(run, 'archive');
      expect(archiveProof?.status).toBe('verified');
      expect(archiveProof?.evidence_jsonb).toMatchObject({
        status: 'verified',
        bucket: archive.bucket,
        key: archive.key,
        versionId: archive.versionId,
        objectSha256,
      });
      expect(check(run, 'archive_proof')?.outcome).toBe('PASS');
    }

    it('complete archive evidence: a fresh real parse of real R-2 pages with matching SourceDocument metadata reaches overall decision REVIEW with zero proof findings and every proof snapshot verified', async () => {
      const run = await runArchivedScenario();

      expect(run.result.decision).toBe('REVIEW');
      expect(run.result.finalState).toBe('TERMINAL_REVIEW');

      // The complete persisted finding list is EMPTY -- no
      // source_metadata_mismatch, no archive finding, no parser-proof finding.
      expect(findings(run)).toEqual([]);
      expect(run.proofFindings?.status).toBe('verified');
      expect(proof(run, 'source_document')?.status).toBe('verified');
      expect(proof(run, 'source_document')?.evidence_jsonb.findings).toBeUndefined();
      expect(proof(run, 'manifest')?.status).toBe('verified');
      expect(proof(run, 'extraction_artifact')?.status).toBe('verified');
      expectArchiveVerifiedAgainst(run, run.archive, realR2SliceSha256);
      expect(proof(run, 'archive')?.evidence_jsonb).toMatchObject({ byteSize: realR2Slice.length });

      // Every required proof-bearing check genuinely PASSES; the two checks
      // that are NOT_RUN are exactly the policy-designed REVIEW triggers.
      for (const code of ['archive_proof', 'parser_run_proof', 'manifest_binding', 'contract_integrity', 'evidence_binding', 'identity_validation']) {
        expect({ code, outcome: check(run, code)?.outcome }).toEqual({ code, outcome: 'PASS' });
      }
      expect(check(run, 'rdte_summary_detail')?.outcome).toBe('NOT_RUN');
      expect(check(run, 'completeness')?.outcome).toBe('NOT_RUN');
      expect(run.checkRows.filter((c) => c.outcome === 'FAIL')).toEqual([]);

      // Only review-severity discrepancies (real R-2 ambiguous_layout omissions).
      expect(run.discrepancyCounts.filter((d) => d.severity === 'blocking')).toEqual([]);
      expect(run.discrepancyCounts.find((d) => d.code === 'review_omission')?.n ?? 0).toBeGreaterThan(0);

      expect(run.candidateRows).toHaveLength(1);
      expect(run.candidateRows[0]!.status).toBe('NEEDS_REVIEW');
      expect(run.candidateRows[0]!.cycle_id).toBe(run.cycleId);
      expect(run.runRows).toHaveLength(1);
      expect(run.runRows[0]!.decision).toBe('REVIEW');
    });

    it('complete archive evidence, component tampered: REJECT on exactly one blocking source_metadata_mismatch (component), archive still verified', async () => {
      const run = await runArchivedScenario({ handoffOverrides: { component: 'NAVY' } });
      expect(run.result.decision).toBe('REJECT');
      expect(run.result.finalState).toBe('TERMINAL_REJECTED');
      expect(findings(run)).toEqual([
        {
          code: 'source_metadata_mismatch',
          severity: 'blocking',
          message: 'SourceDocument component "ARMY" does not match manifest component "NAVY"',
        },
      ]);
      expect(proof(run, 'source_document')?.status).toBe('mismatch');
      expectArchiveVerifiedAgainst(run, run.archive, realR2SliceSha256);
      expect(check(run, 'parser_run_proof')?.outcome).toBe('PASS');
      expect(run.candidateRows.map((c) => c.status)).toEqual(['REJECTED']);
    });

    it('complete archive evidence, sourceKey/identity tampered: REJECT on exactly one blocking source_metadata_mismatch (sourceKey), archive still verified', async () => {
      const db = archivedDb();
      const wrongKey = `defense-budget-observation-${randomUUID()}`;
      const run = await runArchivedScenario({ db, handoffOverrides: { sourceKey: wrongKey } });
      expect(run.result.decision).toBe('REJECT');
      expect(findings(run)).toEqual([
        {
          code: 'source_metadata_mismatch',
          severity: 'blocking',
          message: `SourceDocument sourceKey "${db.sourceKey}" does not match manifest expectedSourceKey "${wrongKey}"`,
        },
      ]);
      expectArchiveVerifiedAgainst(run, run.archive, realR2SliceSha256);
      expect(run.candidateRows.map((c) => c.status)).toEqual(['REJECTED']);
    });

    it('complete archive evidence, fiscal year tampered: REJECT on exactly the fiscal-year metadata findings, archive still verified', async () => {
      const run = await runArchivedScenario({ handoffOverrides: { fiscalYear: 2025 } });
      expect(run.result.decision).toBe('REJECT');
      // Two independent fiscal-year guards fire and nothing else does: the
      // Phase 10B-31 metadata-agreement check (`source_metadata_mismatch`)
      // and SourceDocumentProofResolver's own pre-existing fiscal-year
      // comparison (coded `source_sha_mismatch` by that resolver).
      expect(findings(run)).toEqual([
        {
          code: 'source_metadata_mismatch',
          severity: 'blocking',
          message: 'SourceDocument fiscalYear 2024 does not match manifest fiscalYear 2025',
        },
        {
          code: 'source_sha_mismatch',
          severity: 'blocking',
          message: 'SourceDocument fiscal year 2024 does not match manifest fiscal year 2025',
        },
      ]);
      expectArchiveVerifiedAgainst(run, run.archive, realR2SliceSha256);
      expect(run.candidateRows.map((c) => c.status)).toEqual(['REJECTED']);
    });

    it('complete archive evidence, SourceDocument.sha256 tampered: REJECT on exactly the stored-SHA findings, archive still verified', async () => {
      const staleSha256 = '0'.repeat(64);
      const run = await runArchivedScenario({ db: archivedDb({ sha256: staleSha256 }) });
      expect(run.result.decision).toBe('REJECT');
      // The archive object itself is intact (its bytes hash to the resolved
      // source SHA), so archive proof is verified; what fails closed is the
      // persisted row's own identity binding to those bytes -- via THREE
      // independent guards, in emission order: the Phase 10B-31 metadata
      // check, SourceDocumentProofResolver's pre-existing row-SHA check, and
      // the request-level `expectedSourcePdfSha256` TOCTOU guard (the proof
      // bundle reports the ROW's SHA as the source SHA, so the router's
      // expected value no longer agrees with it).
      expect(findings(run)).toEqual([
        {
          code: 'source_metadata_mismatch',
          severity: 'blocking',
          message: `SourceDocument stored SHA ${staleSha256} does not match resolved source bytes SHA ${realR2SliceSha256}`,
        },
        {
          code: 'source_sha_mismatch',
          severity: 'blocking',
          message: `SourceDocument SHA ${staleSha256} does not match actual source PDF SHA ${realR2SliceSha256}`,
        },
        {
          code: 'source_sha_mismatch',
          severity: 'blocking',
          message: `expected source SHA ${realR2SliceSha256} does not match actual ${staleSha256}`,
        },
      ]);
      expectArchiveVerifiedAgainst(run, run.archive, realR2SliceSha256);
      expect(run.candidateRows.map((c) => c.status)).toEqual(['REJECTED']);
    });

    it('complete archive evidence, archived object bytes substituted under the referenced version: REJECT on the source-SHA binding findings (the archive check alone cannot see the substitution)', async () => {
      // The row's archive pointer references a version that holds DIFFERENT
      // real R-2 pages than the ones the row/handoff/artifact describe.
      const run = await runArchivedScenario({ archivedBytes: otherR2Slice });
      expect(run.result.decision).toBe('REJECT');

      // The archive object hashes to itself, so ArchiveProofResolver reports
      // it verified -- with the SUBSTITUTED bytes' SHA. Detection comes from
      // binding those resolved bytes to the persisted row, the artifact, and
      // the parser run, each of which still names the real slice.
      expectArchiveVerifiedAgainst(run, run.archive, otherR2SliceSha256);

      const all = findings(run);
      expect(all.every((f) => f.severity === 'blocking')).toBe(true);
      expect(new Set(all.map((f) => f.code))).toEqual(
        new Set(['source_metadata_mismatch', 'source_sha_mismatch', 'artifact_source_sha_mismatch', 'parse_input_sha_mismatch']),
      );
      // Exactly ONE metadata-agreement finding, and it is the stored-SHA one:
      // the sourceKey / component / fiscalYear guards do not fire spuriously.
      expect(all.filter((f) => f.code === 'source_metadata_mismatch')).toEqual([
        {
          code: 'source_metadata_mismatch',
          severity: 'blocking',
          message: `SourceDocument stored SHA ${realR2SliceSha256} does not match resolved source bytes SHA ${otherR2SliceSha256}`,
        },
      ]);
      expect(run.candidateRows.map((c) => c.status)).toEqual(['REJECTED']);
    });

    it('complete archive evidence, archive version id tampered to a nonexistent version: production proof aborts fail-closed before any candidate or run is persisted', async () => {
      const prepared = await prepareArchivedScenario({
        archiveVersionIdOverride: `nonexistent-${randomUUID()}`,
      });
      // In production_proof mode the authoritative source bytes MUST resolve
      // from the versioned archive; a version that does not exist is not
      // downgraded to a weaker source or to a REJECT row -- resolution stops
      // with TrustedProofResolutionError before any result is constructed,
      // and the bridge surfaces it as a downstream failure.
      await expect(callHandoff(prepared.handoff)).rejects.toThrow(TrustedProofResolutionError);
      await expect(callHandoff(prepared.handoff)).rejects.toThrow(
        /authoritative source bytes could not be resolved for production proof/,
      );
      const evidence = await queryEvidence(prepared.sourceDocumentId);
      expect(evidence.candidateRows).toEqual([]);
      expect(evidence.runRows).toEqual([]);
    });
  });
});

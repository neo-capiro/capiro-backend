/**
 * Phase 10B-2D -- dedicated real-adapter spec for
 * `PrismaMaterializationArtifactSourceV1`.
 *
 * Table-routed fake Prisma idiom, matching
 * `prisma-family-reconciliation-certification-v1.spec.ts`'s `FakeCertPrisma`
 * and `phase10b2-repair-findings.md` §5. Artifact bytes are read from real
 * temp files via `node:fs` -- this adapter's own `loadVerifiedArtifact`
 * reads the filesystem directly (not through Prisma), so a real byte-level
 * SHA mismatch can only be proven with a real file on disk.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PrismaMaterializationArtifactSourceV1 } from './prisma-materialization-artifact-source-v1.js';
import type { S3ByteReaderPortV1 } from './prisma-materialization-artifact-source-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';

const SHA = 'a'.repeat(64);

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function makeArtifactJson(artifactId: string): DefenseBudgetExtractionArtifactV1 {
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId,
    contentSha256: SHA,
    source: {
      manifestDocumentKey: 'o1',
      sourcePdfSha256: SHA,
      sourceLocator: 's3://bucket/o1.pdf',
      fiscalYear: 2027,
      family: 'om',
      exhibit: 'O-1',
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb_fy2027',
      documentType: 'pb_exhibit',
    },
    parserRuns: [],
    evidence: [],
    sourceFacts: [],
    assertions: [
      {
        assertionId: 'asrt_1',
        assertionKind: 'om_line',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        identity: { lineKind: 'OM_SAG', code: 'SAG1', account: 'O&M, ARMY', component: 'ARMY' },
        title: 'Operations and Maintenance Support',
      },
      {
        assertionId: 'asrt_2',
        assertionKind: 'om_line',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        identity: { lineKind: 'OM_SAG', code: 'SAG2', account: 'O&M, ARMY', component: 'ARMY' },
        title: 'A second, unaccepted assertion',
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

/** Table-routed fake serving both loadCandidateRefs and loadAcceptedAssertionIds. */
class FakeMaterializationPrisma {
  public readonly queries: Array<{ query: string; values: unknown[] }> = [];
  constructor(
    private readonly candidateRows: Array<Record<string, unknown>> = [],
    private readonly verificationRunRows: Array<Record<string, unknown>> = [],
  ) {}

  async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
    this.queries.push({ query, values });
    if (query.includes('FROM "budget_extraction_candidate_v1"')) {
      return this.candidateRows as unknown as T;
    }
    if (query.includes('FROM "budget_verification_run_v1"')) {
      const runId = values[0];
      return this.verificationRunRows.filter((row) => row.id === runId || true) as unknown as T;
      // NOTE: real SQL filters by id; the fake below scopes per-test by only
      // registering the one row a given test expects.
    }
    throw new Error(`unexpected query in fake: ${query}`);
  }
}

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialization-artifact-source-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeArtifactFile(content: DefenseBudgetExtractionArtifactV1): { locator: string; sha256: string } {
  const bytes = Buffer.from(JSON.stringify(content), 'utf8');
  const locator = path.join(tempDir, 'artifact.json');
  fs.writeFileSync(locator, bytes);
  return { locator, sha256: sha256Hex(bytes) };
}

describe('PrismaMaterializationArtifactSourceV1 — loadCandidateRefs', () => {
  it('returns only rows with a resolvable current run decision, and passes cycleId + document keys as bound params', async () => {
    const prisma = new FakeMaterializationPrisma([
      {
        manifestDocumentKey: 'o1',
        extractionArtifactId: 'art_o1',
        extractionArtifactSha256: SHA,
        extractionArtifactLocator: '/fixture/o1.json',
        sourceDocumentId: 'doc_o1',
        sourceSha256: SHA,
        candidateId: 'cand_o1',
        manifestContentSha256: SHA,
        currentRunId: 'run_o1',
        runDecision: 'PASS',
        runStatus: 'VERIFICATION_PASSED',
      },
    ]);
    const adapter = new PrismaMaterializationArtifactSourceV1(prisma);
    const refs = await adapter.loadCandidateRefs({
      cycleId: 'cycle-1',
      manifestDocumentKeys: ['o1', 'op5'],
    });

    expect(refs.size).toBe(1);
    expect(refs.get('o1')?.decision).toBe('PASS');
    expect(refs.get('o1')?.status).toBe('VERIFICATION_PASSED');
    const candidateQuery = prisma.queries.find((q) => q.query.includes('budget_extraction_candidate_v1'));
    expect(candidateQuery?.values).toEqual(['cycle-1', 'o1', 'op5']);
  });

  it('omits a candidate with no resolvable current run (never guesses a status)', async () => {
    const prisma = new FakeMaterializationPrisma([
      {
        manifestDocumentKey: 'o1',
        extractionArtifactId: 'art_o1',
        extractionArtifactSha256: SHA,
        extractionArtifactLocator: '/fixture/o1.json',
        sourceDocumentId: 'doc_o1',
        sourceSha256: SHA,
        candidateId: 'cand_o1',
        manifestContentSha256: SHA,
        currentRunId: null,
        runDecision: null,
        runStatus: null,
      },
    ]);
    const adapter = new PrismaMaterializationArtifactSourceV1(prisma);
    const refs = await adapter.loadCandidateRefs({ cycleId: 'cycle-1', manifestDocumentKeys: ['o1'] });
    expect(refs.size).toBe(0);
  });

  it('throws rather than guessing a locator for a pre-Phase-10B-2C row missing extraction_artifact_locator', async () => {
    const prisma = new FakeMaterializationPrisma([
      {
        manifestDocumentKey: 'o1',
        extractionArtifactId: 'art_o1',
        extractionArtifactSha256: SHA,
        extractionArtifactLocator: null,
        sourceDocumentId: 'doc_o1',
        sourceSha256: SHA,
        candidateId: 'cand_o1',
        manifestContentSha256: SHA,
        currentRunId: 'run_o1',
        runDecision: 'PASS',
        runStatus: 'VERIFICATION_PASSED',
      },
    ]);
    const adapter = new PrismaMaterializationArtifactSourceV1(prisma);
    await expect(
      adapter.loadCandidateRefs({ cycleId: 'cycle-1', manifestDocumentKeys: ['o1'] }),
    ).rejects.toThrow(/no extraction_artifact_locator/);
  });

  it('returns an empty map without querying when manifestDocumentKeys is empty', async () => {
    const prisma = new FakeMaterializationPrisma([]);
    const adapter = new PrismaMaterializationArtifactSourceV1(prisma);
    const refs = await adapter.loadCandidateRefs({ cycleId: 'cycle-1', manifestDocumentKeys: [] });
    expect(refs.size).toBe(0);
    expect(prisma.queries).toHaveLength(0);
  });
});

describe('PrismaMaterializationArtifactSourceV1 — loadVerifiedArtifact', () => {
  it('reloads a filesystem-located artifact, re-verifies its byte SHA, and filters to accepted assertions', async () => {
    const artifactJson = makeArtifactJson('art_o1');
    const { locator, sha256 } = writeArtifactFile(artifactJson);
    const prisma = new FakeMaterializationPrisma();
    const adapter = new PrismaMaterializationArtifactSourceV1(prisma);

    const ref = {
      manifestDocumentKey: 'o1',
      extractionArtifactId: 'art_o1',
      extractionArtifactSha256: sha256,
      extractionArtifactLocator: locator,
      sourceDocumentId: 'doc_o1',
      sourceSha256: SHA,
      candidateId: 'cand_o1',
      verificationRunId: 'run_o1',
      decision: 'PASS' as const,
      status: 'VERIFICATION_PASSED' as const,
      manifestContentSha256: SHA,
      acceptedAssertionIds: ['asrt_1'],
    };

    const reloaded = await adapter.loadVerifiedArtifact(ref);
    expect(reloaded.assertions).toHaveLength(1);
    expect(reloaded.assertions[0]?.assertionId).toBe('asrt_1');
  });

  it('throws on a byte SHA mismatch (tampered/stale storage) rather than trusting storage', async () => {
    const artifactJson = makeArtifactJson('art_o1');
    const { locator } = writeArtifactFile(artifactJson);
    const prisma = new FakeMaterializationPrisma();
    const adapter = new PrismaMaterializationArtifactSourceV1(prisma);

    const ref = {
      manifestDocumentKey: 'o1',
      extractionArtifactId: 'art_o1',
      extractionArtifactSha256: 'b'.repeat(64), // wrong on purpose
      extractionArtifactLocator: locator,
      sourceDocumentId: 'doc_o1',
      sourceSha256: SHA,
      candidateId: 'cand_o1',
      verificationRunId: 'run_o1',
      decision: 'PASS' as const,
      status: 'VERIFICATION_PASSED' as const,
      manifestContentSha256: SHA,
      acceptedAssertionIds: ['asrt_1'],
    };

    await expect(adapter.loadVerifiedArtifact(ref)).rejects.toThrow(/byte SHA mismatch/);
  });

  it('a REJECT decision reload defensively returns zero assertions (caller never reaches here for REJECT, but the empty-set behavior is preserved)', async () => {
    const artifactJson = makeArtifactJson('art_o1');
    const { locator, sha256 } = writeArtifactFile(artifactJson);
    const prisma = new FakeMaterializationPrisma();
    const adapter = new PrismaMaterializationArtifactSourceV1(prisma);

    const ref = {
      manifestDocumentKey: 'o1',
      extractionArtifactId: 'art_o1',
      extractionArtifactSha256: sha256,
      extractionArtifactLocator: locator,
      sourceDocumentId: 'doc_o1',
      sourceSha256: SHA,
      candidateId: 'cand_o1',
      verificationRunId: 'run_o1',
      decision: 'REJECT' as const,
      status: 'REJECTED' as const,
      manifestContentSha256: SHA,
      acceptedAssertionIds: [],
    };

    const reloaded = await adapter.loadVerifiedArtifact(ref);
    expect(reloaded.assertions).toHaveLength(0);
  });

  it('reads an s3:// locator through the injected S3 byte reader, never node:fs, and throws when no reader is configured', async () => {
    const artifactJson = makeArtifactJson('art_s3');
    const bytes = Buffer.from(JSON.stringify(artifactJson), 'utf8');
    const sha256 = sha256Hex(bytes);
    const ref = {
      manifestDocumentKey: 'o1',
      extractionArtifactId: 'art_s3',
      extractionArtifactSha256: sha256,
      extractionArtifactLocator: 's3://bucket/o1.json',
      sourceDocumentId: 'doc_o1',
      sourceSha256: SHA,
      candidateId: 'cand_o1',
      verificationRunId: 'run_o1',
      decision: 'PASS' as const,
      status: 'VERIFICATION_PASSED' as const,
      manifestContentSha256: SHA,
      acceptedAssertionIds: ['asrt_1'],
    };

    // No reader configured -> refuse rather than silently falling back to fs.
    const adapterNoReader = new PrismaMaterializationArtifactSourceV1(new FakeMaterializationPrisma());
    await expect(adapterNoReader.loadVerifiedArtifact(ref)).rejects.toThrow(/no S3 reader was configured/);

    // With a reader configured, the s3 path is used and never touches disk.
    let requestedLocator: string | undefined;
    const s3Reader: S3ByteReaderPortV1 = {
      async readObject(locator: string): Promise<Buffer> {
        requestedLocator = locator;
        return bytes;
      },
    };
    const adapterWithReader = new PrismaMaterializationArtifactSourceV1(new FakeMaterializationPrisma(), s3Reader);
    const reloaded = await adapterWithReader.loadVerifiedArtifact(ref);
    expect(requestedLocator).toBe('s3://bucket/o1.json');
    expect(reloaded.assertions).toHaveLength(1);
  });
});

describe('PrismaMaterializationArtifactSourceV1 — authorization boundary', () => {
  it('[authorization boundary] the adapter file (outside doc comments) never references PROMOTER_DATABASE_URL, DefenseBudgetCanonicalPromotionServiceV1, or DefenseBudgetPromotionAuthorizationServiceV1', () => {
    const source: string = fs.readFileSync(
      require.resolve('./prisma-materialization-artifact-source-v1.ts'),
      'utf8',
    );
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const term of [
      'PROMOTER_DATABASE_URL',
      'DefenseBudgetCanonicalPromotionServiceV1',
      'DefenseBudgetPromotionAuthorizationServiceV1',
    ]) {
      expect(withoutComments).not.toContain(term);
    }
  });
});

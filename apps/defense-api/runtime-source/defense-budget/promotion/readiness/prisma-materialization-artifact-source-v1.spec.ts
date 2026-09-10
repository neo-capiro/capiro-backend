/**
 * Phase 10B-2D -- dedicated real-adapter spec for
 * `PrismaMaterializationArtifactSourceV1`.
 *
 * Table-routed fake Prisma idiom, matching
 * `prisma-family-reconciliation-certification-v1.spec.ts`'s `FakeCertPrisma`
 * and `phase10b2-repair-findings.md` §5. Artifact bytes are read from real
 * temp files via `node:fs` -- this adapter's own `loadVerifiedArtifact`
 * reads the filesystem directly (not through Prisma).
 *
 * Phase 10B-31 hash-boundary fix: `extraction_artifact_sha256` is the
 * artifact's CONTENT hash (`computeArtifactContentSha256`), not a raw byte
 * hash of the serialized file (see the adapter's own header comment). Every
 * fixture artifact built here is made genuinely self-consistent via
 * `computeArtifactContentSha256` -- the SAME function the real producer
 * (`rdte-phase3-semantic-artifact-factory-v1.ts`) and the fixed consumer both
 * use -- rather than a fixed dummy `contentSha256`/hand-hashed-bytes pair,
 * which previously matched only by construction and hid the real
 * byte-vs-content disagreement (see
 * `lifecycle-bridge-candidate-cycle-identity.integration.spec.ts`'s real
 * `95433cc2... vs 9a088be0...` case for the production instance of this bug).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PrismaMaterializationArtifactSourceV1 } from './prisma-materialization-artifact-source-v1.js';
import type { S3ByteReaderPortV1 } from './prisma-materialization-artifact-source-v1.js';
import { computeArtifactContentSha256 } from '../../contracts/extraction-artifact-v1.semantic.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';

const SHA = 'a'.repeat(64);

/**
 * Builds a genuinely self-consistent artifact: `contentSha256`/`artifactId`
 * are computed from the REST of the payload via the real
 * `computeArtifactContentSha256`, exactly as the real producer does, instead
 * of a fixed dummy value that only "matched" by construction.
 */
function makeArtifactJson(
  sourceOverrides: Partial<DefenseBudgetExtractionArtifactV1['source']> = {},
): DefenseBudgetExtractionArtifactV1 {
  const draft = {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: 'placeholder',
    contentSha256: 'placeholder',
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
      ...sourceOverrides,
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
  const contentSha256 = computeArtifactContentSha256(draft);
  return { ...draft, artifactId: `dbx1_${contentSha256}`, contentSha256 };
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

function writeArtifactFile(content: DefenseBudgetExtractionArtifactV1): { locator: string } {
  const bytes = Buffer.from(JSON.stringify(content), 'utf8');
  const locator = path.join(tempDir, 'artifact.json');
  fs.writeFileSync(locator, bytes);
  return { locator };
}

/**
 * Tampers a written artifact's real PAYLOAD (a title, not raw bytes appended
 * after the JSON) so the file stays syntactically valid JSON but its
 * recomputed content hash genuinely changes -- proving the content-hash
 * check fires on real tampering, not just on a corrupted-JSON parse failure.
 */
function tamperArtifactFile(locator: string): void {
  const parsed = JSON.parse(fs.readFileSync(locator, 'utf8')) as { assertions: Array<Record<string, unknown>> };
  parsed.assertions = parsed.assertions.map((assertion, index) =>
    index === 0 ? { ...assertion, title: `${assertion.title as string} (tampered)` } : assertion,
  );
  fs.writeFileSync(locator, JSON.stringify(parsed), 'utf8');
}

describe('PrismaMaterializationArtifactSourceV1 — loadCandidateRefs', () => {
  it('preserves the RDT&E policy SHA and accepted/rejected assertion decision snapshot', async () => {
    const prisma = new FakeMaterializationPrisma([
      {
        manifestDocumentKey: 'r2', extractionArtifactId: 'art_r2',
        extractionArtifactSha256: SHA, extractionArtifactLocator: '/fixture/r2.json',
        sourceDocumentId: 'doc_r2', sourceSha256: SHA, candidateId: 'cand_r2',
        manifestContentSha256: SHA, policySha256: 'b'.repeat(64),
        // Phase 10B-28R: the run row keeps the verifier status (NEEDS_REVIEW);
        // REVIEW_ACCEPTED only ever exists on the candidate row.
        currentRunId: 'run_r2', runDecision: 'REVIEW', runStatus: 'NEEDS_REVIEW', candidateStatus: 'REVIEW_ACCEPTED',
      },
    ], [{ id: 'run_r2', resultSnapshot: {
      acceptedAssertionIds: ['accepted-r2'], rejectedAssertionIds: ['rejected-r2'],
    } }]);
    const refs = await new PrismaMaterializationArtifactSourceV1(prisma).loadCandidateRefs({
      cycleId: 'cycle-rdte', manifestDocumentKeys: ['r2'],
    });
    expect(refs.get('r2')).toMatchObject({
      policySha256: 'b'.repeat(64),
      acceptedAssertionIds: ['accepted-r2'],
      rejectedAssertionIds: ['rejected-r2'],
      status: 'REVIEW_ACCEPTED',
    });
  });

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
        candidateStatus: 'VERIFICATION_PASSED',
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
    expect(candidateQuery?.query).toContain('DISTINCT ON (c."manifest_document_key")');
    expect(candidateQuery?.query).toContain(
      'ORDER BY c."manifest_document_key", c."created_at" DESC',
    );
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
        candidateStatus: 'EXTRACTED',
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
        candidateStatus: 'VERIFICATION_PASSED',
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
  it('applies the same content-SHA-bound reload to an RDT&E candidate artifact (positive control), and rejects a real payload tamper (negative control)', async () => {
    const artifactJson = makeArtifactJson({
      manifestDocumentKey: 'r2',
      family: 'rdte',
      exhibit: 'R-2',
    });
    const { locator } = writeArtifactFile(artifactJson);
    const adapter = new PrismaMaterializationArtifactSourceV1(new FakeMaterializationPrisma());
    const ref = {
      manifestDocumentKey: 'r2', extractionArtifactId: artifactJson.artifactId,
      extractionArtifactSha256: artifactJson.contentSha256, extractionArtifactLocator: locator,
      sourceDocumentId: 'doc_r2', sourceSha256: SHA, candidateId: 'cand_r2',
      verificationRunId: 'run_r2', decision: 'PASS' as const,
      status: 'VERIFICATION_PASSED' as const, manifestContentSha256: SHA,
      acceptedAssertionIds: ['asrt_1'],
    };
    // Positive control: the real, unmodified, self-consistent artifact reloads.
    const reloaded = await adapter.loadVerifiedArtifact(ref);
    expect(reloaded.source.family).toBe('rdte');
    // Negative control: tampering the real payload (not just corrupting JSON
    // syntax) changes the recomputed content hash and must still be rejected.
    tamperArtifactFile(locator);
    await expect(adapter.loadVerifiedArtifact(ref)).rejects.toThrow(/content SHA mismatch/);
  });

  it('reloads a filesystem-located artifact, re-verifies its content SHA, and filters to accepted assertions', async () => {
    const artifactJson = makeArtifactJson();
    const { locator } = writeArtifactFile(artifactJson);
    const prisma = new FakeMaterializationPrisma();
    const adapter = new PrismaMaterializationArtifactSourceV1(prisma);

    const ref = {
      manifestDocumentKey: 'o1',
      extractionArtifactId: artifactJson.artifactId,
      extractionArtifactSha256: artifactJson.contentSha256,
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

  it('throws on a content SHA mismatch (tampered/stale storage, or a byte-hash caller-supplied-by-mistake) rather than trusting storage', async () => {
    const artifactJson = makeArtifactJson();
    const { locator } = writeArtifactFile(artifactJson);
    const prisma = new FakeMaterializationPrisma();
    const adapter = new PrismaMaterializationArtifactSourceV1(prisma);

    const ref = {
      manifestDocumentKey: 'o1',
      extractionArtifactId: artifactJson.artifactId,
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

    await expect(adapter.loadVerifiedArtifact(ref)).rejects.toThrow(/content SHA mismatch/);
  });

  it('never accepts the raw byte SHA of the stored file in place of the content SHA (the exact Phase 10B-31 bug: these are two different hash domains)', async () => {
    const artifactJson = makeArtifactJson();
    const { locator } = writeArtifactFile(artifactJson);
    const rawByteSha256 = createHash('sha256')
      .update(fs.readFileSync(locator))
      .digest('hex');
    expect(rawByteSha256).not.toBe(artifactJson.contentSha256);
    const adapter = new PrismaMaterializationArtifactSourceV1(new FakeMaterializationPrisma());
    const ref = {
      manifestDocumentKey: 'o1',
      extractionArtifactId: artifactJson.artifactId,
      extractionArtifactSha256: rawByteSha256, // the OLD (buggy) consumer's own value
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
    await expect(adapter.loadVerifiedArtifact(ref)).rejects.toThrow(/content SHA mismatch/);
  });

  it('a REJECT decision reload defensively returns zero assertions (caller never reaches here for REJECT, but the empty-set behavior is preserved)', async () => {
    const artifactJson = makeArtifactJson();
    const { locator } = writeArtifactFile(artifactJson);
    const prisma = new FakeMaterializationPrisma();
    const adapter = new PrismaMaterializationArtifactSourceV1(prisma);

    const ref = {
      manifestDocumentKey: 'o1',
      extractionArtifactId: artifactJson.artifactId,
      extractionArtifactSha256: artifactJson.contentSha256,
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
    const artifactJson = makeArtifactJson();
    const bytes = Buffer.from(JSON.stringify(artifactJson), 'utf8');
    const ref = {
      manifestDocumentKey: 'o1',
      extractionArtifactId: artifactJson.artifactId,
      extractionArtifactSha256: artifactJson.contentSha256,
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

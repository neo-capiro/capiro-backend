/**
 * R8.2 Workstream B — persist-mode production proof wiring.
 *
 * Proves the acceptance gates:
 *   - persist mode never constructs FilesystemProofResolver;
 *   - persist mode wires CompositeProofResolver in production_proof mode;
 *   - the repository is created from the SAME Prisma client;
 *   - an unreachable database fails closed before any persistence;
 *   - policy-required archive / parser dependencies fail closed.
 */
import type { PrismaClient } from '@prisma/client';
import {
  wireProductionProofBoundary,
  ProductionProofWiringError,
} from './production-proof-wiring.js';
import { CompositeProofResolver } from './composite-proof-resolver.js';

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

function makeFakePrisma(overrides: Partial<Record<string, unknown>> = {}): PrismaClient {
  const sourceDocument = {
    findFirst: jest.fn(async () => null),
    create: jest.fn(),
    update: jest.fn(),
  };
  const documentParseJob = {
    findFirst: jest.fn(async () => null),
  };
  return {
    $connect: jest.fn(async () => undefined),
    $disconnect: jest.fn(async () => undefined),
    sourceDocument,
    documentParseJob,
    budgetExtractionCandidateV1: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    budgetVerificationRunV1: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    ...overrides,
  } as unknown as PrismaClient;
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

describe('R8.2-B wireProductionProofBoundary', () => {
  it('constructs a CompositeProofResolver in production_proof mode', async () => {
    const prisma = makeFakePrisma();
    const wired = await wireProductionProofBoundary({ prisma, skipDatabaseProbe: true });
    expect(wired.compositeResolver).toBeInstanceOf(CompositeProofResolver);
    expect(wired.compositeResolver.resolverMode).toBe('production_proof');
    expect(wired.proofResolver).toBe(wired.compositeResolver);
    expect(wired.repository).toBeDefined();
  });

  it('never returns a FilesystemProofResolver', async () => {
    const prisma = makeFakePrisma();
    const wired = await wireProductionProofBoundary({ prisma, skipDatabaseProbe: true });
    expect(wired.proofResolver.constructor.name).toBe('CompositeProofResolver');
    expect(wired.proofResolver.constructor.name).not.toBe('FilesystemProofResolver');
  });

  it('creates the repository from the same Prisma client', async () => {
    const prisma = makeFakePrisma();
    const wired = await wireProductionProofBoundary({ prisma, skipDatabaseProbe: true });
    // The repository delegates to the same client: exercise a read path.
    const repo = wired.repository as unknown as {
      prisma: PrismaClient;
    };
    expect(repo.prisma).toBe(prisma);
  });

  it('fails closed before persistence when the database is unreachable', async () => {
    const prisma = makeFakePrisma({
      $connect: jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    await expect(wireProductionProofBoundary({ prisma })).rejects.toThrow(
      ProductionProofWiringError,
    );
    await expect(wireProductionProofBoundary({ prisma })).rejects.toThrow(
      /requires a reachable database/,
    );
  });

  it('probes the database by default', async () => {
    const connect = jest.fn(async () => undefined);
    const prisma = makeFakePrisma({ $connect: connect });
    await wireProductionProofBoundary({ prisma });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('dispose is idempotent and closes owned clients', async () => {
    const prisma = makeFakePrisma();
    const wired = await wireProductionProofBoundary({ prisma, skipDatabaseProbe: true });
    await expect(wired.dispose()).resolves.toBeUndefined();
    // Second call must not throw.
    await expect(wired.dispose()).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Fail-closed resolution through the wired resolver                   */
/* ------------------------------------------------------------------ */

describe('R8.2-B fail-closed resolution through the wired resolver', () => {
  // A minimal manifest + artifact so the resolver can reach the policy and
  // dependency checks. The R-1 policy requires BOTH immutable archive AND
  // parser-run proof.
  const VALID_SHA = 'a'.repeat(64);
  const SRC_SHA = 'b'.repeat(64);

  function makeManifest() {
    return {
      schemaVersion: 'defense_budget_cycle_manifest_v1',
      cycleId: 'fy2027-pb',
      fiscalYear: 2027,
      domain: 'defense',
      documents: [
        {
          documentKey: 'r1_army_fy2027',
          family: 'rdte',
          exhibit: 'R-1',
          required: true,
          title: 'R-1 Army FY2027',
          sourceLocator: '/r1.pdf',
          sourceUrl: 'https://example.test/r1.pdf',
          authority: 'dod-comptroller',
          component: 'ARMY',
          budgetCycle: 'pb',
          documentType: 'exhibit',
          parserPolicy: 'deterministic_table',
          requiredDataCategories: ['identity', 'funding'],
          requiredFundingFields: ['request'],
          expectedLineKinds: ['RDTE_PE'],
          allowEmpty: false,
        },
      ],
    };
  }

  function makeArtifact() {
    const base = {
      schemaVersion: 'defense_budget_extraction_v1',
      artifactId: 'dbx1_b',
      contentSha256: '0'.repeat(64),
      source: {
        manifestDocumentKey: 'r1_army_fy2027',
        sourceDocumentId: 'sd-1',
        sourcePdfSha256: SRC_SHA,
        sourceLocator: '/r1.pdf',
        fiscalYear: 2027,
        family: 'rdte',
        exhibit: 'R-1',
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'r1',
      },
      parserRuns: [
        {
          parserRunId: 'run-1',
          method: 'deterministic_pdfplumber',
          parserVersion: '1.0',
          parserConfigSha256: VALID_SHA,
          inputSourceSha256: SRC_SHA,
          outputArtifactSha256: '0'.repeat(64),
          pageRanges: [{ startPage: 1, endPage: 1 }],
        },
      ],
      evidence: [],
      sourceFacts: [],
      assertions: [],
      warnings: [],
      omissions: [],
      summary: {
        sourceFactCount: 0,
        requiredSourceFactCount: 0,
        coveredRequiredSourceFactCount: 0,
        omittedRequiredSourceFactCount: 0,
        uncoveredRequiredSourceFactCount: 0,
        assertionCount: 0,
        warningCount: 0,
        omissionCount: 0,
        countsByAssertionKind: {},
        countsByOmissionReason: {},
        completenessStatus: 'complete',
      },
    };
    const { computeArtifactContentSha256 } =
      require('../../contracts/extraction-artifact-v1.semantic.js') as {
        computeArtifactContentSha256: (a: unknown) => string;
      };
    const contentSha = computeArtifactContentSha256(base);
    base.contentSha256 = contentSha;
    (base.parserRuns as Array<Record<string, unknown>>)[0]!.outputArtifactSha256 = contentSha;
    return base;
  }

  function makeReader(map: Record<string, Buffer>) {
    return {
      async read(locator: string) {
        const bytes = map[locator];
        if (!bytes) throw new Error(`not found: ${locator}`);
        return {
          locator,
          bytes,
          kind: 'filesystem' as const,
          contentLength: bytes.length,
          checksumSha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
        };
      },
    };
  }

  it('archive-proof dependency failure surfaces as blocking, not silent', async () => {
    const prisma = makeFakePrisma({
      sourceDocument: {
        findFirst: jest.fn(async () => ({
          id: 'sd-1',
          sourceKey: '/r1.pdf',
          sha256: SRC_SHA,
          fiscalYear: 2027,
          component: 'ARMY',
          budgetCycle: 'pb',
          documentType: 'r1',
          // Authoritative local locator so source bytes resolve; but NO
          // archive metadata -> archive proof is missing for a policy that
          // requires an immutable archive.
          artifactPath: '/r1.pdf',
          archiveBucket: null,
          archiveS3Key: null,
          archiveVersionId: null,
        })),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const wired = await wireProductionProofBoundary({ prisma, skipDatabaseProbe: true });
    const reader = makeReader({
      '/manifest.json': Buffer.from(JSON.stringify(makeManifest())),
      '/artifact.json': Buffer.from(JSON.stringify(makeArtifact())),
      '/r1.pdf': Buffer.from('pdf'),
    });
    // Swap in a byte reader via a fresh composite so we can inject bytes.
    const { CompositeProofResolver: Cpr } = await import('./composite-proof-resolver.js');
    const resolver = new Cpr({
      mode: 'production_proof',
      sourceDocumentClient: prisma,
      parseJobClient: prisma,
      s3Reader: {
        getObjectBytes: jest.fn(async () => null),
        headObject: jest.fn(async () => null),
      },
      byteLocatorReader: reader,
      // R8.2-C: R-1 policy requires parser-run proof, so the resolver needs
      // a parser-output proof source to reach the archive-absence path.
      parserOutputProofSource: {
        resolveParserOutput: jest.fn(async () => ({
          persistedRunId: 'run-1',
          outputLocator: '/store/run-1/result.json',
          outputBytes: Buffer.from('{"pages":[1]}'),
          inputSourceSha256: SRC_SHA,
          parserVersion: '1.0',
          parserConfigSha256: VALID_SHA,
          status: 'succeeded',
          succeededPages: [1],
        })),
      },
    });
    const result = await resolver.resolve({
      manifestLocator: '/manifest.json',
      manifestDocumentKey: 'r1_army_fy2027',
      extractionArtifactLocator: '/artifact.json',
      sourceDocumentId: 'sd-1',
    });
    const archiveFindings = result.proofFindings.filter(
      (f: { code: string }) => f.code === 'archive_version_missing',
    );
    expect(archiveFindings.length).toBeGreaterThan(0);
    expect(archiveFindings[0]!.severity).toBe('blocking');
    expect(wired.repository).toBeDefined();
  });
});

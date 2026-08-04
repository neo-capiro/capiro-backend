/**
 * R8.2 Workstream D — unified candidate/reference proof resolution.
 *
 * Every reference artifact is proved through the SAME internal method
 * (`resolveSingleArtifactProof`) as the candidate. There is no separate,
 * weaker reference trust path. Required behaviors:
 *
 *   - `manifestDocumentKey` is mandatory and never defaulted from the
 *     candidate;
 *   - `manifestLocator` defaults ONLY to the candidate manifest locator;
 *   - the SourceDocument ID is never defaulted;
 *   - unknown properties fail closed (schema + CLI);
 *   - the reference's own manifest entry governs its policy;
 *   - authoritative source bytes are resolved from the reference's own
 *     SourceDocument row (never initialized from the artifact's claims);
 *   - archive proof is enforced when the reference's own policy requires it;
 *   - parser-run proof is enforced when the reference's own policy requires
 *     it;
 *   - a required reference-proof failure produces an artifact-specific
 *     blocking finding tagged with the reference ID/locator, excludes the
 *     reference from comparison, and prevents a required comparison from
 *     passing;
 *   - an invalid reference is never indexed for matching.
 */
import { CompositeProofResolver } from './composite-proof-resolver.js';
import { TrustedProofResolutionError } from './trusted-proof-types.js';
import { createComparisonProvider } from '../rules/comparison/comparison-provider.js';
import { computeArtifactContentSha256 } from '../../contracts/extraction-artifact-v1.semantic.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* Fixture builders                                                    */
/* ------------------------------------------------------------------ */

const crypto = require('node:crypto');
const sha256 = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');

const CANDIDATE_SRC = Buffer.from('%PDF-1.4 candidate official source');
const REF_SRC = Buffer.from('%PDF-1.4 reference official source');
const CANDIDATE_SHA = sha256(CANDIDATE_SRC);
const REF_SHA = sha256(REF_SRC);
const OTHER_SHA = sha256('some other bytes');

function docEntry(documentKey: string, sourceLocator: string, exhibit: 'R-1' | 'R-2' = 'R-1') {
  return {
    documentKey,
    family: 'rdte',
    exhibit,
    required: true,
    title: `${documentKey} title`,
    sourceLocator,
    sourceUrl: `https://example.test/${documentKey}.pdf`,
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb',
    documentType: 'exhibit',
    parserPolicy: 'deterministic_table',
    requiredDataCategories: ['identity', 'funding'],
    requiredFundingFields: ['request'],
    expectedLineKinds: ['RDTE_PE'],
    allowEmpty: false,
  };
}

function manifest(documents: unknown[], cycleId = 'fy2027-pb') {
  return {
    schemaVersion: 'defense_budget_cycle_manifest_v1',
    cycleId,
    fiscalYear: 2027,
    domain: 'defense',
    documents,
  };
}

function fundingAssertion(id: string, peCode: string, value: string) {
  return {
    assertionId: id,
    assertionKind: 'funding' as const,
    sourceFactIds: [],
    evidenceIds: [`ev-${id}`],
    confidence: 1,
    identity: { lineKind: 'RDTE_PE' as const, peCode },
    fiscalYear: 2027,
    field: 'request' as const,
    money: { originalValue: value, originalUnit: 'millions' as const, valueMillions: value },
  };
}

interface ArtifactOpts {
  artifactId: string;
  sourceDocumentId: string;
  manifestDocumentKey: string;
  sourcePdfSha256: string;
  sourceLocator: string;
  exhibit?: 'R-1' | 'R-2';
  assertions?: unknown[];
  parserRuns?: unknown[];
}

function buildArtifact(opts: ArtifactOpts): DefenseBudgetExtractionArtifactV1 {
  const exhibit = opts.exhibit ?? 'R-1';
  const artifact = {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId: opts.artifactId,
    contentSha256: '0'.repeat(64),
    source: {
      manifestDocumentKey: opts.manifestDocumentKey,
      sourceDocumentId: opts.sourceDocumentId,
      sourcePdfSha256: opts.sourcePdfSha256,
      sourceLocator: opts.sourceLocator,
      fiscalYear: 2027,
      family: 'rdte',
      exhibit,
      authority: 'dod-comptroller',
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'exhibit',
    },
    parserRuns: (opts.parserRuns ?? [
      {
        parserRunId: `pr1_${opts.artifactId}`,
        method: 'deterministic_pdfplumber',
        parserVersion: '1.0',
        parserConfigSha256: 'c'.repeat(64),
        inputSourceSha256: opts.sourcePdfSha256,
        // The declared parser OUTPUT content SHA — an independent value bound
        // to the persisted parser output bytes (verified through the
        // ParserOutputProofSource), NOT the artifact content SHA. All run
        // fields must be fixed before the content hash is computed so the
        // artifact content SHA recomputes exactly.
        outputArtifactSha256: sha256('{"pages":[1]}'),
        pageRanges: [{ startPage: 1, endPage: 1 }],
      },
    ]) as DefenseBudgetExtractionArtifactV1['parserRuns'],
    evidence: [],
    sourceFacts: [],
    assertions: opts.assertions ?? [],
    warnings: [],
    omissions: [],
    summary: {
      sourceFactCount: 0,
      requiredSourceFactCount: 0,
      coveredRequiredSourceFactCount: 0,
      omittedRequiredSourceFactCount: 0,
      uncoveredRequiredSourceFactCount: 0,
      assertionCount: (opts.assertions ?? []).length,
      warningCount: 0,
      omissionCount: 0,
      countsByAssertionKind: {},
      countsByOmissionReason: {},
      completenessStatus: 'complete',
    },
  } as unknown as DefenseBudgetExtractionArtifactV1;
  const contentSha = computeArtifactContentSha256(artifact);
  artifact.contentSha256 = contentSha;
  return artifact;
}

interface SourceDocRowOpts {
  id: string;
  sourceKey: string;
  sha256: string;
  archiveBucket?: string;
  archiveS3Key?: string;
  archiveVersionId?: string;
}

function sourceDocRow(opts: SourceDocRowOpts) {
  return {
    id: opts.id,
    sourceKey: opts.sourceKey,
    sha256: opts.sha256,
    supersededByDocumentId: null,
    fiscalYear: 2027,
    component: 'ARMY',
    budgetCycle: 'pb',
    documentType: 'exhibit',
    archiveBucket: opts.archiveBucket ?? 'b',
    archiveS3Key: opts.archiveS3Key ?? `k-${opts.id}`,
    archiveVersionId: opts.archiveVersionId ?? `v-${opts.id}`,
  };
}

function s3Locator(row: SourceDocRowOpts): string {
  return `s3://${row.archiveBucket ?? 'b'}/${row.archiveS3Key ?? `k-${row.id}`}?versionId=${row.archiveVersionId ?? `v-${row.id}`}`;
}

interface HarnessOpts {
  candidateArtifact: DefenseBudgetExtractionArtifactV1;
  candidateSourceDoc: ReturnType<typeof sourceDocRow>;
  candidateSourceBytes: Buffer;
  candidateArchiveBytes?: Buffer;
  candidateParserOutput?: ReturnType<typeof okParserOutput> | null;
  references?: Array<{
    descriptor: {
      artifactLocator: string;
      sourceDocumentId: string;
      manifestDocumentKey: string;
      manifestLocator?: string;
    };
    artifact: DefenseBudgetExtractionArtifactV1;
    sourceDoc: ReturnType<typeof sourceDocRow>;
    sourceBytes: Buffer;
    archiveBytes?: Buffer;
    parserOutput?: ReturnType<typeof okParserOutput> | null;
    /** When true, omit this reference's manifest document entry. */
    omitManifestDoc?: boolean;
    /** When true, use a SEPARATE manifest file for this reference. */
    separateManifestLocator?: string;
    /** When true, do not register the source-bytes locator in the reader. */
    dropSourceBytes?: boolean;
    /** When true, do not register the archive locator in the reader. */
    dropArchive?: boolean;
    /** Extra source-doc rows keyed by id. */
    extraSourceDocs?: Record<string, ReturnType<typeof sourceDocRow>>;
  }>;
  /** Candidate manifest document entries (default: candidate entry). */
  candidateDocEntry?: ReturnType<typeof docEntry>;
  /** Reference manifest document entries added to the candidate manifest. */
  referenceDocEntries?: ReturnType<typeof docEntry>[];
}

function okParserOutput(inputSourceSha256: string) {
  return async (req: { declaredOutputSha256: string }) => ({
    persistedRunId: 'run-1',
    outputLocator: '/store/run-1/result.json',
    outputBytes: Buffer.from('{"pages":[1]}'),
    inputSourceSha256,
    parserVersion: '1.0',
    parserConfigSha256: 'c'.repeat(64),
    status: 'succeeded',
    outputContentSha256: req.declaredOutputSha256,
    outputByteSha256: 'a'.repeat(64),
    succeededPages: [1],
  });
}

function buildHarness(opts: HarnessOpts) {
  const files: Record<string, Buffer> = {};
  const sourceDocs: Record<string, ReturnType<typeof sourceDocRow>> = {};

  // Candidate manifest document entries.
  const candDoc =
    opts.candidateDocEntry ??
    docEntry(
      opts.candidateArtifact.source.manifestDocumentKey,
      opts.candidateArtifact.source.sourceLocator,
      (opts.candidateArtifact.source.exhibit as 'R-1' | 'R-2') ?? 'R-1',
    );
  const candManifestDocs: unknown[] = [candDoc, ...(opts.referenceDocEntries ?? [])];
  files['/manifest.json'] = Buffer.from(JSON.stringify(manifest(candManifestDocs)));

  // Candidate artifact + source bytes + archive bytes.
  files['/candidate.json'] = Buffer.from(JSON.stringify(opts.candidateArtifact));
  files[opts.candidateArtifact.source.sourceLocator] = opts.candidateSourceBytes;
  const candRow = opts.candidateSourceDoc;
  sourceDocs[candRow.id] = candRow;
  files[s3Locator(candRow)] = opts.candidateArchiveBytes ?? opts.candidateSourceBytes;

  // References.
  const descriptors: HarnessOpts['references'] = opts.references ?? [];
  const sourceDocRows: Array<ReturnType<typeof sourceDocRow>> = [candRow];
  for (const ref of descriptors) {
    if (ref.extraSourceDocs) {
      for (const [id, row] of Object.entries(ref.extraSourceDocs)) {
        sourceDocs[id] = row;
        sourceDocRows.push(row);
      }
    }
    if (ref.separateManifestLocator) {
      const refManifestDocs = ref.omitManifestDoc
        ? []
        : [docEntry(ref.descriptor.manifestDocumentKey, ref.artifact.source.sourceLocator)];
      files[ref.separateManifestLocator] = Buffer.from(JSON.stringify(manifest(refManifestDocs)));
    }
    files[ref.descriptor.artifactLocator] = Buffer.from(JSON.stringify(ref.artifact));
    if (!ref.dropSourceBytes) {
      files[ref.artifact.source.sourceLocator] = ref.sourceBytes;
    }
    // dropSourceBytes removes BOTH the raw source locator and the reference's
    // authoritative archive locator — otherwise the S3 archive would still
    // resolve the source bytes.
    if (!ref.dropArchive && !ref.dropSourceBytes) {
      files[s3Locator(ref.sourceDoc)] = ref.archiveBytes ?? ref.sourceBytes;
    }
    sourceDocs[ref.sourceDoc.id] = ref.sourceDoc;
    sourceDocRows.push(ref.sourceDoc);
  }

  const reader = {
    async read(locator: string) {
      const bytes = files[locator];
      if (!bytes) throw new Error(`not found: ${locator}`);
      return {
        locator,
        bytes,
        kind: 'filesystem' as const,
        contentLength: bytes.length,
        checksumSha256: sha256(bytes),
      };
    },
  };

  const sourceDocumentClient = {
    sourceDocument: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const id = typeof where.id === 'string' ? where.id : undefined;
        if (id) return sourceDocs[id] ?? null;
        return null;
      }),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  const s3Reader = {
    getObjectBytes: jest.fn(async (bucket: string, key: string) => {
      // Look up by the canonical s3:// locator the resolver will build.
      for (const row of sourceDocRows) {
        const loc = s3Locator(row as unknown as SourceDocRowOpts);
        if (loc === `s3://${bucket}/${key}?versionId=${row.archiveVersionId}`) {
          return files[loc] ?? null;
        }
      }
      return null;
    }),
    headObject: jest.fn(async (bucket: string, key: string) => {
      for (const row of sourceDocRows) {
        const loc = s3Locator(row as unknown as SourceDocRowOpts);
        if (loc.startsWith(`s3://${bucket}/${key}`)) {
          const bytes = files[loc];
          return bytes ? { contentLength: bytes.length } : null;
        }
      }
      return null;
    }),
  };

  // Route parser-output proof by source-document id so candidate and
  // reference each get their own persisted output.
  const parserOutputProofSource = {
    resolveParserOutput: jest.fn(
      async (req: { parserRunId: string; declaredOutputSha256: string }) => {
        // Candidate run ids are prefixed with the candidate artifact id.
        if (req.parserRunId === `pr1_${opts.candidateArtifact.artifactId}`) {
          if (opts.candidateParserOutput === null) return null;
          const fn = opts.candidateParserOutput ?? okParserOutput(CANDIDATE_SHA);
          return fn(req);
        }
        for (const ref of descriptors) {
          if (req.parserRunId === `pr1_${ref.artifact.artifactId}`) {
            if (ref.parserOutput === null) return null;
            const fn = ref.parserOutput ?? okParserOutput(REF_SHA);
            return fn(req);
          }
        }
        return null;
      },
    ),
  };

  const resolver = new CompositeProofResolver({
    mode: 'production_proof',
    byteLocatorReader: reader,
    sourceDocumentClient,
    parseJobClient: { documentParseJob: { findFirst: jest.fn(async () => null) } },
    s3Reader,
    parserOutputProofSource,
  });

  return {
    resolver,
    descriptors,
    input: candidateDescriptor({
      manifestDocumentKey: opts.candidateArtifact.source.manifestDocumentKey,
      referenceDescriptors: descriptors.map((d) => d.descriptor),
    }),
  };
}

function candidateDescriptor(input: {
  manifestDocumentKey: string;
  referenceDescriptors?: Array<{
    artifactLocator: string;
    sourceDocumentId: string;
    manifestDocumentKey: string;
    manifestLocator?: string;
  }>;
}) {
  return {
    manifestLocator: '/manifest.json',
    manifestDocumentKey: input.manifestDocumentKey,
    extractionArtifactLocator: '/candidate.json',
    sourceDocumentId: 'sd-cand',
    ...(input.referenceDescriptors && input.referenceDescriptors.length > 0
      ? { referenceArtifacts: input.referenceDescriptors }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('R8.2-D unified candidate/reference proof', () => {
  it('candidate resolves cleanly with no references', async () => {
    const candidate = buildArtifact({
      artifactId: 'dbx1_cand',
      sourceDocumentId: 'sd-cand',
      manifestDocumentKey: 'r1_army_fy2027',
      sourcePdfSha256: CANDIDATE_SHA,
      sourceLocator: '/r1.pdf',
    });
    const { resolver, input } = buildHarness({
      candidateArtifact: candidate,
      candidateSourceDoc: sourceDocRow({
        id: 'sd-cand',
        sourceKey: '/r1.pdf',
        sha256: CANDIDATE_SHA,
      }),
      candidateSourceBytes: CANDIDATE_SRC,
    });
    const result = await resolver.resolve(input);
    expect(result.proofBundle.sourceDocument.sourceSha256).toBe(CANDIDATE_SHA);
    expect(result.proofBundle.archive.status).toBe('verified');
    expect(result.referenceArtifacts).toHaveLength(0);
    expect(result.referenceArtifactsFindings).toHaveLength(0);
  });

  it('reference has different SourceDocument and is independently proved', async () => {
    const candidate = buildArtifact({
      artifactId: 'dbx1_cand',
      sourceDocumentId: 'sd-cand',
      manifestDocumentKey: 'r1_army_fy2027',
      sourcePdfSha256: CANDIDATE_SHA,
      sourceLocator: '/r1.pdf',
    });
    const refArtifact = buildArtifact({
      artifactId: 'dbx1_ref',
      sourceDocumentId: 'sd-ref',
      manifestDocumentKey: 'r2_army_fy2027',
      sourcePdfSha256: REF_SHA,
      sourceLocator: '/r2.pdf',
      exhibit: 'R-2',
      assertions: [fundingAssertion('ref-a1', '0201101F', '10')],
    });
    const refSourceDoc = sourceDocRow({ id: 'sd-ref', sourceKey: '/r2.pdf', sha256: REF_SHA });
    const { resolver, input } = buildHarness({
      candidateArtifact: candidate,
      candidateSourceDoc: sourceDocRow({
        id: 'sd-cand',
        sourceKey: '/r1.pdf',
        sha256: CANDIDATE_SHA,
      }),
      candidateSourceBytes: CANDIDATE_SRC,
      referenceDocEntries: [docEntry('r2_army_fy2027', '/r2.pdf', 'R-2')],
      references: [
        {
          descriptor: {
            artifactLocator: '/ref.json',
            sourceDocumentId: 'sd-ref',
            manifestDocumentKey: 'r2_army_fy2027',
          },
          artifact: refArtifact,
          sourceDoc: refSourceDoc,
          sourceBytes: REF_SRC,
        },
      ],
    });
    const result = await resolver.resolve(input);
    expect(result.referenceArtifacts).toHaveLength(1);
    expect(result.referenceArtifacts[0]!.artifactId).toBe('dbx1_ref');
    // The reference's own proof was independent: its source SHA is the
    // reference's, not the candidate's.
    const refBundle = result.referenceArtifactsProofBundles[0]!;
    expect(refBundle.sourceDocument.sourceSha256).toBe(REF_SHA);
    expect(refBundle.sourceDocument.id).toBe('sd-ref');
    expect(refBundle.sourceDocument.sourceSha256).not.toBe(CANDIDATE_SHA);
    expect(refBundle.archive.status).toBe('verified');
    expect(result.referenceArtifactsFindings).toHaveLength(0);
  });

  it('reference uses a SEPARATE manifest and is proved against its own entry', async () => {
    const candidate = buildArtifact({
      artifactId: 'dbx1_cand',
      sourceDocumentId: 'sd-cand',
      manifestDocumentKey: 'r1_army_fy2027',
      sourcePdfSha256: CANDIDATE_SHA,
      sourceLocator: '/r1.pdf',
    });
    const refArtifact = buildArtifact({
      artifactId: 'dbx1_ref',
      sourceDocumentId: 'sd-ref',
      manifestDocumentKey: 'r2_army_fy2027',
      sourcePdfSha256: REF_SHA,
      sourceLocator: '/r2.pdf',
      exhibit: 'R-2',
    });
    const refSourceDoc = sourceDocRow({ id: 'sd-ref', sourceKey: '/r2.pdf', sha256: REF_SHA });
    const { resolver, input } = buildHarness({
      candidateArtifact: candidate,
      candidateSourceDoc: sourceDocRow({
        id: 'sd-cand',
        sourceKey: '/r1.pdf',
        sha256: CANDIDATE_SHA,
      }),
      candidateSourceBytes: CANDIDATE_SRC,
      references: [
        {
          descriptor: {
            artifactLocator: '/ref.json',
            sourceDocumentId: 'sd-ref',
            manifestDocumentKey: 'r2_army_fy2027',
            manifestLocator: '/ref-manifest.json',
          },
          artifact: refArtifact,
          sourceDoc: refSourceDoc,
          sourceBytes: REF_SRC,
          separateManifestLocator: '/ref-manifest.json',
        },
      ],
    });
    const result = await resolver.resolve(input);
    expect(result.referenceArtifacts).toHaveLength(1);
    const refBundle = result.referenceArtifactsProofBundles[0]!;
    // The reference manifest proof is bound to the separate manifest locator
    // and the reference's own document key — not the candidate manifest.
    expect(refBundle.manifest.locator).toBe('/ref-manifest.json');
    expect(refBundle.manifest.documentKey).toBe('r2_army_fy2027');
    expect(refBundle.sourceDocument.sourceSha256).toBe(REF_SHA);
    expect(result.referenceArtifactsFindings).toHaveLength(0);
  });

  it('reference with manifestDocumentKey absent from its manifest fails closed', async () => {
    const candidate = buildArtifact({
      artifactId: 'dbx1_cand',
      sourceDocumentId: 'sd-cand',
      manifestDocumentKey: 'r1_army_fy2027',
      sourcePdfSha256: CANDIDATE_SHA,
      sourceLocator: '/r1.pdf',
    });
    const refArtifact = buildArtifact({
      artifactId: 'dbx1_ref',
      sourceDocumentId: 'sd-ref',
      manifestDocumentKey: 'missing_key',
      sourcePdfSha256: REF_SHA,
      sourceLocator: '/r2.pdf',
    });
    const refSourceDoc = sourceDocRow({ id: 'sd-ref', sourceKey: '/r2.pdf', sha256: REF_SHA });
    const { resolver, input } = buildHarness({
      candidateArtifact: candidate,
      candidateSourceDoc: sourceDocRow({
        id: 'sd-cand',
        sourceKey: '/r1.pdf',
        sha256: CANDIDATE_SHA,
      }),
      candidateSourceBytes: CANDIDATE_SRC,
      references: [
        {
          descriptor: {
            artifactLocator: '/ref.json',
            sourceDocumentId: 'sd-ref',
            manifestDocumentKey: 'missing_key',
            manifestLocator: '/ref-manifest.json',
          },
          artifact: refArtifact,
          sourceDoc: refSourceDoc,
          sourceBytes: REF_SRC,
          separateManifestLocator: '/ref-manifest.json',
          omitManifestDoc: true,
        },
      ],
    });
    const result = await resolver.resolve(input);
    // The reference is excluded (not indexed) and a blocking finding is
    // produced, tagged with the reference identity.
    expect(result.referenceArtifacts).toHaveLength(0);
    const blocking = result.referenceArtifactsFindings.filter((f) => f.severity === 'blocking');
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking[0]!.code).toBe('reference_artifact_proof_failed');
    expect(blocking[0]!.artifactId).toBe('dbx1_ref');
    expect(blocking[0]!.locator).toBe('/ref.json');
    expect(blocking[0]!.sourceDocumentId).toBe('sd-ref');
  });

  it('reference with unavailable source bytes fails closed (never artifact-SHA fallback)', async () => {
    const candidate = buildArtifact({
      artifactId: 'dbx1_cand',
      sourceDocumentId: 'sd-cand',
      manifestDocumentKey: 'r1_army_fy2027',
      sourcePdfSha256: CANDIDATE_SHA,
      sourceLocator: '/r1.pdf',
    });
    const refArtifact = buildArtifact({
      artifactId: 'dbx1_ref',
      sourceDocumentId: 'sd-ref',
      manifestDocumentKey: 'r2_army_fy2027',
      sourcePdfSha256: REF_SHA,
      sourceLocator: '/r2.pdf',
      exhibit: 'R-2',
    });
    const refSourceDoc = sourceDocRow({ id: 'sd-ref', sourceKey: '/r2.pdf', sha256: REF_SHA });
    const { resolver, input } = buildHarness({
      candidateArtifact: candidate,
      candidateSourceDoc: sourceDocRow({
        id: 'sd-cand',
        sourceKey: '/r1.pdf',
        sha256: CANDIDATE_SHA,
      }),
      candidateSourceBytes: CANDIDATE_SRC,
      referenceDocEntries: [docEntry('r2_army_fy2027', '/r2.pdf', 'R-2')],
      references: [
        {
          descriptor: {
            artifactLocator: '/ref.json',
            sourceDocumentId: 'sd-ref',
            manifestDocumentKey: 'r2_army_fy2027',
          },
          artifact: refArtifact,
          sourceDoc: refSourceDoc,
          sourceBytes: REF_SRC,
          dropSourceBytes: true,
        },
      ],
    });
    const result = await resolver.resolve(input);
    expect(result.referenceArtifacts).toHaveLength(0);
    const blocking = result.referenceArtifactsFindings.filter((f) => f.severity === 'blocking');
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking.some((f) => f.artifactId === 'dbx1_ref')).toBe(true);
  });

  it('reference with missing archive fails closed when its policy requires it', async () => {
    const candidate = buildArtifact({
      artifactId: 'dbx1_cand',
      sourceDocumentId: 'sd-cand',
      manifestDocumentKey: 'r1_army_fy2027',
      sourcePdfSha256: CANDIDATE_SHA,
      sourceLocator: '/r1.pdf',
    });
    const refArtifact = buildArtifact({
      artifactId: 'dbx1_ref',
      sourceDocumentId: 'sd-ref',
      manifestDocumentKey: 'r2_army_fy2027',
      sourcePdfSha256: REF_SHA,
      sourceLocator: '/r2.pdf',
      exhibit: 'R-2',
    });
    const refSourceDoc = sourceDocRow({ id: 'sd-ref', sourceKey: '/r2.pdf', sha256: REF_SHA });
    const { resolver, input } = buildHarness({
      candidateArtifact: candidate,
      candidateSourceDoc: sourceDocRow({
        id: 'sd-cand',
        sourceKey: '/r1.pdf',
        sha256: CANDIDATE_SHA,
      }),
      candidateSourceBytes: CANDIDATE_SRC,
      referenceDocEntries: [docEntry('r2_army_fy2027', '/r2.pdf', 'R-2')],
      references: [
        {
          descriptor: {
            artifactLocator: '/ref.json',
            sourceDocumentId: 'sd-ref',
            manifestDocumentKey: 'r2_army_fy2027',
          },
          artifact: refArtifact,
          sourceDoc: refSourceDoc,
          sourceBytes: REF_SRC,
          dropArchive: true,
        },
      ],
    });
    const result = await resolver.resolve(input);
    expect(result.referenceArtifacts).toHaveLength(0);
    const blocking = result.referenceArtifactsFindings.filter((f) => f.severity === 'blocking');
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking.some((f) => f.artifactId === 'dbx1_ref')).toBe(true);
  });

  it('reference with missing parser output fails closed when its policy requires it', async () => {
    const candidate = buildArtifact({
      artifactId: 'dbx1_cand',
      sourceDocumentId: 'sd-cand',
      manifestDocumentKey: 'r1_army_fy2027',
      sourcePdfSha256: CANDIDATE_SHA,
      sourceLocator: '/r1.pdf',
    });
    const refArtifact = buildArtifact({
      artifactId: 'dbx1_ref',
      sourceDocumentId: 'sd-ref',
      manifestDocumentKey: 'r2_army_fy2027',
      sourcePdfSha256: REF_SHA,
      sourceLocator: '/r2.pdf',
      exhibit: 'R-2',
    });
    const refSourceDoc = sourceDocRow({ id: 'sd-ref', sourceKey: '/r2.pdf', sha256: REF_SHA });
    const { resolver, input } = buildHarness({
      candidateArtifact: candidate,
      candidateSourceDoc: sourceDocRow({
        id: 'sd-cand',
        sourceKey: '/r1.pdf',
        sha256: CANDIDATE_SHA,
      }),
      candidateSourceBytes: CANDIDATE_SRC,
      referenceDocEntries: [docEntry('r2_army_fy2027', '/r2.pdf', 'R-2')],
      references: [
        {
          descriptor: {
            artifactLocator: '/ref.json',
            sourceDocumentId: 'sd-ref',
            manifestDocumentKey: 'r2_army_fy2027',
          },
          artifact: refArtifact,
          sourceDoc: refSourceDoc,
          sourceBytes: REF_SRC,
          parserOutput: null, // no persisted parser output
        },
      ],
    });
    const result = await resolver.resolve(input);
    expect(result.referenceArtifacts).toHaveLength(0);
    const blocking = result.referenceArtifactsFindings.filter((f) => f.severity === 'blocking');
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking.some((f) => f.artifactId === 'dbx1_ref')).toBe(true);
  });

  it('one valid and one invalid reference: valid still indexed, invalid excluded', async () => {
    const candidate = buildArtifact({
      artifactId: 'dbx1_cand',
      sourceDocumentId: 'sd-cand',
      manifestDocumentKey: 'r1_army_fy2027',
      sourcePdfSha256: CANDIDATE_SHA,
      sourceLocator: '/r1.pdf',
    });
    const validRef = buildArtifact({
      artifactId: 'dbx1_ref_valid',
      sourceDocumentId: 'sd-ref-valid',
      manifestDocumentKey: 'r2_army_fy2027',
      sourcePdfSha256: REF_SHA,
      sourceLocator: '/r2.pdf',
      exhibit: 'R-2',
      assertions: [fundingAssertion('ref-a1', '0201101F', '10')],
    });
    const invalidRef = buildArtifact({
      artifactId: 'dbx1_ref_invalid',
      sourceDocumentId: 'sd-ref-invalid',
      manifestDocumentKey: 'r3_army_fy2027',
      sourcePdfSha256: OTHER_SHA,
      sourceLocator: '/r3.pdf',
      exhibit: 'R-2',
    });
    const validSourceDoc = sourceDocRow({
      id: 'sd-ref-valid',
      sourceKey: '/r2.pdf',
      sha256: REF_SHA,
    });
    const invalidSourceDoc = sourceDocRow({
      id: 'sd-ref-invalid',
      sourceKey: '/r3.pdf',
      sha256: OTHER_SHA,
    });
    const { resolver, input } = buildHarness({
      candidateArtifact: candidate,
      candidateSourceDoc: sourceDocRow({
        id: 'sd-cand',
        sourceKey: '/r1.pdf',
        sha256: CANDIDATE_SHA,
      }),
      candidateSourceBytes: CANDIDATE_SRC,
      referenceDocEntries: [
        docEntry('r2_army_fy2027', '/r2.pdf', 'R-2'),
        docEntry('r3_army_fy2027', '/r3.pdf', 'R-2'),
      ],
      references: [
        {
          descriptor: {
            artifactLocator: '/ref-valid.json',
            sourceDocumentId: 'sd-ref-valid',
            manifestDocumentKey: 'r2_army_fy2027',
          },
          artifact: validRef,
          sourceDoc: validSourceDoc,
          sourceBytes: REF_SRC,
        },
        {
          descriptor: {
            artifactLocator: '/ref-invalid.json',
            sourceDocumentId: 'sd-ref-invalid',
            manifestDocumentKey: 'r3_army_fy2027',
          },
          artifact: invalidRef,
          sourceDoc: invalidSourceDoc,
          sourceBytes: REF_SRC,
          dropSourceBytes: true, // invalid: source bytes unavailable
        },
      ],
    });
    const result = await resolver.resolve(input);

    // Only the valid reference is retained.
    expect(result.referenceArtifacts).toHaveLength(1);
    expect(result.referenceArtifacts[0]!.artifactId).toBe('dbx1_ref_valid');

    // The invalid reference produced a blocking, tagged finding.
    const invalidFindings = result.referenceArtifactsFindings.filter(
      (f) => f.artifactId === 'dbx1_ref_invalid' && f.severity === 'blocking',
    );
    expect(invalidFindings.length).toBeGreaterThan(0);

    // Comparison provider: the invalid reference is NEVER indexed, but the
    // valid reference IS, so the index is non-empty and contains only the
    // valid reference's assertions.
    const provider = createComparisonProvider(
      result.referenceArtifacts,
      result.referenceArtifactsProofBundles,
      result.referenceArtifactsFindings,
    );
    expect(provider.allReferencesProved).toBe(false);
    expect(provider.index.size()).toBe(1);
    const match = provider.lookupFunding(
      JSON.stringify({ lineKind: 'RDTE_PE', peCode: '0201101F' }),
      2027,
      'request',
    );
    expect(match.kind).toBe('one');
    if (match.kind === 'one') {
      expect(match.value.artifactId).toBe('dbx1_ref_valid');
    }
  });

  it('candidate and reference may share the same official document but are resolved independently', async () => {
    const candidate = buildArtifact({
      artifactId: 'dbx1_cand',
      sourceDocumentId: 'sd-cand',
      manifestDocumentKey: 'r1_army_fy2027',
      sourcePdfSha256: CANDIDATE_SHA,
      sourceLocator: '/r1.pdf',
    });
    // Reference re-extracts the SAME official document (same source SHA,
    // same source locator) under its own SourceDocument row.
    const refArtifact = buildArtifact({
      artifactId: 'dbx1_ref_same_doc',
      sourceDocumentId: 'sd-ref-same',
      manifestDocumentKey: 'r1_army_fy2027',
      sourcePdfSha256: CANDIDATE_SHA,
      sourceLocator: '/r1.pdf',
    });
    const refSourceDoc = sourceDocRow({
      id: 'sd-ref-same',
      sourceKey: '/r1.pdf',
      sha256: CANDIDATE_SHA,
      archiveS3Key: 'k-ref-same',
      archiveVersionId: 'v-ref-same',
    });
    const { resolver, input } = buildHarness({
      candidateArtifact: candidate,
      candidateSourceDoc: sourceDocRow({
        id: 'sd-cand',
        sourceKey: '/r1.pdf',
        sha256: CANDIDATE_SHA,
      }),
      candidateSourceBytes: CANDIDATE_SRC,
      references: [
        {
          descriptor: {
            artifactLocator: '/ref-same.json',
            sourceDocumentId: 'sd-ref-same',
            manifestDocumentKey: 'r1_army_fy2027',
          },
          artifact: refArtifact,
          sourceDoc: refSourceDoc,
          sourceBytes: CANDIDATE_SRC,
          archiveBytes: CANDIDATE_SRC,
          // Same official document: the persisted parser output must record
          // the candidate's source SHA.
          parserOutput: okParserOutput(CANDIDATE_SHA),
        },
      ],
    });
    const result = await resolver.resolve(input);
    expect(result.referenceArtifacts).toHaveLength(1);
    const refBundle = result.referenceArtifactsProofBundles[0]!;
    // Independently resolved: the reference's own SourceDocument ID and its
    // own archive proof, even though the underlying bytes are identical.
    expect(refBundle.sourceDocument.id).toBe('sd-ref-same');
    expect(refBundle.sourceDocument.id).not.toBe('sd-cand');
    expect(refBundle.archive.status).toBe('verified');
    expect(refBundle.archive.versionId).toBe('v-ref-same');
    expect(result.referenceArtifactsFindings).toHaveLength(0);
  });

  it('candidate failure aborts in production mode; reference failure does not', async () => {
    // Candidate with unresolvable source bytes must THROW.
    const candidate = buildArtifact({
      artifactId: 'dbx1_cand',
      sourceDocumentId: 'sd-cand',
      manifestDocumentKey: 'r1_army_fy2027',
      sourcePdfSha256: CANDIDATE_SHA,
      sourceLocator: '/r1.pdf',
    });
    const { resolver, input } = buildHarness({
      candidateArtifact: candidate,
      candidateSourceDoc: sourceDocRow({
        id: 'sd-cand',
        sourceKey: '/r1.pdf',
        sha256: CANDIDATE_SHA,
      }),
      candidateSourceBytes: CANDIDATE_SRC,
    });
    // Remove the candidate's source bytes from the reader by rebuilding the
    // resolver against a reader missing the source locator.
    const failingResolver = new CompositeProofResolver({
      mode: 'production_proof',
      byteLocatorReader: {
        async read(locator: string) {
          if (locator === '/r1.pdf') throw new Error('not found');
          const files: Record<string, Buffer> = {
            '/manifest.json': Buffer.from(
              JSON.stringify(manifest([docEntry('r1_army_fy2027', '/r1.pdf')])),
            ),
            '/candidate.json': Buffer.from(JSON.stringify(candidate)),
          };
          const bytes = files[locator];
          if (!bytes) throw new Error(`not found: ${locator}`);
          return {
            locator,
            bytes,
            kind: 'filesystem' as const,
            contentLength: bytes.length,
            checksumSha256: sha256(bytes),
          };
        },
      },
      sourceDocumentClient: {
        sourceDocument: {
          findFirst: jest.fn(async () => ({
            id: 'sd-cand',
            sourceKey: '/r1.pdf',
            sha256: CANDIDATE_SHA,
            supersededByDocumentId: null,
            fiscalYear: 2027,
            component: 'ARMY',
            budgetCycle: 'pb',
            documentType: 'exhibit',
          })),
          create: jest.fn(),
          update: jest.fn(),
        },
      },
      parseJobClient: { documentParseJob: { findFirst: jest.fn(async () => null) } },
      s3Reader: {
        getObjectBytes: jest.fn(async () => null),
        headObject: jest.fn(async () => null),
      },
      parserOutputProofSource: { resolveParserOutput: jest.fn(async () => null) },
    });
    await expect(
      failingResolver.resolve(candidateDescriptor({ manifestDocumentKey: 'r1_army_fy2027' })),
    ).rejects.toThrow(TrustedProofResolutionError);
    void resolver;
  });

  it('artifact-specific findings retain reference ID and locator', async () => {
    const candidate = buildArtifact({
      artifactId: 'dbx1_cand',
      sourceDocumentId: 'sd-cand',
      manifestDocumentKey: 'r1_army_fy2027',
      sourcePdfSha256: CANDIDATE_SHA,
      sourceLocator: '/r1.pdf',
    });
    const refArtifact = buildArtifact({
      artifactId: 'dbx1_ref_tag',
      sourceDocumentId: 'sd-ref-tag',
      manifestDocumentKey: 'r2_army_fy2027',
      sourcePdfSha256: REF_SHA,
      sourceLocator: '/r2.pdf',
      exhibit: 'R-2',
    });
    const refSourceDoc = sourceDocRow({ id: 'sd-ref-tag', sourceKey: '/r2.pdf', sha256: REF_SHA });
    const { resolver, input } = buildHarness({
      candidateArtifact: candidate,
      candidateSourceDoc: sourceDocRow({
        id: 'sd-cand',
        sourceKey: '/r1.pdf',
        sha256: CANDIDATE_SHA,
      }),
      candidateSourceBytes: CANDIDATE_SRC,
      referenceDocEntries: [docEntry('r2_army_fy2027', '/r2.pdf', 'R-2')],
      references: [
        {
          descriptor: {
            artifactLocator: '/ref-tag.json',
            sourceDocumentId: 'sd-ref-tag',
            manifestDocumentKey: 'r2_army_fy2027',
          },
          artifact: refArtifact,
          sourceDoc: refSourceDoc,
          sourceBytes: REF_SRC,
          dropSourceBytes: true,
        },
      ],
    });
    const result = await resolver.resolve(input);
    const tagged = result.referenceArtifactsFindings.filter((f) => f.severity === 'blocking');
    expect(tagged.length).toBeGreaterThan(0);
    for (const f of tagged) {
      expect(f.artifactId).toBe('dbx1_ref_tag');
      expect(f.sourceDocumentId).toBe('sd-ref-tag');
      expect(f.locator).toBe('/ref-tag.json');
    }
  });
});

describe('R8.2-D request contract (schema-level)', () => {
  // The request schema is exercised in verification-contract-v1.spec.ts;
  // here we assert the resolver input type requires the mandatory fields so
  // that a missing manifestDocumentKey cannot even be constructed in typed
  // code paths.
  it('resolveSingleArtifactProof is the only trust path (no separate reference method)', async () => {
    // Structural guard: CompositeProofResolver exposes no public reference-only
    // proof method. The unified method is private; the public surface is
    // resolve() only.
    const candidate = buildArtifact({
      artifactId: 'dbx1_cand',
      sourceDocumentId: 'sd-cand',
      manifestDocumentKey: 'r1_army_fy2027',
      sourcePdfSha256: CANDIDATE_SHA,
      sourceLocator: '/r1.pdf',
    });
    const { resolver, input } = buildHarness({
      candidateArtifact: candidate,
      candidateSourceDoc: sourceDocRow({
        id: 'sd-cand',
        sourceKey: '/r1.pdf',
        sha256: CANDIDATE_SHA,
      }),
      candidateSourceBytes: CANDIDATE_SRC,
    });
    const anyResolver = resolver as unknown as Record<string, unknown>;
    expect(typeof anyResolver.resolve).toBe('function');
    expect(anyResolver.resolveReference).toBeUndefined();
    expect(anyResolver.resolveReferenceArtifact).toBeUndefined();
  });
});

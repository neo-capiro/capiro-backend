import {
  EXTRACTION_METHOD_RISK_PRECEDENCE_V1,
  EXTRACTION_METHOD_V1_VALUES,
  type BudgetFamilyV1,
  type DefenseBudgetExtractionArtifactV1,
  type ExtractionMethodV1,
  type ParserRunV1,
} from '../contracts/extraction-artifact-v1.js';
import { ArtifactBuilderV1, parserRunIdV1 } from '../contracts/artifact-builders.js';
import { HIGH_RISK_EXTRACTION_METHOD_V1_VALUES } from '../promotion/promotion-eligibility-v1.js';
import {
  CandidateSourceMetadataUnresolvedErrorV1,
  deriveCandidateSourceMetadataV1,
  resolveArtifactExtractionMethodV1,
  tryDeriveCandidateSourceMetadataV1,
} from './candidate-source-metadata-v1.js';
import {
  backfillCandidateSourceMetadataV1,
  type BackfillCandidateRowV1,
  type CandidateSourceMetadataBackfillPortsV1,
} from './candidate-source-metadata-backfill-v1.js';
import { computeArtifactContentSha256 } from '../contracts/extraction-artifact-v1.semantic.js';

const SHA = (c: string) => c.repeat(64);

function parserRun(method: ExtractionMethodV1, id = `run-${method}`): ParserRunV1 {
  return {
    parserRunId: id,
    method,
    parserVersion: 'test-v1',
    parserConfigSha256: SHA('1'),
    inputSourceSha256: SHA('2'),
    outputArtifactSha256: SHA('3'),
    pageRanges: [{ startPage: 1, endPage: 1 }],
  };
}

/**
 * Only the fields the derivation reads. Cast rather than built through the
 * artifact builder on purpose: the builder runs full semantic validation, which
 * would make these tests about fixture completeness instead of about the
 * derivation rule.
 */
function artifact(
  overrides: {
    family?: string;
    parserRuns?: ParserRunV1[];
    artifactId?: string;
  } = {},
): DefenseBudgetExtractionArtifactV1 {
  return {
    artifactId: overrides.artifactId ?? 'artifact-1',
    source: { family: overrides.family ?? 'rdte' },
    parserRuns: overrides.parserRuns ?? [parserRun('deterministic_pdfplumber')],
  } as unknown as DefenseBudgetExtractionArtifactV1;
}

describe('EXTRACTION_METHOD_RISK_PRECEDENCE_V1', () => {
  it('covers every extraction method, so a new method forces a placement decision', () => {
    expect([...EXTRACTION_METHOD_RISK_PRECEDENCE_V1].sort()).toEqual(
      [...EXTRACTION_METHOD_V1_VALUES].sort(),
    );
    expect(new Set(EXTRACTION_METHOD_RISK_PRECEDENCE_V1).size).toBe(
      EXTRACTION_METHOD_RISK_PRECEDENCE_V1.length,
    );
  });

  it('leads with exactly the high-risk methods, in the same order', () => {
    // If these diverge, a high-risk artifact silently stops resolving to its
    // high-risk method and the authorizer-equals-extractor control weakens.
    expect(
      EXTRACTION_METHOD_RISK_PRECEDENCE_V1.slice(0, HIGH_RISK_EXTRACTION_METHOD_V1_VALUES.length),
    ).toEqual([...HIGH_RISK_EXTRACTION_METHOD_V1_VALUES]);
  });
});

describe('resolveArtifactExtractionMethodV1', () => {
  it('returns the single method when only one parser run contributed', () => {
    expect(resolveArtifactExtractionMethodV1(artifact())).toBe('deterministic_pdfplumber');
  });

  it('resolves a composed artifact to the riskiest contributing method', () => {
    const resolved = resolveArtifactExtractionMethodV1(
      artifact({
        parserRuns: [
          parserRun('native_structured', 'a'),
          parserRun('llamaparse', 'b'),
          parserRun('deterministic_pdfplumber', 'c'),
        ],
      }),
    );
    expect(resolved).toBe('llamaparse');
  });

  it('is independent of parser-run order', () => {
    const runs = [parserRun('manual', 'a'), parserRun('camelot', 'b')];
    expect(resolveArtifactExtractionMethodV1(artifact({ parserRuns: runs }))).toBe('manual');
    expect(resolveArtifactExtractionMethodV1(artifact({ parserRuns: [...runs].reverse() }))).toBe(
      'manual',
    );
  });

  it('prefers manual over the other two high-risk methods', () => {
    expect(
      resolveArtifactExtractionMethodV1(
        artifact({ parserRuns: [parserRun('paddleocr', 'a'), parserRun('manual', 'b')] }),
      ),
    ).toBe('manual');
  });

  it('refuses an artifact with no parser runs rather than assuming a method', () => {
    expect(() => resolveArtifactExtractionMethodV1(artifact({ parserRuns: [] }))).toThrow(
      CandidateSourceMetadataUnresolvedErrorV1,
    );
  });
});

describe('deriveCandidateSourceMetadataV1', () => {
  it('takes family from the artifact source block', () => {
    expect(deriveCandidateSourceMetadataV1(artifact({ family: 'committee' }))).toEqual({
      family: 'committee',
      extractionMethod: 'deterministic_pdfplumber',
    });
  });

  it('refuses family "unknown" instead of storing an unscopeable value', () => {
    expect(() => deriveCandidateSourceMetadataV1(artifact({ family: 'unknown' }))).toThrow(
      /unclassified document cannot be scoped/,
    );
  });

  it('refuses a family outside the vocabulary', () => {
    expect(() => deriveCandidateSourceMetadataV1(artifact({ family: 'not_a_family' }))).toThrow();
  });

  it('tryDerive returns null rather than throwing, so verification never fails on metadata', () => {
    expect(tryDeriveCandidateSourceMetadataV1(artifact({ parserRuns: [] }))).toBeNull();
    expect(tryDeriveCandidateSourceMetadataV1(artifact({ family: 'unknown' }))).toBeNull();
    expect(tryDeriveCandidateSourceMetadataV1(artifact())).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Backfill                                                            */
/* ------------------------------------------------------------------ */

/**
 * A genuinely valid artifact, built through the real `ArtifactBuilderV1` so it
 * survives `parseDefenseBudgetExtractionArtifactV1`'s strict schema *and*
 * semantic validation. The hand-rolled cast above is fine for the pure
 * derivation tests, which only read three fields, but the backfill parses real
 * bytes — so a cast fixture would make every backfill test assert
 * `artifact_unparseable` and prove nothing about the hash chain.
 *
 * The builder computes `contentSha256` itself, so these are self-consistent by
 * construction.
 */
function builtArtifact(
  overrides: { family?: BudgetFamilyV1; method?: ExtractionMethodV1 } = {},
): DefenseBudgetExtractionArtifactV1 {
  const key = `doc-${overrides.family ?? 'rdte'}-${overrides.method ?? 'camelot'}`;
  const builder = new ArtifactBuilderV1({
    manifestDocumentKey: key,
    sourceDocumentId: `source-document-${key}`,
    sourcePdfSha256: SHA('a'),
    sourceLocator: `/sources/${key}.pdf`,
    fiscalYear: 2027,
    family: overrides.family ?? 'rdte',
    exhibit: 'R-2',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb_fy2027',
    documentType: 'r-2',
  });
  builder.addParserRun({
    parserRunId: parserRunIdV1({ key }),
    method: overrides.method ?? 'camelot',
    parserVersion: 'test-v1',
    parserConfigSha256: SHA('e'),
    inputSourceSha256: SHA('a'),
    outputArtifactSha256: SHA('f'),
    pageRanges: [{ startPage: 1, endPage: 20 }],
  });
  return builder.finalize();
}

class FakeBackfillPorts implements CandidateSourceMetadataBackfillPortsV1 {
  readonly updates: { candidateId: string; family: string; extractionMethod: string }[] = [];

  constructor(
    private readonly rows: BackfillCandidateRowV1[],
    private readonly bytesByLocator: Map<string, Buffer | Error>,
  ) {}

  async listCandidatesMissingMetadata(): Promise<BackfillCandidateRowV1[]> {
    return this.rows;
  }

  async readArtifactBytes(locator: string): Promise<Buffer> {
    const entry = this.bytesByLocator.get(locator);
    if (entry == null) throw new Error(`no such locator ${locator}`);
    if (entry instanceof Error) throw entry;
    return entry;
  }

  async updateCandidateSourceMetadata(
    candidateId: string,
    metadata: { family: string; extractionMethod: string },
  ): Promise<void> {
    this.updates.push({ candidateId, ...metadata });
  }
}

function bytesOf(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

describe('backfillCandidateSourceMetadataV1', () => {
  it('backfills a candidate whose artifact recomputes to its stored content SHA', async () => {
    const art = builtArtifact({ family: 'om', method: 'docling' });
    const ports = new FakeBackfillPorts(
      [
        {
          id: 'cand-1',
          extractionArtifactSha256: computeArtifactContentSha256(art),
          extractionArtifactLocator: 'file:///artifacts/a.json',
        },
      ],
      new Map([['file:///artifacts/a.json', bytesOf(art)]]),
    );

    const report = await backfillCandidateSourceMetadataV1(ports, { commit: true });

    expect(report.backfilled).toBe(1);
    expect(report.refused).toBe(0);
    expect(ports.updates).toEqual([
      { candidateId: 'cand-1', family: 'om', extractionMethod: 'docling' },
    ]);
  });

  it('does the whole verification chain in dry run but writes nothing', async () => {
    const art = builtArtifact();
    const ports = new FakeBackfillPorts(
      [
        {
          id: 'cand-1',
          extractionArtifactSha256: computeArtifactContentSha256(art),
          extractionArtifactLocator: 'file:///a.json',
        },
      ],
      new Map([['file:///a.json', bytesOf(art)]]),
    );

    const report = await backfillCandidateSourceMetadataV1(ports, { commit: false });

    expect(report.outcomes[0]).toMatchObject({ outcome: 'would_backfill', family: 'rdte' });
    expect(report.backfilled).toBe(0);
    expect(ports.updates).toEqual([]);
  });

  it('refuses an artifact filed against a different content SHA', async () => {
    const art = builtArtifact();
    const ports = new FakeBackfillPorts(
      [
        {
          id: 'cand-1',
          extractionArtifactSha256: SHA('9'),
          extractionArtifactLocator: 'file:///a.json',
        },
      ],
      new Map([['file:///a.json', bytesOf(art)]]),
    );

    const report = await backfillCandidateSourceMetadataV1(ports, { commit: true });

    expect(report.outcomes[0]).toMatchObject({
      outcome: 'refused',
      reason: 'artifact_content_sha_mismatch',
    });
    expect(ports.updates).toEqual([]);
  });

  it('refuses an artifact that disagrees with its own declared contentSha256', async () => {
    const art = { ...builtArtifact(), contentSha256: SHA('7') };
    const ports = new FakeBackfillPorts(
      [
        {
          id: 'cand-1',
          extractionArtifactSha256: computeArtifactContentSha256(art),
          extractionArtifactLocator: 'file:///a.json',
        },
      ],
      new Map([['file:///a.json', bytesOf(art)]]),
    );

    const report = await backfillCandidateSourceMetadataV1(ports, { commit: true });

    expect(report.outcomes[0]).toMatchObject({
      outcome: 'refused',
      reason: 'artifact_content_sha_self_inconsistent',
    });
  });

  it('refuses a candidate with no locator', async () => {
    const ports = new FakeBackfillPorts(
      [{ id: 'cand-1', extractionArtifactSha256: SHA('1'), extractionArtifactLocator: null }],
      new Map(),
    );

    const report = await backfillCandidateSourceMetadataV1(ports, { commit: true });

    expect(report.outcomes[0]).toMatchObject({ outcome: 'refused', reason: 'no_locator' });
  });

  it('refuses an unreadable artifact without stopping the run', async () => {
    const art = builtArtifact();
    const ports = new FakeBackfillPorts(
      [
        { id: 'cand-1', extractionArtifactSha256: SHA('1'), extractionArtifactLocator: 's3://x/y' },
        {
          id: 'cand-2',
          extractionArtifactSha256: computeArtifactContentSha256(art),
          extractionArtifactLocator: 'file:///a.json',
        },
      ],
      new Map<string, Buffer | Error>([
        ['s3://x/y', new Error('access denied')],
        ['file:///a.json', bytesOf(art)],
      ]),
    );

    const report = await backfillCandidateSourceMetadataV1(ports, { commit: true });

    expect(report.examined).toBe(2);
    expect(report.refused).toBe(1);
    expect(report.backfilled).toBe(1);
    expect(report.outcomes[0]).toMatchObject({ reason: 'artifact_unreadable' });
    expect(ports.updates).toEqual([{ candidateId: 'cand-2', family: 'rdte', extractionMethod: 'camelot' }]);
  });

  it('refuses bytes that are not an extraction artifact at all', async () => {
    const ports = new FakeBackfillPorts(
      [
        {
          id: 'cand-1',
          extractionArtifactSha256: SHA('1'),
          extractionArtifactLocator: 'file:///a.json',
        },
      ],
      new Map([['file:///a.json', Buffer.from('not json', 'utf8')]]),
    );

    const report = await backfillCandidateSourceMetadataV1(ports, { commit: true });

    expect(report.outcomes[0]).toMatchObject({
      outcome: 'refused',
      reason: 'artifact_unparseable',
    });
  });
});

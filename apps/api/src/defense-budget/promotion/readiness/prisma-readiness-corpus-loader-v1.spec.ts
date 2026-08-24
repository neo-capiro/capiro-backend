/**
 * Phase 10B-2 Gap 2a — dedicated real-adapter spec for
 * `PrismaReadinessCorpusLoaderV1`.
 *
 * These tests exercise the ACTUAL adapter class against a narrow Prisma-like
 * fake (table-routed, matching the existing repo pattern in
 * `promotion-eligibility-read-repository-prisma-v1.spec.ts`), not the
 * orchestrator fakes. The orchestrator's own spec proves orchestration logic
 * against a `FakeCorpusLoader`; this spec proves the adapter that actually
 * turns SQL rows into `CycleFamilyCorpusInputV1`.
 */
import {
  PrismaReadinessCorpusLoaderV1,
  type ReadinessPrismaQueryPortV1,
} from './prisma-readiness-corpus-loader-v1.js';
import type { CycleFamilyReadinessIdentityV1 } from './cycle-family-readiness-v1.js';

const SHA = (c: string) => c.repeat(64);

const IDENTITY: CycleFamilyReadinessIdentityV1 = {
  fiscalYear: 2027,
  authorityTrack: 'authorization',
  familyGroup: 'om',
};

interface FakeTables {
  cycle?: Array<{ id: string }>;
  expected?: Array<{ id: string; sourceFamily: string; expectedState: string; optional: boolean }>;
  observations?: Array<{
    expectedSourceId: string;
    observationState: string;
    sourceDocumentId: string | null;
    contentSha256: string;
    lastSeenAt: Date;
  }>;
  sourceDocuments?: Array<{ id: string; sha256: string | null }>;
  parseJobs?: Array<{ inputSha256: string; status: string }>;
  candidates?: Array<{ id: string; sourceDocumentId: string; sourceSha256: string; currentRunId: string | null }>;
  verificationRuns?: Array<{ id: string; candidateId: string; decision: string; completedAt: Date | string }>;
}

/** Table-routed fake, matching the existing repo pattern for prisma-like fakes. */
class FakeReadinessPrisma implements ReadinessPrismaQueryPortV1 {
  public readonly queries: Array<{ query: string; values: unknown[] }> = [];
  constructor(private readonly tables: FakeTables) {}

  async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
    this.queries.push({ query, values });
    if (query.includes('FROM "defense_budget_cycle"')) {
      return (this.tables.cycle ?? []) as unknown as T;
    }
    if (query.includes('FROM "defense_budget_expected_source"')) {
      return (this.tables.expected ?? []) as unknown as T;
    }
    if (query.includes('FROM "defense_budget_source_observation"')) {
      const requestedIds = new Set((values[0] as string[]) ?? []);
      return (this.tables.observations ?? []).filter((row) =>
        requestedIds.has(row.expectedSourceId),
      ) as unknown as T;
    }
    if (query.includes('FROM "source_document"')) {
      const id = values[0];
      return (this.tables.sourceDocuments ?? []).filter((row) => row.id === id) as unknown as T;
    }
    if (query.includes('FROM "document_parse_job"')) {
      const [sourceDocumentId, sha256] = values;
      return (this.tables.parseJobs ?? []).filter(
        (row) => row.inputSha256 === sha256 && row.status === 'succeeded',
      ) as unknown as T;
      void sourceDocumentId;
    }
    if (query.includes('FROM "budget_extraction_candidate_v1"')) {
      const [sourceDocumentId, sourceSha256] = values;
      return (this.tables.candidates ?? []).filter(
        (row) => row.sourceDocumentId === sourceDocumentId && row.sourceSha256 === sourceSha256,
      ) as unknown as T;
    }
    if (query.includes('FROM "budget_verification_run_v1"')) {
      const candidateId = values[0];
      return (this.tables.verificationRuns ?? []).filter(
        (row) => row.candidateId === candidateId,
      ) as unknown as T;
    }
    throw new Error(`unexpected query in fake: ${query}`);
  }
}

const CYCLE = { id: 'cycle-fy2027-authorization' };

function passRow(overrides: Partial<FakeTables> = {}): FakeTables {
  return {
    cycle: [CYCLE],
    expected: [{ id: 'exp-1', sourceFamily: 'pb_o1', expectedState: 'published', optional: false }],
    observations: [
      {
        expectedSourceId: 'exp-1',
        observationState: 'ingested',
        sourceDocumentId: 'doc-1',
        contentSha256: SHA('a'),
        lastSeenAt: new Date('2027-06-01T00:00:00Z'),
      },
    ],
    sourceDocuments: [{ id: 'doc-1', sha256: SHA('a') }],
    parseJobs: [{ inputSha256: SHA('a'), status: 'succeeded' }],
    candidates: [{ id: 'cand-1', sourceDocumentId: 'doc-1', sourceSha256: SHA('a'), currentRunId: 'run-1' }],
    verificationRuns: [{ id: 'run-1', candidateId: 'cand-1', decision: 'PASS', completedAt: '2027-06-02T00:00:00Z' }],
    ...overrides,
  };
}

describe('PrismaReadinessCorpusLoaderV1', () => {
  it('resolves a persisted SourceDocument + matching durable parser run + PASS verification -> ingested_pass', async () => {
    const loader = new PrismaReadinessCorpusLoaderV1(new FakeReadinessPrisma(passRow()));
    const corpus = await loader.loadCorpus(IDENTITY);
    expect(corpus.cycleId).toBe(CYCLE.id);
    expect(corpus.expectedSources).toHaveLength(1);
    expect(corpus.expectedSources[0]?.latestIngestion).toBe('ingested_pass');
  });

  it('resolves persisted REVIEW -> ingested_review', async () => {
    const tables = passRow({
      verificationRuns: [{ id: 'run-1', candidateId: 'cand-1', decision: 'REVIEW', completedAt: '2027-06-02T00:00:00Z' }],
    });
    const loader = new PrismaReadinessCorpusLoaderV1(new FakeReadinessPrisma(tables));
    const corpus = await loader.loadCorpus(IDENTITY);
    expect(corpus.expectedSources[0]?.latestIngestion).toBe('ingested_review');
  });

  it('resolves persisted REJECT -> ingested_reject', async () => {
    const tables = passRow({
      verificationRuns: [{ id: 'run-1', candidateId: 'cand-1', decision: 'REJECT', completedAt: '2027-06-02T00:00:00Z' }],
    });
    const loader = new PrismaReadinessCorpusLoaderV1(new FakeReadinessPrisma(tables));
    const corpus = await loader.loadCorpus(IDENTITY);
    expect(corpus.expectedSources[0]?.latestIngestion).toBe('ingested_reject');
  });

  it('observation_state=ingested but missing durable parser/verification proof -> ingestion_incomplete (never PASS)', async () => {
    const tables = passRow({ parseJobs: [], candidates: [], verificationRuns: [] });
    const loader = new PrismaReadinessCorpusLoaderV1(new FakeReadinessPrisma(tables), () => {});
    const corpus = await loader.loadCorpus(IDENTITY);
    expect(corpus.expectedSources[0]?.latestIngestion).toBe('ingestion_incomplete');
  });

  it('a SHA mismatch between the observation and its SourceDocument fails closed to ingestion_incomplete', async () => {
    const tables = passRow({ sourceDocuments: [{ id: 'doc-1', sha256: SHA('different') }] });
    const warnings: string[] = [];
    const loader = new PrismaReadinessCorpusLoaderV1(new FakeReadinessPrisma(tables), (m) => warnings.push(m));
    const corpus = await loader.loadCorpus(IDENTITY);
    expect(corpus.expectedSources[0]?.latestIngestion).toBe('ingestion_incomplete');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/invariant violation/);
  });

  it('a stale/superseded verification run cannot satisfy readiness when a newer run exists and is current', async () => {
    // Two runs for the same candidate: an OLD REJECT and a NEWER PASS that is
    // named as the candidate's own currentRunId. The current run must win.
    const tables = passRow({
      candidates: [{ id: 'cand-1', sourceDocumentId: 'doc-1', sourceSha256: SHA('a'), currentRunId: 'run-2' }],
      verificationRuns: [
        { id: 'run-1', candidateId: 'cand-1', decision: 'REJECT', completedAt: '2027-01-01T00:00:00Z' },
        { id: 'run-2', candidateId: 'cand-1', decision: 'PASS', completedAt: '2027-06-02T00:00:00Z' },
      ],
    });
    const loader = new PrismaReadinessCorpusLoaderV1(new FakeReadinessPrisma(tables));
    const corpus = await loader.loadCorpus(IDENTITY);
    expect(corpus.expectedSources[0]?.latestIngestion).toBe('ingested_pass');
  });

  it('a superseded candidate (no currentRunId resolvable) falls back to the latest run by completedAt', async () => {
    const tables = passRow({
      candidates: [{ id: 'cand-1', sourceDocumentId: 'doc-1', sourceSha256: SHA('a'), currentRunId: null }],
      verificationRuns: [
        { id: 'run-1', candidateId: 'cand-1', decision: 'REJECT', completedAt: '2027-01-01T00:00:00Z' },
        { id: 'run-2', candidateId: 'cand-1', decision: 'PASS', completedAt: '2027-06-02T00:00:00Z' },
      ],
    });
    const loader = new PrismaReadinessCorpusLoaderV1(new FakeReadinessPrisma(tables));
    const corpus = await loader.loadCorpus(IDENTITY);
    expect(corpus.expectedSources[0]?.latestIngestion).toBe('ingested_pass');
  });

  it('the loader scopes by the requested fiscal year + authority track via the cycle lookup', async () => {
    const prisma = new FakeReadinessPrisma(passRow());
    const loader = new PrismaReadinessCorpusLoaderV1(prisma);
    await loader.loadCorpus(IDENTITY);
    const cycleQuery = prisma.queries.find((q) => q.query.includes('FROM "defense_budget_cycle"'));
    expect(cycleQuery?.values).toEqual([IDENTITY.fiscalYear, IDENTITY.authorityTrack]);
  });

  it('throws when no cycle exists for the requested (fiscalYear, authorityTrack)', async () => {
    const loader = new PrismaReadinessCorpusLoaderV1(new FakeReadinessPrisma({ cycle: [] }));
    await expect(loader.loadCorpus(IDENTITY)).rejects.toThrow(/defense_budget_cycle_not_found/);
  });

  it('scopes expected sources by family group: another track/family cannot leak into the corpus', async () => {
    const tables = passRow({
      expected: [
        { id: 'exp-1', sourceFamily: 'pb_o1', expectedState: 'published', optional: false }, // om
        { id: 'exp-2', sourceFamily: 'pb_r1', expectedState: 'published', optional: false }, // rdte — must not leak into 'om' scope
      ],
    });
    const loader = new PrismaReadinessCorpusLoaderV1(new FakeReadinessPrisma(tables));
    const corpus = await loader.loadCorpus(IDENTITY);
    expect(corpus.expectedSources).toHaveLength(1);
    expect(corpus.expectedSources[0]?.expectedSourceId).toBe('exp-1');
  });

  it('a milcon-scoped identity never picks up an om expected source from the same cycle', async () => {
    const tables = passRow({
      expected: [{ id: 'exp-1', sourceFamily: 'pb_o1', expectedState: 'published', optional: false }],
    });
    const loader = new PrismaReadinessCorpusLoaderV1(new FakeReadinessPrisma(tables));
    const corpus = await loader.loadCorpus({ ...IDENTITY, familyGroup: 'milcon' });
    expect(corpus.expectedSources).toHaveLength(0);
  });

  it('prefers the newest ingested/changed observation over a newer unclassified duplicate', async () => {
    const tables = passRow({
      observations: [
        {
          expectedSourceId: 'exp-1',
          observationState: 'ingested',
          sourceDocumentId: 'doc-1',
          contentSha256: SHA('a'),
          lastSeenAt: new Date('2027-06-01T00:00:00Z'),
        },
        {
          expectedSourceId: 'exp-1',
          observationState: 'unclassified',
          sourceDocumentId: null,
          contentSha256: SHA('a'),
          lastSeenAt: new Date('2027-07-01T00:00:00Z'),
        },
      ],
    });
    const loader = new PrismaReadinessCorpusLoaderV1(new FakeReadinessPrisma(tables));
    const corpus = await loader.loadCorpus(IDENTITY);
    expect(corpus.expectedSources[0]?.latestIngestion).toBe('ingested_pass');
  });

  it('an expected source with no observation at all reports latestIngestion=null (distinct from ingestion_incomplete)', async () => {
    const tables = passRow({ observations: [] });
    const loader = new PrismaReadinessCorpusLoaderV1(new FakeReadinessPrisma(tables));
    const corpus = await loader.loadCorpus(IDENTITY);
    expect(corpus.expectedSources[0]?.latestIngestion).toBeNull();
  });
});

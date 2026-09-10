import {
  resolveAllowedReviewedAcceptancesV1,
  createPrismaProjectionReviewAcceptanceReaderV1,
  type ProjectionReviewAcceptanceReaderV1,
} from './rdte-projection-review-acceptance-resolver-v1.js';

const CANDIDATE_A = 'candidate-a';
const RUN_A = 'run-a';
const SOURCE_SHA = 'a'.repeat(64);
const ARTIFACT_SHA = 'b'.repeat(64);
const MANIFEST_SHA = 'c'.repeat(64);

function acceptedDecision(overrides: Record<string, string> = {}) {
  return {
    reviewDecisionId: 'rd-1',
    decision: 'accept',
    sourceSha256: SOURCE_SHA,
    extractionArtifactSha256: ARTIFACT_SHA,
    manifestContentSha256: MANIFEST_SHA,
    ...overrides,
  };
}

function fakeReader(
  byKey: Map<string, ReturnType<typeof acceptedDecision> | null>,
): ProjectionReviewAcceptanceReaderV1 {
  return {
    async findAcceptedReviewDecision(input) {
      return byKey.get(`${input.candidateId}|${input.runId}`) ?? null;
    },
  };
}

describe('resolveAllowedReviewedAcceptancesV1', () => {
  test('a real, exactly-matching accepted decision is included', async () => {
    const reader = fakeReader(new Map([[`${CANDIDATE_A}|${RUN_A}`, acceptedDecision()]]));
    const allowed = await resolveAllowedReviewedAcceptancesV1(reader, [
      {
        candidateId: CANDIDATE_A,
        runId: RUN_A,
        expectedSourceSha256: SOURCE_SHA,
        expectedArtifactSha256: ARTIFACT_SHA,
        expectedManifestContentSha256: MANIFEST_SHA,
      },
    ]);
    expect(allowed.has(RUN_A)).toBe(true);
    expect(allowed.size).toBe(1);
  });

  test('no decision at all -> excluded, not a guessed inclusion', async () => {
    const reader = fakeReader(new Map());
    const allowed = await resolveAllowedReviewedAcceptancesV1(reader, [
      {
        candidateId: CANDIDATE_A,
        runId: RUN_A,
        expectedSourceSha256: SOURCE_SHA,
        expectedArtifactSha256: ARTIFACT_SHA,
        expectedManifestContentSha256: MANIFEST_SHA,
      },
    ]);
    expect(allowed.size).toBe(0);
  });

  test('a rejected review decision is excluded', async () => {
    const reader = fakeReader(
      new Map([[`${CANDIDATE_A}|${RUN_A}`, acceptedDecision({ decision: 'reject' })]]),
    );
    const allowed = await resolveAllowedReviewedAcceptancesV1(reader, [
      {
        candidateId: CANDIDATE_A,
        runId: RUN_A,
        expectedSourceSha256: SOURCE_SHA,
        expectedArtifactSha256: ARTIFACT_SHA,
        expectedManifestContentSha256: MANIFEST_SHA,
      },
    ]);
    expect(allowed.size).toBe(0);
  });

  test('wrong artifact SHA (tampered/mismatched) -> excluded', async () => {
    const reader = fakeReader(
      new Map([[`${CANDIDATE_A}|${RUN_A}`, acceptedDecision({ extractionArtifactSha256: 'f'.repeat(64) })]]),
    );
    const allowed = await resolveAllowedReviewedAcceptancesV1(reader, [
      {
        candidateId: CANDIDATE_A,
        runId: RUN_A,
        expectedSourceSha256: SOURCE_SHA,
        expectedArtifactSha256: ARTIFACT_SHA,
        expectedManifestContentSha256: MANIFEST_SHA,
      },
    ]);
    expect(allowed.size).toBe(0);
  });

  test('wrong source SHA -> excluded', async () => {
    const reader = fakeReader(
      new Map([[`${CANDIDATE_A}|${RUN_A}`, acceptedDecision({ sourceSha256: 'f'.repeat(64) })]]),
    );
    const allowed = await resolveAllowedReviewedAcceptancesV1(reader, [
      {
        candidateId: CANDIDATE_A,
        runId: RUN_A,
        expectedSourceSha256: SOURCE_SHA,
        expectedArtifactSha256: ARTIFACT_SHA,
        expectedManifestContentSha256: MANIFEST_SHA,
      },
    ]);
    expect(allowed.size).toBe(0);
  });

  test('wrong manifest SHA -> excluded', async () => {
    const reader = fakeReader(
      new Map([[`${CANDIDATE_A}|${RUN_A}`, acceptedDecision({ manifestContentSha256: 'f'.repeat(64) })]]),
    );
    const allowed = await resolveAllowedReviewedAcceptancesV1(reader, [
      {
        candidateId: CANDIDATE_A,
        runId: RUN_A,
        expectedSourceSha256: SOURCE_SHA,
        expectedArtifactSha256: ARTIFACT_SHA,
        expectedManifestContentSha256: MANIFEST_SHA,
      },
    ]);
    expect(allowed.size).toBe(0);
  });

  test('wrong candidate/run pairing (a decision exists for a different candidate) -> excluded, never cross-matched', async () => {
    const reader = fakeReader(
      new Map([[`other-candidate|${RUN_A}`, acceptedDecision()]]),
    );
    const allowed = await resolveAllowedReviewedAcceptancesV1(reader, [
      {
        candidateId: CANDIDATE_A,
        runId: RUN_A,
        expectedSourceSha256: SOURCE_SHA,
        expectedArtifactSha256: ARTIFACT_SHA,
        expectedManifestContentSha256: MANIFEST_SHA,
      },
    ]);
    expect(allowed.size).toBe(0);
  });

  test('wrong run for the right candidate -> excluded', async () => {
    const reader = fakeReader(new Map([[`${CANDIDATE_A}|other-run`, acceptedDecision()]]));
    const allowed = await resolveAllowedReviewedAcceptancesV1(reader, [
      {
        candidateId: CANDIDATE_A,
        runId: RUN_A,
        expectedSourceSha256: SOURCE_SHA,
        expectedArtifactSha256: ARTIFACT_SHA,
        expectedManifestContentSha256: MANIFEST_SHA,
      },
    ]);
    expect(allowed.size).toBe(0);
  });

  test('never returns a binding the caller did not ask about, even if the reader would match one', async () => {
    const reader = fakeReader(new Map([[`${CANDIDATE_A}|${RUN_A}`, acceptedDecision()]]));
    const allowed = await resolveAllowedReviewedAcceptancesV1(reader, []); // no bindings requested
    expect(allowed.size).toBe(0);
  });

  test('multiple bindings resolve independently -- one accepted, one not', async () => {
    const reader = fakeReader(
      new Map([
        [`${CANDIDATE_A}|${RUN_A}`, acceptedDecision()],
        ['candidate-b|run-b', acceptedDecision({ decision: 'reject' })],
      ]),
    );
    const allowed = await resolveAllowedReviewedAcceptancesV1(reader, [
      {
        candidateId: CANDIDATE_A,
        runId: RUN_A,
        expectedSourceSha256: SOURCE_SHA,
        expectedArtifactSha256: ARTIFACT_SHA,
        expectedManifestContentSha256: MANIFEST_SHA,
      },
      {
        candidateId: 'candidate-b',
        runId: 'run-b',
        expectedSourceSha256: SOURCE_SHA,
        expectedArtifactSha256: ARTIFACT_SHA,
        expectedManifestContentSha256: MANIFEST_SHA,
      },
    ]);
    expect(allowed.has(RUN_A)).toBe(true);
    expect(allowed.has('run-b')).toBe(false);
    expect(allowed.size).toBe(1);
  });
});

describe('createPrismaProjectionReviewAcceptanceReaderV1', () => {
  test('joins review decision to its run requiring the run to belong to the same candidate', async () => {
    const calls: unknown[][] = [];
    const prisma = {
      async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
        calls.push([sql, ...values]);
        return [
          {
            review_decision_id: 'rd-1',
            decision: 'accept',
            source_sha256: SOURCE_SHA,
            extraction_artifact_sha256: ARTIFACT_SHA,
            manifest_content_sha256: MANIFEST_SHA,
          },
        ] as T;
      },
    };
    const reader = createPrismaProjectionReviewAcceptanceReaderV1(prisma);
    const result = await reader.findAcceptedReviewDecision({ candidateId: CANDIDATE_A, runId: RUN_A });
    expect(result).toEqual({
      reviewDecisionId: 'rd-1',
      decision: 'accept',
      sourceSha256: SOURCE_SHA,
      extractionArtifactSha256: ARTIFACT_SHA,
      manifestContentSha256: MANIFEST_SHA,
    });
    expect(String(calls[0]?.[0])).toContain('run."candidate_id" = rd."candidate_id"');
  });

  test('no matching row -> null', async () => {
    const prisma = { async $queryRawUnsafe<T>(): Promise<T> { return [] as T; } };
    const reader = createPrismaProjectionReviewAcceptanceReaderV1(prisma);
    const result = await reader.findAcceptedReviewDecision({ candidateId: CANDIDATE_A, runId: RUN_A });
    expect(result).toBeNull();
  });
});

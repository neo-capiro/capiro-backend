import type {
  EntityResolutionGoldenCase,
  EntityResolutionGoldenCategory,
} from './entity-resolution-golden-corpus.js';

export interface EntityResolutionGoldenObservation {
  caseId: string;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  selectedCanonicalName?: string | null;
  candidateCanonicalNames?: readonly string[];
}

export interface EntityResolutionEvaluationFailure {
  caseId: string;
  kind:
    | 'missing_observation'
    | 'status_mismatch'
    | 'wrong_selection'
    | 'false_merge'
    | 'false_split'
    | 'privacy_leak';
  message: string;
}

export interface EntityResolutionEvaluationReport {
  totalCases: number;
  evaluatedCases: number;
  coverage: number;
  statusAccuracy: number;
  resolvedSelectionAccuracy: number;
  ambiguityAccuracy: number;
  falseMergeCount: number;
  falseSplitCount: number;
  privacyLeakCount: number;
  categoryAccuracy: Record<EntityResolutionGoldenCategory, number>;
  failures: EntityResolutionEvaluationFailure[];
  pass: boolean;
}

const RELEASE_THRESHOLDS = {
  coverage: 1,
  statusAccuracy: 0.95,
  resolvedSelectionAccuracy: 0.95,
  ambiguityAccuracy: 0.95,
  falseMergeCount: 0,
  privacyLeakCount: 0,
} as const;

export function evaluateEntityResolutionGoldenCorpus(
  cases: readonly EntityResolutionGoldenCase[],
  observations: readonly EntityResolutionGoldenObservation[],
): EntityResolutionEvaluationReport {
  const byId = new Map(observations.map((observation) => [observation.caseId, observation]));
  const failures: EntityResolutionEvaluationFailure[] = [];
  let evaluatedCases = 0;
  let correctStatus = 0;
  let expectedResolved = 0;
  let correctResolvedSelection = 0;
  let expectedAmbiguous = 0;
  let correctAmbiguous = 0;
  let falseMergeCount = 0;
  let falseSplitCount = 0;
  let privacyLeakCount = 0;
  const categoryTotals = new Map<EntityResolutionGoldenCategory, number>();
  const categoryCorrect = new Map<EntityResolutionGoldenCategory, number>();

  for (const testCase of cases) {
    categoryTotals.set(testCase.category, (categoryTotals.get(testCase.category) ?? 0) + 1);
    const observation = byId.get(testCase.id);
    if (!observation) {
      failures.push({
        caseId: testCase.id,
        kind: 'missing_observation',
        message: 'No resolver observation was supplied for this golden case.',
      });
      continue;
    }
    evaluatedCases += 1;

    const statusMatches = observation.status === testCase.expected.status;
    if (statusMatches) {
      correctStatus += 1;
      categoryCorrect.set(
        testCase.category,
        (categoryCorrect.get(testCase.category) ?? 0) + 1,
      );
    } else {
      failures.push({
        caseId: testCase.id,
        kind: 'status_mismatch',
        message: `Expected ${testCase.expected.status}, observed ${observation.status}.`,
      });
    }

    if (testCase.expected.status === 'resolved') {
      expectedResolved += 1;
      const expectedName = normalizeName(testCase.expected.selectedCanonicalName);
      const observedName = normalizeName(observation.selectedCanonicalName);
      if (observation.status !== 'resolved') {
        falseSplitCount += 1;
        failures.push({
          caseId: testCase.id,
          kind: 'false_split',
          message: 'A deterministically resolvable identity was not resolved.',
        });
      } else if (expectedName && expectedName === observedName) {
        correctResolvedSelection += 1;
      } else {
        failures.push({
          caseId: testCase.id,
          kind: 'wrong_selection',
          message: `Expected selection ${testCase.expected.selectedCanonicalName ?? 'null'}, observed ${observation.selectedCanonicalName ?? 'null'}.`,
        });
      }
    } else if (observation.status === 'resolved') {
      falseMergeCount += 1;
      failures.push({
        caseId: testCase.id,
        kind: 'false_merge',
        message: `Resolver selected ${observation.selectedCanonicalName ?? 'an entity'} where it should fail closed.`,
      });
    }

    if (testCase.expected.status === 'ambiguous') {
      expectedAmbiguous += 1;
      if (observation.status === 'ambiguous') correctAmbiguous += 1;
    }

    const forbidden = new Set(
      (testCase.expected.forbiddenCanonicalNames ?? []).map(normalizeName).filter(Boolean),
    );
    if (forbidden.size > 0) {
      const exposed = [
        observation.selectedCanonicalName ?? null,
        ...(observation.candidateCanonicalNames ?? []),
      ]
        .map(normalizeName)
        .filter((name): name is string => Boolean(name));
      const leaked = exposed.find((name) => forbidden.has(name));
      if (leaked) {
        privacyLeakCount += 1;
        failures.push({
          caseId: testCase.id,
          kind: 'privacy_leak',
          message: `Forbidden tenant-private identity was exposed: ${leaked}.`,
        });
      }
    }
  }

  const categoryAccuracy = Object.fromEntries(
    [...categoryTotals.entries()].map(([category, total]) => [
      category,
      total === 0 ? 1 : (categoryCorrect.get(category) ?? 0) / total,
    ]),
  ) as Record<EntityResolutionGoldenCategory, number>;

  const coverage = ratio(evaluatedCases, cases.length);
  const statusAccuracy = ratio(correctStatus, evaluatedCases);
  const resolvedSelectionAccuracy = ratio(correctResolvedSelection, expectedResolved);
  const ambiguityAccuracy = ratio(correctAmbiguous, expectedAmbiguous);
  const pass =
    coverage >= RELEASE_THRESHOLDS.coverage &&
    statusAccuracy >= RELEASE_THRESHOLDS.statusAccuracy &&
    resolvedSelectionAccuracy >= RELEASE_THRESHOLDS.resolvedSelectionAccuracy &&
    ambiguityAccuracy >= RELEASE_THRESHOLDS.ambiguityAccuracy &&
    falseMergeCount <= RELEASE_THRESHOLDS.falseMergeCount &&
    privacyLeakCount <= RELEASE_THRESHOLDS.privacyLeakCount;

  return {
    totalCases: cases.length,
    evaluatedCases,
    coverage,
    statusAccuracy,
    resolvedSelectionAccuracy,
    ambiguityAccuracy,
    falseMergeCount,
    falseSplitCount,
    privacyLeakCount,
    categoryAccuracy,
    failures,
    pass,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function normalizeName(value: string | null | undefined): string | null {
  const normalized = value?.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  return normalized || null;
}

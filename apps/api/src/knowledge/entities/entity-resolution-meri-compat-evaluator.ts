import type { EntityResolutionStage } from './entity-resolution-stage-policy.js';
import type { MeriCompatibleEntityResolutionCase } from './entity-resolution-meri-compat-golden.js';

export interface MeriCompatibleEntityResolutionObservation {
  caseId: string;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  selectedCanonicalName?: string | null;
  candidateCanonicalNames?: readonly string[];
  attemptedStages?: readonly EntityResolutionStage[];
  duplicateEntityCreated?: boolean;
  privateIdentityLeaked?: boolean;
}

export interface MeriCompatibleEntityResolutionReport {
  coverage: number;
  externalCompanyResolutionSuccess: number;
  candidateRecall: number;
  stageCoverage: number;
  duplicateEntityCount: number;
  privacyLeakCount: number;
  failures: Array<{ caseId: string; reason: string }>;
  pass: boolean;
}

export function evaluateMeriCompatibleEntityResolution(
  cases: readonly MeriCompatibleEntityResolutionCase[],
  observations: readonly MeriCompatibleEntityResolutionObservation[],
): MeriCompatibleEntityResolutionReport {
  const byId = new Map(observations.map((observation) => [observation.caseId, observation]));
  const failures: Array<{ caseId: string; reason: string }> = [];
  let evaluated = 0;
  let correctCases = 0;
  let requiredCandidates = 0;
  let foundCandidates = 0;
  let requiredStages = 0;
  let foundStages = 0;
  let duplicateEntityCount = 0;
  let privacyLeakCount = 0;

  for (const testCase of cases) {
    const observation = byId.get(testCase.id);
    if (!observation) {
      failures.push({ caseId: testCase.id, reason: 'missing_observation' });
      continue;
    }
    evaluated += 1;
    let correct = observation.status === testCase.expectedStatus;
    if (!correct) {
      failures.push({ caseId: testCase.id, reason: 'status_mismatch' });
    }

    if (testCase.expectedStatus === 'resolved') {
      const expected = normalize(testCase.expectedSelectedCanonicalName);
      const selected = normalize(observation.selectedCanonicalName);
      if (!expected || expected !== selected) {
        correct = false;
        failures.push({ caseId: testCase.id, reason: 'wrong_selection' });
      }
    } else if (observation.status === 'resolved') {
      correct = false;
      failures.push({ caseId: testCase.id, reason: 'candidate_only_stage_auto_selected' });
    }

    const candidates = new Set(
      (observation.candidateCanonicalNames ?? [])
        .map(normalize)
        .filter((value): value is string => Boolean(value)),
    );
    for (const required of testCase.requiredCandidateCanonicalNames ?? []) {
      requiredCandidates += 1;
      const normalized = normalize(required);
      if (normalized && candidates.has(normalized)) {
        foundCandidates += 1;
      } else {
        correct = false;
        failures.push({ caseId: testCase.id, reason: `missing_candidate:${required}` });
      }
    }

    const stages = new Set(observation.attemptedStages ?? []);
    for (const required of testCase.requiredAttemptedStages) {
      requiredStages += 1;
      if (stages.has(required)) {
        foundStages += 1;
      } else {
        correct = false;
        failures.push({ caseId: testCase.id, reason: `missing_stage:${required}` });
      }
    }

    if (observation.duplicateEntityCreated === true) {
      correct = false;
      duplicateEntityCount += 1;
      failures.push({ caseId: testCase.id, reason: 'duplicate_entity_created' });
    }
    if (observation.privateIdentityLeaked === true) {
      correct = false;
      privacyLeakCount += 1;
      failures.push({ caseId: testCase.id, reason: 'private_identity_leaked' });
    }

    if (correct) correctCases += 1;
  }

  const coverage = ratio(evaluated, cases.length);
  const externalCompanyResolutionSuccess = ratio(correctCases, cases.length);
  const candidateRecall = ratio(foundCandidates, requiredCandidates);
  const stageCoverage = ratio(foundStages, requiredStages);
  const pass =
    coverage === 1 &&
    externalCompanyResolutionSuccess >= 0.9 &&
    candidateRecall === 1 &&
    stageCoverage === 1 &&
    duplicateEntityCount === 0 &&
    privacyLeakCount === 0;

  return {
    coverage,
    externalCompanyResolutionSuccess,
    candidateRecall,
    stageCoverage,
    duplicateEntityCount,
    privacyLeakCount,
    failures,
    pass,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function normalize(value: string | null | undefined): string | null {
  const normalized = value?.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  return normalized || null;
}

/** Cycle-level coverage, duplicate, omission and R-1/R-2 comparison helpers. */
import type {
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
  MoneyValueV1,
} from '../../contracts/extraction-artifact-v1.js';
import type { BudgetCycleManifestDocumentV1 } from '../../contracts/budget-cycle-manifest-v1.js';
import { sha256CanonicalJson } from '../../contracts/canonical-json.js';
import type { CategoryCoverageInput, RdteRequiredCategoryV1 } from '../rdte-cycle-summary-v1.js';
import type { RdteCycleComparisonV1 } from '../rdte-cycle-bundle-v1.js';
import {
  independentPrintedValueToleranceMillions,
  withinExactTolerance,
} from '../rdte-rounding-policy-v1.js';

type MoneyUnitV1 = MoneyValueV1['originalUnit'];

const ASSERTION_KINDS: Record<
  RdteRequiredCategoryV1,
  readonly DefenseBudgetAssertionV1['assertionKind'][]
> = {
  identity: ['program_element_identity'],
  funding: ['funding'],
  narrative: ['narrative'],
  projects: ['project'],
  project_funding: ['project_funding'],
  performers: ['performer'],
  milestones: ['milestone'],
  relationships: ['relationship'],
};

const FACT_CATEGORIES: Record<RdteRequiredCategoryV1, string> = {
  identity: 'identity',
  funding: 'money',
  narrative: 'text',
  projects: 'project',
  project_funding: 'money',
  performers: 'performer',
  milestones: 'milestone',
  relationships: 'relationship',
};

function artifactByDocumentKey(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
): Map<string, DefenseBudgetExtractionArtifactV1> {
  const output = new Map<string, DefenseBudgetExtractionArtifactV1>();
  for (const artifact of artifacts) {
    const key = artifact.source.manifestDocumentKey;
    if (output.has(key)) throw new Error(`multiple artifacts supplied for ${key}`);
    output.set(key, artifact);
  }
  return output;
}

function factBelongsToCategory(
  category: RdteRequiredCategoryV1,
  sourcePath: string,
  factCategory: string,
): boolean {
  if (factCategory !== FACT_CATEGORIES[category]) return false;
  const projectScoped = /(?:^|\/)project:/.test(sourcePath);
  if (category === 'funding') return !projectScoped;
  if (category === 'project_funding') return projectScoped;
  return true;
}

export function buildManifestCoverageInputs(input: {
  documents: readonly BudgetCycleManifestDocumentV1[];
  artifacts: readonly DefenseBudgetExtractionArtifactV1[];
}): CategoryCoverageInput[] {
  const byKey = artifactByDocumentKey(input.artifacts);
  const expectedByCategory = new Map<RdteRequiredCategoryV1, Set<string>>();
  const coveredByCategory = new Map<RdteRequiredCategoryV1, Set<string>>();
  const applicable = new Set<RdteRequiredCategoryV1>();

  for (const document of input.documents) {
    const artifact = byKey.get(document.documentKey);
    for (const rawCategory of document.requiredDataCategories) {
      const category = rawCategory as RdteRequiredCategoryV1;
      if (!(category in ASSERTION_KINDS)) continue;
      applicable.add(category);
      const expected = expectedByCategory.get(category) ?? new Set<string>();
      const covered = coveredByCategory.get(category) ?? new Set<string>();
      const allowedKinds = new Set(ASSERTION_KINDS[category]);
      const facts =
        artifact?.sourceFacts.filter(
          (fact) =>
            fact.requiredForCompleteness &&
            factBelongsToCategory(category, fact.sourcePath, fact.category),
        ) ?? [];
      if (facts.length === 0) {
        expected.add(`${document.documentKey}:${category}`);
      } else {
        for (const fact of facts) expected.add(`${document.documentKey}:${fact.factId}`);
      }
      if (artifact) {
        // A required source fact is covered when any assertion or omission
        // references it. Non-budget-year money columns are intentionally
        // ledgered as document_fact (not funding); filtering only by
        // category assertion kinds under-counts real coverage and blocks
        // certification of complete golden cycles.
        for (const assertion of artifact.assertions) {
          const kindAllowed =
            allowedKinds.has(assertion.assertionKind) ||
            assertion.assertionKind === 'document_fact';
          if (!kindAllowed) continue;
          for (const factId of assertion.sourceFactIds) {
            if (!facts.some((fact) => fact.factId === factId)) continue;
            covered.add(`${document.documentKey}:${factId}`);
          }
        }
        for (const omission of artifact.omissions ?? []) {
          const factId = omission.sourceFactId;
          if (!factId) continue;
          if (!facts.some((fact) => fact.factId === factId)) continue;
          covered.add(`${document.documentKey}:${factId}`);
        }
      }
      expectedByCategory.set(category, expected);
      coveredByCategory.set(category, covered);
    }
  }

  return [...applicable].sort().map((category) => ({
    category,
    expectedKeys: [...(expectedByCategory.get(category) ?? [])].sort(),
    coveredKeys: [...(coveredByCategory.get(category) ?? [])].sort(),
    applicable: true,
  }));
}

interface FundingEntry {
  artifact: DefenseBudgetExtractionArtifactV1;
  assertion: Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }>;
  peCode: string;
  fiscalYear: number;
  unit: MoneyUnitV1;
  valueMillions: string;
}

function requestEntries(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
  exhibit: 'R-1' | 'R-2',
): FundingEntry[] {
  const output: FundingEntry[] = [];
  for (const artifact of artifacts.filter((value) => value.source.exhibit === exhibit)) {
    for (const assertion of artifact.assertions) {
      if (assertion.assertionKind !== 'funding' || assertion.field !== 'request') continue;
      if (assertion.identity.lineKind !== 'RDTE_PE') continue;
      const role = assertion.metadata?.columnRole;
      if (role !== undefined && role !== 'budget_year_request') continue;
      output.push({
        artifact,
        assertion,
        peCode: assertion.identity.peCode,
        fiscalYear: assertion.fiscalYear,
        unit: assertion.money.originalUnit,
        valueMillions: assertion.money.valueMillions,
      });
    }
  }
  return output.sort((left, right) => {
    const key = `${left.peCode}|${left.fiscalYear}`.localeCompare(
      `${right.peCode}|${right.fiscalYear}`,
    );
    return key || left.assertion.assertionId.localeCompare(right.assertion.assertionId);
  });
}

export function buildR1R2CycleComparisons(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
): RdteCycleComparisonV1[] {
  const leftEntries = requestEntries(artifacts, 'R-1');
  const rightEntries = requestEntries(artifacts, 'R-2');
  const keys = new Set([
    ...leftEntries.map((value) => `${value.peCode}|${value.fiscalYear}`),
    ...rightEntries.map((value) => `${value.peCode}|${value.fiscalYear}`),
  ]);
  const output: RdteCycleComparisonV1[] = [];

  for (const key of [...keys].sort()) {
    const left = leftEntries.filter((value) => `${value.peCode}|${value.fiscalYear}` === key);
    const right = rightEntries.filter((value) => `${value.peCode}|${value.fiscalYear}` === key);
    const [peCode = '', fiscalYearText = '0'] = key.split('|');
    const fiscalYear = Number(fiscalYearText);
    const allEvidence = [...left, ...right].flatMap((value) => value.assertion.evidenceIds);
    let result: RdteCycleComparisonV1['result'];
    let message: string;
    let toleranceMillions: string | undefined;

    if (left.length !== 1 || right.length !== 1) {
      result = 'review';
      message = `R-1/R-2 comparison for ${peCode} FY${fiscalYear} requires exactly one value per exhibit; found ${left.length}/${right.length}`;
    } else if (left[0]!.unit !== right[0]!.unit) {
      result = 'review';
      message = `R-1/R-2 printed-unit mismatch for ${peCode} FY${fiscalYear}: ${left[0]!.unit}/${right[0]!.unit}`;
    } else {
      toleranceMillions = independentPrintedValueToleranceMillions(left[0]!.unit);
      result = withinExactTolerance(
        left[0]!.valueMillions,
        right[0]!.valueMillions,
        toleranceMillions,
      )
        ? 'pass'
        : 'fail';
      message =
        result === 'pass'
          ? `R-1/R-2 request reconciled for ${peCode} FY${fiscalYear}`
          : `R-1 ${left[0]!.valueMillions} and R-2 ${right[0]!.valueMillions} differ beyond ${toleranceMillions} million for ${peCode} FY${fiscalYear}`;
    }

    output.push({
      comparisonId: `rdte_cmp_${sha256CanonicalJson({
        comparisonKind: 'r1_r2_budget_year_request',
        peCode,
        fiscalYear,
        leftAssertionIds: left.map((value) => value.assertion.assertionId).sort(),
        rightAssertionIds: right.map((value) => value.assertion.assertionId).sort(),
      })}`,
      comparisonKind: 'r1_r2_budget_year_request',
      peCode,
      fiscalYear,
      columnRole: 'budget_year_request',
      leftArtifactId: left[0]?.artifact.artifactId ?? 'missing_r1_artifact',
      rightArtifactId: right[0]?.artifact.artifactId ?? 'missing_r2_artifact',
      leftAssertionIds: left.map((value) => value.assertion.assertionId).sort(),
      rightAssertionIds: right.map((value) => value.assertion.assertionId).sort(),
      result,
      ...(toleranceMillions ? { toleranceMillions } : {}),
      evidenceIds: [...new Set(allEvidence)].sort(),
      message,
    });
  }
  return output;
}

export function collectBlockingOmissionPeCodes(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
): string[] {
  const factById = new Map(
    artifacts.flatMap((artifact) =>
      artifact.sourceFacts.map((fact) => [fact.factId, fact] as const),
    ),
  );
  const output = new Set<string>();
  for (const artifact of artifacts) {
    for (const omission of artifact.omissions.filter((value) => value.severity === 'blocking')) {
      const fact = factById.get(omission.sourceFactId);
      const match = /(?:pe:|PE\s+)([0-9]{7}[A-Z][A-Z0-9]*)/i.exec(
        `${fact?.sourcePath ?? ''} ${JSON.stringify(fact?.rawValue ?? '')}`,
      );
      if (match?.[1]) output.add(match[1]);
    }
  }
  return [...output].sort();
}

export function collectDuplicateNaturalKeys(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
): string[] {
  const output = new Set<string>();
  for (const artifact of artifacts) {
    const seen = new Map<string, string>();
    for (const assertion of artifact.assertions) {
      const naturalKey = naturalKeyOf(assertion);
      if (!naturalKey) continue;
      const value = JSON.stringify(assertion);
      const existing = seen.get(naturalKey);
      if (existing !== undefined && existing !== value) output.add(naturalKey);
      else seen.set(naturalKey, value);
    }
  }
  return [...output].sort();
}

function naturalKeyOf(assertion: DefenseBudgetAssertionV1): string | null {
  switch (assertion.assertionKind) {
    case 'program_element_identity':
      return `pe:${assertion.identity.peCode}`;
    case 'funding':
      return `funding:${JSON.stringify(assertion.identity)}:${assertion.fiscalYear}:${assertion.field}`;
    case 'project':
      return `project:${assertion.parentPeCode}:${assertion.projectCode}`;
    case 'project_funding':
      return `project_funding:${assertion.parentPeCode}:${assertion.projectCode}:${assertion.fiscalYear}:${assertion.field}`;
    case 'performer':
      return `performer:${assertion.parentPeCode}:${assertion.projectCode ?? ''}:${assertion.performerNormalized ?? assertion.performerName}:${assertion.location ?? ''}:${assertion.contractMethod ?? ''}:${assertion.costCategory ?? ''}:${assertion.fiscalYear ?? ''}`;
    case 'milestone':
      return `milestone:${assertion.parentPeCode}:${assertion.milestoneType}:${assertion.plannedDate ?? ''}:${assertion.actualDate ?? ''}`;
    default:
      return null;
  }
}

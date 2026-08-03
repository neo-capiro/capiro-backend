/**
 * Workstream I2 — Reference artifact index.
 *
 * Build an in-memory exact index over resolved V1 reference artifacts:
 *   assertion kind
 *   identity natural key
 *   fiscal year
 *   field
 *   project code
 *
 * The provider returns zero, one, or multiple matches.
 * Multiple matches are never silently reduced to one.
 */
import type {
  DefenseBudgetExtractionArtifactV1,
  DefenseBudgetAssertionV1,
} from '../../../contracts/extraction-artifact-v1.js';
import type {
  ReferenceArtifactEntryV1,
  ReferenceIndexKeyV1,
  ReferenceMatchResultV1,
} from './comparison-types.js';

/* ------------------------------------------------------------------ */
/* Identity natural-key helpers                                         */
/* ------------------------------------------------------------------ */

/** Compute a deterministic identity natural key for an assertion. */
export function identityNaturalKey(assertion: DefenseBudgetAssertionV1): string {
  switch (assertion.assertionKind) {
    case 'program_element_identity':
      return assertion.identity.peCode;
    case 'funding':
    case 'quantity':
    case 'unit_cost':
    case 'om_line':
    case 'narrative':
      return JSON.stringify(assertion.identity);
    case 'project':
    case 'project_funding':
      return `${assertion.parentPeCode}|${assertion.projectCode}`;
    case 'performer':
      return `${assertion.parentPeCode}|${assertion.performerName}`;
    case 'procurement_line':
      return JSON.stringify(assertion.parentIdentity);
    case 'milcon_project':
      return JSON.stringify(assertion.identity);
    case 'milestone':
      return `${assertion.parentPeCode}|${assertion.milestoneType}`;
    case 'relationship':
      return `${JSON.stringify(assertion.from)}|${JSON.stringify(assertion.to)}`;
    case 'document_fact':
      return assertion.fieldName;
    default: {
      // Exhaustive guard — if a new assertion kind is added, this will fail
      const _exhaustive: never = assertion;
      void _exhaustive;
      return '';
    }
  }
}

/** Extract the field value from a funding/project_funding assertion. */
function assertionField(assertion: DefenseBudgetAssertionV1): string | undefined {
  if (assertion.assertionKind === 'funding' || assertion.assertionKind === 'project_funding') {
    return assertion.field;
  }
  return undefined;
}

/** Extract the project code from a project/project_funding assertion. */
function assertionProjectCode(assertion: DefenseBudgetAssertionV1): string | undefined {
  if (assertion.assertionKind === 'project' || assertion.assertionKind === 'project_funding') {
    return assertion.projectCode;
  }
  return undefined;
}

/** Extract the fiscal year from an assertion that has one. */
function assertionFiscalYear(assertion: DefenseBudgetAssertionV1): number | undefined {
  switch (assertion.assertionKind) {
    case 'funding':
    case 'project_funding':
    case 'procurement_line':
    case 'quantity':
    case 'unit_cost':
      return assertion.fiscalYear;
    case 'performer':
      return assertion.fiscalYear;
    default:
      return undefined;
  }
}

/** Extract the value in millions for funding/project_funding assertions. */
function assertionValueMillions(assertion: DefenseBudgetAssertionV1): string | undefined {
  if (assertion.assertionKind === 'funding' || assertion.assertionKind === 'project_funding') {
    return assertion.money.valueMillions;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Reference artifact index                                             */
/* ------------------------------------------------------------------ */

export class ReferenceArtifactIndexV1 {
  private readonly entries: ReferenceArtifactEntryV1[] = [];

  /**
   * Build the index from resolved V1 reference artifacts.
   * Each reference artifact must have already passed its own trusted proof
   * resolution before being added to this index.
   */
  static fromArtifacts(
    referenceArtifacts: readonly DefenseBudgetExtractionArtifactV1[],
  ): ReferenceArtifactIndexV1 {
    const index = new ReferenceArtifactIndexV1();
    for (const artifact of referenceArtifacts) {
      for (const assertion of artifact.assertions) {
        const fy = assertionFiscalYear(assertion);
        const entry: ReferenceArtifactEntryV1 = {
          artifactId: artifact.artifactId,
          contentSha256: artifact.contentSha256,
          sourceDocumentId: artifact.source.sourceDocumentId ?? artifact.source.sourcePdfSha256,
          sourcePdfSha256: artifact.source.sourcePdfSha256,
          assertionId: assertion.assertionId,
          assertionKind: assertion.assertionKind,
          identityKey: identityNaturalKey(assertion),
          fiscalYear: fy ?? 0,
          field: assertionField(assertion),
          projectCode: assertionProjectCode(assertion),
          evidenceIds: assertion.evidenceIds,
          valueMillions: assertionValueMillions(assertion),
        };
        index.entries.push(entry);
      }
    }
    return index;
  }

  /** Total number of indexed assertions. */
  size(): number {
    return this.entries.length;
  }

  /** Look up matches by a reference index key. */
  lookup(key: ReferenceIndexKeyV1): ReferenceMatchResultV1<ReferenceArtifactEntryV1> {
    const matches = this.entries.filter((e) => {
      if (e.assertionKind !== key.assertionKind) return false;
      if (e.identityKey !== key.identityKey) return false;
      if (e.fiscalYear !== key.fiscalYear) return false;
      if (key.field !== undefined && e.field !== key.field) return false;
      if (key.projectCode !== undefined && e.projectCode !== key.projectCode) return false;
      return true;
    });
    if (matches.length === 0) return { kind: 'zero' };
    if (matches.length === 1) return { kind: 'one', value: matches[0]! };
    return { kind: 'multiple', values: matches };
  }

  /** Look up funding assertions by identity key, fiscal year, and field. */
  lookupFunding(
    identityKey: string,
    fiscalYear: number,
    field: string,
  ): ReferenceMatchResultV1<ReferenceArtifactEntryV1> {
    return this.lookup({
      assertionKind: 'funding',
      identityKey,
      fiscalYear,
      field,
    });
  }

  /** Look up project_funding assertions by identity key, fiscal year, and field. */
  lookupProjectFunding(
    parentPeCode: string,
    projectCode: string,
    fiscalYear: number,
    field: string,
  ): ReferenceMatchResultV1<ReferenceArtifactEntryV1> {
    const identityKey = `${parentPeCode}|${projectCode}`;
    return this.lookup({
      assertionKind: 'project_funding',
      identityKey,
      fiscalYear,
      field,
    });
  }

  /** Return all entries (for testing/debugging). */
  allEntries(): readonly ReferenceArtifactEntryV1[] {
    return [...this.entries];
  }
}

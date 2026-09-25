/** Read-only physical-source reconciliation. All identities are exact; unknown is not zero. */
export const COVERAGE_RECONCILIATION_VERSION = 'defense_coverage_reconciliation_v1' as const;

export type CoverageException =
  | 'catalog_completeness_unknown' | 'physical_source_missing' | 'source_unavailable'
  | 'source_superseded' | 'extraction_missing' | 'verification_not_passed'
  | 'review_missing' | 'publication_missing' | 'publication_lineage_unbound'
  | 'account_attribution_unknown';

export interface ReconciliationSlot {
  slotId: string;
  fiscalYear: number;
  sourceFamily: string;
  component: string | null;
  optional: boolean;
  catalogComplete: boolean;
}

export interface ReconciliationUnit {
  unitId: string;
  slotId: string;
  kind: 'document' | 'volume' | 'section' | 'exhibit';
  required: boolean;
  account: string | null;
  budgetActivity: string | null;
  volume: string | null;
  sourceDocumentId: string | null;
  sourceSha256: string | null;
  superseded: boolean;
  unavailable: boolean;
}

export interface ReconciliationCandidate {
  candidateId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  runId: string | null;
  verificationDecision: 'PASS' | 'REVIEW' | 'REJECT' | null;
  reviewAccepted: boolean;
}

export interface ReconciliationPublication {
  sourceDocumentId: string;
  sourceSha256: string;
  candidateId: string;
  runId: string;
}

export interface CoverageReconciliationInput {
  fiscalYear: number;
  environment: string;
  activeSnapshotId: string | null;
  slots: readonly ReconciliationSlot[];
  units: readonly ReconciliationUnit[];
  candidates: readonly ReconciliationCandidate[];
  publications: readonly ReconciliationPublication[];
}

export function buildCoverageReconciliation(input: CoverageReconciliationInput) {
  const candidateBySource = new Map<string, ReconciliationCandidate[]>();
  for (const candidate of input.candidates) {
    const key = `${candidate.sourceDocumentId}:${candidate.sourceSha256}`;
    candidateBySource.set(key, [...(candidateBySource.get(key) ?? []), candidate]);
  }
  const publicationKeys = new Set(input.publications.map((row) =>
    `${row.sourceDocumentId}:${row.sourceSha256}:${row.candidateId}:${row.runId}`));
  const unitsBySlot = new Map<string, ReconciliationUnit[]>();
  for (const unit of input.units) {
    unitsBySlot.set(unit.slotId, [...(unitsBySlot.get(unit.slotId) ?? []), unit]);
  }
  const rows = input.slots.map((slot) => {
    const units = unitsBySlot.get(slot.slotId) ?? [];
    const requiredUnits = units.filter((unit) => unit.required && !unit.superseded);
    const details = units.map((unit) => {
      const exceptions: CoverageException[] = [];
      if (unit.superseded) exceptions.push('source_superseded');
      if (!unit.account) exceptions.push('account_attribution_unknown');
      if (unit.unavailable) exceptions.push('source_unavailable');
      if ((!unit.sourceDocumentId || !unit.sourceSha256) && !unit.unavailable) {
        exceptions.push('physical_source_missing');
      }
      const candidates = unit.sourceDocumentId && unit.sourceSha256
        ? candidateBySource.get(`${unit.sourceDocumentId}:${unit.sourceSha256}`) ?? [] : [];
      const parsed = candidates.length > 0;
      const verified = candidates.some((candidate) => candidate.verificationDecision === 'PASS');
      const reviewed = candidates.some((candidate) => candidate.reviewAccepted);
      const eligibleCurrentSource = !unit.unavailable && !unit.superseded;
      const published = eligibleCurrentSource && input.activeSnapshotId !== null && candidates.some((candidate) =>
        candidate.runId !== null && candidate.verificationDecision === 'PASS' && candidate.reviewAccepted
          && publicationKeys.has(
            `${unit.sourceDocumentId}:${unit.sourceSha256}:${candidate.candidateId}:${candidate.runId}`));
      if (!parsed && unit.sourceDocumentId) exceptions.push('extraction_missing');
      if (parsed && !verified) exceptions.push('verification_not_passed');
      if (parsed && !reviewed) exceptions.push('review_missing');
      if (!published && eligibleCurrentSource) {
        const exactSourcePublication = input.publications.some((row) =>
          row.sourceDocumentId === unit.sourceDocumentId && row.sourceSha256 === unit.sourceSha256);
        exceptions.push(exactSourcePublication ? 'publication_lineage_unbound' : 'publication_missing');
      }
      return { unitId: unit.unitId, kind: unit.kind, required: unit.required,
        superseded: unit.superseded,
        account: unit.account,
        budgetActivity: unit.budgetActivity, volume: unit.volume,
        sourceDocumentId: unit.sourceDocumentId, sourceSha256: unit.sourceSha256,
        parsed, verified, reviewed, published, exceptions };
    });
    const exceptions: CoverageException[] = [];
    if (!slot.catalogComplete) exceptions.push('catalog_completeness_unknown');
    if (requiredUnits.length === 0 && !slot.optional) exceptions.push('physical_source_missing');
    const sum = (key: 'parsed' | 'verified' | 'reviewed' | 'published') =>
      details.filter((unit) => unit.required && !unit.superseded && unit[key]).length;
    return {
      slotId: slot.slotId, fiscalYear: slot.fiscalYear, sourceFamily: slot.sourceFamily,
      component: slot.component, optional: slot.optional,
      discovery: requiredUnits.some((unit) => unit.sourceDocumentId !== null) ? 'observed' as const
        : slot.catalogComplete ? 'not_observed' as const : 'unknown' as const,
      denominator: slot.catalogComplete ? requiredUnits.length : null,
      knownRequiredUnits: requiredUnits.length,
      knownOptionalUnits: units.filter((unit) => !unit.required && !unit.superseded).length,
      parsed: sum('parsed'), verified: sum('verified'), reviewed: sum('reviewed'), published: sum('published'),
      exceptions, units: details,
    };
  });
  return { schemaVersion: COVERAGE_RECONCILIATION_VERSION, fiscalYear: input.fiscalYear,
    environment: input.environment, activeSnapshotId: input.activeSnapshotId,
    logicalSlotCount: rows.length, rows };
}

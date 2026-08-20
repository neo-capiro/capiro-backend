/**
 * Expected-document matrix — completeness accounting for PE Watch ingestion.
 *
 * "Detection is not ingestion, and ingestion is not completeness." Every document we
 * EXPECT for a given FY/authority/component/family carries an explicit status so a
 * missing document is a recorded fact, never a silent omission.
 *
 * Statuses (defense-budget-document-ingestion.md / ingestion-audit.md):
 *   FOUND                – archived + parsed
 *   NOT_YET_PUBLISHED    – expected but the source has not been released for this stage
 *   NOT_APPLICABLE       – does not exist for this component/family
 *   MISSING              – should exist and is released, but we do not have it (ACTION)
 *   BLOCKED              – exists but retrieval failed (auth/WAF/network)
 *   SUPERSEDED           – replaced by a newer version
 *   CLASSIFIED_NOT_PUBLIC– exists only in a classified annex
 */

export type DocStatus =
  | 'FOUND'
  | 'NOT_YET_PUBLISHED'
  | 'NOT_APPLICABLE'
  | 'MISSING'
  | 'BLOCKED'
  | 'SUPERSEDED'
  | 'CLASSIFIED_NOT_PUBLIC';

export interface ExpectedDocument {
  fiscalYear: number;
  /** dod-comptroller | hasc | sasc | hac_d | sac_d | ndaa_conference | public_law */
  authority: string;
  component: string | null;
  /** rdte | procurement | om | milcon | committee | milpers */
  family: string;
  /** Human label, e.g. "FY2027 Army RDT&E R-2 Vol 1". */
  label: string;
  status: DocStatus;
  /** When FOUND: the SourceDocument.sourceKey that satisfies it. */
  satisfiedBy?: string;
  note?: string;
}

export interface MatrixReport {
  total: number;
  byStatus: Record<DocStatus, number>;
  /** The actionable gap: released-but-absent documents. */
  actionable: ExpectedDocument[];
  entries: ExpectedDocument[];
}

const ALL_STATUSES: DocStatus[] = [
  'FOUND',
  'NOT_YET_PUBLISHED',
  'NOT_APPLICABLE',
  'MISSING',
  'BLOCKED',
  'SUPERSEDED',
  'CLASSIFIED_NOT_PUBLIC',
];

/**
 * Reconcile an expected list against the set of ingested sourceKeys. Anything expected
 * whose predicate matches an ingested key is marked FOUND; the caller supplies the
 * baseline expected set with default statuses for docs we know aren't yet published etc.
 */
export function buildMatrix(
  expected: Array<Omit<ExpectedDocument, 'status' | 'satisfiedBy'> & { defaultStatus?: DocStatus; matchKey: string }>,
  ingestedSourceKeys: Set<string>,
): MatrixReport {
  const entries: ExpectedDocument[] = expected.map((e) => {
    const found = ingestedSourceKeys.has(e.matchKey);
    const status: DocStatus = found ? 'FOUND' : (e.defaultStatus ?? 'MISSING');
    return {
      fiscalYear: e.fiscalYear,
      authority: e.authority,
      component: e.component,
      family: e.family,
      label: e.label,
      status,
      satisfiedBy: found ? e.matchKey : undefined,
      note: e.note,
    };
  });

  const byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<DocStatus, number>;
  for (const e of entries) byStatus[e.status] += 1;

  // Actionable = released but we don't have it. NOT_YET_PUBLISHED / NOT_APPLICABLE /
  // CLASSIFIED_NOT_PUBLIC are NOT actionable gaps.
  const actionable = entries.filter((e) => e.status === 'MISSING' || e.status === 'BLOCKED');

  return { total: entries.length, byStatus, actionable, entries };
}

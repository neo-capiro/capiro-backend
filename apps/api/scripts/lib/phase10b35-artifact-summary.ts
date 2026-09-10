/**
 * Phase 10B-35 -- substantive summary of an extraction artifact.
 *
 * Deliberately excludes every run-specific identifier (artifactId,
 * contentSha256, parser run ids, evidence ids, assertion ids) so that two runs
 * of the same source can be compared on WHAT was asserted, not on the
 * per-run hash lineage (jobId -> parserRunId -> outputArtifactSha256 ->
 * contentSha256 -> assertion ids, which differ by design between runs).
 */
import type { DefenseBudgetExtractionArtifactV1 } from '../../src/defense-budget/contracts/extraction-artifact-v1.js';

type AnyAssertion = Record<string, unknown> & { assertionKind: string; evidenceIds?: string[] };

export interface Phase10b35ProjectFundingRow {
  physicalPage: number | null;
  parentPeCode: string | null;
  projectCode: string | null;
  fiscalYear: number | null;
  field: string | null;
  valueMillions: string | null;
  rowIndex: number | null;
  columnIndex: number | null;
}

export interface Phase10b35DocumentFactRow {
  page: number | null;
  fieldName: string | null;
  rowKind: string | null;
  peCode: string | null;
  projectCode: string | null;
  fiscalYear: number | null;
  columnRole: string | null;
  valueMillions: string | null;
}

export interface Phase10b35OmissionRow {
  page: number | null;
  reason: string | null;
  subReason: string | null;
  rawValue: string | null;
  sourcePath: string | null;
}

export interface Phase10b35ArtifactSummary {
  totals: {
    assertions: number;
    byKind: Record<string, number>;
    omissions: number;
    warnings: number;
    projectFunding: number;
    projectFundingByFiscalYear: Record<string, number>;
  };
  identities: Array<{ peCode: string | null; title: string | null; component: string | null; page: number | null }>;
  peTotals: Phase10b35DocumentFactRow[];
  projectFunding: Phase10b35ProjectFundingRow[];
  projectFundingIdentitiesByPage: Record<string, string[]>;
  r2aDocumentFactsByPageIdentity: Record<string, number>;
  omissions: Phase10b35OmissionRow[];
  omissionsByPageSubReason: Record<string, number>;
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : v == null ? null : String(v);
}

export function summarizeExtractionArtifactForPhase10b35(
  artifact: DefenseBudgetExtractionArtifactV1,
): Phase10b35ArtifactSummary {
  const evidenceById = new Map<string, { page?: number }>();
  for (const e of artifact.evidence as Array<{ evidenceId: string; page?: number }>) evidenceById.set(e.evidenceId, e);
  const factsById = new Map<string, { sourcePath?: string; rawValue?: string }>();
  for (const f of (artifact.sourceFacts ?? []) as Array<{ factId: string; sourcePath?: string; rawValue?: string }>) factsById.set(f.factId, f);

  const assertions = artifact.assertions as unknown as AnyAssertion[];
  const byKind: Record<string, number> = {};
  for (const a of assertions) byKind[a.assertionKind] = (byKind[a.assertionKind] ?? 0) + 1;

  const pageOf = (a: AnyAssertion): number | null => {
    const meta = a.metadata as Record<string, unknown> | undefined;
    if (meta && typeof meta.physicalPage === 'number') return meta.physicalPage;
    const ev = (a.evidenceIds ?? []).map((id) => evidenceById.get(id)).find(Boolean);
    return ev?.page ?? null;
  };

  const identities = assertions
    .filter((a) => a.assertionKind === 'program_element_identity')
    .map((a) => ({
      peCode: str((a.identity as Record<string, unknown> | undefined)?.peCode),
      title: str(a.title),
      component: str(a.component),
      page: pageOf(a),
    }))
    .sort((x, y) => (x.page ?? 0) - (y.page ?? 0));

  const documentFacts = assertions.filter((a) => a.assertionKind === 'document_fact');
  const toFactRow = (a: AnyAssertion): Phase10b35DocumentFactRow => {
    const v = (a.value ?? {}) as Record<string, unknown>;
    return {
      page: pageOf(a),
      fieldName: str(a.fieldName),
      rowKind: str(v.rowKind),
      peCode: str(v.peCode),
      projectCode: str(v.projectCode),
      fiscalYear: num(v.fiscalYear),
      columnRole: str(v.columnRole),
      valueMillions: str(v.valueMillions),
    };
  };
  const peTotals = documentFacts
    .map(toFactRow)
    .filter((r) => r.rowKind === 'pe_total' && r.valueMillions != null)
    .sort((x, y) => (x.page ?? 0) - (y.page ?? 0) || String(x.fieldName).localeCompare(String(y.fieldName)) || (x.fiscalYear ?? 0) - (y.fiscalYear ?? 0));

  const r2aDocumentFactsByPageIdentity: Record<string, number> = {};
  for (const r of documentFacts.map(toFactRow)) {
    if (!r.fieldName?.startsWith('r2a_')) continue;
    const k = `${r.page}|${r.peCode}/${r.projectCode}`;
    r2aDocumentFactsByPageIdentity[k] = (r2aDocumentFactsByPageIdentity[k] ?? 0) + 1;
  }

  const projectFunding: Phase10b35ProjectFundingRow[] = assertions
    .filter((a) => a.assertionKind === 'project_funding')
    .map((a) => {
      const meta = (a.metadata ?? {}) as Record<string, unknown>;
      const money = (a.money ?? {}) as Record<string, unknown>;
      return {
        physicalPage: num(meta.physicalPage) ?? pageOf(a),
        parentPeCode: str(a.parentPeCode),
        projectCode: str(a.projectCode),
        fiscalYear: num(a.fiscalYear),
        field: str(a.field),
        valueMillions: str(money.valueMillions),
        rowIndex: num(meta.rowIndex),
        columnIndex: num(meta.columnIndex),
      };
    })
    .sort((x, y) => (x.physicalPage ?? 0) - (y.physicalPage ?? 0) || (x.rowIndex ?? 0) - (y.rowIndex ?? 0) || (x.columnIndex ?? 0) - (y.columnIndex ?? 0));
  const projectFundingByFiscalYear: Record<string, number> = {};
  const projectFundingIdentitiesByPage: Record<string, string[]> = {};
  for (const r of projectFunding) {
    projectFundingByFiscalYear[String(r.fiscalYear)] = (projectFundingByFiscalYear[String(r.fiscalYear)] ?? 0) + 1;
    const k = String(r.physicalPage);
    const id = `${r.parentPeCode}/${r.projectCode}`;
    projectFundingIdentitiesByPage[k] ??= [];
    if (!projectFundingIdentitiesByPage[k].includes(id)) projectFundingIdentitiesByPage[k].push(id);
  }

  const omissions: Phase10b35OmissionRow[] = ((artifact.omissions ?? []) as Array<Record<string, unknown>>).map((o) => {
    const fact = factsById.get(String(o.sourceFactId));
    const sourcePath = fact?.sourcePath ?? null;
    const pageMatch = sourcePath?.match(/page:(\d+)/);
    const msg = String(o.message ?? '');
    const sub = msg.match(/omission: (\w+)/)?.[1] ?? null;
    return {
      page: pageMatch ? Number(pageMatch[1]) : null,
      reason: str(o.reason),
      subReason: sub,
      rawValue: fact?.rawValue ?? null,
      sourcePath,
    };
  });
  omissions.sort((x, y) => (x.page ?? 0) - (y.page ?? 0) || String(x.sourcePath).localeCompare(String(y.sourcePath)));
  const omissionsByPageSubReason: Record<string, number> = {};
  for (const o of omissions) {
    const k = `${o.page}|${o.subReason}`;
    omissionsByPageSubReason[k] = (omissionsByPageSubReason[k] ?? 0) + 1;
  }

  return {
    totals: {
      assertions: assertions.length,
      byKind,
      omissions: omissions.length,
      warnings: (artifact.warnings ?? []).length,
      projectFunding: projectFunding.length,
      projectFundingByFiscalYear,
    },
    identities,
    peTotals,
    projectFunding,
    projectFundingIdentitiesByPage,
    r2aDocumentFactsByPageIdentity,
    omissions,
    omissionsByPageSubReason,
  };
}

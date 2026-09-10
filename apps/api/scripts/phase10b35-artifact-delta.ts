/**
 * Phase 10B-35 -- substantive delta between two extraction artifacts of the
 * same source (e.g. production artifact vs. a repaired local parse).
 *
 * Compares the run-independent summary produced by
 * `lib/phase10b35-artifact-summary.ts`: every assertion is keyed by its
 * semantic content (page / identity / fiscal year / value / field), never by
 * assertion id, evidence id, parser run id or content hash -- those differ
 * between runs by design (ephemeral jobId flows into the artifact hash).
 *
 * Usage:
 *   tsx scripts/phase10b35-artifact-delta.ts --before <artifact.json> --after <artifact.json> [--out <delta.json>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { DefenseBudgetExtractionArtifactV1 } from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import {
  summarizeExtractionArtifactForPhase10b35,
  type Phase10b35DocumentFactRow,
  type Phase10b35OmissionRow,
  type Phase10b35ProjectFundingRow,
} from './lib/phase10b35-artifact-summary.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function keyProjectFunding(r: Phase10b35ProjectFundingRow): string {
  return `p${r.physicalPage}|${r.parentPeCode}/${r.projectCode}|FY${r.fiscalYear}|${r.field}|${r.valueMillions}|r${r.rowIndex}c${r.columnIndex}`;
}
function keyDocumentFact(r: Phase10b35DocumentFactRow): string {
  return `p${r.page}|${r.fieldName}|${r.rowKind}|${r.peCode}/${r.projectCode}|FY${r.fiscalYear}|${r.columnRole}|${r.valueMillions}`;
}
function keyOmission(o: Phase10b35OmissionRow): string {
  return `p${o.page}|${o.reason}|${o.subReason}|${o.rawValue}|${o.sourcePath}`;
}

function setDelta<T>(before: T[], after: T[], key: (t: T) => string): { removed: string[]; added: string[]; unchanged: number } {
  const b = new Map(before.map((x) => [key(x), x]));
  const a = new Map(after.map((x) => [key(x), x]));
  const removed = [...b.keys()].filter((k) => !a.has(k)).sort();
  const added = [...a.keys()].filter((k) => !b.has(k)).sort();
  const unchanged = [...b.keys()].filter((k) => a.has(k)).length;
  return { removed, added, unchanged };
}

export function computeArtifactDelta(
  before: DefenseBudgetExtractionArtifactV1,
  after: DefenseBudgetExtractionArtifactV1,
) {
  const sb = summarizeExtractionArtifactForPhase10b35(before);
  const sa = summarizeExtractionArtifactForPhase10b35(after);
  // document facts: recompute rows from the artifacts (summary keeps only pe_total)
  const allFacts = (art: DefenseBudgetExtractionArtifactV1): Phase10b35DocumentFactRow[] => {
    const evidenceById = new Map<string, { page?: number }>();
    for (const e of art.evidence as Array<{ evidenceId: string; page?: number }>) evidenceById.set(e.evidenceId, e);
    return (art.assertions as unknown as Array<Record<string, unknown>>)
      .filter((a) => a.assertionKind === 'document_fact')
      .map((a) => {
        const v = (a.value ?? {}) as Record<string, unknown>;
        const ev = ((a.evidenceIds as string[] | undefined) ?? []).map((id) => evidenceById.get(id)).find(Boolean);
        return {
          page: ev?.page ?? null,
          fieldName: (a.fieldName as string | undefined) ?? null,
          rowKind: (v.rowKind as string | undefined) ?? null,
          peCode: (v.peCode as string | undefined) ?? null,
          projectCode: (v.projectCode as string | null | undefined) ?? null,
          fiscalYear: typeof v.fiscalYear === 'number' ? v.fiscalYear : null,
          columnRole: (v.columnRole as string | undefined) ?? null,
          valueMillions: v.valueMillions == null ? null : String(v.valueMillions),
        };
      });
  };
  return {
    totals: { before: sb.totals, after: sa.totals },
    identities: setDelta(sb.identities, sa.identities, (i) => `${i.page}|${i.peCode}|${i.title}|${i.component}`),
    peTotals: setDelta(sb.peTotals, sa.peTotals, keyDocumentFact),
    documentFacts: setDelta(allFacts(before), allFacts(after), keyDocumentFact),
    projectFunding: setDelta(sb.projectFunding, sa.projectFunding, keyProjectFunding),
    omissions: setDelta(sb.omissions, sa.omissions, keyOmission),
    projectFundingIdentitiesByPage: { before: sb.projectFundingIdentitiesByPage, after: sa.projectFundingIdentitiesByPage },
    r2aDocumentFactsByPageIdentity: { before: sb.r2aDocumentFactsByPageIdentity, after: sa.r2aDocumentFactsByPageIdentity },
  };
}

function main(): void {
  const beforePath = arg('before');
  const afterPath = arg('after');
  if (!beforePath || !afterPath) {
    console.error('usage: --before <artifact.json> --after <artifact.json> [--out <delta.json>]');
    process.exit(2);
  }
  const before = JSON.parse(readFileSync(beforePath, 'utf8')) as DefenseBudgetExtractionArtifactV1;
  const after = JSON.parse(readFileSync(afterPath, 'utf8')) as DefenseBudgetExtractionArtifactV1;
  const delta = computeArtifactDelta(before, after);
  const out = arg('out');
  if (out) writeFileSync(out, JSON.stringify(delta, null, 2));
  const brief = {
    totals: delta.totals,
    identities: { removed: delta.identities.removed.length, added: delta.identities.added.length },
    peTotals: { removed: delta.peTotals.removed.length, added: delta.peTotals.added.length, unchanged: delta.peTotals.unchanged },
    documentFacts: { removed: delta.documentFacts.removed.length, added: delta.documentFacts.added.length, unchanged: delta.documentFacts.unchanged },
    projectFunding: { removed: delta.projectFunding.removed.length, added: delta.projectFunding.added.length, unchanged: delta.projectFunding.unchanged },
    omissions: { removed: delta.omissions.removed.length, added: delta.omissions.added.length, unchanged: delta.omissions.unchanged },
  };
  console.log(JSON.stringify(brief, null, 2));
}

if (require.main === module) main();

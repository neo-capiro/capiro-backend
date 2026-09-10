import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import {
  reconstructR2PeTotalCellsFromArtifact,
  reconstructR2aProjectFundingValuesFromArtifact,
} from './rdte-artifact-reconciliation-input-v1.js';

const SHA = 'a'.repeat(64);

function artifact(assertions: unknown[]): DefenseBudgetExtractionArtifactV1 {
  return {
    artifactId: 'artifact', schemaVersion: 'defense_budget_extraction_v1', contentSha256: SHA,
    source: { manifestDocumentKey: 'r2', sourceDocumentId: 'source', sourcePdfSha256: SHA, sourceLocator: 'r2.pdf', fiscalYear: 2027, family: 'rdte', exhibit: 'R-2', authority: 'dod-comptroller', component: 'ARMY', budgetCycle: 'PB', documentType: 'justification_book', title: 'R-2' },
    parserRuns: [], evidence: [{ evidenceId: 'ev-r2', sourcePdfSha256: SHA, parserRunId: 'run', granularity: 'page_only', page: 4, printedPage: '12', tableLabel: 'table_2', rowLabel: 'row_7', columnLabel: 'FY 2027' }, { evidenceId: 'ev-r2a', sourcePdfSha256: SHA, parserRunId: 'run', granularity: 'page_only', page: 8, printedPage: '19', tableLabel: 'table_3', rowLabel: 'row_9', columnLabel: 'FY 2027' }],
    sourceFacts: [{ factId: 'fact-r2', sourcePath: 'pe:0600000A/fy:2027/page:4/row:7/col:5', category: 'money', requiredForCompleteness: true, rawValue: '1000', evidenceIds: ['ev-r2'] }, { factId: 'fact-r2a', sourcePath: 'pe:0600000A/project:P1/fy:2027/page:8/col:6', category: 'money', requiredForCompleteness: true, rawValue: '1000', evidenceIds: ['ev-r2a'] }],
    assertions: assertions as DefenseBudgetExtractionArtifactV1['assertions'], warnings: [], omissions: [],
    summary: { sourceFactCount: 2, assertionCount: assertions.length, evidenceCount: 2, warningCount: 0, omissionCount: 0, completenessStatus: 'complete' },
  } as unknown as DefenseBudgetExtractionArtifactV1;
}

describe('persisted RDT&E reconciliation input reconstruction', () => {
  it('reconstructs a canonical R-2 budget-year PE total from assertion metadata', () => {
    const value = artifact([
      {
        assertionKind: 'funding', assertionId: 'r2-request', sourceFactIds: ['fact-r2'],
        evidenceIds: ['ev-r2'], confidence: 1,
        identity: { lineKind: 'RDTE_PE', peCode: '0600000A' }, fiscalYear: 2027,
        field: 'request',
        money: { originalValue: '1000', originalUnit: 'thousands', valueMillions: '1' },
        metadata: { exhibit: 'R-2', rowKind: 'pe_total', columnRole: 'budget_year_request',
          disposition: 'canonical_request_candidate', physicalPage: 4, printedPage: '12',
          tableIndex: 2, rowIndex: 7, columnIndex: 5, headerText: 'FY 2027' },
      },
    ]);
    expect(reconstructR2PeTotalCellsFromArtifact(value)).toEqual([{
      peCode: '0600000A', fiscalYear: 2027, columnRole: 'budget_year_request',
      printedTotal: '1000', unit: 'thousands', page: 4, printedPage: '12',
      rowIndex: 7, columnIndex: 5,
    }]);
  });

  it('losslessly reconstructs R-2 PE totals and R-2A project values', () => {
    const value = artifact([
      { assertionKind: 'document_fact', assertionId: 'r2-total', sourceFactIds: ['fact-r2'], evidenceIds: ['ev-r2'], confidence: 1, fieldName: 'r2_outyear_projection', value: { peCode: '0600000A', projectCode: null, rowKind: 'pe_total', fiscalYear: 2027, columnRole: 'outyear_projection', disposition: 'pe_budget_position', originalValue: '1000', originalUnit: 'thousands', valueMillions: '1', componentContext: 'total', positionCycle: 'pb_fy2027', headerText: 'FY 2027', direct: true } },
      { assertionKind: 'project_funding', assertionId: 'r2a-value', sourceFactIds: ['fact-r2a'], evidenceIds: ['ev-r2a'], confidence: 1, parentPeCode: '0600000A', projectCode: 'P1', fiscalYear: 2027, field: 'request', money: { originalValue: '1000', originalUnit: 'thousands', valueMillions: '1' }, metadata: { exhibit: 'R-2A', rowKind: 'project', columnRole: 'outyear_projection', disposition: 'project_budget_position', positionCycle: 'pb_fy2027', headerText: 'FY 2027', direct: true, physicalPage: 8, tableIndex: 3, rowIndex: 9, columnIndex: 6 } },
    ]);
    expect(reconstructR2PeTotalCellsFromArtifact(value)).toEqual([{ peCode: '0600000A', fiscalYear: 2027, columnRole: 'outyear_projection', printedTotal: '1000', unit: 'thousands', page: 4, printedPage: '12', rowIndex: 7, columnIndex: 5 }]);
    expect(reconstructR2aProjectFundingValuesFromArtifact(value)).toEqual([{ parentPeCode: '0600000A', projectCode: 'P1', rowKind: 'project', fiscalYear: 2027, columnRole: 'outyear_projection', disposition: 'project_budget_position', originalValue: '1000', originalUnit: 'thousands', valueMillions: '1', page: 8, printedPage: '19', tableIndex: 3, rowIndex: 9, columnIndex: 6, headerText: 'FY 2027', direct: true, positionCycle: 'pb_fy2027' }]);
  });

  it('delegates comparison math to the existing reconciler and contains no promotion authority', () => {
    const pipeline = fs.readFileSync(path.join(__dirname, 'rdte-cycle-pipeline-v1.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const reconstruction = fs.readFileSync(
      path.join(__dirname, 'rdte-artifact-reconciliation-input-v1.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(pipeline).toContain("from '../r2a/r2a-project-reconciler.js'");
    expect(pipeline).toContain('reconcileR2aProjectColumn(');
    expect(reconstruction).not.toContain('totalVsChildrenToleranceMillions');
    expect(reconstruction).not.toContain('withinExactTolerance');
    for (const file of [
      'rdte-artifact-reconciliation-input-v1.ts',
      path.resolve(__dirname, '../../promotion/readiness/family-certification-materialization-rdte-v1.ts'),
      path.resolve(__dirname, '../../../../scripts/extract-defense-budget-rdte.ts'),
      path.resolve(__dirname, '../../../../scripts/verify-defense-budget-rdte.ts'),
      path.resolve(__dirname, '../../../../scripts/certify-defense-budget-rdte.ts'),
    ]) {
      const source = fs.readFileSync(path.isAbsolute(file) ? file : path.join(__dirname, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(source).not.toContain('PROMOTER_DATABASE_URL');
      expect(source).not.toContain('.issue(');
      expect(source).not.toContain('.execute(');
    }
  });
});

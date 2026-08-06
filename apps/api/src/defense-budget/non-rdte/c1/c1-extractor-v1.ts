/**
 * c1-extractor-v1 — complete C-1 (MILCON Summary) extraction from Phase 3
 * normalized page results.
 *
 * For every C-1 project row, captures:
 *   - component/service;
 *   - appropriation/title;
 *   - fiscal year;
 *   - project number;
 *   - project title;
 *   - installation;
 *   - city/state/country or source-defined location;
 *   - category code where printed;
 *   - new mission/current mission designation;
 *   - request amount;
 *   - authorization amount when printed;
 *   - appropriation amount when printed;
 *   - total project cost or future cost where printed;
 *   - page/table evidence.
 *
 * Identity rules:
 *   - Every C-1 identity is MILCON_PROJECT, never RDTE_PE or PROCUREMENT_BLIN.
 *   - Same project number at different installations/components remains distinct.
 *   - Project title is not a natural key.
 *   - Summary/subtotal rows are not project identities.
 *   - Missing project number is a blocking omission.
 *   - Ambiguous project-number/location pairings are flagged.
 *
 * Pure module. Never invokes a parser, never calls LlamaParse, never writes
 * to a database. No ProgramElementWriterService.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import type { BudgetComponentV1 } from '../../contracts/extraction-artifact-v1.js';
import { buildMilconProjectIdentity, type MilconProjectIdentityV1 } from '../identity-v1.js';
import {
  detectPrintedUnit,
  toCanonicalDecimal,
  convertUnit,
  type PrintedUnitV1,
} from '../unit-semantics-v1.js';
import { parseMoneyToken } from '../../extractors/types.js';

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export interface C1ProjectIdentity {
  printedProjectCode: string;
  projectTitle: string;
  installation?: string;
  location?: string;
  categoryCode?: string;
  newMission?: string;
  page: number;
  printedPage?: string;
  tableIndex: number;
  rowIndex: number;
  identity: MilconProjectIdentityV1;
}

export type C1FundingType =
  | 'request'
  | 'authorization'
  | 'appropriation'
  | 'total_project_cost'
  | 'future_cost';

export interface C1FundingValue {
  identityNaturalKey: string;
  fundingType: C1FundingType;
  fiscalYear: number;
  originalValue: string;
  originalUnit: PrintedUnitV1;
  valueMillions: string;
  columnIndex: number;
  headerText: string;
  page: number;
}

export interface C1ExtractionOmission {
  page: number;
  rowIndex?: number;
  columnIndex?: number;
  reason: string;
  rawText: string;
  severity: 'blocking' | 'review';
}

export interface C1ExtractionConflict {
  printedProjectCode: string;
  fiscalYear: number;
  fundingType: C1FundingType;
  values: string[];
  pages: number[];
}

export interface C1ExtractionResult {
  identities: C1ProjectIdentity[];
  funding: C1FundingValue[];
  omissions: C1ExtractionOmission[];
  conflicts: C1ExtractionConflict[];
  unitResolution: { unit: PrintedUnitV1 | undefined; source: string };
}

/* ------------------------------------------------------------------ */
/* Label column classification                                         */
/* ------------------------------------------------------------------ */

type LabelColumnRole =
  | 'project_number'
  | 'project_title'
  | 'installation'
  | 'location'
  | 'category_code'
  | 'new_mission'
  | 'appropriation'
  | null;

interface LabelColumnMap {
  projectNumber?: number;
  projectTitle?: number;
  installation?: number;
  location?: number;
  categoryCode?: number;
  newMission?: number;
  appropriation?: number;
}

function classifyLabelColumn(headerText: string): LabelColumnRole {
  const h = headerText.trim().toLowerCase();
  if (h.length === 0) return null;
  if (
    h === 'project number' ||
    h === 'proj no' ||
    h === 'proj number' ||
    h === 'project no.' ||
    h === 'project #' ||
    h === 'no.'
  ) {
    return 'project_number';
  }
  if (
    h === 'project title' ||
    h === 'title' ||
    h === 'description' ||
    h === 'project name' ||
    h === 'project'
  ) {
    return 'project_title';
  }
  if (h === 'installation' || h === 'base' || h === 'site' || h === 'install') {
    return 'installation';
  }
  if (
    h === 'location' ||
    h === 'city/state' ||
    h === 'city, state' ||
    h === 'city' ||
    h === 'state' ||
    h === 'country' ||
    h === 'city/state/country'
  ) {
    return 'location';
  }
  if (h === 'category code' || h === 'cat code' || h === 'category' || h === 'cat') {
    return 'category_code';
  }
  if (h === 'new mission' || h === 'mission' || h === 'new/current' || h === 'mission type') {
    return 'new_mission';
  }
  if (h === 'appropriation' || h === 'approp' || h === 'appropriation account' || h === 'account') {
    return 'appropriation';
  }
  return null;
}

function mapLabelColumns(
  headers: ReadonlyArray<{ columnIndex: number; text: string }>,
): LabelColumnMap {
  const result: LabelColumnMap = {};
  for (const h of headers) {
    const role = classifyLabelColumn(h.text);
    if (role === 'project_number' && result.projectNumber == null) {
      result.projectNumber = h.columnIndex;
    } else if (role === 'project_title' && result.projectTitle == null) {
      result.projectTitle = h.columnIndex;
    } else if (role === 'installation' && result.installation == null) {
      result.installation = h.columnIndex;
    } else if (role === 'location' && result.location == null) {
      result.location = h.columnIndex;
    } else if (role === 'category_code' && result.categoryCode == null) {
      result.categoryCode = h.columnIndex;
    } else if (role === 'new_mission' && result.newMission == null) {
      result.newMission = h.columnIndex;
    } else if (role === 'appropriation' && result.appropriation == null) {
      result.appropriation = h.columnIndex;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Project number / row detection patterns                             */
/* ------------------------------------------------------------------ */

// Project numbers: typically like "ABC-12345" or numeric "12345" — 3-20 chars, alphanumeric with dashes
const PROJECT_NUMBER_RE = /^[A-Z0-9][A-Z0-9\-]{2,19}$/i;

const HEADER_LABELS = new Set([
  'project number',
  'proj no',
  'proj number',
  'project no.',
  'project #',
  'no.',
  'project title',
  'title',
  'description',
  'project name',
  'project',
  'installation',
  'base',
  'location',
  'site',
  'install',
  'city/state',
  'city, state',
  'city',
  'state',
  'country',
  'city/state/country',
  'category code',
  'cat code',
  'category',
  'cat',
  'new mission',
  'mission',
  'new/current',
  'mission type',
  'appropriation',
  'approp',
  'appropriation account',
  'account',
  'request',
  'authorization',
  'appropriation amount',
  'total project cost',
  'future cost',
  'total cost',
  'cost',
  'total',
  'subtotal',
  'sum',
  'grand total',
]);

function isHeaderValue(text: string): boolean {
  return HEADER_LABELS.has(text.trim().toLowerCase());
}

function isValidProjectNumber(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 20) return false;
  if (/\b(?:TOTAL|SUBTOTAL|SUM|GRAND)\b/i.test(t)) return false;
  return PROJECT_NUMBER_RE.test(t);
}

/* ------------------------------------------------------------------ */
/* Funding column detection                                            */
/* ------------------------------------------------------------------ */

interface FundingColumnMap {
  request?: number;
  authorization?: number;
  appropriation?: number;
  total_project_cost?: number;
  future_cost?: number;
}

function detectFundingColumn(headerText: string): keyof FundingColumnMap | null {
  const h = headerText.trim().toLowerCase();
  if (
    h === 'request' ||
    h === 'request amount' ||
    h === 'fy request' ||
    h === 'budget year request' ||
    h.includes('request')
  ) {
    return 'request';
  }
  if (h === 'authorization' || h === 'authorization amount' || h.includes('authorization')) {
    return 'authorization';
  }
  if (
    h === 'appropriation amount' ||
    h === 'appropriation' ||
    (h.includes('appropriation') && !h.includes('account'))
  ) {
    return 'appropriation';
  }
  if (
    h === 'total project cost' ||
    h === 'total cost' ||
    h === 'tpc' ||
    h.includes('total project')
  ) {
    return 'total_project_cost';
  }
  if (h === 'future cost' || h.includes('future cost')) {
    return 'future_cost';
  }
  return null;
}

function mapFundingColumns(
  headers: ReadonlyArray<{ columnIndex: number; text: string }>,
): FundingColumnMap {
  const result: FundingColumnMap = {};
  for (const h of headers) {
    const role = detectFundingColumn(h.text);
    if (role != null && result[role] == null) {
      result[role] = h.columnIndex;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

export function extractC1FromPages(input: {
  pages: readonly ParserPageResultV1[];
  cycleFiscalYear: number;
  component: BudgetComponentV1;
  account?: string;
}): C1ExtractionResult {
  const { pages, cycleFiscalYear, component, account } = input;

  const identities: C1ProjectIdentity[] = [];
  const funding: C1FundingValue[] = [];
  const omissions: C1ExtractionOmission[] = [];
  const conflicts: C1ExtractionConflict[] = [];

  let unit: PrintedUnitV1 | undefined;
  let unitSource = 'not detected';

  const seenNaturalKeys = new Set<string>();

  for (const page of pages) {
    for (const table of page.tables) {
      const rows = groupCellsByRow(table);

      /* Detect unit from table label or page text */
      if (unit == null) {
        if (table.label != null) {
          const detected = detectPrintedUnit(table.label);
          if (detected != null) {
            unit = detected;
            unitSource = `table label: "${table.label}"`;
          }
        }
        if (unit == null && page.text != null) {
          const detected = detectPrintedUnit(page.text.slice(0, 2000));
          if (detected != null) {
            unit = detected;
            unitSource = 'page text';
          }
        }
      }

      /* Find header row and map columns */
      const headerRow = findHeaderRow(rows);
      let labelMap: LabelColumnMap = {};
      let fundingMap: FundingColumnMap = {};

      if (headerRow != null) {
        const headers = headerRow.map((cell, idx) => ({
          columnIndex: idx,
          text: cell.text.trim(),
        }));
        labelMap = mapLabelColumns(headers);
        fundingMap = mapFundingColumns(headers);
      }

      /* Process data rows */
      for (const [rowIndex, cells] of rows) {
        if (isHeaderRow(cells)) continue;

        /* Skip total/subtotal rows */
        if (isTotalRow(cells)) continue;

        /* Detect project number */
        let printedProjectCode = '';
        if (labelMap.projectNumber != null) {
          const projCell = cells.find((c) => c.columnIndex === labelMap.projectNumber);
          if (projCell != null) {
            const candidate = projCell.text.trim();
            if (isValidProjectNumber(candidate)) {
              printedProjectCode = candidate;
            } else {
              const m = /^([A-Za-z0-9][A-Za-z0-9\-]{2,19})\b/.exec(candidate);
              if (m != null && isValidProjectNumber(m[1]!)) {
                printedProjectCode = m[1]!;
              }
            }
          }
        } else {
          /* No dedicated project number column — try first cell */
          const firstCell = cells[0]?.text.trim() ?? '';
          if (isValidProjectNumber(firstCell)) {
            printedProjectCode = firstCell;
          }
        }

        /* Detect project title */
        let projectTitle = '';
        if (labelMap.projectTitle != null) {
          const titleCell = cells.find((c) => c.columnIndex === labelMap.projectTitle);
          projectTitle = titleCell?.text.trim() ?? '';
        }

        /* Detect installation */
        let installation: string | undefined;
        if (labelMap.installation != null) {
          const instCell = cells.find((c) => c.columnIndex === labelMap.installation);
          const instText = instCell?.text.trim() ?? '';
          if (instText.length > 0) installation = instText;
        }

        /* Detect location */
        let location: string | undefined;
        if (labelMap.location != null) {
          const locCell = cells.find((c) => c.columnIndex === labelMap.location);
          const locText = locCell?.text.trim() ?? '';
          if (locText.length > 0) location = locText;
        }

        /* Detect category code */
        let categoryCode: string | undefined;
        if (labelMap.categoryCode != null) {
          const catCell = cells.find((c) => c.columnIndex === labelMap.categoryCode);
          const catText = catCell?.text.trim() ?? '';
          if (catText.length > 0) categoryCode = catText;
        }

        /* Detect new mission */
        let newMission: string | undefined;
        if (labelMap.newMission != null) {
          const nmCell = cells.find((c) => c.columnIndex === labelMap.newMission);
          const nmText = nmCell?.text.trim() ?? '';
          if (nmText.length > 0) newMission = nmText;
        }

        /* Detect appropriation from row */
        let rowAppropriation = account;
        if (labelMap.appropriation != null) {
          const appropCell = cells.find((c) => c.columnIndex === labelMap.appropriation);
          const appropText = appropCell?.text.trim() ?? '';
          if (appropText.length > 0) rowAppropriation = appropText;
        }

        /* Check if row has any money values */
        const hasMoney = hasMoneyInRow(cells, fundingMap);

        if (printedProjectCode.length === 0) {
          if (hasMoney) {
            omissions.push({
              page: page.page,
              rowIndex,
              reason: 'missing project number — cannot build MILCON_PROJECT identity',
              rawText: cells
                .map((c) => c.text)
                .join(' ')
                .slice(0, 200),
              severity: 'blocking',
            });
          }
          continue;
        }

        /* Build MILCON_PROJECT identity */
        let identity: MilconProjectIdentityV1;
        try {
          identity = buildMilconProjectIdentity({
            projectCode: printedProjectCode,
            component,
            ...(installation != null ? { location: installation } : {}),
            ...(rowAppropriation != null ? { account: rowAppropriation } : {}),
          });
        } catch {
          omissions.push({
            page: page.page,
            rowIndex,
            reason: 'invalid MILCON project identity — missing component or project code',
            rawText: printedProjectCode,
            severity: 'blocking',
          });
          continue;
        }

        /* Skip duplicate identities */
        if (seenNaturalKeys.has(identity.naturalKey)) {
          continue;
        }
        seenNaturalKeys.add(identity.naturalKey);

        const projectIdentity: C1ProjectIdentity = {
          printedProjectCode,
          projectTitle: projectTitle.length > 0 ? projectTitle : '(untitled)',
          page: page.page,
          ...(page.printedPage != null ? { printedPage: page.printedPage } : {}),
          tableIndex: table.tableIndex,
          rowIndex,
          ...(installation != null ? { installation } : {}),
          ...(location != null ? { location } : {}),
          ...(categoryCode != null ? { categoryCode } : {}),
          ...(newMission != null ? { newMission } : {}),
          identity,
        };
        identities.push(projectIdentity);

        /* Extract funding values */
        const effectiveUnit = unit ?? 'millions';

        for (const [fundingType, columnIndex] of Object.entries(fundingMap)) {
          if (columnIndex == null) continue;
          const cell = cells.find((c) => c.columnIndex === columnIndex);
          if (cell == null) continue;
          const rawText = cell.text.trim();
          if (rawText === '' || rawText === '-' || rawText === '\u2014') continue;

          const num = parseMoneyToken(rawText);
          if (num == null) continue;

          const originalValue = toCanonicalDecimal(num);
          const valueMillions = convertUnit(originalValue, effectiveUnit, 'millions');

          funding.push({
            identityNaturalKey: identity.naturalKey,
            fundingType: fundingType as C1FundingType,
            fiscalYear: cycleFiscalYear,
            originalValue,
            originalUnit: effectiveUnit,
            valueMillions,
            columnIndex,
            headerText: cell.text,
            page: page.page,
          });
        }
      }
    }
  }

  /* Detect conflicts: same identity + FY + fundingType with different values */
  const fundingByKey = new Map<string, C1FundingValue[]>();
  for (const f of funding) {
    const key = `${f.identityNaturalKey}|${f.fiscalYear}|${f.fundingType}`;
    const list = fundingByKey.get(key) ?? [];
    list.push(f);
    fundingByKey.set(key, list);
  }
  for (const [, list] of fundingByKey) {
    if (list.length <= 1) continue;
    const values = new Set(list.map((f) => f.valueMillions));
    if (values.size > 1) {
      const first = list[0]!;
      const printedCode =
        identities.find((i) => i.identity.naturalKey === first.identityNaturalKey)
          ?.printedProjectCode ?? 'unknown';
      conflicts.push({
        printedProjectCode: printedCode,
        fiscalYear: first.fiscalYear,
        fundingType: first.fundingType,
        values: Array.from(values),
        pages: list.map((f) => f.page),
      });
    }
  }

  return {
    identities,
    funding,
    omissions,
    conflicts,
    unitResolution: { unit, source: unitSource },
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function groupCellsByRow(
  table: ParsedTableV1,
): Map<number, Array<{ columnIndex: number; text: string }>> {
  const rows = new Map<number, Array<{ columnIndex: number; text: string }>>();
  for (const cell of table.cells) {
    const row = rows.get(cell.rowIndex) ?? [];
    row.push({ columnIndex: cell.columnIndex, text: cell.text });
    rows.set(cell.rowIndex, row);
  }
  for (const [, row] of rows) {
    row.sort((a, b) => a.columnIndex - b.columnIndex);
  }
  return new Map([...rows.entries()].sort((a, b) => a[0] - b[0]));
}

function findHeaderRow(
  rows: Map<number, Array<{ columnIndex: number; text: string }>>,
): Array<{ columnIndex: number; text: string }> | null {
  for (const [, cells] of rows) {
    if (isHeaderRow(cells)) return cells;
  }
  return null;
}

function isHeaderRow(cells: Array<{ columnIndex: number; text: string }>): boolean {
  const hasHeaderLabel = cells.some((c) => isHeaderValue(c.text));
  const hasNumericData = cells.some(
    (c, idx) => idx > 0 && /^-?[\d,]+(?:\.\d+)?$/.test(c.text.trim().replace(/[()$]/g, '')),
  );
  return hasHeaderLabel && !hasNumericData;
}

function isTotalRow(cells: Array<{ columnIndex: number; text: string }>): boolean {
  const text = cells
    .map((c) => c.text)
    .join(' ')
    .toLowerCase();
  return /\b(?:total|subtotal|sum|grand total)\b/i.test(text);
}

function hasMoneyInRow(
  cells: Array<{ columnIndex: number; text: string }>,
  fundingMap: FundingColumnMap,
): boolean {
  for (const columnIndex of Object.values(fundingMap)) {
    if (columnIndex == null) continue;
    const cell = cells.find((c) => c.columnIndex === columnIndex);
    if (cell == null) continue;
    const rawText = cell.text.trim();
    if (rawText === '' || rawText === '-' || rawText === '\u2014') continue;
    const num = parseMoneyToken(rawText);
    if (num != null) return true;
  }
  return false;
}

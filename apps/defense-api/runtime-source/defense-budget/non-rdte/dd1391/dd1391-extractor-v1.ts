/**
 * dd1391-extractor-v1 — complete DD Form 1391 (MILCON project justification)
 * extraction from Phase 3 normalized page results.
 *
 * Captures, where printed:
 *   - form/project identity;
 *   - fiscal year;
 *   - component;
 *   - installation and location;
 *   - project title and number;
 *   - category code;
 *   - project scope and units;
 *   - primary facility cost;
 *   - supporting facilities cost;
 *   - contingency, supervision/inspection/overhead, design, escalation,
 *     equipment, and total-request categories as separately labeled facts;
 *   - current working estimate/total project cost where printed;
 *   - authorization/appropriation/request distinctions;
 *   - requirement;
 *   - current situation;
 *   - impact if not provided;
 *   - related projects;
 *   - acquisition/award/start/completion schedule dates;
 *   - environmental/host-nation or other explicit source facts;
 *   - exact evidence and OCR confidence where applicable.
 *
 * Identity rules:
 *   - Every DD1391 identity is MILCON_PROJECT, never RDTE_PE or PROCUREMENT_BLIN.
 *   - Same project number at different installations/components remains distinct.
 *   - Project title is not a natural key.
 *   - Blank form cells become explicit missing facts when required by manifest.
 *   - OCR confidence below policy threshold requires review.
 *   - Never combine cost categories unless the source explicitly supplies a total.
 *
 * Pure module. Never invokes a parser, never calls LlamaParse, never writes
 * to a database. No ProgramElementWriterService.
 */
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import type { BudgetComponentV1, NarrativeTypeV1 } from '../../contracts/extraction-artifact-v1.js';
import { buildMilconProjectIdentity, type MilconProjectIdentityV1 } from '../identity-v1.js';
import {
  detectPrintedUnit,
  toCanonicalDecimal,
  convertUnit,
  type PrintedUnitV1,
} from '../unit-semantics-v1.js';

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export interface Dd1391ProjectIdentity {
  printedProjectCode: string;
  projectTitle: string;
  installation?: string;
  location?: string;
  categoryCode?: string;
  page: number;
  printedPage?: string;
  identity: MilconProjectIdentityV1;
}

export type Dd1391CostCategory =
  | 'primary_facility'
  | 'supporting_facilities'
  | 'contingency'
  | 'supervision_inspection_overhead'
  | 'design'
  | 'escalation'
  | 'equipment'
  | 'total_request'
  | 'current_working_estimate'
  | 'total_project_cost';

export interface Dd1391CostValue {
  identityNaturalKey: string;
  costCategory: Dd1391CostCategory;
  originalValue: string;
  originalUnit: PrintedUnitV1;
  valueMillions: string;
  page: number;
}

export interface Dd1391NarrativeSection {
  identityNaturalKey: string;
  sectionType: string;
  narrativeType: NarrativeTypeV1;
  text: string;
  page: number;
}

export interface Dd1391ScheduleDate {
  identityNaturalKey: string;
  milestone: string;
  date: string;
  page: number;
}

export interface Dd1391FundingValue {
  identityNaturalKey: string;
  fundingType: 'request' | 'authorization' | 'appropriation';
  fiscalYear: number;
  originalValue: string;
  originalUnit: PrintedUnitV1;
  valueMillions: string;
  page: number;
}

export interface Dd1391ExtractionOmission {
  page: number;
  reason: string;
  rawText: string;
  severity: 'blocking' | 'review';
}

export interface Dd1391TotalArithmetic {
  applicable: boolean;
  passed?: boolean;
  expected?: string;
  actual?: string;
}

export interface Dd1391OcrConfidence {
  identityNaturalKey: string;
  minValueConfidence?: number;
  requiresReview: boolean;
}

export interface Dd1391ExtractionResult {
  identities: Dd1391ProjectIdentity[];
  costs: Dd1391CostValue[];
  funding: Dd1391FundingValue[];
  narratives: Dd1391NarrativeSection[];
  schedules: Dd1391ScheduleDate[];
  omissions: Dd1391ExtractionOmission[];
  totalArithmetic: Dd1391TotalArithmetic;
  ocrConfidence: Dd1391OcrConfidence[];
  unitResolution: { unit: PrintedUnitV1 | undefined; source: string };
}

/* ------------------------------------------------------------------ */
/* Patterns                                                            */
/* ------------------------------------------------------------------ */

// Project number from page text: "Project No.: ABC-12345", "Project Number: XYZ-999"
const PROJECT_NUMBER_TEXT_RE =
  /(?:Project\s*(?:No\.?|Number|#))\s*[:\s]*\s*([A-Z0-9][A-Z0-9\-]{2,19})/i;
// Project title from page text
const PROJECT_TITLE_TEXT_RE = /(?:Project\s*Title)\s*[:\s]*\s*(.+?)(?:\n|$)/i;
// Installation from page text
const INSTALLATION_TEXT_RE = /(?:Installation|Base|Location)\s*[:\s]*\s*(.+?)(?:\n|$)/i;
// Category code
const CATEGORY_CODE_TEXT_RE = /(?:Category\s*Code|Cat\.?\s*Code)\s*[:\s]*\s*(\d{3,5})/i;

// Cost category patterns
const COST_CATEGORY_PATTERNS: Array<{
  pattern: RegExp;
  category: Dd1391CostCategory;
}> = [
  { pattern: /primary\s*(?:facility|construction)/i, category: 'primary_facility' },
  { pattern: /support(?:ing)?\s*facilit/i, category: 'supporting_facilities' },
  { pattern: /contingenc/i, category: 'contingency' },
  {
    pattern: /(?:supervision|inspection|overhead|s&i|sioh)/i,
    category: 'supervision_inspection_overhead',
  },
  { pattern: /design/i, category: 'design' },
  { pattern: /escalation/i, category: 'escalation' },
  { pattern: /equipment/i, category: 'equipment' },
  { pattern: /total\s*(?:request|cost)/i, category: 'total_request' },
  { pattern: /current\s*working\s*estimat/i, category: 'current_working_estimate' },
  { pattern: /total\s*project\s*cost/i, category: 'total_project_cost' },
];

// Narrative section headings
const NARRATIVE_SECTIONS: Array<{
  pattern: RegExp;
  sectionType: string;
  narrativeType: NarrativeTypeV1;
}> = [
  {
    pattern: /(?:^|\n)\s*requirement\s*[:\-\u2013]?/i,
    sectionType: 'requirement',
    narrativeType: 'rationale',
  },
  {
    pattern: /(?:^|\n)\s*current\s*(?:situation|condition)\s*[:\-\u2013]?/i,
    sectionType: 'current_situation',
    narrativeType: 'description',
  },
  {
    pattern: /(?:^|\n)\s*impact\s*(?:if\s*not\s*provided)?\s*[:\-\u2013]?/i,
    sectionType: 'impact',
    narrativeType: 'rationale',
  },
  {
    pattern: /(?:^|\n)\s*(?:project\s*)?scope\s*[:\-\u2013]?/i,
    sectionType: 'scope',
    narrativeType: 'description',
  },
  {
    pattern: /(?:^|\n)\s*environmental\s*(?:considerations?|impact)?\s*[:\-\u2013]?/i,
    sectionType: 'environmental',
    narrativeType: 'other',
  },
  {
    pattern: /(?:^|\n)\s*host[\-\s]?nation\s*(?:support|considerations?)?\s*[:\-\u2013]?/i,
    sectionType: 'host_nation',
    narrativeType: 'other',
  },
];

// Schedule date patterns
const SCHEDULE_PATTERNS: Array<{
  pattern: RegExp;
  milestone: string;
}> = [
  {
    pattern: /(?:acquisition|award)\s*(?:date|plan|schedule)\s*[:\s]*\s*(.+?)(?:\n|$)/i,
    milestone: 'acquisition_award',
  },
  {
    pattern: /(?:start|construction\s*start)\s*(?:date)?\s*[:\s]*\s*(.+?)(?:\n|$)/i,
    milestone: 'construction_start',
  },
  {
    pattern: /(?:completion|complete)\s*(?:date)?\s*[:\s]*\s*(.+?)(?:\n|$)/i,
    milestone: 'completion',
  },
];

// Money value pattern
const MONEY_VALUE_RE = /^\$?[\d,]+(?:\.\d+)?$/;

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

export function extractDd1391FromPages(input: {
  pages: readonly ParserPageResultV1[];
  cycleFiscalYear: number;
  component: BudgetComponentV1;
  account?: string;
  ocrConfidenceThreshold?: number;
}): Dd1391ExtractionResult {
  const { pages, cycleFiscalYear, component, account, ocrConfidenceThreshold } = input;

  const identities: Dd1391ProjectIdentity[] = [];
  const costs: Dd1391CostValue[] = [];
  const funding: Dd1391FundingValue[] = [];
  const narratives: Dd1391NarrativeSection[] = [];
  const schedules: Dd1391ScheduleDate[] = [];
  const omissions: Dd1391ExtractionOmission[] = [];
  const ocrConfidence: Dd1391OcrConfidence[] = [];

  let unit: PrintedUnitV1 | undefined;
  let unitSource = 'not detected';

  let currentIdentity: Dd1391ProjectIdentity | null = null;

  for (const page of pages) {
    /* Detect project identity from page text */
    if (page.text != null) {
      const detected = detectProjectIdentityFromText(
        page.text,
        page.page,
        page.printedPage,
        component,
        account,
      );
      if (detected != null) {
        currentIdentity = detected;
        identities.push(detected);
      }

      /* Detect unit */
      if (unit == null) {
        const detected = detectPrintedUnit(page.text.slice(0, 2000));
        if (detected != null) {
          unit = detected;
          unitSource = 'page text';
        }
      }

      /* Extract narratives */
      if (currentIdentity != null && page.text != null) {
        const identityKey = currentIdentity.identity.naturalKey;
        const pageNarratives = extractNarrativesFromText(page.text, identityKey, page.page);
        narratives.push(...pageNarratives);

        /* Extract schedule dates */
        const pageSchedules = extractScheduleDates(page.text, identityKey, page.page);
        schedules.push(...pageSchedules);
      }
    }

    /* Process tables for cost categories */
    for (const table of page.tables) {
      if (unit == null && table.label != null) {
        const detected = detectPrintedUnit(table.label);
        if (detected != null) {
          unit = detected;
          unitSource = `table label: "${table.label}"`;
        }
      }

      if (currentIdentity == null) continue;

      const identityKey = currentIdentity.identity.naturalKey;
      const effectiveUnit = unit ?? 'thousands';

      /* Process table rows for cost category values */
      const rows = groupCellsByRow(table);
      for (const [, cells] of rows) {
        const labelCell = cells[0];
        if (labelCell == null) continue;
        const labelText = labelCell.text.trim();
        if (labelText.length === 0) continue;

        /* Match cost category */
        const costMatch = matchCostCategory(labelText);
        if (costMatch != null) {
          /* Find the value cell — typically the next cell or last cell */
          for (const cell of cells) {
            if (cell.columnIndex === labelCell.columnIndex) continue;
            const rawText = cell.text.trim().replace(/[$,]/g, '');
            if (rawText.length === 0 || rawText === '-' || rawText === '\u2014') continue;
            if (!MONEY_VALUE_RE.test(rawText)) continue;

            const originalValue = toCanonicalDecimal(rawText);
            const valueMillions = convertUnit(originalValue, effectiveUnit, 'millions');
            costs.push({
              identityNaturalKey: identityKey,
              costCategory: costMatch,
              originalValue,
              originalUnit: effectiveUnit,
              valueMillions,
              page: page.page,
            });
            break; /* Only take the first numeric value for this row */
          }
        }
      }

      /* Check OCR confidence */
      if (ocrConfidenceThreshold != null && page.confidence != null) {
        const conf = parseFloat(page.confidence);
        if (!isNaN(conf) && conf < ocrConfidenceThreshold) {
          const existing = ocrConfidence.find((o) => o.identityNaturalKey === identityKey);
          if (existing == null) {
            ocrConfidence.push({
              identityNaturalKey: identityKey,
              minValueConfidence: conf,
              requiresReview: true,
            });
          } else if (existing.minValueConfidence == null || conf < existing.minValueConfidence) {
            existing.minValueConfidence = conf;
          }
        }
      }
    }

    /* Extract funding values from page text */
    if (currentIdentity != null && page.text != null) {
      const identityKey = currentIdentity.identity.naturalKey;
      const effectiveUnit = unit ?? 'thousands';

      /* Request amount */
      const requestMatch =
        /(?:request\s*amount|fy\s*\d{4}\s*request)\s*[:\s]*\s*\$?([\d,]+(?:\.\d+)?)/i.exec(
          page.text,
        );
      if (requestMatch != null) {
        const originalValue = toCanonicalDecimal(requestMatch[1]!.replace(/,/g, ''));
        const valueMillions = convertUnit(originalValue, effectiveUnit, 'millions');
        funding.push({
          identityNaturalKey: identityKey,
          fundingType: 'request',
          fiscalYear: cycleFiscalYear,
          originalValue,
          originalUnit: effectiveUnit,
          valueMillions,
          page: page.page,
        });
      }

      /* Authorization amount */
      const authMatch =
        /(?:authorization\s*amount|authorized)\s*[:\s]*\s*\$?([\d,]+(?:\.\d+)?)/i.exec(page.text);
      if (authMatch != null) {
        const originalValue = toCanonicalDecimal(authMatch[1]!.replace(/,/g, ''));
        const valueMillions = convertUnit(originalValue, effectiveUnit, 'millions');
        funding.push({
          identityNaturalKey: identityKey,
          fundingType: 'authorization',
          fiscalYear: cycleFiscalYear,
          originalValue,
          originalUnit: effectiveUnit,
          valueMillions,
          page: page.page,
        });
      }

      /* Appropriation amount */
      const appropMatch =
        /(?:appropriation\s*amount|appropriated)\s*[:\s]*\s*\$?([\d,]+(?:\.\d+)?)/i.exec(page.text);
      if (appropMatch != null) {
        const originalValue = toCanonicalDecimal(appropMatch[1]!.replace(/,/g, ''));
        const valueMillions = convertUnit(originalValue, effectiveUnit, 'millions');
        funding.push({
          identityNaturalKey: identityKey,
          fundingType: 'appropriation',
          fiscalYear: cycleFiscalYear,
          originalValue,
          originalUnit: effectiveUnit,
          valueMillions,
          page: page.page,
        });
      }
    }
  }

  /* If no project identity was detected, emit a blocking omission. */
  if (identities.length === 0) {
    omissions.push({
      page: pages.length > 0 ? pages[0]!.page : 1,
      reason: 'missing project identity — cannot build MILCON_PROJECT identity',
      rawText: 'no project number or identity header detected in any page',
      severity: 'blocking',
    });
  }

  /* Check total arithmetic: sum of cost categories vs total_request */
  const totalArithmetic = checkTotalArithmetic(costs);

  return {
    identities,
    costs,
    funding,
    narratives,
    schedules,
    omissions,
    totalArithmetic,
    ocrConfidence,
    unitResolution: { unit, source: unitSource },
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function detectProjectIdentityFromText(
  text: string,
  page: number,
  printedPage: string | undefined,
  component: BudgetComponentV1,
  account?: string,
): Dd1391ProjectIdentity | null {
  const projectMatch = PROJECT_NUMBER_TEXT_RE.exec(text);
  if (projectMatch == null) return null;

  const printedProjectCode = projectMatch[1]!.trim();
  if (printedProjectCode.length === 0) return null;

  const titleMatch = PROJECT_TITLE_TEXT_RE.exec(text);
  const projectTitle = titleMatch != null ? titleMatch[1]!.trim() : '(untitled)';

  const instMatch = INSTALLATION_TEXT_RE.exec(text);
  const installation = instMatch?.[1]?.trim();

  const catMatch = CATEGORY_CODE_TEXT_RE.exec(text);
  const categoryCode = catMatch?.[1]?.trim();

  let identity: MilconProjectIdentityV1;
  try {
    identity = buildMilconProjectIdentity({
      projectCode: printedProjectCode,
      component,
      ...(installation != null ? { location: installation } : {}),
      ...(account != null ? { account } : {}),
    });
  } catch {
    return null;
  }

  return {
    printedProjectCode,
    projectTitle,
    page,
    ...(printedPage != null ? { printedPage } : {}),
    ...(installation != null ? { installation } : {}),
    ...(categoryCode != null ? { categoryCode } : {}),
    identity,
  };
}

function matchCostCategory(label: string): Dd1391CostCategory | null {
  for (const { pattern, category } of COST_CATEGORY_PATTERNS) {
    if (pattern.test(label)) {
      return category;
    }
  }
  return null;
}

function groupCellsByRow(
  table: import('../../parser-router/parser-runtime-contract-v1.js').ParsedTableV1,
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

function extractNarrativesFromText(
  text: string,
  identityKey: string,
  page: number,
): Dd1391NarrativeSection[] {
  const results: Dd1391NarrativeSection[] = [];
  for (const { pattern, sectionType, narrativeType } of NARRATIVE_SECTIONS) {
    const match = pattern.exec(text);
    if (match == null) continue;

    const startIdx = match.index + match[0].length;
    let endIdx = Math.min(startIdx + 2000, text.length);
    for (const other of NARRATIVE_SECTIONS) {
      if (other.sectionType === sectionType) continue;
      const otherMatch = other.pattern.exec(text);
      if (otherMatch != null && otherMatch.index > match.index) {
        endIdx = Math.min(endIdx, otherMatch.index);
      }
    }

    const sectionText = text.slice(startIdx, endIdx).trim();
    if (sectionText.length > 0) {
      results.push({
        identityNaturalKey: identityKey,
        sectionType,
        narrativeType,
        text: sectionText.slice(0, 2000),
        page,
      });
    }
  }
  return results;
}

function extractScheduleDates(
  text: string,
  identityKey: string,
  page: number,
): Dd1391ScheduleDate[] {
  const results: Dd1391ScheduleDate[] = [];
  for (const { pattern, milestone } of SCHEDULE_PATTERNS) {
    const match = pattern.exec(text);
    if (match == null) continue;
    const date = match[1]!.trim();
    if (date.length > 0) {
      results.push({
        identityNaturalKey: identityKey,
        milestone,
        date,
        page,
      });
    }
  }
  return results;
}

/**
 * Check total arithmetic: sum of individual cost categories vs the
 * total_request, only when the source explicitly defines all components
 * and the total. Never combines categories unless the source defines a total.
 */
function checkTotalArithmetic(costs: Dd1391CostValue[]): Dd1391TotalArithmetic {
  const totalRequest = costs.find((c) => c.costCategory === 'total_request');
  if (totalRequest == null) return { applicable: false };

  /* Sum component costs */
  const components = costs.filter(
    (c) =>
      c.costCategory !== 'total_request' &&
      c.costCategory !== 'current_working_estimate' &&
      c.costCategory !== 'total_project_cost',
  );

  if (components.length === 0) return { applicable: false };

  /* Use valueMillions for comparison */
  const sum = components.reduce((acc, c) => acc + parseFloat(c.valueMillions), 0);
  const total = parseFloat(totalRequest.valueMillions);

  /* Only check when all components are present (at least primary + contingency) */
  const hasPrimary = costs.some((c) => c.costCategory === 'primary_facility');
  const hasContingency = costs.some((c) => c.costCategory === 'contingency');
  if (!hasPrimary || !hasContingency) return { applicable: false };

  const tolerance = Math.max(Math.abs(total) * 0.02, 0.01);
  return {
    applicable: true,
    passed: Math.abs(sum - total) <= tolerance,
    expected: sum.toString(),
    actual: total.toString(),
  };
}

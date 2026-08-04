/**
 * rdte-golden-cycle-v1 — minimal synthetic golden fixtures for one complete
 * RDT&E cycle (FY2027).
 *
 * Workstream N (Phase 4 plan §19). The fixtures are:
 *   - minimal and synthetic (no official DoD content, no secrets);
 *   - deterministic (fixed pages, no timestamps);
 *   - sufficient to exercise the REAL semantic paths end-to-end:
 *       R-1 identity + FYDP roles
 *       R-2 segmentation + narrative + PE cost table
 *       R-2A project identity + project funding that sums to the R-2 PE total
 *       R-3 role-honest performers
 *       R-4 milestones with exact AND fiscal-quarter periods
 *   - internally consistent so a clean cycle certifies:
 *       R-1 FY2027 request 12.000 == R-2 PE total FY2027 request 12.000
 *       R-2A projects A1 7.000 + B2 5.000 == R-2 PE total 12.000
 *
 * Pure module: builds ParserPageResultV1 fixtures only.
 */
import type {
  LayoutBlockV1,
  ParsedTableV1,
  ParserPageResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import type {
  BudgetCycleManifestDocumentV1,
  BudgetCycleManifestV1,
} from '../../contracts/budget-cycle-manifest-v1.js';
import type { ExtractionSourceV1 } from '../../contracts/extraction-artifact-v1.js';

export const GOLDEN_CYCLE_FY = 2027;
export const GOLDEN_PE = '0601101A';
export const GOLDEN_SHA = 'e'.repeat(64);

/* ------------------------------------------------------------------ */
/* Page builders                                                       */
/* ------------------------------------------------------------------ */

type Cell = { rowIndex: number; columnIndex: number; text: string };

function makeTable(cells: Cell[], tableIndex = 0): ParsedTableV1 {
  const maxRow = Math.max(...cells.map((c) => c.rowIndex), 0);
  const maxCol = Math.max(...cells.map((c) => c.columnIndex), 0);
  return {
    tableIndex,
    rowCount: maxRow + 1,
    columnCount: maxCol + 1,
    cells: cells.map((c) => ({ ...c })),
    warnings: [],
  };
}

function makeBlock(blockIndex: number, blockType: LayoutBlockV1['blockType'], text: string) {
  return { blockIndex, blockType, text };
}

function makePage(input: {
  page: number;
  text?: string;
  blocks?: LayoutBlockV1[];
  tables?: ParsedTableV1[];
}): ParserPageResultV1 {
  return {
    page: input.page,
    ...(input.text != null ? { text: input.text } : {}),
    blocks: input.blocks ?? [],
    tables: input.tables ?? [],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

/* ------------------------------------------------------------------ */
/* R-1                                                                 */
/* ------------------------------------------------------------------ */

export function goldenR1Pages(): ParserPageResultV1[] {
  const table = makeTable([
    { rowIndex: 0, columnIndex: 0, text: 'PE' },
    { rowIndex: 0, columnIndex: 1, text: 'Title' },
    { rowIndex: 0, columnIndex: 2, text: 'FY 2025 Actual' },
    { rowIndex: 0, columnIndex: 3, text: 'FY 2026 Enacted' },
    { rowIndex: 0, columnIndex: 4, text: 'FY 2027 Request' },
    { rowIndex: 0, columnIndex: 5, text: 'FY 2028' },
    { rowIndex: 0, columnIndex: 6, text: 'Cost to Complete' },
    { rowIndex: 0, columnIndex: 7, text: 'Total Cost' },
    { rowIndex: 1, columnIndex: 0, text: GOLDEN_PE },
    { rowIndex: 1, columnIndex: 1, text: 'Advanced Technology Development' },
    { rowIndex: 1, columnIndex: 2, text: '10.000' },
    { rowIndex: 1, columnIndex: 3, text: '11.000' },
    { rowIndex: 1, columnIndex: 4, text: '12.000' },
    { rowIndex: 1, columnIndex: 5, text: '13.000' },
    { rowIndex: 1, columnIndex: 6, text: '5.000' },
    { rowIndex: 1, columnIndex: 7, text: '51.000' },
  ]);
  return [
    makePage({
      page: 1,
      text: 'RDT&E Exhibit R-1 $ in Millions',
      blocks: [makeBlock(0, 'header', 'RDT&E Exhibit R-1')],
      tables: [table],
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* R-2                                                                 */
/* ------------------------------------------------------------------ */

export function goldenR2Pages(): ParserPageResultV1[] {
  const costTable = makeTable([
    { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
    { rowIndex: 0, columnIndex: 1, text: 'FY 2025 Actual' },
    { rowIndex: 0, columnIndex: 2, text: 'FY 2026 Enacted' },
    { rowIndex: 0, columnIndex: 3, text: 'FY 2027 Request' },
    { rowIndex: 0, columnIndex: 4, text: 'FY 2028' },
    { rowIndex: 0, columnIndex: 5, text: 'Cost to Complete' },
    { rowIndex: 0, columnIndex: 6, text: 'Total Cost' },
    { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
    { rowIndex: 1, columnIndex: 1, text: '10.000' },
    { rowIndex: 1, columnIndex: 2, text: '11.000' },
    { rowIndex: 1, columnIndex: 3, text: '12.000' },
    { rowIndex: 1, columnIndex: 4, text: '13.000' },
    { rowIndex: 1, columnIndex: 5, text: '5.000' },
    { rowIndex: 1, columnIndex: 6, text: '51.000' },
  ]);
  return [
    makePage({
      page: 1,
      text: 'RDT&E Budget Item Justification $ in Millions',
      blocks: [
        makeBlock(0, 'header', 'RDT&E Budget Item Justification'),
        makeBlock(1, 'heading', `PE ${GOLDEN_PE} / Advanced Technology Development`),
        makeBlock(2, 'text', 'A. Mission Description and Budget Item Justification'),
        makeBlock(3, 'text', 'This PE develops advanced technology for future systems.'),
        makeBlock(4, 'text', 'B. Accomplishments/Planned Programs'),
        makeBlock(5, 'text', 'Completed the first prototype in FY 2026.'),
      ],
      tables: [costTable],
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* R-2A                                                                */
/* ------------------------------------------------------------------ */

function r2aProjectPage(input: {
  page: number;
  projectCode: string;
  title: string;
  requestValue: string;
  outyearValue: string;
}): ParserPageResultV1 {
  const table = makeTable([
    { rowIndex: 0, columnIndex: 0, text: 'Cost ($ in Millions)' },
    { rowIndex: 0, columnIndex: 1, text: 'FY 2027 Request' },
    { rowIndex: 0, columnIndex: 2, text: 'FY 2028' },
    { rowIndex: 1, columnIndex: 0, text: 'Project Cost' },
    { rowIndex: 1, columnIndex: 1, text: input.requestValue },
    { rowIndex: 1, columnIndex: 2, text: input.outyearValue },
  ]);
  return makePage({
    page: input.page,
    text: 'RDT&E Project Justification $ in Millions',
    blocks: [
      makeBlock(0, 'header', 'RDT&E Project Justification'),
      makeBlock(1, 'heading', `PE ${GOLDEN_PE}`),
      makeBlock(2, 'text', `Project Code: ${input.projectCode}`),
      makeBlock(3, 'text', `Project Title: ${input.title}`),
      makeBlock(4, 'text', 'Mission: Develop the capability.'),
    ],
    tables: [table],
  });
}

export function goldenR2aPages(): ParserPageResultV1[] {
  /* Project detail sums exactly to the R-2 PE total for FY2027 request:
   * 7.000 + 5.000 = 12.000. */
  return [
    r2aProjectPage({
      page: 1,
      projectCode: 'A1',
      title: 'Advanced Radar',
      requestValue: '7.000',
      outyearValue: '7.500',
    }),
    r2aProjectPage({
      page: 2,
      projectCode: 'B2',
      title: 'Sensor Fusion',
      requestValue: '5.000',
      outyearValue: '5.500',
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* R-3                                                                 */
/* ------------------------------------------------------------------ */

export function goldenR3Pages(): ParserPageResultV1[] {
  const table = makeTable([
    { rowIndex: 0, columnIndex: 0, text: 'Performing Activity' },
    { rowIndex: 0, columnIndex: 1, text: 'Location' },
    { rowIndex: 0, columnIndex: 2, text: 'Contract Method' },
    { rowIndex: 0, columnIndex: 3, text: 'Total Cost' },
    { rowIndex: 1, columnIndex: 0, text: 'Lockheed Martin' },
    { rowIndex: 1, columnIndex: 1, text: 'Bethesda, MD' },
    { rowIndex: 1, columnIndex: 2, text: 'C/CPFF' },
    { rowIndex: 1, columnIndex: 3, text: '12.500' },
    { rowIndex: 2, columnIndex: 0, text: 'Army Research Laboratory' },
    { rowIndex: 2, columnIndex: 1, text: 'Adelphi, MD' },
    { rowIndex: 2, columnIndex: 2, text: 'MIPR' },
    { rowIndex: 2, columnIndex: 3, text: '3.000' },
  ]);
  return [
    makePage({
      page: 1,
      text: `R-3 RDT&E Cost Analysis $ in Millions PE ${GOLDEN_PE}`,
      blocks: [
        makeBlock(0, 'header', `R-3 RDT&E Cost Analysis PE ${GOLDEN_PE}`),
      ],
      tables: [table],
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* R-4                                                                 */
/* ------------------------------------------------------------------ */

export function goldenR4Pages(): ParserPageResultV1[] {
  const table = makeTable([
    { rowIndex: 0, columnIndex: 0, text: 'Milestone' },
    { rowIndex: 0, columnIndex: 1, text: 'Planned Date' },
    { rowIndex: 0, columnIndex: 2, text: 'Actual Date' },
    { rowIndex: 0, columnIndex: 3, text: 'Status' },
    { rowIndex: 0, columnIndex: 4, text: 'Notes' },
    { rowIndex: 1, columnIndex: 0, text: 'Critical Design Review' },
    { rowIndex: 1, columnIndex: 1, text: '2027-03-15' },
    { rowIndex: 1, columnIndex: 2, text: '' },
    { rowIndex: 1, columnIndex: 3, text: 'On Track' },
    { rowIndex: 1, columnIndex: 4, text: '' },
    { rowIndex: 2, columnIndex: 0, text: 'Initial Operational Capability' },
    { rowIndex: 2, columnIndex: 1, text: '3Q FY2028' },
    { rowIndex: 2, columnIndex: 2, text: '' },
    { rowIndex: 2, columnIndex: 3, text: 'Planned' },
    { rowIndex: 2, columnIndex: 4, text: '' },
  ]);
  return [
    makePage({
      page: 1,
      text: `R-4 RDT&E Schedule Profile PE ${GOLDEN_PE}`,
      blocks: [makeBlock(0, 'header', `R-4 RDT&E Schedule Profile PE ${GOLDEN_PE}`)],
      tables: [table],
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* Manifest + sources                                                  */
/* ------------------------------------------------------------------ */

const DOC_DEFINITIONS: ReadonlyArray<{
  key: string;
  exhibit: BudgetCycleManifestDocumentV1['exhibit'];
  title: string;
}> = [
  { key: 'golden_r1', exhibit: 'R-1', title: 'Golden R-1 Catalog' },
  { key: 'golden_r2', exhibit: 'R-2', title: 'Golden R-2 PE Summary' },
  { key: 'golden_r2a', exhibit: 'R-2A', title: 'Golden R-2A Project Detail' },
  { key: 'golden_r3', exhibit: 'R-3', title: 'Golden R-3 Cost Analysis' },
  { key: 'golden_r4', exhibit: 'R-4', title: 'Golden R-4 Schedule' },
];

export function goldenManifestDocument(key: string): BudgetCycleManifestDocumentV1 {
  const def = DOC_DEFINITIONS.find((d) => d.key === key);
  if (def == null) throw new Error(`unknown golden document key ${key}`);
  return {
    documentKey: def.key,
    required: true,
    title: def.title,
    sourceLocator: `fixture://${def.key}.pdf`,
    family: 'rdte',
    exhibit: def.exhibit,
    authority: 'dod-comptroller',
    component: 'DW',
    budgetCycle: `pb_fy${GOLDEN_CYCLE_FY}`,
    documentType: 'pb_exhibit',
    parserPolicy: 'native_structured',
    requiredDataCategories: ['identity', 'funding'],
    requiredFundingFields: ['request'],
    expectedLineKinds: ['RDTE_PE'],
    allowEmpty: false,
  };
}

export function goldenManifest(): BudgetCycleManifestV1 {
  return {
    schemaVersion: 'defense_budget_cycle_manifest_v1' as never,
    cycleId: `golden_fy${GOLDEN_CYCLE_FY}`,
    fiscalYear: GOLDEN_CYCLE_FY,
    domain: 'defense',
    documents: DOC_DEFINITIONS.map((d) => goldenManifestDocument(d.key)),
  };
}

export function goldenSource(key: string): ExtractionSourceV1 {
  const def = DOC_DEFINITIONS.find((d) => d.key === key);
  if (def == null) throw new Error(`unknown golden document key ${key}`);
  return {
    manifestDocumentKey: def.key,
    sourcePdfSha256: GOLDEN_SHA,
    sourceLocator: `fixture://${def.key}.pdf`,
    sourceUrl: `https://fixtures.example.com/${def.key}.pdf`,
    fiscalYear: GOLDEN_CYCLE_FY,
    family: 'rdte',
    exhibit: def.exhibit,
    authority: 'dod-comptroller',
    component: 'DW',
    budgetCycle: `pb_fy${GOLDEN_CYCLE_FY}`,
    documentType: 'pb_exhibit',
  };
}

export function goldenPagesByKey(): Record<string, ParserPageResultV1[]> {
  return {
    golden_r1: goldenR1Pages(),
    golden_r2: goldenR2Pages(),
    golden_r2a: goldenR2aPages(),
    golden_r3: goldenR3Pages(),
    golden_r4: goldenR4Pages(),
  };
}

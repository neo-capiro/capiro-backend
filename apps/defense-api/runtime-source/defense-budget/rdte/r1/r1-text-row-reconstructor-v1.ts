/**
 * r1-text-row-reconstructor-v1 (Phase 10B-11).
 *
 * Turns non-table `deterministic_pdfplumber` output into trustworthy R-1
 * `ParsedTableV1` structure, for pages where pdfplumber's structural table
 * detection found nothing (`page.tables.length === 0`) -- proven, against
 * the real archived FY2024 R-1 PDF, to be every one of its 114 pages: this
 * document's tabular data renders as positioned/plain text, never as
 * pdfplumber table objects.
 *
 * Scope: R-1 only, by design (see the module's own header-detection
 * pattern, which is specific to the R-1 exhibit's known, decades-stable
 * DoD Comptroller column vocabulary). Does NOT duplicate PE-code
 * validation, money parsing, fiscal-year column-role classification, unit
 * normalization, or artifact building -- it owns exactly one thing: producing
 * a `ParsedTableV1` truthful enough that the EXISTING, UNCHANGED
 * `detectR1TablesOnPage` / `extractR1FromPages` / `buildR1Artifact` pipeline
 * can consume it exactly as if pdfplumber had found a real table.
 *
 * ## Why the geometry available here is line-level text, not word-level
 *
 * `pdfplumber_engine.py`'s `_extract_blocks` calls pdfplumber's
 * `extract_words()` (which DOES return per-word x/y) but then groups words
 * into LINES by their `top` coordinate and emits one `LayoutBlockV1` per
 * LINE with a single bounding box for the whole line -- individual word
 * boundaries are not part of the current parser-output contract. Profiling
 * the real 114-page output confirms every page has line-level bounding
 * boxes (100%), and confirms every genuine R-1 data row is exactly one
 * physical text line (never split across blocks). Word-level geometry
 * would be strictly better for column-boundary detection, but adding it
 * would mean changing the shared Python engine used by every exhibit type
 * (R-1 through DD-1391) -- explicitly out of scope for an R-1-only PR. This
 * module instead anchors column identity on the R-1 format's own proven
 * invariants (below), and re-verifies them per-row at runtime rather than
 * trusting position alone.
 *
 * ## The dollar-column role sequence, and why it is not a position guess
 *
 * Profiling every page of the real document found exactly one recurring,
 * decades-stable 3-physical-line column header, always ending in the exact
 * substring "Actuals Enacted Enacted* Enacted Request" -- 5 canonical
 * roles, always in this order: FY(cycle-2) Actual, FY(cycle-1) Enacted,
 * FY(cycle-1) Supplemental Enacted, FY(cycle-1) Total Enacted, FY(cycle)
 * Request. A DATA row prints either all 5 values, or 4 (the supplemental
 * column omitted from the rendered text when it is zero).
 *
 * "The last token is the request" would be exactly the kind of position
 * guess this workstream's brief prohibits, EXCEPT that it is independently,
 * mathematically provable per row, not merely assumed: whenever a row
 * prints only 4 trailing numeric tokens, the 2nd and 3rd of those 4 are
 * ALWAYS numerically identical (verified across all 1,031 such rows in the
 * real document, zero exceptions) -- which is exactly what "the
 * supplemental adjustment was zero, so Enacted and Total Enacted collapsed
 * to the same printed value" predicts, and nothing else would. A row with
 * fewer than 4 trailing numbers, OR with 4 numbers that do NOT satisfy this
 * identity, fails this check and is never treated as a confident 4/5-column
 * row (see `reconstructR1RowFromLine` below) -- it is real, PE-code-bearing
 * data (a genuine counter-example exists in the real document: PE
 * 0305251A's row has 3 trailing numbers where the identity holds between
 * the FIRST two, not proving which one is the request), so its PE identity
 * is still recoverable, but no funding value is fabricated for it.
 */
import type {
  ParsedTableCellV1,
  ParsedTableV1,
  ParserPageResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';

type BoundingBoxV1 = NonNullable<ParsedTableCellV1['boundingBox']>;
import { isValidPeCode } from '../../extractors/types.js';
import type { BudgetComponentV1 } from '../../contracts/extraction-artifact-v1.js';

export const R1_TEXT_RECONSTRUCTION_CONFIDENCE_MARKER = 'r1_text_reconstruction_v1';

/**
 * Column indices used in every table this module emits. Matches the
 * EXISTING, unmodified `detectR1TablesOnPage`/`extractR1FromPages` contract
 * exactly: column 0 is read directly as the PE code, column 1 directly as
 * the title (`r1-table-detector.ts`'s `cells[0]`/`cells[1]`), and EVERY
 * column index 2 and above is treated as a candidate money cell, classified
 * purely from the header at that same index (`if (cell.columnIndex <= 1)
 * continue` in `r1-extractor-v1.ts`). There is no slot in that contract for
 * a separate line-number, budget-activity, or category-marker column --
 * this module recovers those fields (see `ReconstructedRowV1`) for its own
 * validation/provenance, but never emits them as table cells, exactly
 * mirroring the existing hand-written test fixture's own table shape
 * (`r1-extractor-v1.spec.ts`'s `makeTable`).
 */
export const R1_RECONSTRUCTED_COLUMNS = {
  peCode: 0,
  title: 1,
  fyMinus2Actual: 2,
  fyMinus1TotalEnacted: 3,
  fyRequest: 4,
} as const;

/**
 * Only 3 of the 5 real dollar figures ever become table cells: the header
 * classifier (`normalizeRdteHeader`/`classifyRdteColumn`, both unchanged)
 * has exactly one role per (stage, fiscal year) pair, and this document's
 * "Enacted" and "Total Enacted" columns share both a stage word
 * ("Enacted") and a fiscal year (cycle-1) -- exposing both, or exposing a
 * synthesized "Supplemental" column that ALSO necessarily carries
 * "Enacted"/cycle-1 in its header text to be recognizable at all, produces
 * two DIFFERENT values (e.g. a real 723,107 against this module's own
 * derived '0' supplemental placeholder) classified to the identical role,
 * which the real `r1_specific` verifier rule correctly flags as
 * `r1_duplicate_conflicting_value` (confirmed against the real 114-page
 * document: 859 such false conflicts before this was narrowed to 3
 * columns). Total Enacted is kept, not pre-supplemental Enacted, because
 * it is the authoritative post-adjustment figure; neither the pre-
 * adjustment Enacted value nor the Supplemental delta itself is needed by
 * any acceptance criterion (only budget_year_request ever becomes a real
 * `funding` assertion -- everything else is document_fact context).
 */
export interface R1TextReconstructionOmissionV1 {
  page: number;
  peCode?: string;
  reason: string;
  rawLine: string;
}

/**
 * Row-level context recovered by this module but with no slot in the
 * existing `ParsedTableV1`/`R1DetectedRow`/`R1PeIdentity` money-cell
 * contract. Threaded as a parallel, R-1-only side channel (never as a fake
 * table column) so extraction/verification/audit code can tell WHY two
 * occurrences of the same PE code might legitimately differ, without
 * touching the shared, exhibit-agnostic `ParsedTableV1` schema used by
 * R-2/R2A/R3/R4/non-RDTE exhibits.
 *
 * `sectionHeading` is the actual page-heading text (e.g. "Defense Threat
 * Reduction Agency"), distinct from and finer-grained than the coarse,
 * canonical `BudgetComponentV1` enum: proven against the real 114-page
 * document that many genuinely different organizational sections (DTRA,
 * Secretary of Defense, Chemical and Biological Defense Program, ...) all
 * resolve to the same `DW` component value, so `component` alone cannot
 * distinguish "the Defense-Wide roll-up volume" from "an individual
 * agency's own chapter" -- exactly the relationship behind the majority of
 * this document's cross-page PE duplicates.
 */
export interface R1RowContextV1 {
  lineNumber: string;
  budgetActivity: string;
  budgetActivityCategory: string;
  sectionHeading: string;
  component: BudgetComponentV1;
  componentEvidence: string;
  appropriation?: string;
}

export interface R1ReconstructedPageV1 {
  page: number;
  printedPage?: string;
  table: ParsedTableV1;
  component: BudgetComponentV1;
  componentEvidence: string;
  sectionHeading: string;
  dataRowCount: number;
  confidentFundingRowCount: number;
  /** Row context keyed by the same `rowIndex` used in `table.cells`. */
  rowContextByRowIndex: Map<number, R1RowContextV1>;
}

export interface R1TextReconstructionResultV1 {
  pages: R1ReconstructedPageV1[];
  omissions: R1TextReconstructionOmissionV1[];
}

/* ------------------------------------------------------------------ */
/* Header detection -- the one invariant this whole module is anchored on */
/* ------------------------------------------------------------------ */

/**
 * The exact, decades-stable trailing column-label sequence. Matched as a
 * literal substring (not a fuzzy heuristic) -- if this exact text is not
 * present, the page is not treated as containing recognizable R-1 rows at
 * all, regardless of what else is on it.
 */
const CANONICAL_STAGE_HEADER_RE = /Actuals\s+Enacted\s+Enacted\*\s+Enacted\s+Request/;

/** One physical text line that is an R-1 data row: lineNo, PE code, then anything. */
const DATA_ROW_RE = /^(\d+)\s+(\d{7}[A-Z][A-Z0-9]*)\s+(.*)$/;

/** A run of trailing whitespace-separated tokens that are each a money figure or a lone dash (blank/zero cell). */
const MONEY_TOKEN_RE = /^-?[\d,]+(?:\.\d+)?$/;
const DASH_TOKEN_RE = /^-$/;

/** Budget activity + category immediately preceding the money run, e.g. "01 U". */
const BA_CATEGORY_RE = /^(\d{2})\s+([A-Z])$/;

const UNIT_RE = /\$?\s*in\s+(Thousands|Millions|Dollars)/i;

function isMoneyOrDashToken(token: string): boolean {
  return MONEY_TOKEN_RE.test(token) || DASH_TOKEN_RE.test(token);
}

function parseMoneyToken(token: string): number {
  if (DASH_TOKEN_RE.test(token)) return 0;
  return Number.parseFloat(token.replace(/,/g, ''));
}

/* ------------------------------------------------------------------ */
/* Component identification -- evidence-based, never a document-wide default */
/* ------------------------------------------------------------------ */

/** Appropriation-code suffix/exact-code -> component. Exact codes checked first (Army/Navy/AF/SF share no ambiguity; a 'D' suffix is Defense-Wide-or-more-specific and resolved further by heading). */
const APPROPRIATION_CODE_COMPONENT: Readonly<Record<string, BudgetComponentV1>> = {
  '2040A': 'ARMY',
  '1319N': 'NAVY',
  '4557N': 'NAVY',
  '3600F': 'AF',
  '3620F': 'SF',
};

/** Organization heading (the line immediately after "UNCLASSIFIED") -> component, for headings this contract has a specific enum value for. Every other Defense-Wide-appropriated heading resolves to DW, evidenced by the appropriation line's own 'D'-suffixed code -- never guessed, never defaulted to a service branch. */
const HEADING_COMPONENT: Readonly<Record<string, BudgetComponentV1>> = {
  'Department of the Army': 'ARMY',
  'Department of the Navy': 'NAVY',
  'Department of the Air Force': 'AF',
  'Defense-Wide': 'DW',
  'Defense Advanced Research Projects Agency': 'DARPA',
  'Defense Health Agency': 'DHA',
  'Missile Defense Agency': 'MDA',
  'U.S., Special Operations Command': 'SOCOM',
};

export function resolveComponent(input: {
  headingLine: string | undefined;
  appropriationLine: string | undefined;
}): { component: BudgetComponentV1; evidence: string } {
  const appropriationMatch = input.appropriationLine?.match(/^Appropriation:\s*(\S+)/);
  const appropriationCode = appropriationMatch?.[1];
  if (appropriationCode && APPROPRIATION_CODE_COMPONENT[appropriationCode]) {
    return {
      component: APPROPRIATION_CODE_COMPONENT[appropriationCode]!,
      evidence: `appropriation code ${appropriationCode} (${input.appropriationLine})`,
    };
  }
  if (input.headingLine && HEADING_COMPONENT[input.headingLine]) {
    return { component: HEADING_COMPONENT[input.headingLine]!, evidence: `organization heading "${input.headingLine}"` };
  }
  // A 'D'-suffixed appropriation code is well-evidenced as Defense-Wide even
  // when the specific office/agency heading has no dedicated enum value
  // (e.g. "Secretary of Defense", "Chemical and Biological Defense
  // Program", "Defense Logistics Agency") -- this is not a default, it is
  // read directly off the appropriation line's own text.
  if (appropriationCode?.endsWith('D')) {
    return { component: 'DW', evidence: `appropriation code ${appropriationCode} ends in 'D' (Defense-Wide) (${input.appropriationLine})` };
  }
  return {
    component: 'UNKNOWN',
    evidence: `no appropriation code or recognized organization heading found (heading="${input.headingLine ?? 'none'}", appropriation="${input.appropriationLine ?? 'none'}")`,
  };
}

/* ------------------------------------------------------------------ */
/* Per-line row reconstruction                                         */
/* ------------------------------------------------------------------ */

export interface ReconstructedRowV1 {
  lineNumber: string;
  peCode: string;
  title: string;
  budgetActivity: string;
  category: string;
  /** Present only when the 4/5-column identity check passed; absent (not fabricated) otherwise. */
  moneyByRole: Partial<Record<'fyMinus2Actual' | 'fyMinus1Enacted' | 'fyMinus1Supplemental' | 'fyMinus1TotalEnacted' | 'fyRequest', string>> | null;
  moneyOmissionReason: string | null;
}

export function reconstructR1RowFromLine(line: string): ReconstructedRowV1 | null {
  const match = DATA_ROW_RE.exec(line);
  if (!match) return null;
  const [, lineNumber, peCodeRaw, rest] = match;
  const peCode = peCodeRaw!;
  if (!isValidPeCode(peCode)) return null;

  const tokens = rest!.split(/\s+/).filter((t) => t.length > 0);

  // Consume the trailing run of money/dash tokens first (unambiguous:
  // comma-grouped numerics or a lone dash), whatever its length.
  let moneyEnd = tokens.length;
  let moneyStart = moneyEnd;
  while (moneyStart > 0 && isMoneyOrDashToken(tokens[moneyStart - 1]!)) moneyStart--;
  const moneyTokens = tokens.slice(moneyStart, moneyEnd);

  // Immediately before the money run: budget activity + category, e.g. "01 U".
  const preMoney = tokens.slice(0, moneyStart);
  if (preMoney.length < 3) return null; // not even room for a 2-word title + BA + category
  const baCategoryText = preMoney.slice(-2).join(' ');
  const baCategoryMatch = BA_CATEGORY_RE.exec(baCategoryText);
  if (!baCategoryMatch) return null; // budget-activity/category anchor not found -- cannot trust the split
  const [, budgetActivity, category] = baCategoryMatch;
  const title = preMoney.slice(0, -2).join(' ').trim();
  if (title.length === 0) return null;

  let moneyByRole: ReconstructedRowV1['moneyByRole'] = null;
  let moneyOmissionReason: string | null = null;

  if (moneyTokens.length === 5) {
    moneyByRole = {
      fyMinus2Actual: moneyTokens[0],
      fyMinus1Enacted: moneyTokens[1],
      fyMinus1Supplemental: moneyTokens[2],
      fyMinus1TotalEnacted: moneyTokens[3],
      fyRequest: moneyTokens[4],
    };
  } else if (moneyTokens.length === 4) {
    const enacted = parseMoneyToken(moneyTokens[1]!);
    const totalEnacted = parseMoneyToken(moneyTokens[2]!);
    if (Math.abs(enacted - totalEnacted) < 0.005) {
      // Proven collapse: supplemental was zero and its column was omitted
      // from the rendered text. Backfilling '0' here is a derived,
      // mathematically forced value (enacted + 0 = total_enacted), not a
      // guess -- it never touches the request figure.
      moneyByRole = {
        fyMinus2Actual: moneyTokens[0],
        fyMinus1Enacted: moneyTokens[1],
        fyMinus1Supplemental: '0',
        fyMinus1TotalEnacted: moneyTokens[2],
        fyRequest: moneyTokens[3],
      };
    } else {
      moneyOmissionReason =
        `4 trailing numeric tokens but Enacted (${moneyTokens[1]}) != Total Enacted (${moneyTokens[2]}) -- ` +
        `the proven zero-supplemental collapse identity does not hold, so column alignment for this row is not trustworthy`;
    }
  } else {
    moneyOmissionReason = `${moneyTokens.length} trailing numeric tokens (need 4 or 5 for a confident column mapping) -- ambiguous, not guessed`;
  }

  return {
    lineNumber: lineNumber!,
    peCode,
    title,
    budgetActivity: budgetActivity!,
    category: category!,
    moneyByRole,
    moneyOmissionReason,
  };
}

/* ------------------------------------------------------------------ */
/* Per-page reconstruction                                             */
/* ------------------------------------------------------------------ */

function reconstructR1PageTable(
  page: ParserPageResultV1,
  omissions: R1TextReconstructionOmissionV1[],
): R1ReconstructedPageV1 | null {
  if (page.tables.length > 0) return null; // structural tables already present -- nothing to reconstruct
  const text = page.text ?? '';
  if (!CANONICAL_STAGE_HEADER_RE.test(text)) return null; // no recognizable R-1 header on this page at all

  const lines = text.split('\n');
  const headingLine = lines[1]?.trim(); // consistently the 2nd physical line, right after "UNCLASSIFIED"
  const appropriationLine = lines.find((l) => l.trim().startsWith('Appropriation:'))?.trim();
  const { component, evidence } = resolveComponent({ headingLine, appropriationLine });

  const unitMatch = UNIT_RE.exec(text);
  const unitLabel = unitMatch ? `$ in ${unitMatch[1]}` : '$ in Thousands';

  const lineBbox = (blockText: string): BoundingBoxV1 | undefined =>
    page.blocks.find((b) => b.text.trim() === blockText.trim())?.boundingBox;

  const cells: ParsedTableCellV1[] = [];
  const rowContextByRowIndex = new Map<number, R1RowContextV1>();
  let rowIndex = 1; // row 0 reserved for the synthesized header
  let dataRowCount = 0;
  let confidentFundingRowCount = 0;

  // Row 0: one synthesized header row. Column text is written so the
  // EXISTING, unmodified normalizeRdteHeader/classifyRdteColumn correctly
  // derive stageLabel/fiscalLabelKind from it -- this module never assigns
  // a role directly.
  const cycleFyPlaceholder = ''; // filled in by caller via a second pass -- see reconstructR1TablesFromTextV1
  void cycleFyPlaceholder;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const row = reconstructR1RowFromLine(line);
    if (!row) continue;
    dataRowCount++;
    const bbox = lineBbox(line);

    const pushCell = (columnIndex: number, cellText: string) => {
      cells.push({
        rowIndex,
        columnIndex,
        text: cellText,
        ...(bbox ? { boundingBox: bbox } : {}),
        confidence: R1_TEXT_RECONSTRUCTION_CONFIDENCE_MARKER,
      });
    };
    // Line number, budget activity, and category are recovered onto `row`
    // for validation/provenance (see reconstructR1RowFromLine) but have no
    // slot in the existing extractor's cells[0]=PE/cells[1]=title contract
    // -- emitting them as cells would just become spurious
    // unresolved_column_role/invalid_number omissions downstream. They are
    // instead preserved via `rowContextByRowIndex`, a parallel side channel
    // (see `R1RowContextV1`).
    rowContextByRowIndex.set(rowIndex, {
      lineNumber: row.lineNumber,
      budgetActivity: row.budgetActivity,
      budgetActivityCategory: row.category,
      sectionHeading: headingLine ?? '',
      component,
      componentEvidence: evidence,
      ...(appropriationLine != null ? { appropriation: appropriationLine } : {}),
    });
    pushCell(R1_RECONSTRUCTED_COLUMNS.peCode, row.peCode);
    pushCell(R1_RECONSTRUCTED_COLUMNS.title, row.title);

    if (row.moneyByRole) {
      confidentFundingRowCount++;
      // Only 3 columns emitted -- see the R1TextReconstructionOmissionV1
      // doc comment above for why pre-adjustment Enacted and the
      // Supplemental delta are deliberately never turned into cells.
      if (row.moneyByRole.fyMinus2Actual != null) pushCell(R1_RECONSTRUCTED_COLUMNS.fyMinus2Actual, row.moneyByRole.fyMinus2Actual);
      if (row.moneyByRole.fyMinus1TotalEnacted != null) pushCell(R1_RECONSTRUCTED_COLUMNS.fyMinus1TotalEnacted, row.moneyByRole.fyMinus1TotalEnacted);
      if (row.moneyByRole.fyRequest != null) pushCell(R1_RECONSTRUCTED_COLUMNS.fyRequest, row.moneyByRole.fyRequest);
    } else {
      omissions.push({
        page: page.page,
        peCode: row.peCode,
        reason: row.moneyOmissionReason ?? 'funding columns could not be confidently mapped',
        rawLine: line,
      });
    }
    rowIndex++;
  }

  if (dataRowCount === 0) return null;

  // Header row cells last, using the SAME 5-column scheme the existing
  // extractor expects (PE code + title + 5 money columns; text chosen so
  // the existing classifier resolves each role correctly, verified in this
  // module's own spec against the real classifyRdteColumn/normalizeRdteHeader).
  const headerCells: ParsedTableCellV1[] = [
    { rowIndex: 0, columnIndex: R1_RECONSTRUCTED_COLUMNS.peCode, text: 'Program Element Number' },
    { rowIndex: 0, columnIndex: R1_RECONSTRUCTED_COLUMNS.title, text: 'Item' },
  ];
  cells.unshift(...headerCells);

  const table: ParsedTableV1 = {
    tableIndex: 0,
    rowCount: rowIndex,
    columnCount: 5,
    cells,
    parserReportAccuracy: R1_TEXT_RECONSTRUCTION_CONFIDENCE_MARKER,
    warnings: [`reconstructed from flattened text; unit=${unitLabel}; component_evidence=${evidence}`],
  };

  return {
    page: page.page,
    printedPage: page.printedPage ?? undefined,
    table,
    component,
    componentEvidence: evidence,
    sectionHeading: headingLine ?? '',
    dataRowCount,
    confidentFundingRowCount,
    rowContextByRowIndex,
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                        */
/* ------------------------------------------------------------------ */

/**
 * Integration seam for `rdte-phase3-semantic-artifact-factory-v1.ts`'s R-1
 * branch: returns pages with `tables` backfilled ONLY where pdfplumber
 * found none and this module could recognize a canonical R-1 header +
 * data rows, plus this module's own omissions in the exact shape
 * `R1ExtractionOmission` already uses (`rawText`, not `rawLine`) so they
 * can be concatenated onto `extractR1FromPages`'s own omissions list
 * without any shape translation at the call site. A page this module
 * cannot reconstruct (no recognizable header, or already has real
 * structural tables) passes through completely unchanged -- this seam
 * never removes or degrades anything `extractR1FromPages` could already do
 * on its own.
 */
export function applyR1TextReconstructionV1(
  pages: readonly ParserPageResultV1[],
  cycleFiscalYear: number,
): {
  pages: ParserPageResultV1[];
  omissions: Array<{ peCode?: string; page: number; reason: string; rawText: string }>;
  /**
   * Row context keyed by physical page, then by the same `rowIndex` used in
   * that page's `table.cells` -- an R-1-only side channel (see
   * `R1RowContextV1`) carrying budget-activity/section-heading/component
   * context that has no slot in the shared `ParsedTableV1` cell grid.
   */
  rowContextByPage: Map<number, Map<number, R1RowContextV1>>;
} {
  const { pages: reconstructed, omissions } = reconstructR1TablesFromTextV1(pages, cycleFiscalYear);
  const byPage = new Map(reconstructed.map((r) => [r.page, r.table]));
  const rowContextByPage = new Map(reconstructed.map((r) => [r.page, r.rowContextByRowIndex]));
  const outPages = pages.map((page) => {
    const table = byPage.get(page.page);
    return table ? { ...page, tables: [table] } : page;
  });
  return {
    pages: outPages,
    omissions: omissions.map((o) => ({ peCode: o.peCode, page: o.page, reason: o.reason, rawText: o.rawLine })),
    rowContextByPage,
  };
}

export function reconstructR1TablesFromTextV1(
  pages: readonly ParserPageResultV1[],
  cycleFiscalYear: number,
): R1TextReconstructionResultV1 {
  const omissions: R1TextReconstructionOmissionV1[] = [];
  const reconstructed: R1ReconstructedPageV1[] = [];
  for (const page of pages) {
    const result = reconstructR1PageTable(page, omissions);
    if (result) {
      // Header column labels are finalized here (need cycleFiscalYear,
      // which reconstructR1PageTable does not receive, to keep that
      // function's own signature free of a parameter it would otherwise
      // thread through unused for every non-FY cell).
      const fyCells: ParsedTableCellV1[] = [
        { rowIndex: 0, columnIndex: R1_RECONSTRUCTED_COLUMNS.fyMinus2Actual, text: `FY ${cycleFiscalYear - 2} Actuals` },
        { rowIndex: 0, columnIndex: R1_RECONSTRUCTED_COLUMNS.fyMinus1TotalEnacted, text: `FY ${cycleFiscalYear - 1} Enacted` },
        { rowIndex: 0, columnIndex: R1_RECONSTRUCTED_COLUMNS.fyRequest, text: `FY ${cycleFiscalYear} Request` },
      ];
      result.table.cells.push(...fyCells);
      reconstructed.push(result);
    }
  }
  return { pages: reconstructed, omissions };
}

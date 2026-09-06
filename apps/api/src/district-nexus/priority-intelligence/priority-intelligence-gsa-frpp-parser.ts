/**
 * District Nexus Release 4 — GSA FRPP public-dataset parser (pure).
 *
 * Source: GSA Federal Real Property Profile public data set
 * (https://www.gsa.gov/.../federal-real-property-public-data-set), distributed
 * via inventory.data.gov as an XLSX ("FYxx FRPP Public Dataset"). FY2024
 * verified shape: single sheet, 117 columns, 307,919 data rows, detailed
 * CIVILIAN assets only (DoD excluded under FASTA and published separately as
 * summarized installation rows).
 *
 * Parser rules:
 *  - Column identity is by HEADER NAME (not position) so a re-publication with
 *    reordered columns still parses; unknown/renamed required columns are a
 *    rejection with reason, never a guess.
 *  - A blank cell means "not applicable or redacted" (GSA FAQ) → null. Blank is
 *    never converted to zero.
 *  - Congressional District, State, Latitude/Longitude are taken verbatim;
 *    boundary Congress is NOT present in the dataset → null (visible, honest).
 *  - Square feet only when the source supplies it.
 */

export interface FrppRawRow {
  rpUid: string;
  reportingAgency: string;
  reportingAgencyCode: string | null;
  usingAgency: string | null;
  bureau: string | null;
  installationName: string | null;
  installationId: string | null;
  grain: 'detailed_asset' | 'summarized_installation';
  isDefense: boolean;
  usOrForeign: string;
  countryName: string | null;
  stateCode: string | null;
  stateName: string | null;
  countyName: string | null;
  cityName: string | null;
  zipCode: string | null;
  streetAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  geographyBasis: 'source_coordinates' | 'source_state_only' | 'unresolved';
  legalInterest: string | null;
  realPropertyType: string | null;
  realPropertyUse: string | null;
  utilization: string | null;
  assetStatus: string | null;
  assetStatusCode: string | null;
  historicalStatus: string | null;
  squareFeet: number | null;
  squareFeetUom: string | null;
  congressionalDistrict: string | null;
  boundaryCongress: number | null;
  congressSession: number | null;
  leaseExpirationDate: Date | null;
  leaseStartDate: Date | null;
  annualRentUsd: number | null;
  federalEmployeesCount: number | null;
  federalContractorsCount: number | null;
}

export interface FrppParseRejection {
  rowNumber: number;
  reason: string;
}

export interface FrppParseResult {
  rows: FrppRawRow[];
  rejections: FrppParseRejection[];
  warnings: string[];
  /** Header names the parser requires; reported when missing. */
  missingRequiredColumns: string[];
}

/** Exact FY24 public-dataset header names (verified 2026-09-02). */
export const FRPP_REQUIRED_COLUMNS = [
  'Real Property Unique Identifier',
  'Reporting Agency',
  'US/Foreign',
  'Legal Interest Indicator',
  'Real Property Type',
  'Real Property Use',
  'Asset Status',
  'FiscalYear',
] as const;

const OPTIONAL_COLUMN_ALIASES: Record<string, string[]> = {
  'Reporting Agency Code': ['Reporting Agency Code'],
  'Using Agency': ['Using Agency'],
  'Using Bureau': ['Using Bureau'],
  'Installation Name': ['Installation Name'],
  'Installation Id': ['Installation Id'],
  'State Code': ['State Code'],
  'State Name': ['State Name'],
  'County Name': ['County Name'],
  'City Name': ['City Name'],
  'Zip Code': ['Zip Code'],
  'Street Address': ['Street Address'],
  Latitude: ['Latitude'],
  Longitude: ['Longitude'],
  'Asset Status Code': ['Asset Status Code'],
  'Historical Status': ['Historical Status'],
  'Square Feet (Buildings)': ['Square Feet (Buildings)'],
  'Square Feet Unit of Measure': ['Square Feet Unit of Measure'],
  'Congressional District': ['Congressional District'],
  'Lease Expiration Date': ['Lease Expiration Date'],
  'Lease Start Date': ['Lease Start Date'],
  'Lease Annual Rent to Lessor': ['Lease Annual Rent to Lessor'],
  'Number of Federal Employees': ['Number of Federal Employees'],
  'Number of Federal Contractors': ['Number of Federal Contractors'],
  'Country Name': ['Country Name'],
  Utilization: ['Utilization'],
};

/** Defense-ish reporting agencies — used to label rows from any DoD-source file. */
const DEFENSE_AGENCY_PATTERNS = [
  /department of defense/i,
  /\barmy\b/i,
  /\bnavy\b/i,
  /air force/i,
  /space force/i,
  /marine corps/i,
  /national guard bureau/i,
  /defense (logistics|health|threat|advanced|information|contract)/i,
  /army corps of engineers/i,
];

function isDefenseAgency(reportingAgency: string): boolean {
  return DEFENSE_AGENCY_PATTERNS.some((p) => p.test(reportingAgency));
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** Hard ceiling for varchar columns — never invent content, just refuse overflow. */
function truncateTo(value: string | null, max: number): string | null {
  if (value == null) return null;
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * A single FRPP asset may list multiple congressional districts (e.g.
 * "46,47,48,49"). That is not a single district key — store NULL rather than
 * inventing one or overflowing the column. Accept only a single integer-ish
 * district token (1–2 digits, optional leading zeros) or a 2-letter at-large.
 */
export function normalizeCongressionalDistrict(value: string | null): string | null {
  if (value == null) return null;
  const raw = value.trim();
  if (!raw) return null;
  // Multi-district or free text → unresolved
  if (/[,\s;/|]/.test(raw)) return null;
  if (/^\d{1,2}$/.test(raw)) return String(Number(raw)); // strip leading zeros
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  // Anything else (e.g. "AL-02", "District 5") is not a clean key
  return null;
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function excelDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  // Excel serial dates (1900 epoch) arrive as numbers when cells are date-typed.
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Parse ONE worksheet row against the current header context. Mutates `ctx`:
 * the first non-empty row establishes the header (by NAME); subsequent rows are
 * parsed or rejected. Returns the parsed row, or null for header/rejected rows.
 *
 * Split out of parseFrppWorksheet so the runner can feed the ExcelJS STREAMING
 * reader row by row — the FY24 authoritative workbook (145 MB XLSX, 307,919
 * rows × 117 columns) exceeds ExcelJS's buffered readFile (jszip aborts with
 * RangeError: Invalid string length), so buffering the whole sheet is not
 * viable on the real source.
 */
export interface FrppParseContext {
  headerRow: string[] | null;
  colIndex: Record<string, number>;
  missing: string[];
  sawFiscalYear: number | null;
  rows: FrppRawRow[];
  rejections: FrppParseRejection[];
  warnings: string[];
}

export function createFrppParseContext(): FrppParseContext {
  return {
    headerRow: null,
    colIndex: {},
    missing: [],
    sawFiscalYear: null,
    rows: [],
    rejections: [],
    warnings: [],
  };
}

export function parseFrppRow(
  ctx: FrppParseContext,
  rowNumber: number,
  values: unknown[],
  expectedFiscalYear: number | null,
): FrppRawRow | null {
  if (ctx.headerRow == null) {
    ctx.headerRow = values.map((v) => (v == null ? '' : String(v).trim()));
    ctx.colIndex = {};
    ctx.headerRow.forEach((name, i) => {
      if (name) ctx.colIndex[name] = i;
    });
    ctx.missing = FRPP_REQUIRED_COLUMNS.filter((c) => ctx.colIndex[c] == null);
    if (ctx.missing.length) {
      ctx.rejections.push({
        rowNumber,
        reason: `header missing required columns: ${ctx.missing.join(', ')}`,
      });
      ctx.headerRow = null; // keep scanning for a valid header
    }
    return null;
  }

  const get = (name: string): unknown => {
    const idx = ctx.colIndex[name];
    return idx == null ? undefined : values[idx];
  };

  const rpUid = text(get('Real Property Unique Identifier'));
  const reportingAgency = text(get('Reporting Agency'));
  if (!rpUid || !reportingAgency) {
    ctx.rejections.push({
      rowNumber,
      reason: 'missing Real Property Unique Identifier or Reporting Agency',
    });
    return null;
  }

  const fiscalYear = num(get('FiscalYear'));
  if (fiscalYear == null) {
    ctx.rejections.push({ rowNumber, reason: 'missing FiscalYear' });
    return null;
  }
  if (expectedFiscalYear != null && fiscalYear !== expectedFiscalYear) {
    ctx.rejections.push({
      rowNumber,
      reason: `FiscalYear ${fiscalYear} does not match expected ${expectedFiscalYear}`,
    });
    return null;
  }
  if (ctx.sawFiscalYear == null) ctx.sawFiscalYear = fiscalYear;

  const stateCode = text(get('State Code'));
  const latitude = num(get('Latitude'));
  const longitude = num(get('Longitude'));
  const usOrForeign = text(get('US/Foreign')) ?? '';
  const isForeign = /foreign/i.test(usOrForeign) && !(stateCode && stateCode.length === 2);
  // Multi-district values (e.g. "46,47,48,49") are not a single district key —
  // store NULL rather than inventing one or overflowing varchar(8/32).
  const congressionalDistrict = normalizeCongressionalDistrict(
    text(get('Congressional District')),
  );
  // FY24 source uses "Rentable Square Feet" (20 chars) > original varchar(16).
  const squareFeetUom = truncateTo(text(get('Square Feet Unit of Measure')), 32);

  const geographyBasis: FrppRawRow['geographyBasis'] = isForeign
    ? 'unresolved'
    : latitude != null && longitude != null
      ? 'source_coordinates'
      : stateCode
        ? 'source_state_only'
        : 'unresolved';

  const row: FrppRawRow = {
    rpUid,
    reportingAgency,
    reportingAgencyCode: truncateTo(text(get('Reporting Agency Code')), 8),
    usingAgency: text(get('Using Agency')),
    bureau: text(get('Using Bureau')),
    installationName: text(get('Installation Name')),
    installationId: truncateTo(text(get('Installation Id')), 64),
    // The detailed public dataset contains asset-grain rows. Summarized
    // installation rows only appear in the separate DoD dataset, which the
    // runner labels grain='summarized_installation' at ingest.
    grain: 'detailed_asset',
    isDefense: isDefenseAgency(reportingAgency),
    usOrForeign: truncateTo(usOrForeign || 'UNKNOWN', 24) ?? 'UNKNOWN',
    countryName: text(get('Country Name')),
    stateCode: truncateTo(stateCode, 8),
    stateName: text(get('State Name')),
    countyName: text(get('County Name')),
    cityName: text(get('City Name')),
    zipCode: truncateTo(text(get('Zip Code')), 16),
    streetAddress: text(get('Street Address')),
    latitude: isForeign ? null : latitude,
    longitude: isForeign ? null : longitude,
    geographyBasis,
    legalInterest: truncateTo(text(get('Legal Interest Indicator')), 24),
    realPropertyType: text(get('Real Property Type')),
    realPropertyUse: text(get('Real Property Use')),
    utilization: text(get('Utilization')),
    assetStatus: text(get('Asset Status')),
    assetStatusCode: truncateTo(text(get('Asset Status Code')), 8),
    historicalStatus: text(get('Historical Status')),
    squareFeet: num(get('Square Feet (Buildings)')),
    squareFeetUom,
    congressionalDistrict: isForeign ? null : congressionalDistrict,
    // The public dataset does NOT publish a boundary Congress for its district
    // column. Leave null — visible unknown, never inferred.
    boundaryCongress: null,
    congressSession: null,
    leaseExpirationDate: excelDate(get('Lease Expiration Date')),
    leaseStartDate: excelDate(get('Lease Start Date')),
    annualRentUsd: num(get('Lease Annual Rent to Lessor')),
    federalEmployeesCount: num(get('Number of Federal Employees')),
    federalContractorsCount: num(get('Number of Federal Contractors')),
  };
  ctx.rows.push(row);
  return row;
}

/** Parse one ExcelJS worksheet (first sheet) of the FRPP public dataset. */
export function parseFrppWorksheet(
  worksheet: {
    eachRow: (
      opts: { includeEmpty: boolean },
      cb: (row: number, row_2: { values: unknown[] }) => void,
    ) => void;
  },
  expectedFiscalYear: number | null,
): FrppParseResult {
  const ctx = createFrppParseContext();
  worksheet.eachRow({ includeEmpty: false }, (rowNumber, row) => {
    const values = (row.values ?? []) as unknown[];
    parseFrppRow(ctx, rowNumber, values, expectedFiscalYear);
  });
  finalizeFrppParse(ctx, expectedFiscalYear);
  return {
    rows: ctx.rows,
    rejections: ctx.rejections,
    warnings: ctx.warnings,
    missingRequiredColumns: ctx.missing,
  };
}

/** Shared end-of-parse warning pass for both buffered and streaming paths. */
export function finalizeFrppParse(ctx: FrppParseContext, expectedFiscalYear: number | null): void {
  if (ctx.headerRow == null) {
    ctx.warnings.push('No valid header row found; no rows parsed.');
  }
  if (
    expectedFiscalYear != null &&
    ctx.sawFiscalYear != null &&
    ctx.sawFiscalYear !== expectedFiscalYear
  ) {
    ctx.warnings.push(
      `Workbook fiscal year ${ctx.sawFiscalYear} differs from expected ${expectedFiscalYear}`,
    );
  }
}

/**
 * Deterministic per-row source hash preimage. The upsert service SHA-256s this
 * canonical JSON: (sourceDocumentSha256, rpUid, fiscalYear, boundaryCongress,
 * assetStatusCode) — matching the migration's identity contract.
 */
export interface FrppIdentityInput {
  sourceDocumentSha256: string;
  rpUid: string;
  fiscalYear: number;
  boundaryCongress: number | null;
  assetStatusCode: string | null;
}

export function frppIdentityPreimage(input: FrppIdentityInput): string {
  return JSON.stringify({
    sourceDocumentSha256: input.sourceDocumentSha256,
    rpUid: input.rpUid,
    fiscalYear: input.fiscalYear,
    boundaryCongress: input.boundaryCongress,
    assetStatusCode: input.assetStatusCode,
  });
}

export { DEFENSE_AGENCY_PATTERNS };

import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { parseCsvRecords } from './district-nexus-csv.js';
import type {
  FootprintEvidenceType,
  FootprintImportPreviewRequest,
  FootprintImportRowInput,
  FootprintPreviewEvidence,
} from './district-nexus-economic.types.js';

export const MAX_FOOTPRINT_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_FOOTPRINT_IMPORT_ROWS = 500;

const EVIDENCE_TYPES = new Set<FootprintEvidenceType>([
  'facility',
  'employee',
  'payroll',
  'capital_investment',
  'taxes',
  'supplier',
  'supplier_spend',
  'partner',
  'beneficiary',
  'beneficiary_count',
  'project_site',
  'other',
]);

const HEADER_ALIASES: Record<string, keyof FootprintImportRowInput> = {
  type: 'evidenceType',
  evidence_type: 'evidenceType',
  evidence: 'evidenceType',
  name: 'name',
  subject: 'subjectName',
  subject_name: 'subjectName',
  subject_id: 'subjectId',
  facility: 'facilityName',
  facility_name: 'facilityName',
  supplier: 'supplierName',
  supplier_name: 'supplierName',
  partner: 'partnerName',
  partner_name: 'partnerName',
  project: 'projectName',
  project_name: 'projectName',
  address: 'addressLine1',
  address_1: 'addressLine1',
  address_line_1: 'addressLine1',
  address_line1: 'addressLine1',
  address_2: 'addressLine2',
  address_line_2: 'addressLine2',
  address_line2: 'addressLine2',
  city: 'city',
  state: 'state',
  zip: 'postalCode',
  zipcode: 'postalCode',
  postal_code: 'postalCode',
  country: 'country',
  district: 'congressionalDistrict',
  congressional_district: 'congressionalDistrict',
  employees: 'employeeCount',
  employee_count: 'employeeCount',
  payroll: 'payroll',
  annual_payroll: 'payroll',
  capital_investment: 'capitalInvestment',
  investment: 'capitalInvestment',
  taxes: 'taxes',
  taxes_paid: 'taxes',
  supplier_spend: 'supplierSpend',
  vendor_spend: 'supplierSpend',
  beneficiary_count: 'beneficiaryCount',
  numeric_value: 'numericValue',
  value: 'numericValue',
  unit: 'unit',
  currency: 'currency',
  effective_date: 'effectiveFrom',
  effective_from: 'effectiveFrom',
  effective_to: 'effectiveTo',
  observed_at: 'observedAt',
  notes: 'notes',
  note: 'notes',
};

export interface ParsedFootprintImport {
  rows: FootprintImportRowInput[];
  contentSha256: string | null;
  warnings: string[];
}

export interface ExpandedFootprintEvidence extends Omit<FootprintPreviewEvidence, 'geography'> {
  geography: FootprintPreviewEvidence['geography'];
}

interface ParsedGeography {
  state: string | null;
  district: string | null;
  warnings: string[];
}

function normalizeHeader(input: unknown): string {
  return String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cleanString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function parseMoneyLike(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = String(value)
    .trim()
    .replace(/[,$\s]/g, '')
    .replace(/^\((.*)\)$/, '-$1');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate(value: unknown): string | null {
  const text = cleanString(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function normalizeTimestamp(value: unknown): string | null {
  const text = cleanString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeStateToken(value: unknown): string | null {
  const state = cleanString(value)?.toUpperCase() ?? null;
  return state && /^[A-Z]{2}$/.test(state) ? state : null;
}

function normalizeDistrictToken(value: string): string | null {
  if (value === 'AL') return '00';
  if (!/^\d{1,2}$/.test(value)) return null;
  const numeric = Number(value);
  // 90/98/99 are source sentinels, not a single congressional district.
  if (!Number.isInteger(numeric) || numeric < 0 || numeric >= 90) return null;
  return String(numeric).padStart(2, '0');
}

/**
 * Parse state and district as one atomic geography. This prevents a district
 * prefix from one state being silently combined with a separate state column
 * from another (for example state=VA + district=TX-10 becoming VA-10).
 */
export function parseCongressionalGeography(
  stateInput: unknown,
  districtInput: unknown,
): ParsedGeography {
  const warnings: string[] = [];
  const rawState = cleanString(stateInput)?.toUpperCase() ?? null;
  let state = normalizeStateToken(rawState);
  if (rawState && !state) warnings.push('State must be a two-letter US code.');

  const rawDistrict = cleanString(districtInput)?.toUpperCase() ?? null;
  if (!rawDistrict) return { state, district: null, warnings };

  const qualified = /^([A-Z]{2})-(\d{1,2}|AL)$/.exec(rawDistrict);
  const bare = /^(\d{1,2}|AL)$/.exec(rawDistrict);
  if (!qualified && !bare) {
    warnings.push('Congressional district was not recognized.');
    return { state, district: null, warnings };
  }

  const districtState = qualified?.[1] ?? null;
  const district = normalizeDistrictToken((qualified?.[2] ?? bare?.[1])!);
  if (!district) {
    warnings.push('Congressional district was not recognized as a resolvable district.');
    return { state, district: null, warnings };
  }

  if (districtState) {
    if (state && state !== districtState) {
      warnings.push(
        `District state prefix ${districtState} does not match supplied state ${state}; requires review.`,
      );
      return { state, district: null, warnings };
    }
    state = districtState;
  }

  if (!state) {
    warnings.push('A state is required when the district is not state-qualified.');
    return { state: null, district: null, warnings };
  }

  return { state, district, warnings };
}

function mapRecord(
  record: Record<string, unknown>,
  columnMap: Record<string, string> | undefined,
): FootprintImportRowInput {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(record)) {
    const normalized = normalizeHeader(rawKey);
    const mapped = columnMap?.[rawKey] ?? columnMap?.[normalized] ?? HEADER_ALIASES[normalized];
    if (!mapped) continue;
    out[mapped] = value;
  }
  return out as FootprintImportRowInput;
}

async function xlsxRows(buffer: Buffer): Promise<Record<string, unknown>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = String(cell.text ?? '').trim();
  });
  const rows: Record<string, unknown>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: Record<string, unknown> = {};
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const header = headers[col];
      if (!header) return;
      record[header] = cell.value instanceof Date ? cell.value.toISOString() : cell.text;
    });
    if (Object.values(record).some((value) => cleanString(value))) rows.push(record);
  });
  return rows;
}

export async function parseFootprintImport(
  request: FootprintImportPreviewRequest,
): Promise<ParsedFootprintImport> {
  const filename = cleanString(request.filename);
  if (!filename) throw new Error('filename is required');
  if (!['csv', 'xlsx', 'manual', 'meri_structured'].includes(request.format)) {
    throw new Error('Unsupported footprint import format');
  }

  let rows: FootprintImportRowInput[] = [];
  let contentSha256: string | null = null;
  const warnings: string[] = [];

  if (request.format === 'manual' || request.format === 'meri_structured') {
    if (!Array.isArray(request.rows)) throw new Error('rows are required for structured imports');
    rows = request.rows;
  } else {
    if (!request.contentBase64) throw new Error('contentBase64 is required for file imports');
    const buffer = Buffer.from(request.contentBase64, 'base64');
    if (!buffer.length) throw new Error('The imported file is empty');
    if (buffer.length > MAX_FOOTPRINT_IMPORT_BYTES) {
      throw new Error(`Footprint files are limited to ${MAX_FOOTPRINT_IMPORT_BYTES} bytes`);
    }
    contentSha256 = createHash('sha256').update(buffer).digest('hex');
    const rawRows = request.format === 'csv' ? parseCsvRecords(buffer) : await xlsxRows(buffer);
    rows = rawRows.map((row) => mapRecord(row, request.columnMap));
  }

  if (rows.length > MAX_FOOTPRINT_IMPORT_ROWS) {
    throw new Error(`Footprint imports are limited to ${MAX_FOOTPRINT_IMPORT_ROWS} rows`);
  }
  if (rows.length === 0) warnings.push('No non-empty rows were found.');
  return { rows, contentSha256, warnings };
}

function inferredSubject(row: FootprintImportRowInput): string | null {
  return (
    cleanString(row.subjectName) ??
    cleanString(row.facilityName) ??
    cleanString(row.supplierName) ??
    cleanString(row.partnerName) ??
    cleanString(row.projectName) ??
    cleanString(row.name)
  );
}

function canonicalType(input: unknown): FootprintEvidenceType | null {
  const normalized = normalizeHeader(input);
  if (!normalized) return null;
  const aliases: Record<string, FootprintEvidenceType> = {
    employees: 'employee',
    employee_count: 'employee',
    annual_payroll: 'payroll',
    investment: 'capital_investment',
    taxes_paid: 'taxes',
    vendor: 'supplier',
    vendor_spend: 'supplier_spend',
    project: 'project_site',
  };
  const type = (aliases[normalized] ?? normalized) as FootprintEvidenceType;
  return EVIDENCE_TYPES.has(type) ? type : null;
}

interface EvidenceValueSpec {
  type: FootprintEvidenceType;
  value: unknown;
  unit: string | null;
  currency: string | null;
  subjectName?: string | null;
}

function evidenceSpecs(row: FootprintImportRowInput): EvidenceValueSpec[] {
  const specs: EvidenceValueSpec[] = [];
  const explicitType = canonicalType(row.evidenceType);
  if (explicitType) {
    specs.push({
      type: explicitType,
      value: row.numericValue,
      unit: cleanString(row.unit),
      currency: cleanString(row.currency)?.toUpperCase() ?? null,
    });
  }
  if (row.facilityName || row.addressLine1) {
    specs.push({
      type: 'facility',
      value: null,
      unit: 'facility',
      currency: null,
      subjectName: row.facilityName,
    });
  }
  if (row.employeeCount != null && row.employeeCount !== '') {
    specs.push({ type: 'employee', value: row.employeeCount, unit: 'people', currency: null });
  }
  if (row.payroll != null && row.payroll !== '') {
    specs.push({ type: 'payroll', value: row.payroll, unit: 'USD', currency: 'USD' });
  }
  if (row.capitalInvestment != null && row.capitalInvestment !== '') {
    specs.push({
      type: 'capital_investment',
      value: row.capitalInvestment,
      unit: 'USD',
      currency: 'USD',
    });
  }
  if (row.taxes != null && row.taxes !== '') {
    specs.push({ type: 'taxes', value: row.taxes, unit: 'USD', currency: 'USD' });
  }
  if (row.supplierName) {
    specs.push({
      type: 'supplier',
      value: null,
      unit: 'supplier',
      currency: null,
      subjectName: row.supplierName,
    });
  }
  if (row.supplierSpend != null && row.supplierSpend !== '') {
    specs.push({
      type: 'supplier_spend',
      value: row.supplierSpend,
      unit: 'USD',
      currency: 'USD',
      subjectName: row.supplierName,
    });
  }
  if (row.partnerName) {
    specs.push({
      type: 'partner',
      value: null,
      unit: 'partner',
      currency: null,
      subjectName: row.partnerName,
    });
  }
  if (row.projectName) {
    specs.push({
      type: 'project_site',
      value: null,
      unit: 'project_site',
      currency: null,
      subjectName: row.projectName,
    });
  }
  if (row.beneficiaryCount != null && row.beneficiaryCount !== '') {
    specs.push({
      type: 'beneficiary_count',
      value: row.beneficiaryCount,
      unit: 'people',
      currency: null,
    });
  }

  const seen = new Set<string>();
  return specs.filter((spec) => {
    const key = `${spec.type}:${cleanString(spec.subjectName) ?? ''}:${String(spec.value ?? '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function expandFootprintRows(
  rows: FootprintImportRowInput[],
  options: { effectiveDate?: string | null; sourceType: 'client_import' | 'meri_structured' },
): FootprintPreviewEvidence[] {
  const evidence: FootprintPreviewEvidence[] = [];
  rows.forEach((row, index) => {
    const rowOrdinal = index + 1;
    const geography = parseCongressionalGeography(row.state, row.congressionalDistrict);
    const rowWarnings = [...geography.warnings];
    const addressLine1 = cleanString(row.addressLine1);
    const city = cleanString(row.city);
    const postalCode = cleanString(row.postalCode);
    const hasGeocodableAddress = Boolean(addressLine1 && city && geography.state);
    if (!geography.district && !hasGeocodableAddress) {
      rowWarnings.push('No district or complete geocodable address was supplied.');
    }

    const effectiveFrom = normalizeDate(row.effectiveFrom) ?? normalizeDate(options.effectiveDate);
    const effectiveTo = normalizeDate(row.effectiveTo);
    if (row.effectiveFrom && !normalizeDate(row.effectiveFrom)) {
      rowWarnings.push('effective_from is not a valid date; requires review.');
    }
    if (row.effectiveTo && !effectiveTo) {
      rowWarnings.push('effective_to is not a valid date; requires review.');
    }
    if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
      rowWarnings.push('effective_to precedes effective_from; requires review.');
    }
    const observedAt = normalizeTimestamp(row.observedAt);
    if (row.observedAt && !observedAt) {
      rowWarnings.push('observed_at is not a valid timestamp; requires review.');
    }

    const specs = evidenceSpecs(row);
    if (!specs.length) {
      specs.push({
        type: 'other',
        value: row.numericValue,
        unit: cleanString(row.unit),
        currency: cleanString(row.currency),
      });
      rowWarnings.push('The row did not identify a known footprint type; stored as other.');
    }

    for (const [specIndex, spec] of specs.entries()) {
      const numericValue = parseMoneyLike(spec.value);
      const valueRequired = [
        'employee',
        'payroll',
        'capital_investment',
        'taxes',
        'supplier_spend',
        'beneficiary_count',
      ].includes(spec.type);
      const warnings = [...rowWarnings];
      if (valueRequired && numericValue == null) warnings.push(`${spec.type} requires a numeric value.`);
      const subjectName = cleanString(spec.subjectName) ?? inferredSubject(row);
      evidence.push({
        previewId: `${rowOrdinal}:${specIndex + 1}:${spec.type}`,
        rowOrdinal,
        evidenceType: spec.type,
        subjectName,
        subjectId: cleanString(row.subjectId),
        address: {
          line1: addressLine1,
          line2: cleanString(row.addressLine2),
          city,
          state: geography.state,
          postalCode,
          country: cleanString(row.country)?.toUpperCase() ?? 'US',
        },
        geography: {
          state: geography.state,
          congressionalDistrict: geography.district,
          boundaryCongress: null,
          latitude: null,
          longitude: null,
          districtSource: geography.district ? 'provided' : 'unresolved',
        },
        numericValue,
        unit: spec.unit ?? cleanString(row.unit),
        currency: spec.currency ?? cleanString(row.currency)?.toUpperCase() ?? null,
        verificationStatus: 'user_provided',
        effectiveFrom,
        effectiveTo,
        observedAt,
        warnings,
        sourceRecordId: `row-${rowOrdinal}-${specIndex + 1}`,
        metadata: {
          ...(row.metadata ?? {}),
          ...(cleanString(row.notes) ? { notes: cleanString(row.notes) } : {}),
          importSource: options.sourceType,
        },
      });
    }
  });
  return evidence;
}

/**
 * procurement-account-reports.ts — USAspending /api/v2/awards/funding/ account report layer.
 *
 * Release 1 scope:
 *   - Fetch single-page (<=100 rows) account funding data for 1-25 explicit full award IDs.
 *   - Validate completeness: hasNext=true, wrong page, oversize, HTTP failure → refuse.
 *   - Preserve raw text + SHA256; never parse numbers through IEEE 754.
 *   - Closed writer: append via SQL function defproc_append_account_report_v1.
 *   - No retries; no aggregation; no inferred TAS/PE.
 *
 * Allowed to be imported by: enrich-award-pe-tas.ts (new mode), qualification fixture, tests.
 */

import { createHash } from 'node:crypto';
import { validateAwardEnrichmentIds } from './procurement-award-enrichment.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Source API POST endpoint — stays as the fetch URL constant. */
export const FUNDING_ENDPOINT = 'https://api.usaspending.gov/api/v2/awards/funding/';
/** Base URL for per-award USAspending browse links (distinct from fetch endpoint). */
export const SOURCE_AWARD_URL_BASE = 'https://www.usaspending.gov/award/';
export const MAX_AWARDS = 25;
export const MAX_BODY_BYTES = 1_048_576; // 1 MiB
export const DEFAULT_RESPONSE_MS = 30_000;
export const DEFAULT_OVERALL_MS = 120_000;

// ── sourceUrl helper ──────────────────────────────────────────────────────────

/**
 * Build the per-award USAspending browse URL for a CONT_AWD ID.
 * Returns https://www.usaspending.gov/award/<percent-encoded CONT_AWD ID>
 * This is distinct from FUNDING_ENDPOINT which is the source API POST URL.
 */
export function buildAwardSourceUrl(contAwardId: string): string {
  return `${SOURCE_AWARD_URL_BASE}${encodeURIComponent(contAwardId)}`;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface AccountFetchInput {
  /** Exact full CONT_AWD_… award ID (not a key). */
  awardUniqueId: string;
  responseMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface RawAccountPage {
  /** Exact UTF-8 text of the response body. */
  rawText: string;
  /** hex-encoded sha256 of rawText in UTF-8. */
  sha256: string;
  /** UTC instant captured after full body retrieval. */
  sourceObservedAt: string;
  /** Validated row count (matches results array length). */
  rowCount: number;
}

export type FetchAccountPageError =
  | 'HTTP_FAILURE'
  | 'REDIRECT_REFUSED'
  | 'RESPONSE_TIMEOUT'
  | 'BODY_OVERSIZE'
  | 'BODY_UNREADABLE'
  | 'PAGE_INCOMPLETE'     // hasNext=true
  | 'WRONG_PAGE'          // page_metadata.page !== 1
  | 'MALFORMED_RESPONSE'  // JSON parse failure or missing required structure
  | 'OVERSIZED_RESULT';   // results.length > 100

export interface FetchAccountPageResult {
  ok: true;
  page: RawAccountPage;
}
export interface FetchAccountPageFailure {
  ok: false;
  error: FetchAccountPageError;
  detail?: string;
}

export type AccountPageOutcome = FetchAccountPageResult | FetchAccountPageFailure;

// ── UTC clock ────────────────────────────────────────────────────────────────

/** Millisecond-precision wall clock, formatted with six fractional digits. */
export function nowUtc(): string {
  const ms = Date.now();
  const sec = Math.floor(ms / 1000);
  const us = (ms % 1000) * 1000; // truncate to ms; real microseconds unavailable in Node
  const d = new Date(sec * 1000);
  const iso = d.toISOString().slice(0, 19); // "YYYY-MM-DDTHH:MM:SS"
  const pad = String(us).padStart(6, '0');
  return `${iso}.${pad}Z`;
}

// ── Unforgeable numeric lexeme marker ────────────────────────────────────────

/**
 * Opaque internal class used as an unforgeable marker for numeric lexemes.
 * Source-supplied JSON cannot produce an instance of this class, unlike a plain {$numericLexeme:...}
 * object that any JSON payload can forge.
 */
class NumericLexeme {
  readonly lexeme: string;
  private constructor(lexeme: string) { this.lexeme = lexeme; }
  static create(lexeme: string): NumericLexeme { return new NumericLexeme(lexeme); }
  static isInstance(v: unknown): v is NumericLexeme { return v instanceof NumericLexeme; }
}

// ── Reviver for lossless number extraction ────────────────────────────────────

/**
 * JSON.parse reviver that replaces numeric values with unforgeable NumericLexeme instances
 * holding the original source lexeme. Uses Node 24 reviver context.source.
 * If context is absent (unsupported runtime), throws rather than falling back to IEEE 754.
 * Source-supplied JSON cannot forge a NumericLexeme instance.
 */
export function numericLexemeReviver(this: unknown, _key: string, value: unknown,
  context?: { source?: string }): unknown {
  if (typeof value === 'number') {
    if (!context || typeof context.source !== 'string') {
      throw new Error(
        'numericLexemeReviver: JSON.parse context.source not available on this runtime. ' +
        'Cannot safely extract numeric lexemes without IEEE 754 loss.',
      );
    }
    return NumericLexeme.create(context.source);
  }
  return value;
}

/** Extract a numeric lexeme from an unforgeable NumericLexeme instance. Returns null otherwise. */
export function extractNumericLexeme(value: unknown): string | null {
  if (NumericLexeme.isInstance(value)) return value.lexeme;
  return null;
}

// ── Nullable string validation ────────────────────────────────────────────────

/** Control character pattern: U+0000-001F and U+007F. */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

/** Max UTF-8 byte length for nullable source strings. */
const MAX_STR_UTF8_BYTES = 4096;

/**
 * Validate a nullable string source field.
 * - null/undefined → null (valid absence)
 * - string: reject if it contains control chars U+0000-001F/007F or exceeds 4096 UTF-8 bytes
 * - non-string → throw (field present but wrong type = malformed row)
 */
function validateNullableStr(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`Malformed row field ${field}: expected string or null, got ${typeof value}`);
  if (CONTROL_CHAR_RE.test(value)) throw new Error(`Malformed row field ${field}: contains control characters`);
  const byteLen = Buffer.byteLength(value, 'utf8');
  if (byteLen > MAX_STR_UTF8_BYTES) throw new Error(`Malformed row field ${field}: exceeds ${MAX_STR_UTF8_BYTES} UTF-8 bytes`);
  return value;
}

// ── Numeric validation ────────────────────────────────────────────────────────

/** Valid decimal lexeme: optional sign, 1-128 integer digits, optional fractional part up to 128 digits. No scientific notation. */
const DECIMAL_LEXEME_RE = /^-?[0-9]{1,128}(\.[0-9]{1,128})?$/;

/**
 * Validate a source money field (JSON NUMBER or null).
 * - null/undefined → null
 * - NumericLexeme with valid decimal lexeme (no scientific notation) → lexeme string
 * - anything else → throw
 */
function validateMoneyField(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (NumericLexeme.isInstance(value)) {
    const lex = value.lexeme;
    if (!DECIMAL_LEXEME_RE.test(lex)) {
      throw new Error(`Malformed row field ${field}: unsupported numeric lexeme "${lex}" (scientific notation not accepted in Release 1)`);
    }
    return lex;
  }
  throw new Error(`Malformed row field ${field}: source money must be JSON NUMBER or null, got ${typeof value}`);
}

// ── Validated integer fields ──────────────────────────────────────────────────

function numericValue(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (NumericLexeme.isInstance(value)) {
    if (!/^\d+(?:\.0+)?$/.test(value.lexeme)) throw new Error(`Malformed row field ${field}: expected exact integer`);
    return Number(value.lexeme);
  }
  if (typeof value === 'number') return value;
  throw new Error(`Malformed row field ${field}: expected integer or null`);
}

/** Validate fiscal year: nullable integer 1900..9999. */
function validateFiscalYear(value: unknown): number | null {
  const n = numericValue(value, 'reporting_fiscal_year');
  if (n === null) return null;
  if (!Number.isInteger(n) || n < 1900 || n > 9999)
    throw new Error(`Malformed row field reporting_fiscal_year: out of range [1900..9999], got ${n}`);
  return n;
}

/** Validate fiscal quarter: nullable integer 1..4. */
function validateFiscalQuarter(value: unknown): number | null {
  const n = numericValue(value, 'reporting_fiscal_quarter');
  if (n === null) return null;
  if (!Number.isInteger(n) || n < 1 || n > 4)
    throw new Error(`Malformed row field reporting_fiscal_quarter: out of range [1..4], got ${n}`);
  return n;
}

/** Validate fiscal month: nullable integer 1..12. */
function validateFiscalMonth(value: unknown): number | null {
  const n = numericValue(value, 'reporting_fiscal_month');
  if (n === null) return null;
  if (!Number.isInteger(n) || n < 1 || n > 12)
    throw new Error(`Malformed row field reporting_fiscal_month: out of range [1..12], got ${n}`);
  return n;
}

/** Validate nullable boolean submission mode. */
function validateNullableBool(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') throw new Error(`Malformed row field ${field}: expected boolean or null, got ${typeof value}`);
  return value;
}

// ── Page metadata validation ──────────────────────────────────────────────────

/**
 * Validate the complete page_metadata structure.
 * Requires exact: page=1, hasNext=false, next=null, hasPrevious=false, previous=null.
 * All five fields must be present with exact correct types/values; no missing-field loopholes.
 * Returns error string if invalid, null if valid.
 */
function validatePageMetadata(meta: Record<string, unknown>): string | null {
  if (!('page' in meta)) return 'page_metadata missing page';
  if (!/^1(?:\.0+)?$/.test(extractNumericLexeme(meta['page']) ?? '')) return 'page_metadata.page must be exactly 1';
  if (!('hasNext' in meta)) return 'page_metadata missing hasNext';
  if (meta['hasNext'] !== false) return `page_metadata.hasNext must be false, got ${String(meta['hasNext'])}`;
  if (!('next' in meta)) return 'page_metadata missing next';
  if (meta['next'] !== null) return `page_metadata.next must be null, got ${String(meta['next'])}`;
  if (!('hasPrevious' in meta)) return 'page_metadata missing hasPrevious';
  if (meta['hasPrevious'] !== false) return `page_metadata.hasPrevious must be false, got ${String(meta['hasPrevious'])}`;
  if (!('previous' in meta)) return 'page_metadata missing previous';
  if (meta['previous'] !== null) return `page_metadata.previous must be null, got ${String(meta['previous'])}`;
  return null;
}

/** Parse a funding response body.
 *  Returns two views:
 *  - `meta`: page_metadata with numeric lexemes preserved.
 *  - `results`: results array parsed with the lexeme reviver (numbers boxed as NumericLexeme).
 */
function parseFundingBody(rawText: string): {
  results: unknown[];
  meta: Record<string, unknown>;
} | null {
  try {
    // Validate metadata and rows from original numeric lexemes, without rounding.
    const withReviver = JSON.parse(rawText, function (this: unknown, _key: string, value: unknown) {
      // eslint-disable-next-line prefer-rest-params
      const ctx = arguments[2] as { source?: string } | undefined;
      return numericLexemeReviver.call(this, _key, value, ctx);
    }) as Record<string, unknown>;
    if (!withReviver || typeof withReviver !== 'object') return null;
    const meta = withReviver['page_metadata'];
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const revivedResults = withReviver['results'];
    if (!Array.isArray(revivedResults)) return null;

    return { results: revivedResults as unknown[], meta: meta as Record<string, unknown> };
  } catch {
    return null;
  }
}

// ── Row projection ────────────────────────────────────────────────────────────

export interface ProjectedAccountRow {
  sourceRowIndex: number;
  federalAccount: string | null;
  accountTitle: string | null;
  treasuryAccountSymbol: null; // always null per contract
  programActivityCode: string | null;
  programActivityName: string | null;
  objectClass: string | null;
  objectClassName: string | null;
  disasterEmergencyFundCode: string | null; // nullable STRING, not boolean
  fundingAgencyName: string | null;
  awardingAgencyName: string | null;
  reportingFiscalYear: number | null;
  reportingFiscalQuarter: number | null;
  reportingFiscalMonth: number | null;
  isQuarterlySubmission: boolean | null;
  reportedObligationUsd: string | null; // exact decimal string or null
  reportedGrossOutlayUsd: string | null; // exact decimal string or null
}

/**
 * Project a single validated source row.
 * Throws on any malformed field — never silently repairs to null.
 * Every expected mapped property must be present and either correctly typed or explicit null.
 */
export function projectRow(sourceRow: Record<string, unknown>, sourceRowIndex: number): ProjectedAccountRow {
  for (const field of ['federal_account', 'account_title', 'program_activity_code', 'program_activity_name',
    'object_class', 'object_class_name', 'disaster_emergency_fund_code', 'funding_agency_name',
    'awarding_agency_name', 'reporting_fiscal_year', 'reporting_fiscal_quarter', 'reporting_fiscal_month',
    'is_quarterly_submission', 'transaction_obligated_amount', 'gross_outlay_amount']) {
    if (!Object.hasOwn(sourceRow, field) || sourceRow[field] === undefined) throw new Error(`Malformed row field ${field}: missing required property`);
  }
  return {
    sourceRowIndex,
    federalAccount: validateNullableStr(sourceRow['federal_account'], 'federal_account'),
    accountTitle: validateNullableStr(sourceRow['account_title'], 'account_title'),
    treasuryAccountSymbol: null,
    programActivityCode: validateNullableStr(sourceRow['program_activity_code'], 'program_activity_code'),
    programActivityName: validateNullableStr(sourceRow['program_activity_name'], 'program_activity_name'),
    objectClass: validateNullableStr(sourceRow['object_class'], 'object_class'),
    objectClassName: validateNullableStr(sourceRow['object_class_name'], 'object_class_name'),
    // disaster_emergency_fund_code is a nullable STRING in actual source.
    disasterEmergencyFundCode: validateNullableStr(sourceRow['disaster_emergency_fund_code'], 'disaster_emergency_fund_code'),
    fundingAgencyName: validateNullableStr(sourceRow['funding_agency_name'], 'funding_agency_name'),
    awardingAgencyName: validateNullableStr(sourceRow['awarding_agency_name'], 'awarding_agency_name'),
    reportingFiscalYear: validateFiscalYear(sourceRow['reporting_fiscal_year']),
    reportingFiscalQuarter: validateFiscalQuarter(sourceRow['reporting_fiscal_quarter']),
    reportingFiscalMonth: validateFiscalMonth(sourceRow['reporting_fiscal_month']),
    isQuarterlySubmission: validateNullableBool(sourceRow['is_quarterly_submission'], 'is_quarterly_submission'),
    reportedObligationUsd: validateMoneyField(sourceRow['transaction_obligated_amount'], 'transaction_obligated_amount'),
    reportedGrossOutlayUsd: validateMoneyField(sourceRow['gross_outlay_amount'], 'gross_outlay_amount'),
  };
}

/**
 * Project all rows from a raw funding page.
 * Each row must be a plain object; null/array/primitive rows are rejected (throw).
 * Throws on malformed input — never silently repairs to missing facts.
 */
export function projectRows(results: unknown[]): ProjectedAccountRow[] {
  return results.map((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Malformed row at index ${index}: expected object, got ${row === null ? 'null' : Array.isArray(row) ? 'array' : typeof row}`);
    }
    return projectRow(row as Record<string, unknown>, index);
  });
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

/** Fetch a single funding page for one award. No retries. */
export async function fetchAccountPage(input: AccountFetchInput): Promise<AccountPageOutcome> {
  const { awardUniqueId, responseMs = DEFAULT_RESPONSE_MS } = input;
  validateAwardEnrichmentIds([awardUniqueId]);
  const fetchFn = input.fetch ?? globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), responseMs);

  const requestBody = JSON.stringify({
    award_id: awardUniqueId,
    page: 1,
    limit: 100,
    sort: 'reporting_fiscal_date',
    order: 'desc',
  });

  let response: Response;
  try {
    response = await fetchFn(FUNDING_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: requestBody,
      redirect: 'error',
      signal: controller.signal,
    } as RequestInit);
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('redirect') || msg.includes('REDIRECT') || msg.includes('NetworkError')) {
      return { ok: false, error: 'REDIRECT_REFUSED', detail: msg };
    }
    if (controller.signal.aborted) return { ok: false, error: 'RESPONSE_TIMEOUT' };
    return { ok: false, error: 'HTTP_FAILURE', detail: msg };
  }

  if (!response.ok) {
    clearTimeout(timer);
    return { ok: false, error: 'HTTP_FAILURE', detail: `HTTP ${response.status}` };
  }

  // Stream body with size guard.
  let rawText: string;
  let sourceObservedAt: string;
  try {
    const reader = response.body?.getReader();
    if (!reader) {
      clearTimeout(timer);
      return { ok: false, error: 'BODY_UNREADABLE' };
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      if (controller.signal.aborted) throw new Error('RESPONSE_TIMEOUT');
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > MAX_BODY_BYTES) {
          reader.cancel().catch(() => {});
          clearTimeout(timer);
          return { ok: false, error: 'BODY_OVERSIZE', detail: `>${MAX_BODY_BYTES} bytes` };
        }
        chunks.push(value);
      }
    }
    // Capture timestamp after body fully received.
    sourceObservedAt = nowUtc();
    const allBytes = Buffer.concat(chunks as Buffer[]);

    // Reject unsupported BOM variants. TextDecoder with fatal:true silently strips a UTF-8 BOM
    // (EF BB BF), which would change the source hash. Explicitly refuse all BOM variants.
    if (allBytes.length >= 3 &&
        allBytes[0] === 0xEF && allBytes[1] === 0xBB && allBytes[2] === 0xBF) {
      clearTimeout(timer);
      return { ok: false, error: 'BODY_UNREADABLE', detail: 'UTF-8 BOM present; rejected to preserve source hash' };
    }
    if (allBytes.length >= 2 && (
      (allBytes[0] === 0xFF && allBytes[1] === 0xFE) ||
      (allBytes[0] === 0xFE && allBytes[1] === 0xFF)
    )) {
      clearTimeout(timer);
      return { ok: false, error: 'BODY_UNREADABLE', detail: 'UTF-16 BOM present; rejected' };
    }

    rawText = new TextDecoder('utf-8', { fatal: true }).decode(allBytes);
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'RESPONSE_TIMEOUT' || controller.signal.aborted) return { ok: false, error: 'RESPONSE_TIMEOUT' };
    return { ok: false, error: 'BODY_UNREADABLE', detail: msg };
  } finally {
    clearTimeout(timer);
  }

  // Validate the parsed structure.
  const parsed = parseFundingBody(rawText);
  if (!parsed) return { ok: false, error: 'MALFORMED_RESPONSE', detail: 'JSON parse or structure failure' };

  // Validate complete page metadata: page=1, hasNext=false, next=null, hasPrevious=false, previous=null.
  const metaError = validatePageMetadata(parsed.meta);
  if (metaError) {
    // Distinguish PAGE_INCOMPLETE (hasNext not false) from WRONG_PAGE (page!=1 or missing).
    if (metaError.includes('hasNext')) {
      return { ok: false, error: 'PAGE_INCOMPLETE', detail: metaError };
    }
    if (metaError.includes('.page must be') || metaError.includes('missing page')) {
      return { ok: false, error: 'WRONG_PAGE', detail: metaError };
    }
    return { ok: false, error: 'MALFORMED_RESPONSE', detail: metaError };
  }

  if (parsed.results.length > 100) {
    return { ok: false, error: 'OVERSIZED_RESULT', detail: `${parsed.results.length} rows` };
  }

  try { projectRows(parsed.results); } catch {
    return { ok: false, error: 'MALFORMED_RESPONSE', detail: 'Invalid source row' };
  }

  const sha256 = createHash('sha256').update(rawText, 'utf8').digest('hex');

  return {
    ok: true,
    page: { rawText, sha256, sourceObservedAt, rowCount: parsed.results.length },
  };
}

// ── Cohort fetch ──────────────────────────────────────────────────────────────

export interface CohortFetchResult {
  awardUniqueId: string;
  outcome: AccountPageOutcome;
}

/** Fetch the complete cohort sequentially. Validates ALL before any writes. */
export async function fetchAccountCohort(
  awardIds: readonly string[],
  options: { responseMs?: number; overallMs?: number; fetch?: typeof globalThis.fetch } = {},
): Promise<CohortFetchResult[]> {
  validateAwardEnrichmentIds(awardIds);
  const { responseMs = DEFAULT_RESPONSE_MS, overallMs = DEFAULT_OVERALL_MS, fetch: fetchFn } = options;
  const deadline = Date.now() + overallMs;
  const results: CohortFetchResult[] = [];
  for (const awardUniqueId of awardIds) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      results.push({ awardUniqueId, outcome: { ok: false, error: 'RESPONSE_TIMEOUT', detail: 'overall deadline' } });
      continue;
    }
    const outcome = await fetchAccountPage({
      awardUniqueId,
      responseMs: Math.min(responseMs, remaining),
      fetch: fetchFn,
    });
    results.push({ awardUniqueId, outcome });
  }
  return results;
}

// ── Closed writer interface ───────────────────────────────────────────────────

export interface AppendAccountReportInput {
  awardKey: string;        // usaspending|award|CONT_AWD_…
  sourceObservedAt: string; // exact UTC6 text
  rawBody: string;
  sha256: string;
}

export interface AppendAccountReportResult {
  snapshotId: string;
  inserted: boolean;
}

/** Minimal SQL writer port. Injects a pg Client via dependency injection. */
export interface AccountReportDbPort {
  appendReport(input: AppendAccountReportInput): Promise<AppendAccountReportResult>;
}

// ── Argument parsing for enrich-award-pe-tas.ts --account-award-ids-file mode ──

export const ACCOUNT_AWARD_IDS_FILE_FLAG = '--account-award-ids-file';

/** Parse CLI args for the new account mode. Returns null if this flag is absent.
 *  Throws on malformed or mixed args — never falls through to legacy mode.
 */
export function parseAccountModeArgs(args: readonly string[]): {
  accountAwardIdsFile: string;
  commit: boolean;
} | null {
  if (!args.includes(ACCOUNT_AWARD_IDS_FILE_FLAG)) return null;

  let file: string | undefined;
  let commit = false;

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--commit' && !commit) { commit = true; continue; }
    if (token === ACCOUNT_AWARD_IDS_FILE_FLAG && file === undefined) {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--account-award-ids-file requires a file path argument');
      file = next;
      i++;
      continue;
    }
    throw new Error(
      `Account mode accepts only ${ACCOUNT_AWARD_IDS_FILE_FLAG} <file> and optional --commit. Unknown: ${token}`,
    );
  }

  if (!file) throw new Error('--account-award-ids-file requires a file path argument');
  return { accountAwardIdsFile: file, commit };
}

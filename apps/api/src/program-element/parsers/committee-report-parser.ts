import { Logger } from '@nestjs/common';
import { isValidProgramCode, dollarsToMillions } from '../jbook/jbook-extract.js';
import { ProgramElementWriterService } from '../program-element-writer.service.js';
import type { PeYearWriteContext } from '../types.js';

/**
 * Shared base for congressional committee-report PE-mark parsers (Steps 22 & 23).
 *
 * Both the Armed Services (authorization) and Defense Appropriations parsers share
 * ~90% of their logic — only the writer source tag and the target mark field differ.
 * This module holds the common pure parsing functions and an abstract loader; the
 * per-committee services are thin subclasses that supply { source, markField }.
 *
 * Consistent with the rest of the PE ingestion pipeline (R-1/R-2 J-books): heavy
 * PDF→rows extraction is deterministic and done offline (pdfplumber tool producing
 * a committed JSON artifact); these services are the pure parser + DB loader. No
 * Textract/LLM in the runtime path.
 */

/** A committee mark for one PE in one fiscal year, as extracted from a report. */
export interface CommitteeReportMarkRecord {
  peCode: string;
  fy: number;
  /** President's request in dollars (optional — reports don't always restate it). */
  request: number | null;
  /** The committee's recommended/authorized/appropriated mark in dollars. */
  mark: number | null;
  /** Optional plus-up / mark explanation text. */
  explanation: string | null;
}

/** One pre-extracted tabular row from the offline pdfplumber tool. */
export interface ExtractedReportRow {
  peCode?: string | null;
  fy?: number | string | null;
  request?: number | string | null;
  mark?: number | string | null;
  explanation?: string | null;
  [key: string]: unknown;
}

export interface ParseOptions {
  /** Fiscal year the report covers (e.g. 2027 for an FY2027 report). */
  fy: number;
}

export interface LoadResult {
  source: string;
  rowsSeen: number;
  upserted: number;
  changed: number;
  quarantined: number;
}

/** Mark fields on ProgramElementYear that a committee report can populate. */
// 'conference' = appropriations-track conference (RESERVED — no loader writes it yet).
// 'ndaaConference' = NDAA authorization conference report (written by the NDAA loader).
export type MarkField =
  | 'hascMark'
  | 'sascMark'
  | 'hacDMark'
  | 'sacDMark'
  | 'conference'
  | 'ndaaConference'
  | 'enacted';

// PE code: 7 digits + service letter (+ optional suffix). Same canon as jbook.
const PE_TOKEN = /\b([0-9]{7}[A-Z][A-Z0-9]*)\b/;
// A dollar amount in a mark column: 1,234 / 1234 / (500) negative / 12.5 (thousands).
const AMOUNT = /\(?-?\$?[\d,]+(?:\.\d+)?\)?/g;

/** Normalize a money token to a number in dollars. Parenthesized = negative. */
export function parseAmount(token: string | number | null | undefined): number | null {
  if (token === null || token === undefined) return null;
  if (typeof token === 'number') return Number.isFinite(token) ? token : null;
  const t = token.trim();
  if (!t) return null;
  const negative = /^\(.*\)$/.test(t);
  const cleaned = t.replace(/[(),$\s]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Parse raw committee-report text into mark records. Scans line-by-line; a line
 * is a PE row when its first token is a valid PE code followed by one or more
 * amount columns. By convention the LAST amount on the line is the committee
 * recommendation (mark); when two amounts are present the first is the request.
 */
export function parseReportText(text: string, opts: ParseOptions): CommitteeReportMarkRecord[] {
  const out: CommitteeReportMarkRecord[] = [];
  if (!text) return out;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const peMatch = line.match(PE_TOKEN);
    if (!peMatch) continue;
    // Require the PE code at the start of the row (table first column), not merely
    // mentioned mid-sentence in narrative prose.
    if (line.indexOf(peMatch[1]!) > 8) continue;

    const peCode = peMatch[1]!.toUpperCase();
    const afterPe = line.slice(line.indexOf(peMatch[1]!) + peMatch[1]!.length);
    const amounts = (afterPe.match(AMOUNT) ?? [])
      .map((a) => parseAmount(a))
      .filter((n): n is number => n !== null);

    if (amounts.length === 0) continue;

    const mark = amounts[amounts.length - 1] ?? null;
    const request = amounts.length >= 2 ? amounts[0]! : null;
    const explanation = extractExplanation(afterPe);

    out.push({ peCode, fy: opts.fy, request, mark, explanation });
  }

  return dedupeByPe(out);
}

/** Parse already-tabular rows (from the offline pdfplumber extractor JSON). */
export function parseExtractedRows(
  rows: ExtractedReportRow[],
  opts: ParseOptions,
): CommitteeReportMarkRecord[] {
  const out: CommitteeReportMarkRecord[] = [];
  for (const r of rows) {
    const peCode = (r.peCode ?? '').toString().trim().toUpperCase();
    if (!peCode) continue;
    const fy = r.fy !== null && r.fy !== undefined && r.fy !== '' ? Number(r.fy) : opts.fy;
    out.push({
      peCode,
      fy: Number.isFinite(fy) ? fy : opts.fy,
      request: parseAmount(r.request ?? null),
      mark: parseAmount(r.mark ?? null),
      explanation: r.explanation ? String(r.explanation) : null,
    });
  }
  return dedupeByPe(out);
}

function extractExplanation(afterPe: string): string | null {
  const stripped = afterPe.replace(AMOUNT, ' ').replace(/\s+/g, ' ').trim();
  return stripped.length > 2 ? stripped : null;
}

/** Last-wins dedupe on peCode within a single report. */
export function dedupeByPe(records: CommitteeReportMarkRecord[]): CommitteeReportMarkRecord[] {
  const byPe = new Map<string, CommitteeReportMarkRecord>();
  for (const r of records) byPe.set(r.peCode, r);
  return Array.from(byPe.values());
}

/**
 * Abstract loader: validates pe_codes (quarantining bad ones via the writer),
 * then upserts each into ProgramElementYear under the subclass's source tag and
 * mark field. The writer owns source-priority, delta detection, and
 * IntelligenceChange emission; bad pe_codes are counted here for the run summary.
 */
export abstract class CommitteeReportParserBase {
  protected abstract readonly logger: Logger;

  protected constructor(protected readonly writer: ProgramElementWriterService) {}

  protected async loadRecords(
    records: CommitteeReportMarkRecord[],
    source: string,
    markField: MarkField,
    writeContext?: PeYearWriteContext,
  ): Promise<LoadResult> {
    let upserted = 0;
    let changed = 0;
    let quarantined = 0;

    for (const rec of records) {
      // Accept BOTH RDT&E PE codes AND procurement BLINs (incl. appropriation-namespaced
      // ones) — committee/appropriations reports mark procurement lines too, not just RDT&E.
      if (!isValidProgramCode(rec.peCode)) {
        await this.writer.quarantine(rec, `Invalid pe_code in ${source}: ${rec.peCode}`, source);
        quarantined += 1;
        continue;
      }

      // Ensure the parent program_element row exists before writing a year row
      // (FK: program_element_year.pe_code -> program_element.pe_code). Committee
      // reports can reference PEs the J-book catalog hasn't ingested yet (e.g. new
      // FY programs); create a low-confidence stub so the mark still lands. J-book
      // syncs later enrich it via source-priority. Title from the table line text.
      await this.writer.upsertProgramElement(
        { peCode: rec.peCode, title: rec.explanation ?? rec.peCode, firstSeenFy: rec.fy, raw: rec },
        source,
        0.3,
      );

      // Committee / NDAA-conference / enacted public-law extraction artifacts encode
      // FULL DOLLARS (e.g. 215322000 = $215.3M); convert to the canonical MILLIONS
      // unit before the write so marks aren't 1,000,000x inflated in the UI.
      const requestM = dollarsToMillions(rec.request);
      const markM = dollarsToMillions(rec.mark);
      const context: PeYearWriteContext | undefined = writeContext
        ? {
            ...writeContext,
            originalValues: {
              ...(writeContext.originalValues ?? {}),
              ...(rec.request != null
                ? { request: { value: rec.request, unit: 'dollars' as const } }
                : {}),
              ...(rec.mark != null
                ? { [markField]: { value: rec.mark, unit: 'dollars' as const } }
                : {}),
            },
          }
        : undefined;
      const result = await this.writer.upsertProgramElementYear(
        {
          peCode: rec.peCode,
          fy: rec.fy,
          request: requestM,
          [markField]: markM,
          notes: rec.explanation,
          raw: rec,
        },
        source,
        context,
      );
      upserted += 1;
      if (result.changed) changed += 1;
    }

    this.logger.log(
      `${source}: ${upserted} upserted, ${changed} changed, ${quarantined} quarantined`,
    );
    return { source, rowsSeen: records.length, upserted, changed, quarantined };
  }
}

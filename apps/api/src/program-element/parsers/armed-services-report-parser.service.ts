import { Injectable, Logger } from '@nestjs/common';
import { ProgramElementWriterService } from '../program-element-writer.service.js';
import type { PeYearWriteContext } from '../types.js';
import {
  CommitteeReportParserBase,
  parseAmount,
  parseExtractedRows,
  parseReportText,
  dedupeByPe,
  type CommitteeReportMarkRecord,
  type ExtractedReportRow,
  type LoadResult,
  type ParseOptions,
} from './committee-report-parser.js';

/**
 * HASC / SASC Armed Services committee-report parser (Step 22).
 *
 * Parses NDAA authorization committee reports (House HRPT / Senate SRPT) for
 * per-PE budget marks and writes them via the program-element writer under
 * source 'hasc_report_fy<NN>' / 'sasc_report_fy<NN>', setting hascMark / sascMark.
 *
 * Shares all parsing + loading logic with the Defense Appropriations parser via
 * CommitteeReportParserBase; only the source tag + mark field differ.
 */

export type Chamber = 'HASC' | 'SASC';

// Re-export the shared building blocks so existing importers (and the spec) keep
// their import path. ArmedServicesMarkRecord is the shared record shape.
export type ArmedServicesMarkRecord = CommitteeReportMarkRecord;
export { parseAmount, parseExtractedRows, parseReportText, dedupeByPe };
export type { ExtractedReportRow, LoadResult, ParseOptions };

/** Build the writer source tag, e.g. hasc_report_fy27 / sasc_report_fy27. */
export function reportSource(chamber: Chamber, fy: number): string {
  const fy2 = String(fy).slice(-2);
  return `${chamber === 'HASC' ? 'hasc' : 'sasc'}_report_fy${fy2}`;
}

@Injectable()
export class ArmedServicesReportParserService extends CommitteeReportParserBase {
  protected readonly logger = new Logger(ArmedServicesReportParserService.name);

  constructor(writer: ProgramElementWriterService) {
    super(writer);
  }

  /** Load parsed marks for a chamber + fiscal year. */
  async load(
    records: ArmedServicesMarkRecord[],
    chamber: Chamber,
    fy: number,
    writeContext?: PeYearWriteContext,
  ): Promise<LoadResult> {
    const source = reportSource(chamber, fy);
    const markField = chamber === 'HASC' ? 'hascMark' : 'sascMark';
    return this.loadRecords(records, source, markField, writeContext);
  }
}

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
  type MarkField,
  type ParseOptions,
} from './committee-report-parser.js';

/**
 * House / Senate Defense Appropriations subcommittee report parser (Step 23).
 *
 * Parses Defense Appropriations subcommittee reports (House HRPT / Senate SRPT,
 * Defense Subcommittee) for per-PE appropriated marks and writes them via the
 * program-element writer under source 'hac_d_report_fy<NN>' / 'sac_d_report_fy<NN>',
 * setting hacDMark / sacDMark.
 *
 * Shares all parsing + loading logic with the Armed Services parser via
 * CommitteeReportParserBase (Step 22); only the source tag + mark field differ.
 */

/** Defense Appropriations chamber: House (HAC-D) or Senate (SAC-D) Defense Subcommittee. */
export type AppropsChamber = 'HAC-D' | 'SAC-D';

export type DefenseAppropsMarkRecord = CommitteeReportMarkRecord;
export { parseAmount, parseExtractedRows, parseReportText, dedupeByPe };
export type { ExtractedReportRow, LoadResult, ParseOptions };

/** Build the writer source tag, e.g. hac_d_report_fy27 / sac_d_report_fy27. */
export function appropsReportSource(chamber: AppropsChamber, fy: number): string {
  const fy2 = String(fy).slice(-2);
  return `${chamber === 'HAC-D' ? 'hac_d' : 'sac_d'}_report_fy${fy2}`;
}

@Injectable()
export class DefenseAppropsReportParserService extends CommitteeReportParserBase {
  protected readonly logger = new Logger(DefenseAppropsReportParserService.name);

  constructor(writer: ProgramElementWriterService) {
    super(writer);
  }

  /** Load parsed appropriations marks for a chamber + fiscal year. */
  async load(
    records: DefenseAppropsMarkRecord[],
    chamber: AppropsChamber,
    fy: number,
    writeContext?: PeYearWriteContext,
  ): Promise<LoadResult> {
    const source = appropsReportSource(chamber, fy);
    const markField: MarkField = chamber === 'HAC-D' ? 'hacDMark' : 'sacDMark';
    return this.loadRecords(records, source, markField, writeContext);
  }
}

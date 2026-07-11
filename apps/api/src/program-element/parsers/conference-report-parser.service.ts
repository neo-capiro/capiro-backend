import { Injectable, Logger } from '@nestjs/common';
import { ProgramElementWriterService } from '../program-element-writer.service.js';
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
 * NDAA conference report + Defense Appropriations public-law parser (Step 24).
 *
 * Two stages, same extraction pipeline as Steps 22/23 (shared
 * CommitteeReportParserBase):
 *   - 'conference'  → NDAA conference report (final negotiated AUTHORIZATION). Writes
 *                     the `ndaaConference` field (authorization track — deliberately
 *                     OUTSIDE the appropriations funding ladder so it never becomes the
 *                     "current" appropriations number), source 'conference_report_fy<NN>'.
 *   - 'public_law'  → enacted Defense Appropriations public law. Writes the
 *                     `enacted` field, source 'public_law_fy<NN>'.
 *
 * Deterministic offline extraction (pdfplumber tool → committed rows artifact);
 * this service is the pure loader. No Textract/LLM at runtime.
 */

export type ReportStage = 'conference' | 'public_law';

export type ConferenceMarkRecord = CommitteeReportMarkRecord;
export { parseAmount, parseExtractedRows, parseReportText, dedupeByPe };
export type { ExtractedReportRow, LoadResult, ParseOptions };

/** Build the writer source tag, e.g. conference_report_fy27 / public_law_fy27. */
export function conferenceReportSource(stage: ReportStage, fy: number): string {
  const fy2 = String(fy).slice(-2);
  return `${stage === 'conference' ? 'conference_report' : 'public_law'}_fy${fy2}`;
}

@Injectable()
export class ConferenceReportParserService extends CommitteeReportParserBase {
  protected readonly logger = new Logger(ConferenceReportParserService.name);

  constructor(writer: ProgramElementWriterService) {
    super(writer);
  }

  /**
   * Load parsed marks for a stage + fiscal year.
   *   conference → ndaaConference field (NDAA authorization); public_law → enacted field.
   */
  async load(records: ConferenceMarkRecord[], stage: ReportStage, fy: number): Promise<LoadResult> {
    const source = conferenceReportSource(stage, fy);
    const markField: MarkField = stage === 'conference' ? 'ndaaConference' : 'enacted';
    return this.loadRecords(records, source, markField);
  }
}

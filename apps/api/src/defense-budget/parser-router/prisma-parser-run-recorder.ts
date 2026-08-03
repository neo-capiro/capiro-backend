/**
 * Prisma-based parser-run recorder.
 * Stub for Phase 3 Session 1 — full implementation uses DocumentParseJob model.
 * The real implementation will be connected when the persistence path is wired.
 */

import type { ParserRunRecorderV1 } from './parser-run-recorder.js';

export class PrismaParserRunRecorder implements ParserRunRecorderV1 {
  constructor(private readonly _prisma: unknown) {}

  async record(input: {
    sourceDocumentId?: string;
    method: string;
    providerJobId?: string;
    mode?: string;
    pageStart?: number;
    pageEnd?: number;
    exactPageList?: number[];
    inputSha256: string;
    outputLocator: string;
    outputByteSha256: string;
    outputContentSha256: string;
    parserVersion: string;
    parserConfigSha256: string;
    status: string;
    error?: string;
    metrics?: Record<string, unknown>;
  }): Promise<{ parseJobId: string }> {
    // Full implementation will use prisma.documentParseJob.create/update
    // with the existing DocumentParseJob model.
    // For Session 1, this is a typed stub.
    throw new Error(
      'PrismaParserRunRecorder not implemented in Phase 3 Session 1 — use NoOpParserRunRecorder for local mode',
    );
  }
}

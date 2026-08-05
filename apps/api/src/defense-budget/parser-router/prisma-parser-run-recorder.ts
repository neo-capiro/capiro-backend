/**
 * Prisma-backed parser-run recorder using the existing DocumentParseJob model.
 *
 * Exact terminal parser identities are reused rather than duplicated. All
 * fields not represented as first-class columns are preserved in metadata for
 * Phase 2 proof resolution and audit replay.
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import type { ParserRunRecorderV1 } from './parser-artifact-store.js';
import { computeParserRunCacheKey } from './parser-runtime-contract-v1.js';

export class PrismaParserRunRecorder implements ParserRunRecorderV1 {
  constructor(private readonly prisma: PrismaClient) {}

  async record(
    input: Parameters<ParserRunRecorderV1['record']>[0],
  ): Promise<{ parseJobId: string }> {
    if (!input.sourceDocumentId) {
      throw new Error('Prisma parser-run recording requires sourceDocumentId');
    }
    const exactPages = [...(input.exactPageList ?? [])].sort((a, b) => a - b);
    if (exactPages.length === 0 && input.pageStart !== undefined && input.pageEnd !== undefined) {
      for (let page = input.pageStart; page <= input.pageEnd; page++) exactPages.push(page);
    }
    if (exactPages.length === 0) {
      throw new Error('Prisma parser-run recording requires an exact nonempty page set');
    }

    const cacheKey = computeParserRunCacheKey({
      sourceSha256: input.inputSha256,
      method: input.method,
      parserVersion: input.parserVersion,
      parserConfigSha256: input.parserConfigSha256,
      pages: exactPages,
      runtimeContractVersion: 'defense_budget_parser_job_v1',
    });
    const pageStart = Math.min(...exactPages);
    const pageEnd = Math.max(...exactPages);
    const provider = input.method;
    const terminalStatus =
      input.status === 'completed' ? 'succeeded' : input.status === 'failed' ? 'failed' : 'running';

    const candidates = await this.prisma.documentParseJob.findMany({
      where: {
        sourceDocumentId: input.sourceDocumentId,
        provider,
        inputSha256: input.inputSha256,
        pageStart,
        pageEnd,
        mode: input.mode ?? provider,
        resultType: 'json',
      },
      orderBy: { startedAt: 'desc' },
      take: 25,
    });
    for (const candidate of candidates) {
      const metadata = asRecord(candidate.metadata);
      if (
        metadata.cacheKey === cacheKey &&
        metadata.outputContentSha256 === input.outputContentSha256 &&
        metadata.outputByteSha256 === input.outputByteSha256 &&
        candidate.status === terminalStatus
      ) {
        return { parseJobId: candidate.id };
      }
    }

    const metadata: Prisma.InputJsonValue = {
      cacheKey,
      exactPageList: exactPages,
      method: input.method,
      parserVersion: input.parserVersion,
      parserConfigSha256: input.parserConfigSha256,
      outputLocator: input.outputLocator,
      outputByteSha256: input.outputByteSha256,
      outputContentSha256: input.outputContentSha256,
      // Phase 2 LlamaParse proof consumes this exact top-level key. It is
      // harmless and useful for local parsers as well.
      normalizedResultSha256: input.outputContentSha256,
      ...(input.metrics ? { metrics: toJson(input.metrics) } : {}),
      ...(input.metadata ? { recorderMetadata: toJson(input.metadata) } : {}),
    };

    const created = await this.prisma.documentParseJob.create({
      data: {
        sourceDocumentId: input.sourceDocumentId,
        provider,
        ...(input.providerJobId ? { providerJobId: input.providerJobId } : {}),
        mode: input.mode ?? provider,
        resultType: 'json',
        pageStart,
        pageEnd,
        inputSha256: input.inputSha256,
        outputJsonS3Key: input.outputLocator,
        status: terminalStatus,
        ...(input.error ? { error: input.error } : {}),
        ...(terminalStatus !== 'running' ? { completedAt: new Date() } : {}),
        metadata,
      },
      select: { id: true },
    });
    return { parseJobId: created.id };
  }
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

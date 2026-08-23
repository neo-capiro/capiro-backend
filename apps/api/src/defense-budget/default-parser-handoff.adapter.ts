/**
 * Phase 10B-1 — ParserHandoffPort implementation over the existing Phase 1-7
 * pipeline entrypoint (`runParserHandoffForSourceDocument`).
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { runParserHandoffForSourceDocument } from './parser-router/source-document-parser-handoff.js';
import { routingForSourceFamily } from './parser-router/source-family-routing.js';
import type { ParserHandoffInput, ParserHandoffPort, ParserHandoffResult } from './observation-ingestion-bridge.ports.js';

export interface DefaultParserHandoffAdapterOptions {
  readonly workDir: string;
  readonly maxEscalationRounds?: number;
  readonly persistVerificationAudit?: boolean;
}

@Injectable()
export class DefaultParserHandoffAdapter implements ParserHandoffPort {
  constructor(private readonly options: DefaultParserHandoffAdapterOptions) {}

  async handoff(input: ParserHandoffInput): Promise<ParserHandoffResult> {
    const routing = routingForSourceFamily(input.sourceFamily);
    const terminal = await runParserHandoffForSourceDocument({
      executionId: `phase10b1-bridge-${input.sourceDocumentId}-${randomUUID().slice(0, 8)}`,
      cycleId: input.cycleId,
      sourceDocumentId: input.sourceDocumentId,
      sourcePath: input.sourcePath,
      sourceSha256: input.sourceSha256,
      sourceLocator: input.sourceUrl,
      sourceUrl: input.sourceUrl,
      parserPolicy: routing.parserPolicy,
      exhibitType: routing.exhibit,
      budgetFamily: routing.family,
      fiscalYear: input.fiscalYear,
      authority: routing.authority,
      budgetCycle: routing.budgetCycle,
      documentType: routing.documentType,
      title: input.title,
      workDir: this.options.workDir,
      maxEscalationRounds: this.options.maxEscalationRounds ?? 4,
      allowPaidParse: false,
      maxPaidPages: 0,
      persistVerificationAudit: this.options.persistVerificationAudit ?? false,
    });
    return {
      invoked: true,
      decision: terminal.decision,
      finalState: terminal.finalState,
      artifactLocator: terminal.artifactLocator,
    };
  }
}

import { Injectable } from '@nestjs/common';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);

/** Feature and worker controls for the incremental mailbox knowledge path. */
@Injectable()
export class MailboxKnowledgeFlagsService {
  enabled(): boolean {
    return (
      readBooleanFlag('KNOWLEDGE_PLANE_ENABLED') &&
      (readBooleanFlag('MAILBOX_KNOWLEDGE_ENABLED') ||
        readBooleanFlag('MAILBOX_KNOWLEDGE_INGEST_ENABLED'))
    );
  }

  batchSize(): number {
    return readBoundedInteger('MAILBOX_KNOWLEDGE_BATCH_SIZE', 10, 1, 100);
  }

  maxAttempts(): number {
    return readBoundedInteger('MAILBOX_KNOWLEDGE_MAX_ATTEMPTS', 8, 1, 25);
  }

  /**
   * Phase 6 is separately armed so deploying extraction code cannot itself
   * start sending private mailbox text to an AI provider.
   */
  extractionEnabled(): boolean {
    return this.enabled() && readBooleanFlag('MAILBOX_KNOWLEDGE_EXTRACTION_ENABLED');
  }

  extractionBatchSize(): number {
    return readBoundedInteger('MAILBOX_KNOWLEDGE_EXTRACTION_BATCH_SIZE', 5, 1, 50);
  }

  extractionMaxAttempts(): number {
    return readBoundedInteger('MAILBOX_KNOWLEDGE_EXTRACTION_MAX_ATTEMPTS', 6, 1, 25);
  }
}

export function readBooleanFlag(name: string): boolean {
  return TRUE_VALUES.has((process.env[name] ?? '').trim().toLowerCase());
}

function readBoundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

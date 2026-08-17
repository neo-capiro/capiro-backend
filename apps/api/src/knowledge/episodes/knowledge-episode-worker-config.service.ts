import { Injectable } from '@nestjs/common';

/** Operational tuning for the always-on Phase 7 projection worker. */
@Injectable()
export class KnowledgeEpisodeWorkerConfigService {
  batchSize(): number {
    return readBoundedInteger('MAILBOX_KNOWLEDGE_EPISODES_BATCH_SIZE', 10, 1, 100);
  }

  maxAttempts(): number {
    return readBoundedInteger('MAILBOX_KNOWLEDGE_EPISODES_MAX_ATTEMPTS', 6, 1, 25);
  }
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

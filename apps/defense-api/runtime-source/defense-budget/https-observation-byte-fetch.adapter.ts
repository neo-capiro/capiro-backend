/**
 * Phase 10B-1 — full-byte-buffer fetch adapter for the observation ingestion
 * bridge.
 *
 * Deliberately reuses the SAME official-source HTTP conventions as
 * `HttpsSourceFetchAdapter` (Session 7's watcher fetch port) — identical user
 * agent, identical redirect-follow behaviour, identical SHA-256 identity rule
 * — but returns the durable byte buffer instead of discarding it after
 * hashing. The watcher's own port is intentionally left untouched: this is a
 * new, narrower port (`ObservationByteFetchPort`), not a widening of it.
 */
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

import type {
  FetchedObservationBytes,
  ObservationByteFetchFailure,
  ObservationByteFetchPort,
} from './observation-ingestion-bridge.ports.js';

const USER_AGENT =
  'Capiro-Phase10B1-ObservationIngestionBridge/1.0 (+source-grounded-ingestion; contact: platform@capiro.ai)';

export interface HttpsObservationByteFetchOptions {
  readonly timeoutMs?: number;
}

@Injectable()
export class HttpsObservationByteFetchAdapter implements ObservationByteFetchPort {
  private readonly logger = new Logger(HttpsObservationByteFetchAdapter.name);

  constructor(private readonly options: HttpsObservationByteFetchOptions = {}) {}

  async fetchFullBytes(input: {
    url: string;
  }): Promise<FetchedObservationBytes | ObservationByteFetchFailure> {
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    let response: Response;
    try {
      response = await fetch(input.url, {
        headers: { 'user-agent': USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`fetch failed for ${input.url}: ${reason}`);
      return { blocked: true, reason };
    }

    if (!response.ok) {
      return { blocked: true, reason: `HTTP ${response.status} for ${input.url}` };
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      return {
        blocked: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (bytes.length === 0) {
      return { blocked: true, reason: `empty body for ${input.url}` };
    }

    return {
      bytes,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
      byteSize: bytes.length,
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';

/** The exact proposed write behind a WARN decision (B4.1). */
export interface PendingActionPayload {
  fingerprint: string;
  tool: string;
  input: unknown;
}

/**
 * Fire-and-forget bridge to apps/api's pending-action cache: posts the EXACT
 * {tool, input} behind a WARN decision via `POST /api/clio/pending-actions`,
 * keyed by the SAME fingerprint the `pending_approval` SSE frame carries (same
 * bridge pattern as ApiComplianceAuditRepo).
 *
 * B4.1 fix: approving a WARN write used to only record an approval row, then
 * the caller re-ran the WHOLE chat turn by resending the user's ORIGINAL
 * prompt and hoping the model re-derived a byte-identical proposal on its own
 * — it never reliably does (it re-researches/rewords), so the fresh proposal
 * hashed to a DIFFERENT fingerprint that was never approved, and the write
 * WARNed again, forever. This repo captures the input the FIRST time so
 * apps/api's approve endpoint can replay it directly — no second model call,
 * so nothing can drift between "approved" and "what actually runs".
 *
 * FAIL-OPEN like the audit repo: caching the pending input must NEVER block,
 * delay, or crash a Meri turn. `record()` returns void immediately and
 * swallows every error — a missed cache write just means `approve` falls back
 * to its pre-fix behavior (no worse than before this repo existed) rather than
 * failing the turn.
 */
@Injectable()
export class ApiPendingActionRepo {
  private readonly logger = new Logger(ApiPendingActionRepo.name);
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.apiBaseUrl = (
      config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    this.timeoutMs = Number.parseInt(config.get<string>('MERIV2_TOOL_TIMEOUT_MS') ?? '60000', 10);
  }

  /** Fire-and-forget: schedule the cache write, never await it into the turn. */
  record(payload: PendingActionPayload): void {
    const bearer = RequestCredentialsStore.get()?.bearerToken;
    if (!bearer) return; // no caller identity to scope the row — skip silently
    void this.post(bearer, payload).catch((e) =>
      this.logger.warn(`pending-action cache write skipped (${(e as Error).message})`),
    );
  }

  private async post(bearer: string, payload: PendingActionPayload): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/clio/pending-actions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) this.logger.warn(`pending-action cache write -> ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

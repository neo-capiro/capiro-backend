import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Memory write-back client (Phase 3.4): posts a promoted Workspace artifact fact
 * to apps/api's InternalServiceGuard-gated `POST /api/internal/memory/candidates`
 * over the shared INTERNAL_SERVICE_SECRET (the SAME channel intel-api/BYOK3 uses;
 * never a browser JWT). apps/api runs it through Phase 1's real candidate
 * lifecycle — a firm-scope candidate lands 'pending' in the admin review queue,
 * so memory promotion goes through governance, never a raw cross-service insert.
 *
 * FAIL-CLOSED: if INTERNAL_SERVICE_SECRET is unset the promote action errors
 * (never a silent no-op) — a write-back must not appear to succeed while writing
 * nothing. Reads env directly (matches MeriV2OrchestratorClient's convention).
 */
@Injectable()
export class MemoryPromotionClient {
  private readonly logger = new Logger(MemoryPromotionClient.name);
  private readonly apiBaseUrl = (process.env.API_BASE_URL ?? 'https://app.capiro.ai').replace(
    /\/+$/,
    '',
  );
  private readonly sharedSecret = process.env.INTERNAL_SERVICE_SECRET;

  get configured(): boolean {
    return Boolean(this.sharedSecret);
  }

  async promote(input: {
    tenantId: string;
    clerkUserId: string;
    key: string;
    value: string;
    source?: string;
  }): Promise<{ candidateId: string; status: string }> {
    if (!this.sharedSecret) {
      throw new ServiceUnavailableException(
        'Memory promotion is not configured (INTERNAL_SERVICE_SECRET unset)',
      );
    }
    const res = await fetch(`${this.apiBaseUrl}/api/internal/memory/candidates`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-service-secret': this.sharedSecret,
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.warn(`memory promotion failed: ${res.status} ${detail.slice(0, 200)}`);
      throw new ServiceUnavailableException(`Memory promotion failed (${res.status})`);
    }
    return (await res.json()) as { candidateId: string; status: string };
  }
}

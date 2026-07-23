import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ResolvedAttachment {
  filename: string;
  text: string;
}

const RESOLVE_TIMEOUT_MS = 8_000;
const MAX_ATTACHMENTS = 10;

/**
 * Resolves the extracted TEXT of uploaded grounding attachments (CRT-5/MRI-7) so
 * the Strategy Planner Meri draft/assistant call can ground on them. api-strategy
 * cannot read ClioAttachment (it lives in apps/api's schema and is user-scoped),
 * so it hops to apps/api's `POST /api/clio/attachments/resolve-text` under the
 * CALLER's bearer (the same user who uploaded them — RolesGuard authorises).
 *
 * Fails SOFT: any error / missing bearer / no ids degrades to an empty set, so a
 * flaky attachment lookup never blocks the draft — the plan is simply drafted
 * without the document grounding rather than erroring.
 */
@Injectable()
export class StrategyAttachmentResolver {
  private readonly logger = new Logger(StrategyAttachmentResolver.name);
  private readonly apiBaseUrl: string;

  constructor(config: ConfigService) {
    this.apiBaseUrl = (
      config.get<string>('API_INTERNAL_URL') ??
      config.get<string>('API_BASE_URL') ??
      'https://app.capiro.ai'
    ).replace(/\/+$/, '');
  }

  async resolve(bearer: string | undefined, attachmentIds: string[] | undefined): Promise<ResolvedAttachment[]> {
    const ids = [...new Set((attachmentIds ?? []).filter((s) => typeof s === 'string' && s))].slice(
      0,
      MAX_ATTACHMENTS,
    );
    if (!ids.length || !bearer) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/clio/attachments/resolve-text`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: bearer.startsWith('Bearer ') ? bearer : `Bearer ${bearer}`,
        },
        body: JSON.stringify({ attachmentIds: ids }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        documents?: Array<{ filename?: unknown; text?: unknown }>;
      };
      return (body.documents ?? [])
        .filter((d) => d && typeof d.text === 'string' && (d.text as string).trim())
        .map((d) => ({ filename: String(d.filename ?? 'document'), text: String(d.text) }));
    } catch (err) {
      // Never log document contents; only that we degraded.
      this.logger.warn(
        `attachment text resolve failed (${ids.length} id(s)); drafting without them: ${(err as Error).message}`,
      );
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

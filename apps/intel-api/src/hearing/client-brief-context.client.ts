import { Injectable, Logger } from '@nestjs/common';

export type BriefRelevanceBand = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE' | 'INSUFFICIENT_EVIDENCE';

const BANDS: ReadonlySet<string> = new Set(['HIGH', 'MEDIUM', 'LOW', 'NONE', 'INSUFFICIENT_EVIDENCE']);

/** apps/api's stored relevance for one hearing × client, as the brief consumes it. */
export interface BriefClientRelevance {
  band: BriefRelevanceBand;
  score: number | null;
  whyItMatters: string;
  matchedPriorities: Array<{ label: string; kind: string | null }>;
  implications: string[];
}

export interface ClientBriefContext {
  clientName: string | null;
  /** Null when the session has no canonical hearing, or none is on record. */
  relevance: BriefClientRelevance | null;
}

/** The client block intel-api forwards to the orchestrator's summary tool. */
export interface PostHearingClientInput {
  clientId: string;
  name: string | null;
  relevance: Omit<BriefClientRelevance, 'score'> | null;
}

/**
 * Bounds the extra hop the brief now makes. It runs in PARALLEL with the four
 * derived-table reads (never after them), so the ceiling it adds to a recap is
 * max(existing reads, this) — and on a stall the brief degrades to "no client
 * context available" rather than failing. Generous relative to a normal call
 * (tens of ms in-VPC) because the alternative is a silently generic recap.
 */
const CONTEXT_TIMEOUT_MS = 8_000;

/**
 * Client context for the post-hearing brief, delegated to apps/api.
 *
 * intel-api has NO Client model and none of the relevance tables (they are
 * apps/api-owned, FORCE-RLS), so — exactly like AlertSummaryClient and
 * HearingAiCredentialResolver — it GETs over the shared INTERNAL_SERVICE_SECRET
 * channel to the InternalServiceGuard-gated
 * `GET /api/internal/legiwatch/client-brief-context`. That route returns the
 * SAME `ClientRelevanceResult` the hearing detail page shows, so the brief can
 * never claim a relevance the product does not.
 *
 * Fail-soft: any error, or the secret simply not being configured on this task,
 * degrades to null and the brief is written without client grounding — and
 * SAYS so via `clientContext: 'unavailable'` (never silently generic).
 *
 * Reads raw process.env (not ConfigService) to match every other internal
 * client in this app.
 */
@Injectable()
export class ClientBriefContextClient {
  private readonly logger = new Logger(ClientBriefContextClient.name);
  private readonly apiBaseUrl = (process.env.API_BASE_URL ?? 'https://app.capiro.ai').replace(
    /\/+$/,
    '',
  );
  private readonly sharedSecret = process.env.INTERNAL_SERVICE_SECRET;

  get configured(): boolean {
    return Boolean(this.sharedSecret);
  }

  async fetch(input: {
    tenantId: string;
    clientId: string;
    hearingId: string | null;
  }): Promise<ClientBriefContext | null> {
    if (!this.sharedSecret) {
      this.logger.warn(
        `client brief context skipped client=${input.clientId}: INTERNAL_SERVICE_SECRET not configured`,
      );
      return null;
    }
    const q = new URLSearchParams({ tenantId: input.tenantId, clientId: input.clientId });
    if (input.hearingId) q.set('hearingId', input.hearingId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONTEXT_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${this.apiBaseUrl}/api/internal/legiwatch/client-brief-context?${q.toString()}`,
        {
          method: 'GET',
          headers: { accept: 'application/json', 'x-internal-service-secret': this.sharedSecret },
          signal: controller.signal,
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseClientBriefContext(await res.json());
    } catch (err) {
      const msg =
        (err as Error).name === 'AbortError'
          ? `timed out after ${CONTEXT_TIMEOUT_MS / 1000}s`
          : (err as Error).message;
      this.logger.warn(
        `client brief context failed client=${input.clientId} hearing=${input.hearingId ?? '-'}; ` +
          `writing brief without client grounding: ${msg}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Defensive: apps/api is a separate deploy, so its shape is checked, not trusted. */
export function parseClientBriefContext(body: unknown): ClientBriefContext | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const clientName = typeof b.clientName === 'string' ? b.clientName : null;
  const r = b.relevance;
  if (!r || typeof r !== 'object') return { clientName, relevance: null };
  const rel = r as Record<string, unknown>;
  const band = typeof rel.band === 'string' && BANDS.has(rel.band) ? (rel.band as BriefRelevanceBand) : null;
  if (!band) return { clientName, relevance: null };
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
  const priorities = Array.isArray(rel.matchedPriorities)
    ? rel.matchedPriorities
        .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
        .filter((p) => typeof p.label === 'string' && p.label.trim().length > 0)
        .map((p) => ({ label: p.label as string, kind: typeof p.kind === 'string' ? p.kind : null }))
    : [];
  return {
    clientName,
    relevance: {
      band,
      score: typeof rel.score === 'number' ? rel.score : null,
      whyItMatters: typeof rel.whyItMatters === 'string' ? rel.whyItMatters : '',
      matchedPriorities: priorities,
      implications: strs(rel.implications),
    },
  };
}

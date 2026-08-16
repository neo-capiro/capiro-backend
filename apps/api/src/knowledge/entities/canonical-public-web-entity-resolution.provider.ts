import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';
import {
  buildWebSearchRequest,
  normalizeWebResults,
  type NormalizedWebResult,
  type WebSearchProvider,
} from '../../common/web-search.helpers.js';
import { clampResolutionConfidence } from './entity-normalization.js';
import type {
  EntityResolutionFallbackCandidate,
  EntityResolutionFallbackLookupInput,
  EntityResolutionFallbackProvider,
  EntityResolutionFallbackResult,
} from './universal-entity-resolution-orchestrator.types.js';

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_CANDIDATES = 5;
const MAX_QUERY_LENGTH = 200;
const BASE_CONFIDENCE = 0.6;
const CONFIDENCE_STEP = 0.05;
const MIN_CONFIDENCE = 0.3;

/**
 * Production `public_web` fallback provider. Reuses Capiro's existing
 * Tavily/Serper web-search transport (extracted to
 * `common/web-search.helpers.ts` so this stays independent of Meri's agent
 * reasoning/tool-routing layer) — no new search stack, no new credential
 * system. Candidate-only by construction: `entity-resolution-stage-policy.ts`
 * hard-codes `public_web` as a candidate-only stage, so nothing this class
 * returns can ever auto-resolve, auto-merge, or register a canonical entity
 * on its own — see the orchestrator's `decideEntityResolutionStagePolicy`.
 *
 * Deliberately does not fall back to scraping DuckDuckGo HTML the way Meri's
 * chat tool does: a scraped snippet carries no structured relevance/authority
 * signal suitable for identity evidence. Without a configured Tavily/Serper
 * key this stage reports `unavailable` rather than degrading to an
 * unstructured scrape.
 */
@Injectable()
export class PublicWebEntityResolutionProvider implements EntityResolutionFallbackProvider {
  readonly stage = 'public_web' as const;
  private readonly logger = new Logger(PublicWebEntityResolutionProvider.name);
  private readonly configuredProvider: 'duckduckgo' | 'tavily' | 'serper';
  private readonly tavilyKey?: string;
  private readonly serperKey?: string;

  constructor(config: ConfigService<AppConfig, true>) {
    this.configuredProvider = config.get('CLIO_WEB_SEARCH_PROVIDER', { infer: true });
    this.tavilyKey = config.get('TAVILY_API_KEY', { infer: true });
    this.serperKey = config.get('SERPER_API_KEY', { infer: true });
  }

  async lookup(
    input: EntityResolutionFallbackLookupInput,
  ): Promise<EntityResolutionFallbackResult> {
    const query = buildQuery(input);
    if (!query) {
      return { stage: this.stage, sourceStatus: 'complete', candidates: [] };
    }

    const resolved = this.resolveProviderAndKey();
    if (!resolved) {
      return {
        stage: this.stage,
        sourceStatus: 'unavailable',
        candidates: [],
        stopReason: 'public_web_search_not_configured',
      };
    }

    let response: Response;
    try {
      const request = buildWebSearchRequest(resolved.provider, query, MAX_CANDIDATES, resolved.apiKey);
      response = await fetchWithTimeout(request.url, request.init, REQUEST_TIMEOUT_MS);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      this.logger.warn(
        `public_web lookup via ${resolved.provider} failed: ${(error as Error).message}`,
      );
      return {
        stage: this.stage,
        sourceStatus: 'error',
        candidates: [],
        stopReason: timedOut ? 'public_web_provider_timeout' : 'public_web_provider_network_error',
      };
    }

    if (!response.ok) {
      return {
        stage: this.stage,
        sourceStatus: 'error',
        candidates: [],
        stopReason: `public_web_provider_http_${response.status}`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        stage: this.stage,
        sourceStatus: 'error',
        candidates: [],
        stopReason: 'public_web_provider_malformed_response',
      };
    }

    const results = normalizeWebResults(resolved.provider, body);
    const candidates = toCandidates(results, resolved.provider, input.entityTypeHint, input.query);

    return { stage: this.stage, sourceStatus: 'complete', candidates };
  }

  private resolveProviderAndKey(): { provider: 'tavily' | 'serper'; apiKey: string } | null {
    if (this.configuredProvider === 'tavily' && this.tavilyKey) {
      return { provider: 'tavily', apiKey: this.tavilyKey };
    }
    if (this.configuredProvider === 'serper' && this.serperKey) {
      return { provider: 'serper', apiKey: this.serperKey };
    }
    return null;
  }
}

function buildQuery(input: EntityResolutionFallbackLookupInput): string {
  const base = input.query.trim();
  if (!base) return '';
  const hints: string[] = [];
  if (input.entityTypeHint === 'organization') hints.push('company');
  else if (input.entityTypeHint === 'person') hints.push('person');
  const domainHint = input.identifiers.find(
    (identifier) => identifier.type === 'domain' || identifier.type === 'official_domain',
  );
  if (domainHint) hints.push(domainHint.value);
  const combined = hints.length > 0 ? `${base} ${hints.join(' ')}` : base;
  return combined.slice(0, MAX_QUERY_LENGTH).trim();
}

function toCandidates(
  results: readonly NormalizedWebResult[],
  provider: WebSearchProvider,
  entityTypeHint: string | null,
  rawQuery: string,
): EntityResolutionFallbackCandidate[] {
  const canonicalName = rawQuery.trim();
  const entityType = entityTypeHint ?? 'other';
  const seen = new Set<string>();
  const candidates: EntityResolutionFallbackCandidate[] = [];

  for (const result of results) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const key = normalizeUrlKey(result.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const rank = candidates.length;
    candidates.push({
      candidateKey: key,
      canonicalName,
      entityType,
      aliases: result.title
        ? [
            {
              value: result.title,
              sourceType: `public_web:${provider}`,
              sourceId: result.url,
              confidence: clampResolutionConfidence(Math.max(MIN_CONFIDENCE, BASE_CONFIDENCE - rank * CONFIDENCE_STEP)),
              verifiedAt: null,
            },
          ]
        : [],
      evidenceKinds: ['public_web_claim'],
      sourceType: `public_web:${provider}`,
      sourceId: result.url,
      sourceUrl: result.url,
      observedAt: new Date(),
      confidence: clampResolutionConfidence(Math.max(MIN_CONFIDENCE, BASE_CONFIDENCE - rank * CONFIDENCE_STEP)),
    });
  }

  return candidates;
}

function normalizeUrlKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    parsed.hash = '';
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

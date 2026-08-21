/**
 * Phase 8 Session 9 — real embedding provider.
 *
 * Implements the FROZEN `EmbeddingPort` rather than altering it, so
 * `searchCapabilityLines` is untouched: its query, cosine floor, ranking and
 * enrichment were already the real implementation, waiting only for a vector.
 *
 * Three properties are contractual, not stylistic:
 *
 *  1. **`model` must match what `apps/api` stored.** Every vector read filters on
 *     `context_embeddings.model`, so a model mismatch does not error — it
 *     silently returns zero rows, which looks exactly like "no results". The
 *     model id therefore comes from the same resolution the dark port used and is
 *     recorded on every audit row.
 *
 *  2. **`embedQuery` returns `null`, never throws.** The port documents
 *     degrade-to-empty, and `searchCapabilityLines` relies on it to serve an
 *     honest empty state instead of a 500.
 *
 *  3. **The query text never leaves this call.** It is sent to the provider and
 *     hashed for the audit row. It is not logged, not persisted, and no audit
 *     column can hold it.
 *
 * This adapter is only constructed when `selectEmbeddingProvider` returned a live
 * selection, so its mere existence in the container means a provider was
 * deliberately configured — never that a stray credential turned a dark
 * deployment live.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { EmbeddingPort } from '@capiro/defense-contracts';

import {
  DEFAULT_PROVIDER_CONCURRENCY,
  PROVIDER_LIMITS,
  type ProviderSelection,
  type RetryPolicy,
} from '@capiro/defense-domain';

import { ProviderInvocationRunner } from './provider-invocation.runner.js';
import type { ProviderHttpPort } from './provider-runtime.ports.js';

const PROVIDER = 'bedrock';

@Injectable()
export class BedrockEmbeddingAdapter implements EmbeddingPort {
  private readonly logger = new Logger(BedrockEmbeddingAdapter.name);

  readonly model: string;

  private readonly region: string;
  private readonly policy: RetryPolicy;
  private readonly concurrency: number;

  constructor(
    private readonly http: ProviderHttpPort,
    private readonly runner: ProviderInvocationRunner,
    selection: ProviderSelection,
    concurrency: number = DEFAULT_PROVIDER_CONCURRENCY,
  ) {
    if (selection.mode !== 'bedrock_embedding' || !selection.live) {
      // Constructing a live adapter from a dark selection would silently make a
      // dark deployment live, which is the one thing selection exists to prevent.
      throw new Error(
        `BedrockEmbeddingAdapter requires a live bedrock selection, got "${selection.mode}"`,
      );
    }
    this.model = String(selection.resolved.model);
    this.region = String(selection.resolved.region);
    this.policy = {
      maxAttempts: Number(selection.resolved.maxAttempts),
      timeoutMs: Number(selection.resolved.timeoutMs),
    };
    this.concurrency = concurrency;
    this.logger.log(
      `embedding provider live: ${this.model} in ${this.region} ` +
        `(timeout ${this.policy.timeoutMs}ms, up to ${this.policy.maxAttempts} attempts)`,
    );
  }

  /** Titan v2 invoke-model endpoint for the configured region and model. */
  private endpoint(): string {
    return `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(
      this.model,
    )}/invoke`;
  }

  async embedQuery(text: string): Promise<readonly number[] | null> {
    const query = (text ?? '').trim().slice(0, PROVIDER_LIMITS.maxQueryChars);
    const tenantScope = 'defense-api';

    // An empty query is not a provider failure and must not spend an attempt.
    if (query === '') {
      await this.runner.recordNonInvocation({
        provider: PROVIDER,
        operation: 'embed_query',
        model: this.model,
        tenantId: tenantScope,
        payload: { chars: 0 },
        outcome: 'degraded_empty_input',
        reason: 'empty query; no provider attempt made',
      });
      return null;
    }

    // The payload recorded for idempotency and audit is the query's SHAPE, never
    // its text: length plus the digest the runner computes over this object.
    const auditPayload = { chars: query.length, model: this.model };

    const outcome = await this.runner.invoke<readonly number[]>(
      {
        provider: PROVIDER,
        operation: 'embed_query',
        model: this.model,
        tenantId: tenantScope,
        payload: auditPayload,
        policy: this.policy,
        attempt: () =>
          this.http.post({
            url: this.endpoint(),
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            // Titan v2 request shape.
            body: { inputText: query },
            timeoutMs: this.policy.timeoutMs,
          }),
        interpret: (body) => interpretTitanEmbedding(body),
        resultDimension: (vector) => vector.length,
      },
      this.concurrency,
    );

    return outcome.result;
  }
}

/**
 * Read a Titan embedding response.
 *
 * Returns `null` for anything that is not a usable, finite, non-empty vector, so
 * the runner classifies it as `malformed_response` rather than recording an empty
 * success. A vector containing a NaN would poison a cosine comparison silently,
 * which is exactly the class of bug that is invisible in production.
 */
export function interpretTitanEmbedding(body: unknown): readonly number[] | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as { embedding?: unknown }).embedding;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const vector: number[] = [];
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    vector.push(value);
  }
  return Object.freeze(vector);
}

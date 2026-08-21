/**
 * Phase 8 Session 9 — real client-relevance provider.
 *
 * Implements the FROZEN `ClientRelevancePort`. The contract already specified the
 * shape this session had to deliver:
 *
 *   "Of `peCodes`, which are relevant to ANY client in this tenant at or above
 *    `minScore`? ONE call for the whole candidate set. `apps/api` answers the same
 *    question with up to 50 sequential per-PE probes (MAX_RELEVANCE_PROBES). The
 *    batched shape is a deliberate improvement required by the Workstream E gate
 *    ('no unbounded N+1 fanout'); the ANSWER is the same set."
 *
 * So the batching is not an optimisation added here — it is the port's stated
 * requirement, and the main API's new internal endpoint answers it in one call.
 *
 * Transport is the main API's existing internal-service channel: the same static
 * shared secret and `x-internal-service-secret` header that six other
 * `internal/*` controllers already use. Session 9 introduces no new credential
 * CLASS, which is what keeps the Session 3 serve-environment boundary intact —
 * that boundary forbids promoter, snapshot-activation, NVIDIA, SageMaker-admin
 * and parser-model credentials, none of which appear here.
 *
 * The secret is held in a closure and used only as a header value. It is never
 * logged, never returned, and no audit column can express it.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { ClientRelevancePort } from '@capiro/defense-contracts';

import {
  DEFAULT_PROVIDER_CONCURRENCY,
  type ProviderSelection,
  type RetryPolicy,
} from '@capiro/defense-domain';

import { ProviderInvocationRunner } from './provider-invocation.runner.js';
import type { ProviderHttpPort } from './provider-runtime.ports.js';

const PROVIDER = 'main_api_internal';

/** The one additive internal route Session 9 adds on the main API. */
export const RELEVANCE_BATCH_PATH = '/internal/program-elements/relevance/batch';

@Injectable()
export class InternalServiceClientRelevanceAdapter implements ClientRelevancePort {
  private readonly logger = new Logger(InternalServiceClientRelevanceAdapter.name);

  private readonly baseUrl: string;
  private readonly maxBatch: number;
  private readonly policy: RetryPolicy;
  private readonly concurrency: number;

  constructor(
    private readonly http: ProviderHttpPort,
    private readonly runner: ProviderInvocationRunner,
    selection: ProviderSelection,
    private readonly secret: string,
    concurrency: number = DEFAULT_PROVIDER_CONCURRENCY,
  ) {
    if (selection.mode !== 'internal_service_relevance' || !selection.live) {
      throw new Error(
        `InternalServiceClientRelevanceAdapter requires a live internal_service selection, got "${selection.mode}"`,
      );
    }
    if (secret.trim() === '') {
      // Calling the other side without a secret is pointless: its guard is
      // fail-closed and would deny every request.
      throw new Error('InternalServiceClientRelevanceAdapter requires a non-empty shared secret');
    }
    this.baseUrl = String(selection.resolved.baseUrl);
    this.maxBatch = Number(selection.resolved.maxBatch);
    this.policy = {
      maxAttempts: Number(selection.resolved.maxAttempts),
      timeoutMs: Number(selection.resolved.timeoutMs),
    };
    this.concurrency = concurrency;
    this.logger.log(
      `client-relevance provider live against ${this.baseUrl} ` +
        `(batch ${this.maxBatch}, timeout ${this.policy.timeoutMs}ms, ` +
        `up to ${this.policy.maxAttempts} attempts)`,
    );
  }

  async relevantPeCodes(input: {
    tenantId: string;
    userId: string;
    peCodes: readonly string[];
    minScore: number;
  }): Promise<ReadonlySet<string>> {
    // Normalised the same way the main API normalises a PE code, and deduped, so
    // the batch we send is the batch the answer is about.
    const codes = [
      ...new Set(
        input.peCodes
          .map((code) => code.trim().toUpperCase())
          .filter((code) => code !== ''),
      ),
    ].sort();

    if (codes.length === 0) {
      await this.runner.recordNonInvocation({
        provider: PROVIDER,
        operation: 'relevant_pe_codes',
        model: null,
        tenantId: input.tenantId,
        payload: { codes: 0, minScore: input.minScore },
        outcome: 'degraded_empty_input',
        reason: 'no candidate PE codes; no provider attempt made',
      });
      return new Set<string>();
    }

    // Bounded so a large candidate page cannot turn into an unbounded request
    // body. The truncation is reported rather than silent — a silently trimmed
    // batch would look like "those PEs are not relevant".
    const batch = codes.slice(0, this.maxBatch);
    if (batch.length < codes.length) {
      this.logger.warn(
        `client-relevance batch truncated from ${codes.length} to ${batch.length} PE codes; ` +
          'the remainder is unanswered, not answered negatively',
      );
    }

    const outcome = await this.runner.invoke<readonly string[]>(
      {
        provider: PROVIDER,
        operation: 'relevant_pe_codes',
        model: null,
        tenantId: input.tenantId,
        // Digest input records the SHAPE of the request: how many codes and at
        // what threshold. The codes themselves are tenant data and are hashed.
        payload: { codes: batch, minScore: input.minScore },
        policy: this.policy,
        attempt: () =>
          this.http.post({
            url: `${this.baseUrl}${RELEVANCE_BATCH_PATH}`,
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              'x-internal-service-secret': this.secret,
            },
            body: {
              tenantId: input.tenantId,
              clerkUserId: input.userId,
              peCodes: batch,
              minScore: input.minScore,
            },
            timeoutMs: this.policy.timeoutMs,
          }),
        // Only codes we actually asked about may come back. A provider echoing
        // an unrequested code would otherwise inject relevance for a PE that was
        // never a candidate.
        interpret: (body) => interpretRelevanceResponse(body, batch),
        resultCount: (result) => result.length,
      },
      this.concurrency,
    );

    return new Set(outcome.result ?? []);
  }
}

/**
 * Read a relevance response, constrained to the codes that were requested.
 *
 * Returns `null` for a body that is not a string array, so the runner classifies
 * it as `malformed_response`. An empty array IS a valid answer — "none of these
 * are relevant" — and is returned as an empty list rather than as a failure.
 */
export function interpretRelevanceResponse(
  body: unknown,
  requested: readonly string[],
): readonly string[] | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as { relevantPeCodes?: unknown }).relevantPeCodes;
  if (!Array.isArray(raw)) return null;

  const allowed = new Set(requested);
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') return null;
    const code = value.trim().toUpperCase();
    // Silently dropping an unrequested code is right: it is the provider's
    // mistake, not a reason to discard the whole answer.
    if (allowed.has(code) && !out.includes(code)) out.push(code);
  }
  return Object.freeze(out.sort());
}

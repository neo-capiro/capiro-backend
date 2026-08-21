/**
 * Phase 8 Session 9 — the single decision point that binds a port to a provider.
 *
 * Exactly one place decides whether a cross-domain port is dark or live, so there
 * is no second path by which a provider could appear. The rule it enforces:
 *
 *   a real provider is bound ONLY when `selectCrossDomainProviders` returned a
 *   live selection for that port, and every construction failure falls back to
 *   the dark implementation rather than propagating.
 *
 * That last clause matters more than it looks. These ports sit on read routes
 * documented to degrade rather than 500, so a provider that cannot be constructed
 * must produce the same honest empty state an unconfigured one does — not a
 * failed application boot and not a 500 on first request.
 *
 * The result is that a deployment with no provider configuration behaves exactly
 * as it does today, byte for byte, which is what lets Session 9 ship dark.
 */

import { Logger } from '@nestjs/common';
import type { ClientRelevancePort, EmbeddingPort } from '@capiro/defense-contracts';

import {
  DEFAULT_PROVIDER_CONCURRENCY,
  ProviderConcurrencyGate,
  assertNoForbiddenProviderConfig,
  selectCrossDomainProviders,
  type ProviderSelection,
} from '@capiro/defense-domain';

import { UnconfiguredClientRelevancePort, UnconfiguredEmbeddingPort } from './ports.js';
import { BedrockEmbeddingAdapter } from './bedrock-embedding.adapter.js';
import { InternalServiceClientRelevanceAdapter } from './internal-service-client-relevance.adapter.js';
import { ProviderInvocationRunner } from './provider-invocation.runner.js';
import { HttpsProviderHttpAdapter } from './https-provider-http.adapter.js';
import {
  systemProviderClock,
  type ProviderAuditSink,
  type ProviderClock,
  type ProviderHttpPort,
} from './provider-runtime.ports.js';

const logger = new Logger('CrossDomainProviderFactory');

/**
 * Injection token for the single binding.
 *
 * Both ports resolve from ONE binding so they share a runner, a clock and a
 * concurrency-gate map. Two bindings would give each port its own gates and
 * silently double the effective in-flight cap per provider.
 */
export const BOUND_CROSS_DOMAIN_PROVIDERS = Symbol('BOUND_CROSS_DOMAIN_PROVIDERS');

export interface ProviderRuntimeDependencies {
  readonly audit: ProviderAuditSink;
  readonly http?: ProviderHttpPort;
  readonly clock?: ProviderClock;
  readonly env?: NodeJS.ProcessEnv;
  readonly concurrency?: number;
}

export interface BoundProviders {
  readonly embedding: EmbeddingPort;
  readonly clientRelevance: ClientRelevancePort;
  readonly embeddingSelection: ProviderSelection;
  readonly clientRelevanceSelection: ProviderSelection;
}

/**
 * Bind both cross-domain ports.
 *
 * Also asserts, at the moment providers are wired, that no forbidden credential
 * class is present. Session 3 froze the serve environment against promoter,
 * snapshot-activation, NVIDIA, SageMaker-model-admin and parser-model
 * credentials; Session 9 adds an embedding and an internal-service credential and
 * this is where a later change trying to smuggle in one of the forbidden classes
 * under a provider-shaped name gets stopped.
 */
export function bindCrossDomainProviders(deps: ProviderRuntimeDependencies): BoundProviders {
  const env = deps.env ?? process.env;

  // Fail LOUD here, unlike provider construction below: a forbidden credential
  // in the serve environment is a boundary violation, not a degraded provider.
  assertNoForbiddenProviderConfig(env);

  const selections = selectCrossDomainProviders(env);
  const concurrency = deps.concurrency ?? DEFAULT_PROVIDER_CONCURRENCY;
  const http = deps.http ?? new HttpsProviderHttpAdapter();
  const clock = deps.clock ?? systemProviderClock;
  const runner = new ProviderInvocationRunner(
    deps.audit,
    clock,
    new Map<string, ProviderConcurrencyGate>(),
  );

  const embedding = bindEmbedding({
    selection: selections.embedding,
    http,
    runner,
    concurrency,
  });

  const clientRelevance = bindClientRelevance({
    selection: selections.clientRelevance,
    http,
    runner,
    concurrency,
    secret: env.DEFENSE_MAIN_API_INTERNAL_SECRET ?? '',
  });

  logger.log(
    `cross-domain providers bound: embedding=${selections.embedding.mode} ` +
      `clientRelevance=${selections.clientRelevance.mode}`,
  );
  if (!selections.anyLive) {
    logger.log(
      'both cross-domain ports are dark; capability search and client relevance serve their ' +
        'documented empty results, exactly as before Session 9',
    );
  }

  return {
    embedding,
    clientRelevance,
    embeddingSelection: selections.embedding,
    clientRelevanceSelection: selections.clientRelevance,
  };
}

function bindEmbedding(input: {
  selection: ProviderSelection;
  http: ProviderHttpPort;
  runner: ProviderInvocationRunner;
  concurrency: number;
}): EmbeddingPort {
  if (!input.selection.live) {
    logger.log(`embedding port dark: ${input.selection.reason}`);
    return new UnconfiguredEmbeddingPort();
  }
  try {
    return new BedrockEmbeddingAdapter(
      input.http,
      input.runner,
      input.selection,
      input.concurrency,
    );
  } catch (error) {
    // Degrade, do not throw: this port is on a read route that must serve an
    // honest empty state rather than fail.
    logger.error(
      `embedding provider could not be constructed; falling back to dark: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return new UnconfiguredEmbeddingPort();
  }
}

function bindClientRelevance(input: {
  selection: ProviderSelection;
  http: ProviderHttpPort;
  runner: ProviderInvocationRunner;
  concurrency: number;
  secret: string;
}): ClientRelevancePort {
  if (!input.selection.live) {
    logger.log(`client-relevance port dark: ${input.selection.reason}`);
    return new UnconfiguredClientRelevancePort();
  }
  try {
    return new InternalServiceClientRelevanceAdapter(
      input.http,
      input.runner,
      input.selection,
      input.secret,
      input.concurrency,
    );
  } catch (error) {
    logger.error(
      `client-relevance provider could not be constructed; falling back to dark: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return new UnconfiguredClientRelevancePort();
  }
}

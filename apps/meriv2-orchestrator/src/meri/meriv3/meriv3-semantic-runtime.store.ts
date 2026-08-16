import { AsyncLocalStorage } from 'node:async_hooks';
import type { MeriRetrievalPlan } from '../retrieval/meri-retrieval-plan.js';

export type MeriSemanticGatewayMode = 'legacy' | 'shadow' | 'enabled';

export interface MeriSemanticGatewayDecision {
  mode: MeriSemanticGatewayMode;
  legacyNames: string[];
  proposedNames: string[];
  exposedNames: string[];
  removedNames: string[];
  fallbackToLegacy: boolean;
  fallbackReason: string | null;
  canonicalResearchDirector: boolean;
}

export interface MeriV3SemanticRuntimeConfig {
  tenantId: string;
  request: string;
  recentUserContext: string;
  plan: MeriRetrievalPlan;
}

export interface MeriV3SemanticRuntimeState extends MeriV3SemanticRuntimeConfig {
  decision?: MeriSemanticGatewayDecision;
}

/**
 * Request-local bridge between deterministic retrieval planning and schema
 * exposure. MeriV3 services are singletons, so mutable per-turn gateway state
 * must never live on the service instance itself.
 */
export class MeriV3SemanticRuntimeStore {
  private static readonly storage = new AsyncLocalStorage<MeriV3SemanticRuntimeState>();

  static run<T>(config: MeriV3SemanticRuntimeConfig, fn: () => T): T {
    return this.storage.run({ ...config }, fn);
  }

  static current(): Readonly<MeriV3SemanticRuntimeState> | undefined {
    return this.storage.getStore();
  }

  static recordDecision(decision: MeriSemanticGatewayDecision): void {
    const state = this.storage.getStore();
    if (state) state.decision = decision;
  }
}

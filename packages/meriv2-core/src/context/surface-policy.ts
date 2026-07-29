import type { ContextRequest, ContextSurface, SteeringLayer } from './contract.js';

/**
 * Explicit per-surface context policy. Surfaces may have different budgets, but
 * they cannot silently invent their own layer sets or downgrade persistence.
 */
export interface ContextSurfacePolicy {
  surface: ContextSurface;
  layers: readonly SteeringLayer[];
  tokenBudget: number;
  persistence: 'required' | 'best-effort';
  /** A deliverable may require corroboration before episodic memory is rendered. */
  externalDeliverable: boolean;
}

const CHAT_LAYERS = [
  'firm-identity',
  'user-voice',
  'client-steering',
  'client-people',
] as const satisfies readonly SteeringLayer[];

const DELIVERABLE_LAYERS = [
  'firm-identity',
  'firm-playbook',
  'user-voice',
  'client-steering',
  'client-people',
] as const satisfies readonly SteeringLayer[];

const POLICIES: Readonly<Record<ContextSurface, ContextSurfacePolicy>> = {
  chat: {
    surface: 'chat',
    layers: CHAT_LAYERS,
    tokenBudget: 5_000,
    persistence: 'required',
    externalDeliverable: false,
  },
  'ga-chat': {
    surface: 'ga-chat',
    layers: CHAT_LAYERS,
    tokenBudget: 5_000,
    persistence: 'required',
    externalDeliverable: false,
  },
  'tool-invoke': {
    surface: 'tool-invoke',
    layers: ['firm-identity', 'client-steering'],
    tokenBudget: 2_000,
    persistence: 'best-effort',
    externalDeliverable: false,
  },
  'in-editor': {
    surface: 'in-editor',
    layers: DELIVERABLE_LAYERS,
    tokenBudget: 6_000,
    persistence: 'required',
    externalDeliverable: true,
  },
  strategy: {
    surface: 'strategy',
    layers: DELIVERABLE_LAYERS,
    tokenBudget: 8_000,
    persistence: 'required',
    externalDeliverable: true,
  },
  steward: {
    surface: 'steward',
    layers: ['firm-identity', 'client-steering', 'client-people'],
    tokenBudget: 5_000,
    persistence: 'required',
    externalDeliverable: false,
  },
  outreach: {
    surface: 'outreach',
    layers: DELIVERABLE_LAYERS,
    tokenBudget: 6_000,
    persistence: 'required',
    externalDeliverable: true,
  },
  memo: {
    surface: 'memo',
    layers: DELIVERABLE_LAYERS,
    tokenBudget: 7_000,
    persistence: 'required',
    externalDeliverable: true,
  },
  'district-brief': {
    surface: 'district-brief',
    layers: DELIVERABLE_LAYERS,
    tokenBudget: 7_000,
    persistence: 'required',
    externalDeliverable: true,
  },
  research: {
    surface: 'research',
    layers: DELIVERABLE_LAYERS,
    tokenBudget: 8_000,
    persistence: 'required',
    externalDeliverable: true,
  },
  'workspace-gen': {
    surface: 'workspace-gen',
    layers: DELIVERABLE_LAYERS,
    tokenBudget: 8_000,
    persistence: 'required',
    externalDeliverable: true,
  },
};

export function contextSurfacePolicy(surface: ContextSurface): ContextSurfacePolicy {
  return POLICIES[surface];
}

/**
 * Apply v2 defaults without overwriting an explicitly configured budget or
 * documented surface-specific layer exclusion.
 */
export function applyContextSurfacePolicy(
  request: Omit<ContextRequest, 'layers'> & { layers?: readonly SteeringLayer[] },
): ContextRequest {
  const policy = contextSurfacePolicy(request.surface);
  const layers = (request.layers ?? policy.layers).filter((layer) => {
    // Client layers are not requested when no client is in scope. This prevents
    // a "missing layer" health warning from pretending client context should exist.
    if (!request.clientId && (layer === 'client-steering' || layer === 'client-people')) {
      return false;
    }
    return true;
  });
  return {
    ...request,
    contractVersion: request.contractVersion ?? 2,
    layers,
    tokenBudget: request.tokenBudget ?? policy.tokenBudget,
    budgetUnit: request.budgetUnit ?? 'tokens',
    persistence: request.persistence ?? policy.persistence,
    compilerVersion: request.compilerVersion ?? 'context-compiler-v2.0',
  };
}

export function surfacePolicies(): readonly ContextSurfacePolicy[] {
  return Object.values(POLICIES);
}

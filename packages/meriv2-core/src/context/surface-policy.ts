import type { MemorySensitivity } from '../memory/governance';
import type { ContextRequest, ContextSurface, SteeringLayer } from './contract';

export type ContextEnvelopeMode = 'typed' | 'plain';

/** Explicit per-surface Phase 8 context policy. */
export interface ContextSurfacePolicy {
  surface: ContextSurface;
  /** Always required when the surface is in scope. */
  requiredLayers: readonly SteeringLayer[];
  /** Required only when the request has a server-resolved client. */
  clientRequiredLayers: readonly SteeringLayer[];
  /** Missing values never degrade packet health. */
  optionalLayers: readonly SteeringLayer[];
  /** Optional only when a server-resolved client is in scope. */
  clientOptionalLayers: readonly SteeringLayer[];
  /** Compatibility projection containing every possible layer for this surface. */
  layers: readonly SteeringLayer[];
  tokenBudget: number;
  persistence: 'required' | 'best-effort';
  externalDeliverable: boolean;
  allowedSensitivities: readonly MemorySensitivity[];
  /** External/body-rendering surfaces must not receive literal context_item tags. */
  renderEnvelope: ContextEnvelopeMode;
}

export interface AppliedContextSurfacePolicy {
  requiredLayers: readonly SteeringLayer[];
  optionalLayers: readonly SteeringLayer[];
  layers: readonly SteeringLayer[];
  renderEnvelope: ContextEnvelopeMode;
}

const INTERNAL_SENSITIVITIES = ['normal', 'confidential'] as const;
const EXTERNAL_SENSITIVITIES = ['normal'] as const;

function definePolicy(input: Omit<ContextSurfacePolicy, 'layers'>): ContextSurfacePolicy {
  const layers = uniqueLayers([
    ...input.requiredLayers,
    ...input.clientRequiredLayers,
    ...input.optionalLayers,
    ...input.clientOptionalLayers,
  ]);
  return { ...input, layers };
}

const POLICIES: Readonly<Record<ContextSurface, ContextSurfacePolicy>> = {
  chat: definePolicy({
    surface: 'chat',
    requiredLayers: ['firm-identity'],
    clientRequiredLayers: ['client-steering'],
    optionalLayers: ['user-voice'],
    clientOptionalLayers: ['client-people'],
    tokenBudget: 5_000,
    persistence: 'best-effort',
    externalDeliverable: false,
    allowedSensitivities: INTERNAL_SENSITIVITIES,
    renderEnvelope: 'typed',
  }),
  'ga-chat': definePolicy({
    surface: 'ga-chat',
    requiredLayers: ['firm-identity'],
    clientRequiredLayers: ['client-steering'],
    optionalLayers: ['user-voice'],
    clientOptionalLayers: ['client-people'],
    tokenBudget: 5_000,
    persistence: 'best-effort',
    externalDeliverable: false,
    allowedSensitivities: INTERNAL_SENSITIVITIES,
    renderEnvelope: 'typed',
  }),
  'tool-invoke': definePolicy({
    surface: 'tool-invoke',
    requiredLayers: ['firm-identity'],
    clientRequiredLayers: [],
    optionalLayers: [],
    clientOptionalLayers: ['client-steering'],
    tokenBudget: 2_000,
    persistence: 'best-effort',
    externalDeliverable: false,
    allowedSensitivities: INTERNAL_SENSITIVITIES,
    renderEnvelope: 'typed',
  }),
  'in-editor': definePolicy({
    surface: 'in-editor',
    requiredLayers: ['firm-identity'],
    clientRequiredLayers: ['client-steering'],
    optionalLayers: ['firm-playbook', 'user-voice'],
    clientOptionalLayers: ['client-people'],
    tokenBudget: 6_000,
    persistence: 'required',
    externalDeliverable: true,
    allowedSensitivities: EXTERNAL_SENSITIVITIES,
    renderEnvelope: 'plain',
  }),
  'workspace-editor': definePolicy({
    surface: 'workspace-editor',
    requiredLayers: ['firm-identity'],
    clientRequiredLayers: ['client-steering'],
    optionalLayers: ['firm-playbook', 'user-voice'],
    clientOptionalLayers: ['client-people'],
    tokenBudget: 6_000,
    persistence: 'required',
    externalDeliverable: true,
    allowedSensitivities: EXTERNAL_SENSITIVITIES,
    renderEnvelope: 'plain',
  }),
  strategy: definePolicy({
    surface: 'strategy',
    requiredLayers: ['firm-identity'],
    clientRequiredLayers: ['client-steering'],
    optionalLayers: ['firm-playbook', 'user-voice'],
    clientOptionalLayers: ['client-people'],
    tokenBudget: 8_000,
    persistence: 'required',
    externalDeliverable: true,
    allowedSensitivities: EXTERNAL_SENSITIVITIES,
    renderEnvelope: 'plain',
  }),
  steward: definePolicy({
    surface: 'steward',
    requiredLayers: ['firm-identity'],
    clientRequiredLayers: ['client-steering'],
    optionalLayers: [],
    clientOptionalLayers: ['client-people'],
    tokenBudget: 5_000,
    persistence: 'best-effort',
    externalDeliverable: false,
    allowedSensitivities: INTERNAL_SENSITIVITIES,
    renderEnvelope: 'typed',
  }),
  outreach: definePolicy({
    surface: 'outreach',
    requiredLayers: ['firm-identity'],
    clientRequiredLayers: ['client-steering'],
    optionalLayers: ['firm-playbook', 'user-voice'],
    clientOptionalLayers: ['client-people'],
    tokenBudget: 6_000,
    persistence: 'required',
    externalDeliverable: true,
    allowedSensitivities: EXTERNAL_SENSITIVITIES,
    renderEnvelope: 'plain',
  }),
  memo: definePolicy({
    surface: 'memo',
    requiredLayers: ['firm-identity'],
    clientRequiredLayers: ['client-steering'],
    optionalLayers: ['firm-playbook', 'user-voice'],
    clientOptionalLayers: ['client-people'],
    tokenBudget: 7_000,
    persistence: 'required',
    externalDeliverable: true,
    allowedSensitivities: EXTERNAL_SENSITIVITIES,
    renderEnvelope: 'plain',
  }),
  'district-brief': definePolicy({
    surface: 'district-brief',
    requiredLayers: ['firm-identity'],
    clientRequiredLayers: ['client-steering'],
    optionalLayers: ['firm-playbook', 'user-voice'],
    clientOptionalLayers: ['client-people'],
    tokenBudget: 7_000,
    persistence: 'required',
    externalDeliverable: true,
    allowedSensitivities: EXTERNAL_SENSITIVITIES,
    renderEnvelope: 'plain',
  }),
  research: definePolicy({
    surface: 'research',
    requiredLayers: ['firm-identity'],
    clientRequiredLayers: ['client-steering'],
    optionalLayers: ['firm-playbook', 'user-voice'],
    clientOptionalLayers: ['client-people'],
    tokenBudget: 8_000,
    persistence: 'required',
    externalDeliverable: true,
    allowedSensitivities: EXTERNAL_SENSITIVITIES,
    renderEnvelope: 'plain',
  }),
  'workspace-gen': definePolicy({
    surface: 'workspace-gen',
    requiredLayers: ['firm-identity'],
    clientRequiredLayers: ['client-steering'],
    optionalLayers: ['firm-playbook', 'user-voice'],
    clientOptionalLayers: ['client-people'],
    tokenBudget: 8_000,
    persistence: 'required',
    externalDeliverable: true,
    allowedSensitivities: EXTERNAL_SENSITIVITIES,
    renderEnvelope: 'plain',
  }),
};

export function contextSurfacePolicy(surface: ContextSurface): ContextSurfacePolicy {
  return POLICIES[surface];
}

export function appliedContextSurfacePolicy(
  surface: ContextSurface,
  clientId: string | null | undefined,
): AppliedContextSurfacePolicy {
  const policy = contextSurfacePolicy(surface);
  const requiredLayers = uniqueLayers([
    ...policy.requiredLayers,
    ...(clientId ? policy.clientRequiredLayers : []),
  ]);
  const optionalLayers = uniqueLayers([
    ...policy.optionalLayers,
    ...(clientId ? policy.clientOptionalLayers : []),
  ]).filter((layer) => !requiredLayers.includes(layer));
  return {
    requiredLayers,
    optionalLayers,
    layers: uniqueLayers([...requiredLayers, ...optionalLayers]),
    renderEnvelope: policy.renderEnvelope,
  };
}

/** Apply v2 defaults while retaining explicit legacy render/character budgets. */
export function applyContextSurfacePolicy(
  request: Omit<ContextRequest, 'layers'> & { layers?: readonly SteeringLayer[] },
): ContextRequest {
  const policy = contextSurfacePolicy(request.surface);
  const applied = appliedContextSurfacePolicy(request.surface, request.clientId);
  const requestedLayers = request.layers ? uniqueLayers([...request.layers]) : [...applied.layers];
  const layers = requestedLayers.filter(
    (layer) => request.clientId || (layer !== 'client-steering' && layer !== 'client-people'),
  );
  return {
    ...request,
    contractVersion: request.contractVersion ?? 2,
    layers,
    allowedSensitivities: request.allowedSensitivities ?? [...policy.allowedSensitivities],
    tokenBudget: request.tokenBudget ?? policy.tokenBudget,
    budgetUnit: request.budgetUnit ?? 'tokens',
    persistence: request.persistence ?? policy.persistence,
    compilerVersion: request.compilerVersion ?? 'context-compiler-v2.1',
  };
}

export function surfacePolicies(): readonly ContextSurfacePolicy[] {
  return Object.values(POLICIES);
}

function uniqueLayers(layers: readonly SteeringLayer[]): SteeringLayer[] {
  return [...new Set(layers)];
}

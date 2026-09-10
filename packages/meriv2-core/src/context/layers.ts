import type { SteeringLayer } from './contract';

/**
 * Phase 16 universal Context Plane layers.
 *
 * These are architectural layers, not UI locations, authorization scopes, or
 * feature-specific RAG buckets. Existing SteeringLayer values remain the
 * durable-memory sub-layer vocabulary inside Layers A-C.
 */
export const CONTEXT_LAYER_ORDER = [
  'firm-context',
  'user-context',
  'client-context',
  'live-authoritative',
  'institutional-knowledge',
] as const;

export type ContextLayer = (typeof CONTEXT_LAYER_ORDER)[number];
export type ContextLayerId = 'A' | 'B' | 'C' | 'D' | 'E';
export type ContextLayerContentClass = 'steering' | 'evidence';
export type EvidenceContextLayer = Extract<
  ContextLayer,
  'live-authoritative' | 'institutional-knowledge'
>;

export interface ContextLayerDefinition {
  id: ContextLayerId;
  layer: ContextLayer;
  contentClass: ContextLayerContentClass;
  description: string;
  /** Existing curated-memory vocabulary that belongs inside this layer. */
  steeringMembers: readonly SteeringLayer[];
}

export const CONTEXT_LAYER_DEFINITIONS = {
  'firm-context': {
    id: 'A',
    layer: 'firm-context',
    contentClass: 'steering',
    description: 'Firm identity and firm playbook steering context.',
    steeringMembers: ['firm-identity', 'firm-playbook'],
  },
  'user-context': {
    id: 'B',
    layer: 'user-context',
    contentClass: 'steering',
    description: 'User preferences, profile, and voice steering context.',
    steeringMembers: ['user-voice'],
  },
  'client-context': {
    id: 'C',
    layer: 'client-context',
    contentClass: 'steering',
    description: 'Explicitly scoped client steering and client-people context.',
    steeringMembers: ['client-steering', 'client-people'],
  },
  'live-authoritative': {
    id: 'D',
    layer: 'live-authoritative',
    contentClass: 'evidence',
    description: 'Current authoritative source and live Capiro domain data.',
    steeringMembers: [],
  },
  'institutional-knowledge': {
    id: 'E',
    layer: 'institutional-knowledge',
    contentClass: 'evidence',
    description: 'Private evidence and provenance-bearing institutional knowledge.',
    steeringMembers: [],
  },
} as const satisfies Readonly<Record<ContextLayer, ContextLayerDefinition>>;

export const CONTEXT_LAYER_BY_STEERING_LAYER: Readonly<
  Record<SteeringLayer, Extract<ContextLayer, 'firm-context' | 'user-context' | 'client-context'>>
> = {
  'firm-identity': 'firm-context',
  'firm-playbook': 'firm-context',
  'user-voice': 'user-context',
  'client-steering': 'client-context',
  'client-people': 'client-context',
};

export interface NormalizedContextLayer {
  id: ContextLayerId;
  layer: ContextLayer;
  contentClass: ContextLayerContentClass;
  /** Canonical SteeringLayer members for the architecture layer. */
  steeringMembers: SteeringLayer[];
  /** Steering rows selected by the legacy compiler policy for this request. */
  selectedSteeringLayers: SteeringLayer[];
  /** Source/domain identifiers routed to an evidence layer. */
  sourceRefs: string[];
  /** Explicit SubjectScope clients only; UI-selected clients never belong here by themselves. */
  subjectClientIds: string[];
}

/** Exactly five slots, always in A -> E architectural order. */
export type NormalizedContextLayers = readonly [
  NormalizedContextLayer,
  NormalizedContextLayer,
  NormalizedContextLayer,
  NormalizedContextLayer,
  NormalizedContextLayer,
];

export interface NormalizeContextLayersInput {
  selectedSteeringLayers?: readonly SteeringLayer[];
  subjectClientIds?: readonly string[];
  liveAuthoritativeSources?: readonly string[];
  institutionalKnowledgeSources?: readonly string[];
}

export function contextLayerForSteeringLayer(layer: SteeringLayer): ContextLayer {
  return CONTEXT_LAYER_BY_STEERING_LAYER[layer];
}

export function normalizeContextLayers(
  input: NormalizeContextLayersInput = {},
): NormalizedContextLayers {
  const selected = new Set(input.selectedSteeringLayers ?? []);
  const subjectClientIds = uniqueStrings(input.subjectClientIds ?? []);
  const liveSources = uniqueStrings(input.liveAuthoritativeSources ?? []);
  const institutionalSources = uniqueStrings(input.institutionalKnowledgeSources ?? []);

  const slot = (
    layer: ContextLayer,
    sourceRefs: readonly string[] = [],
    scopedClientIds: readonly string[] = [],
  ): NormalizedContextLayer => {
    const definition = CONTEXT_LAYER_DEFINITIONS[layer];
    return {
      id: definition.id,
      layer,
      contentClass: definition.contentClass,
      steeringMembers: [...definition.steeringMembers],
      selectedSteeringLayers: definition.steeringMembers.filter((member) => selected.has(member)),
      sourceRefs: [...sourceRefs],
      subjectClientIds: [...scopedClientIds],
    };
  };

  return [
    slot('firm-context'),
    slot('user-context'),
    slot('client-context', [], subjectClientIds),
    slot('live-authoritative', liveSources),
    slot('institutional-knowledge', institutionalSources),
  ];
}

export function selectedSteeringLayersFromContextLayers(
  layers: NormalizedContextLayers,
): SteeringLayer[] {
  return layers.flatMap((layer) => layer.selectedSteeringLayers);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
